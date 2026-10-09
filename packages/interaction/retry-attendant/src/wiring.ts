/**
 * Live wiring for the retry-attendant (design doc
 * docs/plans/2026-10-09-verify-before-retry.md §3.2/§3.3): the
 * `tools/post-execute` listener serving M1 (guidance) and the M2 set/clear
 * rules, the `tools/pre-execute` escalation waterfall (`prepend:true`, Act
 * pseudocode), and the two resolution-tracking seams (`tools/execute`
 * observe-only consume, `tools/result` release). Every listener degrades to
 * silent passthrough + debug log on internal error (§4 swallow rule).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { CLASS_TABLE, classify } from './classes.ts'
import { digestKey } from './digest.ts'
import { firstShellToken, secondShellToken } from './shell-words.ts'
import { readUserSettings } from './settings.ts'
import {
  clearEntry,
  consumeDispatch,
  createState,
  liveEntry,
  recordEntry,
  releaseReservation,
  reserve,
  resolveEntries,
  sweep,
  type RetryEntry,
  type RetryState,
} from './state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** Designated checks for clear-rule (b): git read-only subcommands (second tokens). */
const GIT_CHECK_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show'])

/** Guarded dshHome read (context-crusher index.ts pattern): cordis throws on the property access itself. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    return ctx.dshHomePath?.()
  } catch {
    return undefined
  }
}

/** One context/inject message carrying our source-marked guidance text. */
function attendantMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `[retry-attendant] ${text}` }],
    source: { kind: 'retry-attendant' },
  })
}

/** Session event append, try/caught (open-turn append can throw). */
function appendEvent(agent: ToolExecution['agent'], payload: { kind: 'guidance' | 'escalation'; class: string; tool: string; digest: string; ts: number }): void {
  try {
    agent?.session.append('retry-attendant/event', payload)
  } catch {
    // Log-only telemetry must never break a tool call.
  }
}

/**
 * Mount the retry-attendant listeners on `ctx`. `stateFor` is injectable for
 * tests; production passes one shared per-plugin instance.
 */
export function registerListeners(ctx: Context, injectedStateFor?: () => RetryState): void {
  // Default stateFor must be a lazily-created SHARED instance, not the bare
  // `createState` factory: the parameter is invoked per listener event, and a
  // bare factory would mint a fresh (always-empty) state per invocation —
  // recording/dedup/escalation would never persist. One instance per mount.
  let state: RetryState | undefined
  const stateFor = injectedStateFor ?? ((): RetryState => (state ??= createState()))
  // --- M2 escalation: pre-execute, prepend:true (outermost; §3.3 Act (a)) ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    let entry: RetryEntry | undefined
    let bitSet = false
    let delegated = false
    try {
      const state = stateFor()
      const agent = exec.agent
      const home = dshHomeOf(ctx)
      if (agent === undefined || home === undefined) return next()
      const settings = await readUserSettings(home)
      if (!settings.enabled || !settings.escalate) return next()
      const sessionId = String(agent.session.header.id)
      const digest = digestKey(exec.name, exec.arguments)
      entry = liveEntry(state, settings.expireMinutes * 60_000, sessionId, digest)
      if (entry === undefined || entry.escalated === true) return next()
      if (entry.askInFlight === true) {
        // Sibling of a pending ask: must not execute and must not return the
        // downstream (possibly non-delegating allow) verdict.
        return { kind: 'deny', reason: 'identical call is already awaiting confirmation' }
      }
      entry.askInFlight = true // synchronous CAS, pre-await window
      bitSet = true
      delegated = true
      const downstream = await next()
      if (downstream.kind === 'deny' || downstream.kind === 'cancel') {
        delete entry.askInFlight
        return downstream
      }
      const reason = reasonFor(entry)
      // Per-escalation call-time approval lookup (never latched at registration).
      const approval = ctx.get('approval')
      if (approval === undefined) {
        // Approval-absent fallback: preserve deny/ask; allow/passthrough →
        // allow + M1-style advice by direct injection (release the bit here:
        // no seam will ever fire for this path).
        delete entry.askInFlight
        if (downstream.kind === 'ask') return downstream
        injectFallbackAdvice(agent, entry)
        return { kind: 'allow' }
      }
      reserve(state, String(exec.callId), sessionId, digest)
      const combined = downstream.kind === 'ask' && typeof downstream.reason === 'string' && downstream.reason.length > 0
        ? `${reason} (also: ${downstream.reason})`
        : reason
      appendEvent(agent, { kind: 'escalation', class: entry.class, tool: exec.name, digest, ts: Date.now() })
      return { kind: 'ask', reason: combined, displayReason: { en: combined } }
    } catch (error: unknown) {
      ctx.logger.debug(`retry-attendant: pre-execute degraded to passthrough: ${String(error)}`)
      // Release anything we set; delegate if we never did.
      if (bitSet && entry !== undefined) delete entry.askInFlight
      if (!delegated) {
        try {
          return await next()
        } catch (nested: unknown) {
          ctx.logger.debug(`retry-attendant: pre-execute delegation also failed: ${String(nested)}`)
          return { kind: 'allow' }
        }
      }
      return { kind: 'allow' }
    }
  }, { prepend: true })

  // --- Resolution seam (i): observe-only dispatch evidence, passthrough ---
  ctx.on('tools/execute', async (exec, next) => {
    try {
      consumeDispatch(stateFor(), String(exec.callId))
    } catch (error: unknown) {
      ctx.logger.debug(`retry-attendant: dispatch tracking failed: ${String(error)}`)
    }
    return next()
  })

  // --- Resolution seam (ii): terminal release on the frozen final outcome ---
  ctx.on('tools/result', (exec) => {
    try {
      releaseReservation(stateFor(), String(exec.callId))
    } catch (error: unknown) {
      ctx.logger.debug(`retry-attendant: result release failed: ${String(error)}`)
    }
  })

  // --- M1 guidance + M2 set/clear: post-execute, default priority ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    try {
      return await observe(ctx, stateFor(), exec, result, downstream)
    } catch (error: unknown) {
      // Fail-soft invariant of the seam: a throw here would turn the user's
      // tool result into an error result (data loss).
      ctx.logger.debug(`retry-attendant: post-execute degraded to passthrough: ${String(error)}`)
      return downstream
    }
  })
}

/** M1/M2 post-execute body: guidance append, entry set/clear/check rules. */
async function observe(
  ctx: Context,
  state: RetryState,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  downstream: PostToolDecision,
): Promise<PostToolDecision> {
  const home = dshHomeOf(ctx)
  if (home === undefined) return downstream
  const settings = await readUserSettings(home)
  if (!settings.enabled) return downstream
  const agent = exec.agent
  const sessionId = agent === undefined ? undefined : String(agent.session.header.id)
  const now = Date.now()
  const expireMs = settings.expireMinutes * 60_000
  if (sessionId !== undefined) sweep(state, expireMs, sessionId, now)
  const matched = classify(exec.name, exec.arguments, result)

  if (matched !== undefined) {
    const digest = digestKey(exec.name, exec.arguments)
    // M1: guidance on a FRESH digest only (dedup when a live entry exists).
    const live = sessionId !== undefined ? state.sessions.get(sessionId)?.get(digest) : undefined
    let appended: PostToolDecision | undefined
    if (live === undefined && settings.guidance) {
      appended = { ...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), attendantMessage(matched.guidance)] } as PostToolDecision
      appendEvent(agent, { kind: 'guidance', class: matched.class, tool: exec.name, digest, ts: now })
    }
    // M2 set: M2 classes only (mcp-mutation is M1-only), absent/expired keys only.
    // Recorded regardless of `escalate` — the entry doubles as the guidance
    // dedup marker (§4: guidance fires per fresh digest); only the pre-execute
    // ACT is gated on `escalate`.
    if (sessionId !== undefined && matched.class !== 'mcp-mutation' && live === undefined) {
      const entry: RetryEntry = {
        recordedAt: now,
        class: matched.class,
        tool: exec.name,
        outcomeHead: outcomeHeadOf(result),
      }
      const filePath = filePathOf(exec)
      if (filePath !== undefined) entry.filePath = filePath
      recordEntry(state, sessionId, digest, entry)
    }
    return appended ?? downstream
  }

  // No ambiguous class on this outcome — the clear/check rules (success only).
  if (result.isError || sessionId === undefined) return downstream
  applyDesignatedChecks(state, sessionId, exec, now)
  const digest = digestKey(exec.name, exec.arguments)
  if (state.sessions.get(sessionId)?.has(digest) === true) {
    // Same-digest success matching NO class at all: the effect landed fresh — clear.
    clearEntry(state, sessionId, digest)
  }
  return downstream
}

/** Clear-rule (b): a designated check marks the matching entries `resolved:true`. */
function applyDesignatedChecks(state: RetryState, sessionId: string, exec: ToolExecution, now: number): void {
  const args = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments as Record<string, unknown> : {}
  if (exec.name === 'bash' || exec.name === 'pwsh') {
    const command = typeof args['command'] === 'string' ? args['command'] : ''
    const first = firstShellToken(command)
    const second = secondShellToken(command)
    if (first === 'git' && GIT_CHECK_SUBCOMMANDS.has(second)) {
      resolveEntries(state, sessionId, (entry) => entry.class === 'git-mutation', `git ${second}`, now)
    }
    return
  }
  if (exec.name === 'read') {
    const filePath = typeof args['file_path'] === 'string' ? args['file_path'] : undefined
    if (filePath !== undefined) {
      resolveEntries(state, sessionId, (entry) => entry.class === 'write-partial' && entry.filePath === filePath, `read ${filePath}`, now)
    }
  }
}

/** Escalation ask reason: neutral wording names the check when one resolved the entry. */
function reasonFor(entry: RetryEntry): string {
  if (entry.resolved === true && entry.check !== undefined && entry.checkAt !== undefined) {
    return `identical retry after ${entry.class}; a check (${entry.check}, ${new Date(entry.checkAt).toISOString()}) ran in between — confirm the effect state before re-running`
  }
  return `identical retry of ${entry.tool} after ${entry.class} at ${new Date(entry.recordedAt).toISOString()}`
}

/** Approval-absent fallback advice: the class guidance text, injected directly. */
function injectFallbackAdvice(agent: NonNullable<ToolExecution['agent']>, entry: RetryEntry): void {
  const guidance = CLASS_TABLE.find((row) => row.class === entry.class)?.guidance
  if (guidance === undefined) return
  try {
    agent.inject(attendantMessage(guidance))
  } catch {
    // Inject contract permits disposal to discard pending context — never throw.
  }
}

function outcomeHeadOf(result: Readonly<ToolExecutionResult>): string {
  const text = (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return text.slice(0, 120)
}

function filePathOf(exec: ToolExecution): string | undefined {
  const args = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments as Record<string, unknown> : {}
  const filePath = args['file_path']
  return typeof filePath === 'string' ? filePath : undefined
}
