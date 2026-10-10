/**
 * Arming state machine for the MAIN agent (design §3.1 truth table).
 *
 * Pure and synchronous; the live `moa.enabled` read is injected at
 * construction (settings hot-reload: consumers re-read, the machine follows
 * the getter each time).
 *
 * §6 precedence (high→low): explicit /model this session > moa overlay >
 * boot default. **No self-feedback guard is needed**: the wiring slice (later)
 * only overrides the model AFTER `observeRequestModel` runs in the
 * `agent/request` waterfall, so this machine always sees the user's live
 * selection (pre-override), never moa's own overlay.
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

/** Why the machine disarmed. */
export type DisarmReason = 'explicit-model-switch'

const same = (a: RequestPair, b: RequestPair): boolean => a.provider === b.provider && a.model === b.model

/**
 * §3.1 truth table, implementable rows:
 * - `moa.enabled` false → never armed; arming when disabled does nothing.
 * - enabled + no explicit /model → armed on the main agent (boot default
 *   captured from the first observed main-agent request model).
 * - enabled + /model `<pair>` ≠ boot default → disarmed for the rest of the
 *   session's pairing.
 * - /model back to the boot default → re-arms (user returned to "no opinion").
 * - Settings flip enabled→true at runtime → arms from the next genuine turn
 *   (`observeRequestModel` on a not-yet-armed machine arms and captures).
 */
export class ArmingMachine {
  private bootDefault: RequestPair | undefined
  private armed = false
  private reason: DisarmReason | undefined

  constructor(private readonly isEnabled: () => boolean) {}

  /** Called by the wiring slice at mount when `moa.enabled` reads true. */
  arm(): void {
    if (!this.isEnabled()) return
    // Boot default is captured from the first observed request model, not here.
    if (this.reason === undefined) this.armed = true
  }

  /** Observe one genuine main-agent request model (pre-override). */
  observeRequestModel(pair: RequestPair): void {
    if (!this.isEnabled()) return
    // Hot-reload row: enabled flipped true at runtime → arm from this turn.
    if (!this.armed && this.reason === undefined) {
      this.armed = true
      this.bootDefault = { ...pair }
      return
    }
    if (this.bootDefault === undefined) {
      this.bootDefault = { ...pair }
      return
    }
    if (same(pair, this.bootDefault)) {
      if (this.reason !== undefined) {
        // /model back to boot default: the user explicitly returned to
        // "no opinion" — re-arm (§3.1 row 4).
        this.reason = undefined
        this.armed = true
      }
      return
    }
    // Differing pair, not produced by moa itself (see module doc, §6):
    // explicit /model → disarmed until the pair returns to boot default.
    this.armed = false
    this.reason = 'explicit-model-switch'
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
}
