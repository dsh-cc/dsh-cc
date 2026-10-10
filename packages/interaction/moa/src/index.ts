/**
 * moa — tiered cascade routing for the main conversation
 * (design docs/plans/2026-10-09-moa-tiered-cascade-routing.md).
 *
 * Plain plugin (advisor-watchdog shape): `apply(ctx)` registers the `moa`
 * settings namespace, constructs the core singletons, and wires the routing
 * slice: a capture-only `agent/pre-step` listener and the `agent/request`
 * classify/override listener (design §3.2). Both bail fast when
 * `moa.enabled` is false.
 *
 * @module @dsh-cc/moa
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import { dshHomeFn } from '@dsh-cc/sidecar-io'
import { readUserSection } from '@dsh-cc/settings-ns'
import { ArmingMachine } from './arming.ts'
import { createOpeningCapture } from './capture.ts'
import { createAcceptanceJudge, type JudgeDeps } from './judge.ts'
import { createRequestRouter, validateArming, type ArmingValidation, type EnsureArmed, type RequestRouter, type RouterDeps } from './router.ts'
import { registerSettings, type MoaSettings } from './settings.ts'
import { EscalationBookkeeping } from './state.ts'

export { SETTINGS_NAMESPACE, DEFAULT_MOA_SETTINGS, MAX_ESCALATIONS_CEILING, registerSettings, type MoaSettings, type JudgeRouteObject, type JudgeRouteSetting } from './settings.ts'
export { ArmingMachine, type RequestPair, type DisarmReason } from './arming.ts'
export { TIER_ALIASES, TIER_COUNT, resolveTiers, tierAt, nextTierUp, type TierResolution } from './tiers.ts'
export { DEFAULT_JUDGE_ALIAS, resolveJudgeRoute, resolveContextWindow, normalizeModelId, MOA_MODEL_CONTEXT_WINDOWS, MOA_DEFAULT_CONTEXT_WINDOW, type JudgeRouteResolution } from './judge-route.ts'
export { MOA_ESCALATION_KIND, isMoaEscalationMessage, EscalationBookkeeping, type EscalationState } from './state.ts'
export { moaNoticeSource } from './provenance.ts'
export { createOpeningCapture, CAPTURE_CAPACITY } from './capture.ts'
export { createRequestRouter, validateArming, textOf, requestHeaderOf, ROUTING_QUESTION, type RouterDeps, type RequestRouter, type RequestPayload, type ArmingValidation, type EnsureArmed, type MoaRouteBackend } from './router.ts'
export { createAcceptanceJudge, ACCEPT_QUESTION, type AcceptanceJudge, type JudgeDeps } from './judge.ts'

/** What the wiring slice consumes. */
export interface MoaCore {
  /** Live settings reader (hot-reloaded per use). */
  readSettings(): MoaSettings
  /** The MAIN-agent arming state machine (§3.1). */
  arming: ArmingMachine
  /** Per-session escalation bookkeeping (§4). */
  bookkeeping: EscalationBookkeeping
  /** The routing slice's router handle (tier decisions + pair record). */
  router?: RequestRouter
  /**
   * The live arming validation (mutated in place by the settings-arrival
   * retry below). Observability seam for wiring tests; the router and judge
   * closures read this same object every firing.
   */
  armingValidation?: ArmingValidation
}

let core: MoaCore | undefined

/**
 * Access the plugin core; throws before `apply` ran (a wiring listener
 * cannot exist without its mount anyway).
 */
export function getMoaCore(): MoaCore {
  if (core === undefined) throw new Error('moa core not initialized: apply() has not run')
  return core
}

/** Test seam: drop the singleton (between tests / on hot reload). */
export function resetMoaCore(): void {
  core = undefined
}

/** Cordis plugin id. */
export const name = 'cc-moa'

/**
 * Mount the plugin: register the settings namespace, construct the core, and
 * wire the two agent-scoped listeners (`agent/pre-step` capture +
 * `agent/request` classify/override). Idempotent — a second apply in one
 * runtime reuses the live core; listener registration follows the same
 * idempotency (a re-apply returns before re-registering).
 *
 * Listeners are registered unconditionally even when `moa.enabled` is false:
 * the `enabled` fast bail at the top of each listener preserves the §3.1
 * "zero overhead" default-off contract, while a settings hot-reload can arm
 * the feature without a restart (each firing re-reads live settings). This
 * substitutes the design's literal "no listeners" row — the observable
 * behavior (no calls, no overrides when disabled) is identical.
 *
 * Arming validation (§3.7/§3.6) runs at mount when enabled: a degenerate
 * ladder or a failing judge-route window check leaves the feature unarmed
 * with ONE warn (the router additionally gates every classify on it).
 *
 * Mount-order race (live-traced 2026-10-10): the cc preset sweep mounts
 * BEFORE the vendored settings provider (and app-level services) settle, so
 * `read()` at mount time may still report defaults. Both the settings
 * registration (settings.ts, deferred via `ctx.inject` inside
 * `registerNamespaceSafe`) and the arm/validation pass here therefore retry:
 * on `ctx.inject(['settings', 'ccModelRoutes'])` and again right before the
 * router/judge `validation.ok` gate, until validation succeeds — mutating the
 * shared `validation` object the router/judge closures read per firing. No
 * failure reason is final: a frozen verdict at mount (disabled, routes
 * unavailable, or a ladder that is degenerate only until the alias overlay
 * mounts) would otherwise disarm the feature for the whole process lifetime.
 * @param ctx - the plug context (agent-scoped when mounted per agent).
 */
export function apply(ctx: Context): void {
  const read = registerSettings(ctx)
  if (core !== undefined) return
  const arming = new ArmingMachine(() => read().enabled)
  const validation: ArmingValidation = { ok: false, reason: 'moa disabled' }
  core = { readSettings: read, arming, bookkeeping: new EscalationBookkeeping(), armingValidation: validation }

  /**
   * Arm + validate until it succeeds. Every not-yet-ok state is retryable:
   * settings may still be defaults, `ccModelRoutes` may be absent, and the
   * alias overlay may not be mounted yet (a temporarily degenerate ladder or
   * an unresolved `gauge` default). Once ok, it is a no-op. Each distinct
   * failure reason warns once (no spam from the per-firing retry).
   */
  const warnedReasons = new Set<string>()
  const tryArm: EnsureArmed = () => {
    if (validation.ok) return
    const settings = read()
    if (!settings.enabled) {
      // Leave unarmed but retryable: a later enable (hot reload) re-runs this.
      validation.reason = 'moa disabled'
      return
    }
    // Routes resolve lazily: `ccModelRoutes` is an app-level service that is
    // also absent during the preset sweep (capturing it at mount would pin
    // undefined for the process lifetime).
    const routes = optionalRoutes(ctx)
    const result = validateArming({ settings, routes, logger: ctx.logger })
    if (!result.ok) {
      const reason = result.reason ?? 'unknown'
      if (!warnedReasons.has(reason)) {
        warnedReasons.add(reason)
        ctx.logger.warn(`moa: not armed — ${reason}`)
      }
      validation.ok = false
      validation.reason = reason
      return
    }
    arming.arm()
    validation.ok = true
    validation.reason = 'armed'
  }
  tryArm()
  try {
    // Fires once BOTH services are present (and again if either is
    // re-provided); the router/judge also call tryArm before their gate, so
    // callback ordering vs the deferred settings registration cannot
    // permanently miss.
    ctx.inject(['settings', 'ccModelRoutes'], tryArm)
  } catch {
    // Caller fiber already unloading: the per-firing ensureArmed still runs.
  }

  const capture = createOpeningCapture()
  liveCapture = capture
  ctx.on('agent/pre-step', capture.listener as never)
  const router = createRequestRouter(core, { validation, ensureArmed: tryArm, deps: buildDeps(ctx, capture.getCapturedOpening) })
  core.router = router
  ctx.on('agent/pre-step', router.preStepListener as never)
  ctx.on('agent/request', router.listener)
  // Acceptance judge (§3.3/§3.4): capture-only `agent/turn-stopping`
  // listener — capture inputs synchronously, dispatch the judge DETACHED
  // (never blocks the waterfall; wakes the retry via agent.followup).
  const judgeDeps = buildJudgeDeps(ctx)
  const judge = createAcceptanceJudge(core, { validation, ensureArmed: tryArm, deps: judgeDeps })
  ctx.on('agent/turn-stopping', judge.listener as never)
}

/** The `ccModelRoutes` service, read defensively (cordis throws when absent). */
function optionalRoutes(ctx: Context): ModelRoutes | undefined {
  try {
    return ctx.get('ccModelRoutes') as ModelRoutes | undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a System One backend (baseURL) for `route` from the user-layer
 * `llm-pi-ai` provider records via the settings service's describe face
 * (gauge-backend precedent, permission-rules/src/gauge-backend.ts).
 *
 * Bug-fix note (2026-10-10): both call sites previously passed the *cordis
 * context* where this helper expects the settings *service* — an `as never`
 * cast hid the mismatch, `readUserSection` saw no `describe`, and every
 * classify/judge call fail-opened with "no backend baseURL" in production.
 * The wiring tests pin the real path.
 */
export function resolveSystemOneBackend(
  settings: { describe?: () => ReadonlyArray<{ ns?: unknown; user?: unknown }> } | undefined,
  route: { provider?: string | undefined },
): { baseURL: string } | undefined {
  const raw = readUserSection(settings, 'llm-pi-ai')
  const record = (raw?.providers as Record<string, { baseURL?: unknown } | undefined> | undefined)?.[route.provider ?? '']
  const baseURL = typeof record?.baseURL === 'string' && record.baseURL.length > 0 ? record.baseURL : undefined
  return baseURL === undefined ? undefined : { baseURL }
}

/** The settings service, read defensively (absent during the preset sweep). */
function optionalSettings(ctx: Context): { describe?: () => ReadonlyArray<{ ns?: unknown; user?: unknown }> } | undefined {
  try {
    return ctx.get('settings') as { describe?: () => ReadonlyArray<{ ns?: unknown; user?: unknown }> } | undefined
  } catch {
    return undefined
  }
}

/** Wire the judge's host seams off the plug context (§3.3/§3.4). */
function buildJudgeDeps(ctx: Context): JudgeDeps {
  return {
    getCapturedOpening: (turnId) => getMoaCapture()?.getCapturedOpening(turnId),
    tierFor: (turnId) => core?.router?.tierFor(turnId),
    routes: () => optionalRoutes(ctx),
    resolveBackend: (route) => resolveSystemOneBackend(optionalSettings(ctx), route),
    routingLedgerPath: () => {
      const home = dshHomeFn(ctx)
      return home === undefined ? undefined : home('moa', 'routing.jsonl')
    },
    acceptanceLedgerPath: () => {
      const home = dshHomeFn(ctx)
      return home === undefined ? undefined : home('moa', 'acceptance.jsonl')
    },
    logger: ctx.logger,
  }
}

/** The live opening capture (set in apply; test seam for the judge deps). */
let liveCapture: ReturnType<typeof createOpeningCapture> | undefined
function getMoaCapture(): ReturnType<typeof createOpeningCapture> | undefined {
  return liveCapture
}

/** Wire the router's host seams off the plug context. */
function buildDeps(ctx: Context, getCapturedOpening: RouterDeps['getCapturedOpening']): RouterDeps {
  let llm: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts: readonly { id: unknown }[] } }> } | undefined
  try {
    llm = (ctx as { llm?: unknown }).llm as typeof llm
  } catch {
    llm = undefined
  }
  return {
    getCapturedOpening,
    // Lazy: `ccModelRoutes` is an app-level service absent during the preset
    // sweep — resolving per use (not capturing at mount) keeps the judge
    // alias path alive once the service settles.
    routes: () => optionalRoutes(ctx),
    // Provider connection facts from the user-layer `llm-pi-ai` section
    // (gauge-backend precedent): the judge route's provider record must
    // carry a baseURL or the classify fail-opens with a warn-once.
    resolveBackend: (route: ResolvedRoute) => resolveSystemOneBackend(optionalSettings(ctx), route),
    // Advertised efforts for the effort re-validation (§3.2): the harness
    // adapter-owned metadata via `llm.resolveModelInfo` — the smallest host
    // read equivalent to the TUI's rt.resolveEfforts.
    ...(llm === undefined
      ? {}
      : {
          resolveEfforts: (provider: string, model: string, signal: AbortSignal) =>
            llm.resolveModelInfo(provider, model, signal).then(
              (info) => info.reasoning?.efforts.map((level) => String(level.id)),
              () => undefined,
            ),
        }),
    // Route log (§7 R1): a SIDE-CAR JSONL ledger, NOT a session event —
    // unknown non-ignorable session event types poison session resume
    // (repo red line). One file per process under <dshHome>/moa/.
    ledgerPath: () => {
      const home = dshHomeFn(ctx)
      return home === undefined ? undefined : home('moa', 'routing.jsonl')
    },
    logger: ctx.logger,
  }
}
