/**
 * Evidence-preserving reducer (plan §3.1-§3.3, §3.7): the escalation stage
 * between the deterministic route and the passthrough decision. One cheap-lane
 * side query extracts a receipt from the (possibly truncated) tool output
 * view; a deterministic verifier (verifier.ts) gates the replacement; ANY
 * failure — eligibility, lane provenance, timeout, malformed JSON, failed
 * verification — returns `undefined` so the caller passes the ORIGINAL bytes
 * through untouched (never the deterministic route's sub-threshold candidate).
 *
 * Fail-soft is the hard invariant: this stage never throws (the caller's
 * waterfall try/catch is the backstop, and the stage also guards internally).
 *
 * @module @dsh-cc/context-crusher/reducer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@dsh-cc/tools'
import { resolveAlias } from '@dsh-cc/model-aliases'
import { runSideQuery } from '@dsh-cc/side-query'
import { buildMarker } from './marker.ts'
import { parseReceipt, renderReceipt } from './receipt.ts'
import { verifyReceipt } from './verifier.ts'
import type { CrusherMode, LedgerRow, ResolvedConfig } from './types.ts'

/** Tools whose invocation command line is reducer-eligible (§3.2). */
export const REDUCER_COMMAND_TOOLS: readonly string[] = ['bash']

/**
 * System prompt for the extraction side query (§3.3, §3.7): pure extraction,
 * no inference, no advice, strict JSON only. The prompt NEVER embeds the
 * user's task or conversation history — only the single tool output view.
 */
const REDUCER_SYSTEM = [
  'You extract evidence from tool output. Pure extraction only: never infer,',
  'never diagnose, never advise. Every "evidence" and "key_output" string MUST',
  'be copied verbatim from the tool output (no paraphrase, no trimming).',
  'Output ONLY strict JSON — no prose, no code fences — matching exactly:',
  '{"v":1,"cmd":"first line of the invocation","exit":{"ok":boolean,',
  '"code":number only when the output states an exit code},"failures":',
  '[{"name":"test/file identifier","evidence":"exact quote from the output"}],',
  '"key_output":["exact quote", up to 8 entries],"counts":',
  '{"pass":number,"fail":number,"skip":number} only when the counts are stated}.',
  '"failures" is empty on success; omit "counts" when unknowable.',
].join('\n')

/** Executed command line of a tool invocation, when it is a string (§3.2). */
export function invocationCommand(exec: ToolExecution): string | undefined {
  const args = exec.arguments as Record<string, unknown> | null | undefined
  const command = args === null || typeof args !== 'object' ? undefined : args.command
  return typeof command === 'string' && command.length > 0 ? command : undefined
}

/** §3.2 eligibility: command surface, configured patterns, flag. */
export function isReducerEligible(cfg: ResolvedConfig, exec: ToolExecution): boolean {
  if (!cfg.reducerEnabled) return false
  if (!REDUCER_COMMAND_TOOLS.includes(exec.name)) return false
  const command = invocationCommand(exec)
  if (command === undefined) return false
  return cfg.reducerCommands.some((pattern) => pattern.test(command))
}

/**
 * Head/tail truncation for oversized sources (§3.3): the view budget is the
 * `reducerMaxInputTokens` cap, split ~20% head / ~80% tail of lines (build
 * and test failures concentrate at the tail).
 */
// ponytail: per-line token cost is a linear average, not per-line estimates;
// if real logs skew the split, switch to incremental estimation.
export function truncateView(text: string, maxTokens: number, estimate: (text: string) => number): string {
  if (estimate(text) <= maxTokens) return text
  const lines = text.split('\n')
  if (lines.length < 2) return text
  const tokensPerLine = Math.max(estimate(text) / lines.length, 0.01)
  const headCount = Math.max(1, Math.floor((0.2 * maxTokens) / tokensPerLine))
  const tailCount = Math.max(1, Math.floor((0.8 * maxTokens) / tokensPerLine))
  if (headCount + tailCount >= lines.length) return text
  return [...lines.slice(0, headCount), ...lines.slice(lines.length - tailCount)].join('\n')
}

/** Side-query failure reason → ledger reason (§3.7 fail-mode: passthrough). */
function laneReason(reason: 'unrouted' | 'timeout' | 'error' | 'empty'): string {
  switch (reason) {
    case 'unrouted': return 'lane-missing'
    case 'timeout': return 'lane-timeout'
    case 'empty': return 'malformed'
    case 'error': return 'lane-error'
  }
}

export interface ReducerStageDeps {
  ctx: Context
  cfg: ResolvedConfig
  exec: ToolExecution
  originalText: string
  tokensBefore: number
  isError: boolean
  estimate: (text: string) => number
  projectKey: string | undefined
  mode: CrusherMode
  /** Store write for the full original text (only called in `on` mode). */
  put: (projectKey: string, text: string) => Promise<string>
  ledgerRow: (row: Omit<LedgerRow, 'ts' | 'sessionId' | 'tool'>) => Promise<void>
}

/**
 * Run one reducer attempt. Returns the replacement text
 * (`renderReceipt` + the verbatim pinned `buildMarker` line as the LAST
 * line), or `undefined` = passthrough the original bytes. Every rejection is
 * ledgered `applied:false` with a reason (§3.4, §3.7); the deterministic
 * route's sub-threshold candidate is never mixed in.
 */
export async function reduceToolOutput(deps: ReducerStageDeps): Promise<string | undefined> {
  try {
    if (!isReducerEligible(deps.cfg, deps.exec)) return undefined
    const { originalText, tokensBefore } = deps
    const ledger = async (
      applied: boolean,
      tokensAfter: number,
      reason?: string,
      hash?: string,
      charsAfter?: number,
    ): Promise<void> => {
      await deps.ledgerRow({
        kind: 'receipt',
        charsBefore: originalText.length,
        charsAfter: charsAfter ?? receiptBodyRef.length,
        tokensBefore,
        tokensAfter,
        applied,
        ...(reason === undefined ? {} : { reason }),
        ...(hash === undefined ? {} : { hash }),
      })
    }

    // The extraction view: the full text under the input cap, else head/tail.
    // Verifier quotes are checked against this SAME view (§3.3).
    const view = truncateView(originalText, deps.cfg.reducerMaxInputTokens, deps.estimate)
    let receiptBodyRef = ''

    // Lane provenance pre-check: resolve the reducer alias ourselves so the
    // string-form (model-only) alias hole — `toOneShotRoute` fills the
    // provider from the parent request — never bills the parent route (§3.3).
    const agent = deps.exec.agent
    if (agent === undefined) {
      await ledger(false, 0, 'lane-missing')
      return undefined
    }
    const route = resolveAlias(deps.ctx, deps.cfg.reducerAlias)
    if (route === undefined) {
      // Unconfigured alias: the side query would return 'unrouted' anyway;
      // decline here so no model call is attempted at all (§4 test b).
      await ledger(false, 0, 'lane-missing')
      return undefined
    }
    if (route.provider === undefined || route.provider.length === 0) {
      await ledger(false, 0, 'lane-inherited')
      return undefined
    }

    const side = await runSideQuery(deps.ctx, {
      agent,
      alias: deps.cfg.reducerAlias,
      onUnrouted: 'skip', // mandatory: an unrouted alias never bills the parent route
      rejectToolCalls: true, // llm.stream-class: no tools, no seeds (§3.7)
      system: REDUCER_SYSTEM,
      prompt: [
        'Reduce the following tool output into the receipt JSON described in the system prompt.',
        'The output is the complete and only source; quote from it verbatim.',
        '--- tool output start ---',
        view,
        '--- tool output end ---',
      ].join('\n'),
      maxTokens: deps.cfg.reducerMaxTokens,
      timeoutMs: deps.cfg.reducerTimeoutMs,
    })
    if (!side.ok) {
      await ledger(false, 0, laneReason(side.reason))
      return undefined
    }
    // Defense in depth for the inherited-route hole: side-query provenance.
    if (side.inheritedRoute) {
      await ledger(false, 0, 'lane-inherited')
      return undefined
    }

    let raw: unknown
    try {
      raw = JSON.parse(side.text)
    } catch {
      await ledger(false, 0, 'malformed')
      return undefined
    }
    const receipt = parseReceipt(raw)
    if (receipt === null) {
      await ledger(false, 0, 'malformed')
      return undefined
    }
    receiptBodyRef = renderReceipt(receipt)

    // Verify against the SAME view used for extraction (§3.4).
    const verdict = verifyReceipt(view, receipt, deps.isError, deps.estimate, {
      minSavingsRatio: deps.cfg.reducerMinSavingsRatio,
    })
    if (!verdict.ok) {
      const tokensAfter = deps.estimate(receiptBodyRef)
      await ledger(false, tokensAfter, `verify:${verdict.reason}`, undefined, receiptBodyRef.length)
      return undefined
    }

    const tokensAfter = deps.estimate(receiptBodyRef)
    if (deps.mode !== 'on') {
      // Dry-run (§3.6): produce + verify only — no store.put, no substitution.
      await ledger(false, tokensAfter, undefined, undefined, receiptBodyRef.length)
      return undefined
    }
    if (deps.projectKey === undefined) return undefined

    // The FULL original text goes to the store, never the truncated view.
    const hash = await deps.put(deps.projectKey, originalText)
    // The LAST line is the verbatim pinned marker contract (§3.5): TUS
    // isCrusherStub and the microcompact guard recognize it unchanged.
    const replacementText = `${receiptBodyRef}\n${buildMarker(tokensBefore, tokensAfter, hash)}`
    await ledger(true, tokensAfter, undefined, hash, replacementText.length)
    return replacementText
  } catch (error: unknown) {
    // Fail-soft (§3.7): any internal throw degrades to unchanged passthrough.
    deps.ctx.logger.warn(`context-crusher: reducer stage degraded to passthrough: ${String(error)}`)
    return undefined
  }
}

