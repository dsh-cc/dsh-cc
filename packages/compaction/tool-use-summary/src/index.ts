/**
 * W2 — Tool Use Summary (TUS) pipeline (design doc
 * docs/plans/2026-09-15-side-queries.md §5).
 *
 * Plain cordis plugin (no Service — reasoning-fold/handoff-store pattern, so
 * it needs no isolate realm). Registers an internal `tools/post-execute`
 * listener with NO `prepend`: the context-crusher uses `prepend: true`, so it
 * stays the outermost listener and TUS always runs inside it, summarizing the
 * RAW tool result regardless of the crusher's decision-level rewrite (§5.6).
 *
 * After `next()` the summarization is fire-and-forget (post-next pattern):
 * every failure degrades to a ledger row — never a throw into the waterfall,
 * never an unhandled rejection. Summarization uses `runSideQuery` on the
 * cheap lane with the result wrapped in hard untrusted delimiters; the digest
 * lands in an in-memory LRU store and an append-only per-session JSONL ledger
 * under `<dshHome>/tool-use-summary/`.
 *
 * @module @dsh-cc/tool-use-summary
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { runSideQuery } from '@dsh-cc/side-query'
import { appendLedgerRow, loadSummaries, sweepLedgers } from './ledger.ts'
import { registerTusSettings, type TusSettings } from './settings.ts'
import { clampSummary, TUS_SYSTEM, tusPrompt } from './summary.ts'
import { SummaryStore } from './store.ts'
import type { SummaryRow } from './types.ts'

export { loadSummaries, sweepLedgers } from './ledger.ts'
export { SETTINGS_NAMESPACE, registerTusSettings, DEFAULT_SETTINGS, SettingsSchema } from './settings.ts'
export type { TusSettings } from './settings.ts'
export { UNTRUSTED_HEAD, UNTRUSTED_TAIL, TUS_SYSTEM, tusPrompt, clampSummary } from './summary.ts'
export { SummaryStore } from './store.ts'
export { tusFramedSummary, isCrusherStub } from './framing.ts'
export type { SummaryRow } from './types.ts'

/** dshHomePath seam, read defensively (a providerless host must not crash the plugin). */
type HomeFn = (...segments: string[]) => string

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

function dshHomeFn(ctx: Context): HomeFn | undefined {
  try {
    return ctx.dshHomePath
  } catch {
    return undefined
  }
}

/** Concatenate text blocks; non-text blocks are ignored. */
function textOf(content: readonly ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Top-level-session check (recall.ts/section.ts `delegationDepthOf`
 * precedent, inlined to avoid a dsh-subagent dependency whose compiled lib
 * re-declares the tools event map with a conflicting `ToolExecution` brand).
 * Fail closed: any read error treats the agent as a child.
 */
function isTopLevel(agent: ToolExecution['agent']): boolean {
  if (agent === undefined) return true
  try {
    const header = (agent as { session?: { header?: { delegationDepth?: number } } }).session?.header
    const runtime = (agent as { options?: { subagentDepth?: number } }).options?.subagentDepth
    if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0)) return false
    return Math.max(header?.delegationDepth ?? 0, runtime ?? 0) === 0
  } catch {
    return false
  }
}

interface Deps {
  readonly ctx: Context
  readonly read: () => TusSettings
  readonly home: HomeFn | undefined
  readonly store: SummaryStore
  /** Plugin effect-scope disposal signal; aborts in-flight summaries. */
  readonly signal: AbortSignal
}

/**
 * Run the gate chain and (when every gate passes) the side query, then
 * persist one {@link SummaryRow}. Gates in order, first gate wins in the
 * ledger: enabled → top-level → size → excluded tool → cap (LRU) → dedupe.
 * Never throws.
 */
export async function maybeSummarize(deps: Deps, exec: ToolExecution, result: Readonly<ToolExecutionResult>): Promise<void> {
  const { ctx, read, home, store, signal } = deps
  const settings = read()
  const sessionId = exec.agent === undefined ? 'unknown' : String(exec.agent.session.id)
  const callId = String(exec.callId)
  const base = { callId, tool: exec.name, at: new Date().toISOString() }
  const writeRow = async (row: Omit<SummaryRow, 'callId' | 'tool' | 'at'>): Promise<void> => {
    const full: SummaryRow = { ...base, ...row }
    store.put(sessionId, full)
    if (home === undefined || settings.retentionDays <= 0) return
    await appendLedgerRow(home('tool-use-summary', `${sessionId}.jsonl`), full)
  }
  const start = Date.now()
  try {
    if (!settings.enabled) {
      await writeRow({ status: 'skipped', skipReason: 'disabled', resultBytes: 0, durationMs: 0 })
      return
    }
    if (settings.topLevelOnly && !isTopLevel(exec.agent)) {
      await writeRow({ status: 'skipped', skipReason: 'not-top-level', resultBytes: 0, durationMs: 0 })
      return
    }
    const resultText = textOf(result.content)
    const resultBytes = Buffer.byteLength(resultText, 'utf8')
    if (resultBytes < settings.minResultBytes) {
      await writeRow({ status: 'skipped', skipReason: 'small', resultBytes, durationMs: 0 })
      return
    }
    if (settings.excludeTools.includes(exec.name)) {
      await writeRow({ status: 'skipped', skipReason: 'excluded', resultBytes, durationMs: 0 })
      return
    }
    // Cap (gate 5, before dedupe): evict the least-recently-used in-memory
    // entries until under the cap; the ledger keeps every row (append-only),
    // so the cap bounds memory, not history.
    store.evictLru(sessionId, settings.maxSummariesPerSession)
    if (store.has(sessionId, callId)) {
      await writeRow({ status: 'skipped', skipReason: 'duplicate', resultBytes, durationMs: 0 })
      return
    }
    const side = await runSideQuery(ctx, {
      agent: exec.agent as never,
      alias: settings.alias,
      system: TUS_SYSTEM,
      prompt: tusPrompt(resultText),
      maxTokens: settings.maxTokens,
      timeoutMs: settings.timeoutMs,
      // §5.2: NOT exec.signal (tool-scoped; aborts before the digest lands).
      // runSideQuery composes this disposal signal with its internal timeout.
      signal,
    })
    const durationMs = Date.now() - start
    if (side.ok) {
      await writeRow({
        status: 'ok',
        resultBytes,
        summary: clampSummary(side.text),
        inheritedRoute: side.inheritedRoute,
        durationMs,
      })
      return
    }
    // Disposal-aborted run writes nothing (§5.2); every other failure is a
    // failed ledger row.
    if (signal.aborted) return
    await writeRow({ status: 'failed', resultBytes, durationMs })
  } catch (error: unknown) {
    // Never throw into the waterfall — degrade to a failed ledger row.
    try {
      ctx.logger?.warn?.(`tool-use-summary: degraded: ${String(error)}`)
    } catch {
      // Logging is best-effort too.
    }
  }
}

/**
 * Mount the TUS producer. Never throws; degrades to a no-op when the host
 * has no dshHomePath (in-memory only) and to a passthrough listener when the
 * settings provider is absent (schema defaults apply).
 * @param ctx - the plug context.
 * @returns a disposer aborting in-flight summaries and removing the listener.
 */
export function apply(ctx: Context): (() => void) | undefined {
  const read = registerTusSettings(ctx)
  const home = dshHomeFn(ctx)
  const store = new SummaryStore(() => read().maxSummariesPerSession)
  // Effect-scope disposal signal (memory-consolidation precedent): fires on
  // plugin dispose, aborting in-flight fire-and-forget summaries.
  const controller = new AbortController()
  ctx.effect(() => () => controller.abort(), 'tool-use-summary: abort in-flight summaries')
  if (home !== undefined && read().retentionDays > 0) {
    // Retention sweep out of any result hot path: fire-and-forget at mount.
    void sweepLedgers(home(), read().retentionDays).catch(() => {})
  }
  const off = ctx.on('tools/post-execute', async (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next,
  ): Promise<PostToolDecision> => {
    const d = await next()
    if (d.kind === 'accept') {
      void maybeSummarize({ ctx, read, home, store, signal: controller.signal }, exec, result)
        .catch(() => {})
    }
    return d // NEVER throw into the waterfall
  })
  return () => {
    controller.abort()
    off()
  }
}

/** Cordis plugin id. */
export const name = 'cc-tool-use-summary'

// Re-exported for the compaction-micro consumer (pure reader over the ledger).
export { loadSummaries as loadTusSummaries }
