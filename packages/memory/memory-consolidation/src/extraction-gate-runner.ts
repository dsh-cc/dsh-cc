/**
 * The single-window gate call and the window reconstruction around it (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Building a
 * complete window from the event watermark", §"Questions and answer contract",
 * §"Preset wiring (root-realm bridge)").
 *
 * Everything here is one-shot by construction:
 * - the window is rebuilt from a live snapshot plus one index read, with the
 *   configured budgets, so an over-budget or unreconstructable material set can
 *   only ever fall back to extraction;
 * - the scope comes from `bound.scope(throughInclusive)` — never hand-built —
 *   and an unusable runner/scope is `unavailable`, which extracts;
 * - the gate is called AT MOST ONCE per window, and no fault is retried.
 *
 * @module @dsh-cc/memory-consolidation/extraction-gate-runner
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BoundDecisionRunner, DecisionScope } from '@dsh-cc/systemone'
import { createExtractionDecisionGate } from './extraction-gate.ts'
import type { ExtractionDecisionSettings, ExtractionSettingsReader } from './extraction-settings.ts'
import {
  buildExtractionWindow,
  type ExtractionWindow,
  type GateVerdict,
  type IndexSnapshot,
} from './extraction-window.ts'

/** The gate's outcome plus the identity a skip commit must re-verify. */
export interface GateOutcome {
  readonly verdict: GateVerdict
  /** The bound runner the answer came from (`undefined` ⇒ nothing was asked). */
  readonly runner?: BoundDecisionRunner | undefined
  /** The scope minted for this window (`undefined` ⇒ nothing was asked). */
  readonly scope?: DecisionScope | undefined
}

/** What one window reconstruction needs. */
export interface WindowBuildInput {
  /** The Agent whose session snapshot is reviewed. */
  readonly agent: Agent
  /** Review watermark, exclusive. */
  readonly from: number
  /** Captured evidence head, inclusive. */
  readonly through: number
  /** The index snapshot from the current read. */
  readonly index: IndexSnapshot
  /** The live settings snapshot (budgets). */
  readonly settings: ExtractionDecisionSettings
}

/** What one gate call needs. */
export interface GateCallInput {
  /** The Agent whose session is under review. */
  readonly agent: Agent
  /** The complete review window. */
  readonly window: ExtractionWindow
  /** The captured evidence head (the authoritative scope's origin). */
  readonly through: number
  /** Cancellation from Agent/plugin disposal, a scope change or a takeover. */
  readonly signal: AbortSignal
  /** Per-gate runner resolution (root-realm bridge; never cached). */
  readonly resolveRunner?: (agent: Agent) => BoundDecisionRunner | undefined
  /** Live settings (mode, route alias, timeout, answer budget). */
  readonly readSettings: ExtractionSettingsReader
}

/**
 * Build one extraction window with the configured budgets.
 * @param input - the snapshot, watermark, head, index and budgets.
 * @returns the window (complete only when it may be sent to the decision model).
 */
export function buildWindowFor(input: WindowBuildInput): ExtractionWindow {
  return buildExtractionWindow({
    events: input.agent.session.snapshotEvents(),
    reviewedThrough: input.from,
    capturedHead: input.through,
    index: input.index,
    maxSurfaceEvents: input.settings.maxSurfaceEvents,
    maxStateBytes: input.settings.maxStateBytes,
    maxInputTokens: input.settings.maxInputTokens,
  })
}

/**
 * Mint the authoritative scope for one window end; `undefined` when the bound
 * runner refuses (a fabricated scope is never acceptable).
 * @param runner - the bound runner.
 * @param through - the captured evidence head.
 * @returns the scope, or `undefined`.
 */
export function mintScope(runner: BoundDecisionRunner, through: number): DecisionScope | undefined {
  try {
    const scope = runner.scope(through) as DecisionScope | undefined
    return scope === undefined || scope === null ? undefined : scope
  } catch {
    return undefined
  }
}

/**
 * Ask the gate once for one window.
 *
 * An incomplete or over-budget window is never sent (the legacy whole-session
 * prompt is its only path), a missing runner or scope is `unavailable`, and the
 * decision itself is never retried.
 * @param input - the Agent, the window, the head and the live seams.
 * @returns the outcome, with the runner/scope when the gate was actually asked.
 */
export async function decideWindow(input: GateCallInput): Promise<GateOutcome> {
  if (!input.window.complete) {
    return { verdict: { kind: 'extract', reason: input.window.extractReason ?? 'incomplete' } }
  }
  const runner = input.resolveRunner?.(input.agent)
  if (runner === undefined) return { verdict: { kind: 'extract', reason: 'unavailable' } }
  const scope = mintScope(runner, input.through)
  if (scope === undefined) return { verdict: { kind: 'extract', reason: 'unavailable' } }
  const gate = createExtractionDecisionGate({ runner, readSettings: input.readSettings })
  const verdict = await gate.decide(input.window, scope, input.signal)
  return { verdict, runner, scope }
}
