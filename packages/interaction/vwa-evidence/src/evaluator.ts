/**
 * Turn-stopping evaluator (design docs/plans/2026-10-12-verifiable-workspace-agent.md
 * §4.5) — the SOLE WRITER of the vwa-receipts ledger: extract → gates →
 * coverage/overall → append receipt (write-then-read-back) → maybe sync
 * nudge. Nothing else in this package (or any other) appends rows.
 *
 * Window anchoring (§4.5): from the turn's LAST genuine `user/message`
 * (source absent or `source.kind === 'user'` — completion-gate evaluate.ts:91-95
 * pattern) through the `assistant/message` with `data.turn === payload.turn`.
 * Never by turn boundary: `turn/start` precedes the turn's own user message
 * (agent.ts:305 vs :419-422), so turn boundaries would wrap the previous
 * turn's events. The turn guard (aborted/errored turn ⇒ no `assistant/message`
 * with this `data.turn`, and an `interrupted: true` tail is treated as an
 * abort too) makes the round produce NO receipt and prevents substituting an
 * older turn's tail message.
 *
 * Restart recovery (§4.5): pending artifacts = session-wide paths hit by
 * EDITING_TOOLS with no ledger row whose `artifactHash` matches the current
 * file; they join the window set so the next turn-stopping re-evaluates
 * them. Consumed nudge budget is recovered from the ledger projection
 * (`nudge.round > 0` rows, §4.1), mirrored by a process-local latch so a
 * swallowed append cannot re-arm the gate (completion-gate evaluate.ts:203-208).
 *
 * Self-repair re-evaluation needs no extra mechanism: the nudge is a
 * same-turn synchronous inject whose message is NOT a genuine user message
 * (source.kind = 'vwa-evidence'), so the window anchor stays on the real
 * user's message and the continuation's edits land inside the same window;
 * the re-run writes a second receipt. Per-artifact-per-turn ≤ 1 means the
 * still-failing re-evaluation lands its fail/abstained receipt and the
 * in-text abstain note stands — NO delivery blocking in v1 (§4.5/§5).
 *
 * Time correlation (§4.5, notes only — see README): row identity is the
 * triple (artifactPath, event seq)/bootId/appendedAt with the
 * "largest appendedAt ≤ event time" selection rule; this module keeps
 * last-row-per-path selection ({@link staleAgainst}), which is the same
 * rule on the session's monotonic event order.
 *
 * @module @dsh-cc/vwa-evidence/evaluator
 */

import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readJsonl } from '@dsh-cc/sidecar-io'
import type { Executor } from './gates.ts'
import { evaluateArtifact, type EvaluationResult } from './pipeline.ts'
import {
  nudgeBudgetConsumed,
  receiptLedgerPath,
  sha256Hex,
  staleAgainst,
  writeReceipt,
  type AnyReceiptRow,
} from './receipt.ts'
import { boundArtifactMap, evaluateBoundArtifact } from './bound-eval.ts'
import type { VwaArgumentDeliveryProvider } from './vwa-delivery.ts'
import { isWhitelistedRel } from './verify.ts'
import type { VwaEvidenceSettings } from './settings.ts'

/**
 * Runtime editing tool names, lowercase (post-edit-verify wiring.ts:20 —
 * that Set is not exported, so this is a local copy with the provenance
 * pinned here; `multi_edit` does not exist).
 */
const EDITING_TOOLS = new Set(['edit', 'write'])

/** The injected nudge user-message source kind (own named kind). */
export const VWA_EVIDENCE_SOURCE_KIND = 'vwa-evidence'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The turn-stopping evaluator's injected self-repair nudge. */
    'vwa-evidence': { readonly kind: 'vwa-evidence' }
  }
}

/** One session-view event (structural minimum; order is array order). */
export interface EvalEvent {
  type: string
  data: any
}

/** Structural minimum of the Session face used by the evaluator. */
export interface EvalSession {
  header?: { id?: unknown }
  snapshotEvents(): readonly EvalEvent[]
}

/** Structural minimum of the turn-stopping payload's agent face. */
export interface EvalAgent {
  session: EvalSession
  inject?(message: unknown): void
}

/** Process-local nudge state: the durable projection's latch mirror + per-turn caps. */
export interface EvaluatorState {
  /** sessionId → nudges fired this process (max with the ledger projection). */
  latch: Map<string, number>
  /** `${sessionId}|${turn}` → nudges fired this turn (cap 2, §4.5). */
  perTurn: Map<string, number>
  /** `${sessionId}|${turn}|${artifactPath}` — per-artifact-per-turn cap 1 (§4.5). */
  perArtifact: Set<string>
}

export function createEvaluatorState(): EvaluatorState {
  return { latch: new Map(), perTurn: new Map(), perArtifact: new Set() }
}

export interface EvaluateTurnOptions {
  agent: EvalAgent
  turn: number
  settings: VwaEvidenceSettings
  /** Session workspace root (the session cwd). */
  workspaceRoot: string
  exec: Executor
  /** Harness home; the ledger lives under it. Undefined ⇒ skip (nothing durable). */
  dshHome: string | undefined
  state: EvaluatorState
  debug(message: string): void
  now?: () => number | undefined
  /** Abort signal of the turn (payload.signal): an abort discards the round. */
  signal?: AbortSignal | undefined
  /**
   * The vwa-argument delivery provider (§16.2), resolved duck-typed per
   * dispatch. Undefined / absent service ⇒ lane-1-only (v1 path unchanged).
   */
  deliveryProvider?: VwaArgumentDeliveryProvider | undefined
}

export type TurnOutcome =
  | { action: 'skip'; reason: string }
  | { action: 'receipts'; receipts: number }
  | { action: 'nudge'; receipts: number; nudged: string[] }

/** The genuine-user predicate (completion-gate evaluate.ts:91-95 pattern). */
export function isGenuineUser(event: EvalEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data?.source
  return source === undefined || source === null || source.kind === 'user'
}

/**
 * Index of the final `assistant/message` with `data.turn === turn` whose
 * stream was not cut by an abort (`interrupted: true`), or -1 (§4.5 turn
 * guard: an aborted/errored turn must not recycle an earlier turn's tail).
 */
export function findJudgedMessage(events: readonly EvalEvent[], turn: number): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'assistant/message' && event.data?.turn === turn && event.data?.interrupted !== true) return i
  }
  return -1
}

/** Index of the last genuine `user/message` before `before`, or -1 (§4.5 anchor). */
export function windowStartIndex(events: readonly EvalEvent[], before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    if (isGenuineUser(events[i]!)) return i
  }
  return -1
}

/** The edited file path of one `tool/call` event, or undefined. */
export function editedPathOf(event: EvalEvent): string | undefined {
  if (event.type !== 'tool/call' || !EDITING_TOOLS.has(event.data?.name)) return undefined
  let args: unknown
  try {
    args = JSON.parse(event.data?.arguments ?? '{}')
  } catch {
    return undefined
  }
  const path = (args as Record<string, unknown>)?.file_path ?? (args as Record<string, unknown>)?.notebook_path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

/** Edited paths of events[start..end] (inclusive), resolved against the workspace root. */
export function editedPaths(events: readonly EvalEvent[], start: number, end: number, workspaceRoot: string): string[] {
  const out: string[] = []
  for (let i = Math.max(start, 0); i <= Math.min(end, events.length - 1); i++) {
    const raw = editedPathOf(events[i]!)
    if (raw === undefined) continue
    out.push(isAbsolute(raw) ? raw : join(workspaceRoot, raw))
  }
  return out
}

/** Whitelist ∩ inside-workspace filter (§4.3): realpath must stay under realpath(workspace). */
async function insideWhitelist(absolutePath: string, workspaceRoot: string): Promise<string | undefined> {
  const rootReal = await realpath(workspaceRoot).catch(() => workspaceRoot)
  const targetReal = await realpath(absolutePath).catch(() => undefined)
  if (targetReal === undefined) return undefined
  const rel = relative(rootReal, targetReal)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep + '..')) return undefined
  return isWhitelistedRel(rel.split(sep).join('/')) ? targetReal : undefined
}

/** Realpath-deduped artifact set (§4.3); the ORIGINAL path is kept so artifactId
 * and the gates' join stay rooted at the caller's workspaceRoot. */
async function deriveArtifacts(
  paths: readonly string[],
  workspaceRoot: string,
): Promise<string[]> {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const ok = await insideWhitelist(path, workspaceRoot)
    if (ok === undefined || seen.has(ok)) continue
    seen.add(ok)
    out.push(path)
  }
  return out.sort()
}

/**
 * Pending recovery replay (§4.5): session-wide edited paths whose latest
 * ledger row does not carry the current content hash (no row at all counts).
 * Replay sources are exactly the doc's two: the session's events (the
 * `tool/call` EDITING_TOOLS hits) and the ledger file on disk.
 */
async function pendingArtifacts(
  allEdits: readonly string[],
  windowSet: ReadonlySet<string>,
  rows: readonly AnyReceiptRow[],
): Promise<string[]> {
  const pending: string[] = []
  for (const path of allEdits) {
    if (windowSet.has(path)) continue
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    if (staleAgainst(rows, path, sha256Hex(text))) pending.push(path)
  }
  return pending
}

/**
 * Run the turn-stopping evaluation for one dispatch. Never throws; failures
 * debug-log. Aborts (`signal.aborted`) discard the round before any write.
 */
export async function evaluateTurnStopping(options: EvaluateTurnOptions): Promise<TurnOutcome> {
  const { settings, state } = options
  const debug = options.debug
  try {
    if (!settings.enabled) return { action: 'skip', reason: 'disabled' }
    if (options.dshHome === undefined) return { action: 'skip', reason: 'no-dsh-home' }
    options.signal?.throwIfAborted()
    const sessionId = typeof options.agent.session.header?.id === 'string' ? options.agent.session.header.id : undefined
    if (sessionId === undefined) return { action: 'skip', reason: 'no-session' }

    const events = options.agent.session.snapshotEvents()
    // Turn guard (§4.5): abort/error turn ⇒ no receipt for this round.
    const judgedIdx = findJudgedMessage(events, options.turn)
    if (judgedIdx < 0) return { action: 'skip', reason: 'turn-guard' }
    const startIdx = windowStartIndex(events, judgedIdx)

    // Artifact set (§4.3): window edits ∪ pending-recovery replay, realpath-deduped,
    // whitelist ∩ inside-workspace filtered.
    const windowEdits = editedPaths(events, startIdx + 1, judgedIdx, options.workspaceRoot)
    const ledgerPath = receiptLedgerPath(options.dshHome, sessionId)
    // Discriminated union read (§16.1): callers filter by row.v; nothing
    // here casts the whole ledger to v1.
    const rows = (await readJsonl<unknown>(ledgerPath).catch(() => [] as unknown[])) as AnyReceiptRow[]
    // Bound lane-2 artifacts (§16.2 step 2): editing paths ∪ project-bound
    // artifacts ∪ pending, deduped by realpath. No pointer / provider ⇒ lane 1 only.
    const bound = boundArtifactMap(options, events, debug)
    const windowArtifacts = await deriveArtifacts(windowEdits, options.workspaceRoot)
    const pending = await pendingArtifacts(
      editedPaths(events, 0, events.length - 1, options.workspaceRoot),
      new Set(windowEdits),
      rows,
    )
    const artifacts = await deriveArtifacts(
      [...windowArtifacts, ...pending, ...[...bound.values()].map(entry => entry.absolutePath)],
      options.workspaceRoot,
    )
    if (artifacts.length === 0) return { action: 'skip', reason: 'no-artifacts' }

    const turnKey = `${sessionId}|${options.turn}`
    let receipts = 0
    const nudged: string[] = []
    for (const artifactPath of artifacts) {
      options.signal?.throwIfAborted()
      const realKey = await realpath(artifactPath).catch(() => artifactPath)
      const boundEntry = bound.get(realKey) ?? bound.get(artifactPath)
      if (boundEntry !== undefined) {
        // §16.2 lane-2 path: the vwa-argument provider owns the checks.
        const outcome = await evaluateBoundArtifact(options, {
          sessionId, turnKey, ledgerPath, rows, events, artifactPath, boundEntry,
        })
        if (outcome.receiptWritten) receipts++
        if (outcome.nudged) nudged.push(outcome.artifactId)
        continue
      }
      let text: string
      try {
        text = await readFile(artifactPath, 'utf8')
      } catch (error: unknown) {
        debug(`vwa-evidence: artifact unreadable: ${artifactPath}: ${String(error)}`)
        continue
      }
      let result: EvaluationResult
      try {
        result = await evaluateArtifact({
          sessionId,
          artifactPath,
          text,
          workspaceRoot: options.workspaceRoot,
          exec: options.exec,
          gates: { timeoutMs: settings['gate-timeout-ms'] },
          ...(options.now === undefined ? {} : { now: options.now() }),
        })
      } catch (error: unknown) {
        debug(`vwa-evidence: evaluation failed for ${artifactPath}: ${String(error)}`)
        continue
      }
      // Nudge trigger (§4.5): fires on overall=fail (any gate fail or an
      // out-of-bounds claim) and on overall=pass with coverage below the
      // threshold. `abstained` (zero detected claims, no gate failures) does
      // NOT nudge: a no-claim document has no valid self-repair target, and
      // prompting there would nag every plain-doc turn. (Orchestrator
      // adjudication over the literal "overall ≠ pass" reading; disclosed in
      // the PR and consistent with §4.1's abstained semantics.)
      const trigger = result.overall === 'fail'
        || (result.overall === 'pass' && result.coverage !== null && result.coverage < settings['coverage-threshold'])
      // Budgets (§4.5): per artifact per turn ≤ 1, per turn ≤ 2, per session
      // nudge-budget. Session consumption = ledger projection (round > 0
      // rows) maxed with the process latch — a restart does NOT reset it.
      const artifactKey = `${turnKey}|${artifactPath}`
      const sessionSpent = Math.max(nudgeBudgetConsumed(rows), state.latch.get(sessionId) ?? 0)
      const fire = trigger
        && !state.perArtifact.has(artifactKey)
        && (state.perTurn.get(turnKey) ?? 0) < 2
        && sessionSpent < settings['nudge-budget']
      if (fire) {
        state.perArtifact.add(artifactKey)
        state.perTurn.set(turnKey, (state.perTurn.get(turnKey) ?? 0) + 1)
        state.latch.set(sessionId, Math.max(state.latch.get(sessionId) ?? 0, sessionSpent) + 1)
        result.row.nudge.round = 1
        nudged.push(result.row.artifactId)
      }
      // Write-then-read-back (§4.1); the write is best-effort, never fatal.
      const written = await writeReceipt(ledgerPath, result.row)
      if (!written.ok) debug(`vwa-evidence: receipt read-back failed for ${artifactPath}: ${written.detail ?? '?'}`)
      else receipts++
      if (fire) injectNudge(options.agent, result, settings['coverage-threshold'], debug)
    }
    if (nudged.length > 0) return { action: 'nudge', receipts, nudged }
    return { action: 'receipts', receipts }
  } catch (error: unknown) {
    debug(`vwa-evidence: turn-stopping evaluation failed: ${String(error)}`)
    return { action: 'skip', reason: 'error' }
  }
}

/** Synchronous inject (completion-gate evaluate.ts:222-233 shape, §4.5). */
function injectNudge(agent: EvalAgent, result: EvaluationResult, threshold: number, debug: (m: string) => void): void {
  const coverage = result.coverage === null ? 'n/a' : result.coverage.toFixed(2)
  const gateFails = result.row.gates.filter(g => g.status === 'fail').map(g => `gate ${g.gate}: ${g.detail ?? 'failed'}`)
  const outOfBounds = result.row.claims.filter(c => c.status === 'out-of-bounds').length
  const parts = [
    `VWA evidence: ${result.row.artifactId} does not fully verify (overall ${result.overall}, coverage ${coverage}, threshold ${threshold}).`,
    gateFails.length > 0 ? gateFails.join('; ') : '',
    outOfBounds > 0 ? `${outOfBounds} out-of-bounds claim marker(s).` : '',
    'Self-repair once: fix the failing constructs or backfill 〔src:ws:...〕 markers citing workspace files, then continue. (vwa-evidence)',
  ].filter(s => s !== '')
  try {
    agent.inject?.(createUserMessage({
      content: [{ type: 'text', text: parts.join(' ') }],
      source: { kind: VWA_EVIDENCE_SOURCE_KIND },
    }))
  } catch (error: unknown) {
    debug(`vwa-evidence: inject failed: ${String(error)}`)
  }
}
