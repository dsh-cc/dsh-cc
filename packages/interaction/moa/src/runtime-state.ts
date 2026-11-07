/**
 * Shared moa runtime state (effective-model-truth design §5.1/§5.2;
 * harness-0.2.2 provenance-r3-final redesign).
 *
 * Side-effect-free module: importing it NEVER pulls the plugin `apply()`
 * path — `@dsh-cc/moa/sanitizer` (sanitizer.ts) imports this module, and the
 * subpath export's import graph must stay free of the plugin mount. The
 * plugin `apply()` (index.ts) populates `arming`/`validation` via
 * `setRuntimeCore`; every accessor below degrades to an inert value (false /
 * undefined / no-op) while the plugin is absent, never throwing.
 *
 * DELIBERATE ASYMMETRY — do not "fix": the published per-step selection is
 * PER-AGENT (each agent's frozen `payload.modelSelection` snapshot is its
 * own), while the boot pair is PROCESS-GLOBAL first-wins (the arming
 * machine's and the sanitizer's shared baseline is the session's boot
 * selection, one per process). Different lifecycles, different keys (design
 * §3/§5.1/§5.2).
 *
 * Provenance (r3-final): arming is signal-driven — the driver's `/model` /
 * `/effort` writes call {@link noteUserSelection} (which also writes the
 * routing.jsonl `user-select` sidecar row); moa's own selects call
 * {@link noteMoaSelection}. The entry-point admission seam reaches the live
 * router through {@link routeBeforeAdmission} (registered per `apply()` via
 * `setMoaAdmissionEntry`).
 *
 * @module
 */

import { ArmingMachine, type ProvenanceSelection, type RequestPair } from './arming.ts'
import { isSubagentAgent } from './agent-scope.ts'
import { appendJsonl } from '@dsh-cc/sidecar-io'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

export type { RequestPair }
export type { ProvenanceSelection }

/** Field comparison (provider/model) — NEVER object identity (design §3). */
export function sameFields(a: RequestPair, b: RequestPair): boolean {
  return a.provider === b.provider && a.model === b.model
}

/** Maximum simultaneously-captured turns (effective-model-truth §5.3). */
export const CAPTURE_CAPACITY = 8

/** Bounded FIFO per-turn capture (effective-model-truth §5.3): the LAST
 * claimed message of a turn wins (the claim batch claims pending next-step
 * items first, then the next-turn message). */
const captured = new Map<number, UserMessage>()

/**
 * Record one claimed message (the `agent/inbox/claimed` listener, per-message
 * emit). Subagent-guarded: child turn numbers restart at 1, so an unguarded
 * child would shadow the root's slot (see agent-scope.ts).
 */
export function captureClaimed(agent: unknown, message: UserMessage, turn: number): void {
  if (isSubagentAgent(agent)) return
  captured.set(turn, message)
  while (captured.size > CAPTURE_CAPACITY) {
    const oldest = captured.keys().next().value
    if (oldest === undefined) break
    captured.delete(oldest)
  }
}

/** The captured opening message for a turn, or undefined. */
export function getCapturedOpening(turnId: number): UserMessage | undefined {
  return captured.get(turnId)
}

let lastClaimedTurn: number | undefined

/** Track the last claimed turn (subagent-guarded on write; §5.3). */
export function noteClaimedTurn(agent: unknown, turn: number): void {
  if (isSubagentAgent(agent)) return
  lastClaimedTurn = turn
}

/** The LAST turn seen by the `agent/inbox/claimed` listener. */
export function currentClaimedTurn(): number | undefined {
  return lastClaimedTurn
}

/** The sticky per-turn tier decision (§5.3). */
export interface TurnTier {
  turn: number
  tier: number
  /** True for moa-escalation openings: NO queued row (§3.5 single-row). */
  suppressRow?: boolean
}

let turnTier: TurnTier | undefined

/** Store the whole-turn tier decision (classification seam, §5.3). */
export function setTurnTier(entry: TurnTier): void {
  turnTier = entry
}

export function getTurnTier(): TurnTier | undefined {
  return turnTier
}

/** The decided tier for a turn, or undefined (judge deps seam). */
export function tierFor(turnId: number): number | undefined {
  return turnTier !== undefined && turnTier.turn === turnId ? turnTier.tier : undefined
}

/** Queued status rows, delivered by the next main-agent pre-step (§3.1).
 * `model` (when present) is the effective model id the overlay resolves to
 * (effective-model-truth §5.4 — carried on the notice source). */
const pendingRows: { text: string; tier?: number; model?: string }[] = []

/** Queue one status row (called from the assemble waterfall). */
export function queueMoaRow(text: string, tier?: number, model?: string): void {
  pendingRows.push({ text, ...(tier === undefined ? {} : { tier }), ...(model === undefined ? {} : { model }) })
}

/** Drain the queued rows (the pre-step splice). */
export function spliceMoaRows(): { text: string; tier?: number; model?: string }[] {
  return pendingRows.splice(0)
}

/** Clear un-delivered rows (request clause 5 skips withTier → the queued row
 * would advertise a tier that was not applied). */
export function clearMoaRows(): void {
  pendingRows.length = 0
}

/** Minimal structural shape of the shared arming validation ref. */
export interface RuntimeValidation {
  ok: boolean
  reason?: string
  /**
   * The enabled-but-unarmed reason (scope-aware-listeners §4): set by `tryArm`
   * on every failure while `moa.enabled`, cleared on arming success. NEVER set
   * for `moa disabled` — the default-off population stays silent.
   */
  unarmedReason?: string | undefined
}

let arming: ArmingMachine | undefined
let validation: RuntimeValidation | undefined
const publishedSelection = new WeakMap<object, RequestPair>()

/** Populate the live plugin core (called by `apply()` in index.ts). */
export function setRuntimeCore(parts: { arming: ArmingMachine; validation: RuntimeValidation }): void {
  arming = parts.arming
  validation = parts.validation
}

/** Drop the live plugin core (test seam / hot reload): also drops the
 * per-turn capture, claimed-turn, sticky-tier, and pending-row slots. */
export function resetRuntimeCore(): void {
  arming = undefined
  validation = undefined
  captured.clear()
  lastClaimedTurn = undefined
  turnTier = undefined
  pendingRows.length = 0
  admissionEntry = undefined
  tripwireViolations.length = 0
}

/** First non-undefined pair wins, never overwritten (design §5.2 part 1). */
export function noteBootPair(pair: RequestPair | undefined): void {
  arming?.noteBootPair(pair)
}

/** The shared boot pair, or undefined when the plugin is not applied. */
export function moaBootDefault(): RequestPair | undefined {
  return arming?.getBootDefaultModel()
}

/** `validation.ok && arming.isArmed()`; false (never throws) when not applied. */
export function moaOverlayActive(): boolean {
  return validation?.ok === true && (arming?.isArmed() ?? false)
}

/**
 * The enabled-but-unarmed reason, or undefined when armed, disabled, or not
 * applied (§4 visibility). The statusline tap renders this as `moa:unarmed — …`.
 */
export function moaUnarmedReason(): string | undefined {
  return validation?.unarmedReason
}

/** Publish one agent's frozen per-step selection (the sanitizer's pre-step half). */
export function publishLiveSelection(agent: unknown, pair: RequestPair): void {
  if (agent !== null && typeof agent === 'object') publishedSelection.set(agent, pair)
}

/** Read a published per-step selection; undefined in sanitizer-less deployments. */
export function readPublishedSelection(agent: unknown): RequestPair | undefined {
  return agent !== null && typeof agent === 'object' ? publishedSelection.get(agent) : undefined
}

/** Bounded tripwire violation log (spec observability + live console warn). */
const tripwireViolations: string[] = []
const TRIPWIRE_CAPACITY = 32

/** Tripwire findings so far (newest last); cleared with the runtime core. */
export function moaTripwireViolations(): readonly string[] {
  return tripwireViolations
}

/**
 * The sanctioned observation path (r3-final: TRIPWIRE ONLY). Every pre-step
 * frozen-selection observation goes through here: a non-moa, non-boot pair
 * reaching a request without a preceding {@link noteUserSelection} is a
 * bug — recorded and warned, NEVER silently armed/disarmed around (pair
 * inference retired; explicit signals own arming).
 */
export function observeLiveSelection(pair: RequestPair | undefined): void {
  if (pair === undefined || pair.model === undefined || arming === undefined) return
  const violation = arming.observeTripwire(pair)
  if (violation === undefined) return
  tripwireViolations.push(violation)
  if (tripwireViolations.length > TRIPWIRE_CAPACITY) tripwireViolations.shift()
  console.warn(violation)
}

/** Structural provider/model view of a resolved config / selection snapshot. */
export function pairOf(
  source: { provider?: unknown; model?: unknown } | undefined | null,
): RequestPair | undefined {
  if (source === undefined || source === null || source.model === undefined) return undefined
  return {
    ...(source.provider === undefined ? {} : { provider: source.provider as string }),
    model: source.model as string,
  }
}

/** The admission entry one `apply()` registers so entry-point call sites can
 * reach the live router (side-effect-free when absent — a moa-less deployment
 * leaves routing inert). */
interface MoaAdmissionEntry {
  routeBeforeAdmission(agent: unknown, opening: UserMessage): Promise<void>
  /** Routing sidecar accessor for the `user-select` row; absence disables it. */
  ledgerPath(): string | undefined
}

let admissionEntry: MoaAdmissionEntry | undefined

/** Register the live admission entry (called by `apply()` in index.ts). */
export function setMoaAdmissionEntry(entry: MoaAdmissionEntry): void {
  admissionEntry = entry
}

/**
 * The entry-point admission seam (D3.2): every dsh-cc entry point routing a
 * user turn through `agent.followup` awaits this FIRST on the exact
 * `UserMessage`. Side-effect-free when moa is unmounted or disarmed.
 */
export function routeBeforeAdmission(agent: unknown, opening: UserMessage): Promise<void> {
  if (admissionEntry === undefined) return Promise.resolve()
  return admissionEntry.routeBeforeAdmission(agent, opening)
}

/**
 * Explicit USER write signal (r3-final provenance / D3.2): the driver's
 * `/model` AND `/effort` write paths call this with the selection they just
 * recorded. Updates `userBaseSelection` (effort included), disarms (or
 * re-arms on the boot pair — `ModelSwitchBack`), drops any still-queued moa
 * status row (a stale routed row would be a lie), and appends the
 * routing.jsonl `user-select` sidecar row (best-effort; the resume
 * rehydration path freshness-checks it against the durable selection).
 */
export function noteUserSelection(selection: ProvenanceSelection): void {
  arming?.noteUserSelection(selection)
  clearMoaRows()
  const path = admissionEntry?.ledgerPath()
  if (path === undefined) return
  const row: Record<string, unknown> = {
    type: 'user-select',
    ts: new Date().toISOString(),
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
  void appendJsonl(path, row).catch(() => undefined)
}

/** Explicit MOA write signal: the router's routing select and the judge's
 * escalation select call this. NEVER disarms. */
export function noteMoaSelection(selection: ProvenanceSelection): void {
  arming?.noteMoaSelection(selection)
}
