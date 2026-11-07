/**
 * Arming state machine for the MAIN agent (design §3.1 truth table; the
 * harness-0.2.2 provenance-r3-final redesign).
 *
 * Pure and synchronous; the live `moa.enabled` read is injected at
 * construction (settings hot-reload: consumers re-read, the machine follows
 * the getter each time).
 *
 * Provenance (r3-final — EXPLICIT signals, NOT pair inference): arming is
 * driven by two write notifications, never by request-pair comparison:
 * - {@link ArmingMachine.noteUserSelection} — called by the driver's `/model`
 *   AND `/effort` write paths: updates the independently tracked
 *   `userBaseSelection` (pair + effort, so a FailOpenServe restore never
 *   resurrects a stale effort), disarms, and RE-ARMS when the pair equals the
 *   boot pair (the model's `ModelSwitchBack` transition).
 * - {@link ArmingMachine.noteMoaSelection} — called by the router's routing
 *   select and the judge's escalation select: records `lastMoaSelection`,
 *   never disarms.
 * The pre-step observation ({@link ArmingMachine.observeTripwire}) is a
 * TRIPWIRE ONLY: a non-moa, non-boot, non-userBase pair reaching a request
 * without a preceding `noteUserSelection` is a bug — it is reported, never
 * silently armed/disarmed around (observation-based arming could let
 * admission routing overwrite an explicit user choice before disarming).
 *
 * §6 precedence (high→low): explicit /model this session > moa routing >
 * boot default.
 *
 * Single-slot state (`lastSeenBootDefault` style), per review r5: one
 * boot-default pair, no sets.
 *
 * @module
 */

/** A provider+model pair as seen entering the waterfall (pre-override). */
export interface RequestPair {
  provider?: string | undefined
  model?: string | undefined
}

/** A complete selection carried by an explicit write signal (effort included). */
export interface ProvenanceSelection {
  provider: string
  model: string
  reasoningEffort?: string | undefined
}

/** Why the machine disarmed. */
export type DisarmReason = 'explicit-model-switch' | 'resume-unconfirmed'

const same = (a: RequestPair, b: RequestPair): boolean => a.provider === b.provider && a.model === b.model

/**
 * §3.1 truth table, implementable rows (r3-final: rows 3-5 are signal-driven):
 * - `moa.enabled` false → never armed; arming when disabled does nothing.
 * - enabled + no explicit /model → armed on the main agent (boot default
 *   captured from the first observed genuine pair).
 * - enabled + `noteUserSelection(pair)` with pair ≠ boot default → disarmed
 *   until the pair returns to the boot default.
 * - `noteUserSelection(boot pair)` → re-arms (user returned to "no opinion").
 * - Settings flip enabled→true at runtime → arms at the next validation pass
 *   (`arm()`).
 * - Crash/resume: rehydrated from the routing.jsonl sidecar's last row —
 *   `route`/`escalate` ⇒ `lastMoaSelection` (armed); `user-select` ⇒
 *   `userBaseSelection` with armed = (pair equals boot, deferred until the
 *   boot pair is captured); missing/stale ⇒ unarmed-until-boot-pair
 *   (`resume-unconfirmed`).
 */
export class ArmingMachine {
  private bootDefault: RequestPair | undefined
  private armed = false
  private reason: DisarmReason | undefined
  private lastMoa: ProvenanceSelection | undefined
  private userBase: ProvenanceSelection | undefined
  /** A rehydrated user-select awaiting the boot-pair capture for its re-arm check. */
  private deferredSwitchBack = false

  constructor(private readonly isEnabled: () => boolean) {}

  /** Called by the wiring slice at mount when `moa.enabled` reads true. */
  arm(): void {
    if (!this.isEnabled()) return
    // Boot default is captured from the first observed genuine pair, not here.
    if (this.reason === undefined) this.armed = true
  }

  /**
   * First-wins boot-baseline capture (effective-model-truth design §5.2
   * part 1): the first non-undefined pair wins, never overwritten.
   * UNCONDITIONAL — runs regardless of `moa.enabled` so a ship-dark session
   * that later enables still shares one baseline. Also first-wins the
   * `userBaseSelection` (absent any explicit signal the boot pair IS the
   * user's pair) and resolves a deferred rehydrated switch-back check.
   * Callers must never feed moa's own writes here (the tripwire helpers
   * filter them).
   */
  noteBootPair(pair: (RequestPair & { reasoningEffort?: string | undefined }) | undefined): void {
    if (pair === undefined || pair.model === undefined) return
    if (this.bootDefault !== undefined) return
    this.bootDefault = { provider: pair.provider, model: pair.model }
    if (this.userBase === undefined) {
      this.userBase = {
        provider: pair.provider ?? '',
        model: pair.model,
        ...(pair.reasoningEffort === undefined ? {} : { reasoningEffort: pair.reasoningEffort }),
      }
    }
    if (this.deferredSwitchBack) {
      this.deferredSwitchBack = false
      if (this.userBase !== undefined && same(this.userBase, this.bootDefault)) {
        this.reason = undefined
        this.armed = true
      }
    }
  }

  /**
   * Explicit USER write signal (r3-final): `/model` AND `/effort` paths call
   * this with the pair they just selected — regardless of the pair value,
   * which dissolves the same-tier ambiguity by construction. Updates
   * `userBaseSelection` (effort included — a stale effort must not ride a
   * later FailOpenServe restore), disarms, and re-arms on the boot pair
   * (`ModelSwitchBack`). With the boot pair still unknown, the write itself
   * proves the user left whatever default they had: disarm.
   */
  noteUserSelection(selection: ProvenanceSelection): void {
    this.userBase = { ...selection }
    if (this.bootDefault !== undefined && same(selection, this.bootDefault)) {
      this.reason = undefined
      this.armed = true
      return
    }
    this.armed = false
    this.reason = 'explicit-model-switch'
  }

  /**
   * Explicit MOA write signal: the router's routing select and the judge's
   * escalation select record the pair here. NEVER disarms; the tripwire
   * treats this pair as moa-authored.
   */
  noteMoaSelection(selection: ProvenanceSelection): void {
    this.lastMoa = { ...selection }
  }

  /**
   * TRIPWIRE-ONLY observation (r3-final): observes one pair reaching a
   * request path. Never mutates arming state beyond the first-wins boot
   * baseline (skipped for moa's own writes — a routed pair must not become
   * "boot"). Returns a violation message when the pair is non-moa, non-boot,
   * and lacks a preceding `noteUserSelection` — a wiring bug, reported by
   * the caller; undefined when the pair is accounted for (or the boot pair
   * is not yet known and the write could be moa's first).
   */
  observeTripwire(pair: RequestPair): string | undefined {
    if (pair.model === undefined) return undefined
    const isMoa = this.lastMoa !== undefined && same(pair, this.lastMoa)
    if (!isMoa) this.noteBootPair(pair)
    if (isMoa) return undefined
    if (this.bootDefault === undefined) return undefined
    if (same(pair, this.bootDefault)) return undefined
    if (this.userBase !== undefined && same(pair, this.userBase)) return undefined
    return (
      `moa tripwire: selection ${pair.provider ?? '?'}/${pair.model} reached a request without a preceding `
      + 'noteUserSelection — an explicit user write bypassed the notification seam'
    )
  }

  /**
   * Resume rehydration (D3.2 provenance): apply the routing.jsonl sidecar's
   * LAST row — already freshness-checked by the caller against the session's
   * durable `model/selection` state. `route`/`escalate` ⇒ `lastMoaSelection`
   * (armed); `user-select` ⇒ `userBaseSelection` with armed = (pair equals
   * the boot pair — deferred via the next boot capture when the boot pair is
   * not yet known); missing-file/stale-check-failure ⇒ conservative
   * unarmed-until-boot-pair. Run at most once per machine lifetime.
   */
  rehydrateFromSidecar(row:
    | { kind: 'route' | 'escalate'; selection: ProvenanceSelection }
    | { kind: 'user-select'; selection: ProvenanceSelection }
    | undefined): void {
    if (row === undefined) {
      this.armed = false
      this.reason = 'resume-unconfirmed'
      return
    }
    if (row.kind === 'user-select') {
      this.userBase = { ...row.selection }
      if (this.bootDefault === undefined) {
        // The boot pair arrives with the first genuine observation; the
        // switch-back check defers to that capture (ModelSwitchBack
        // survives restart).
        this.deferredSwitchBack = true
        this.armed = false
        this.reason = 'resume-unconfirmed'
      } else if (same(row.selection, this.bootDefault)) {
        this.reason = undefined
        this.armed = true
        this.deferredSwitchBack = false
      } else {
        this.armed = false
        this.reason = 'explicit-model-switch'
        this.deferredSwitchBack = false
      }
      return
    }
    // route/escalate: the durable selection IS moa's last write.
    this.lastMoa = { ...row.selection }
    this.reason = undefined
    this.armed = true
    this.deferredSwitchBack = false
  }

  isArmed(): boolean {
    return this.armed && this.isEnabled()
  }

  disarmReason(): DisarmReason | undefined {
    return this.reason
  }

  /** The captured boot-default pair (test/wiring introspection). */
  getBootDefaultModel(): RequestPair | undefined {
    return this.bootDefault === undefined ? undefined : { ...this.bootDefault }
  }

  /** moa's last recorded write, or undefined (tripwire filter input). */
  lastMoaSelection(): ProvenanceSelection | undefined {
    return this.lastMoa === undefined ? undefined : { ...this.lastMoa }
  }

  /**
   * The independently tracked user/base selection (FailOpenServe restore
   * target): the latest explicit user write, the rehydrated user-select row,
   * or the boot-pair first-wins initialization.
   */
  userBaseSelection(): ProvenanceSelection | undefined {
    return this.userBase === undefined ? undefined : { ...this.userBase }
  }
}
