/**
 * moa — tiered cascade routing for the main conversation
 * (design docs/plans/2026-10-09-moa-tiered-cascade-routing.md).
 *
 * Plain plugin (advisor-watchdog shape): `apply(ctx)` registers the `moa`
 * settings namespace, constructs the core singletons, and wires the routing
 * slice: an `agent/inbox/claimed` capture listener, an observe+splice
 * `agent/pre-step` listener, the `agent/request` override listener, and the
 * `system-prompt/assemble` classification seam (effective-model-truth §5.3).
 * All bail fast when `moa.enabled` is false.
 *
 * @module @dsh-cc/moa
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { dshHomeFn } from '@dsh-cc/sidecar-io'
import { readUserSection } from '@dsh-cc/settings-ns'
import { isSubagentAgent } from './agent-scope.ts'
import { ArmingMachine } from './arming.ts'
import { createAcceptanceJudge, type JudgeDeps } from './judge.ts'
import { createRequestRouter, validateArming, type ArmingValidation, type EnsureArmed, type RouterDeps } from './router.ts'
import { registerSettings, type MoaSettings } from './settings.ts'
import {
  captureClaimed,
  getCapturedOpening,
  noteClaimedTurn,
  observeLiveSelection,
  readPublishedSelection,
  resetRuntimeCore,
  setRuntimeCore,
  tierFor,
} from './runtime-state.ts'
import { EscalationBookkeeping } from './state.ts'

export { SETTINGS_NAMESPACE, DEFAULT_MOA_SETTINGS, MAX_ESCALATIONS_CEILING, registerSettings, type MoaSettings, type JudgeRouteObject, type JudgeRouteSetting } from './settings.ts'
export { ArmingMachine, type RequestPair, type DisarmReason } from './arming.ts'
export { TIER_ALIASES, TIER_COUNT, resolveTiers, tierAt, nextTierUp, type TierResolution } from './tiers.ts'
export { DEFAULT_JUDGE_ALIAS, resolveJudgeRoute, resolveContextWindow, normalizeModelId, MOA_MODEL_CONTEXT_WINDOWS, MOA_DEFAULT_CONTEXT_WINDOW, type JudgeRouteResolution } from './judge-route.ts'
export { MOA_ESCALATION_KIND, isMoaEscalationMessage, EscalationBookkeeping, type EscalationState } from './state.ts'
export { moaNoticeSource } from './provenance.ts'
export { CAPTURE_CAPACITY, captureClaimed, getCapturedOpening } from './runtime-state.ts'
export { createRequestRouter, validateArming, textOf, tierRouteVariables, ROUTING_QUESTION, type RouterDeps, type RequestRouter, type RequestPayload, type ArmingValidation, type EnsureArmed, type MoaRouteBackend } from './router.ts'
export { createAcceptanceJudge, ACCEPT_QUESTION, type AcceptanceJudge, type JudgeDeps } from './judge.ts'

/**
 * The shared plugin core: ONE instance per runtime, holding only cross-tree
 * truth (scope-aware-listeners design §2.2.1/§2.2.4). Anything that binds a
 * specific preset tree — the settings reader, the router, the judge — is
 * constructed per `apply` instead, because a value captured from the first
 * tree's context is unreachable from a sibling scope.
 */
export interface MoaCore {
  /** The MAIN-agent arming state machine (§3.1). */
  arming: ArmingMachine
  /** Per-session escalation bookkeeping (§4). */
  bookkeeping: EscalationBookkeeping
  /**
   * Warn-once reasons already reported while unarmed. Shared, so two trees'
   * arming retries never double-warn for one reason (§2.2.4).
   */
  warnedReasons: Set<string>
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
  resetRuntimeCore()
}

/** Cordis plugin id. */
export const name = 'cc-moa'

/**
 * Mount the plugin: register the settings namespace, create the shared core on
 * the first apply, and wire the routing slice (capture, observe+splice,
 * request override, assemble seam, acceptance judge) on THIS context. The
 * idempotency boundary is the shared core only — listener registration is
 * per-apply, because scope-tagged dispatch reaches only the tree whose scope
 * key the agent is bound to (design §2.1/§2.2). A second apply in a sibling
 * preset tree therefore wires its own, reachable copy.
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
  // The shared core is created once, on the first apply of the runtime; it
  // holds arming truth, bookkeeping, validation and warn dedup — and nothing
  // that belongs to one tree (§2.2.1/§2.2.2).
  if (core === undefined) {
    const arming = new ArmingMachine(() => read().enabled)
    const validation: ArmingValidation = { ok: false, reason: 'moa disabled' }
    core = { arming, bookkeeping: new EscalationBookkeeping(), warnedReasons: new Set<string>(), armingValidation: validation }
    // Shared runtime state (effective-model-truth §5.2): the sanitizer's
    // accessors read these singletons without importing the apply() path.
    setRuntimeCore({ arming, validation })
  }
  const { arming, warnedReasons } = core
  // The live validation object the router/judge closures read every firing.
  const validation: ArmingValidation = (core.armingValidation ??= { ok: false, reason: 'moa disabled' })
  // Every host seam below closes over THIS apply's context: the tree-local
  // settings reader (never a core-held one), routes, backends, ledger paths.
  const deps = buildDeps(ctx, read)

  /**
   * Arm + validate until it succeeds. Every not-yet-ok state is retryable:
   * settings may still be defaults, `ccModelRoutes` may be absent, and the
   * alias overlay may not be mounted yet (a temporarily degenerate ladder or
   * an unresolved `gauge` default). Once ok, it is a no-op. Each distinct
   * failure reason warns once PROCESS-wide (the dedup lives on the shared
   * core, so two trees cannot double-warn for one reason).
   */
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
    const routes = deps.routes?.()
    const result = validateArming({ settings, routes, logger: ctx.logger })
    if (!result.ok) {
      const reason = result.reason ?? 'unknown'
      if (!warnedReasons.has(reason)) {
        warnedReasons.add(reason)
        ctx.logger.warn(`moa: not armed — ${reason}`)
      }
      validation.ok = false
      validation.reason = reason
      validation.ladder = undefined
      return
    }
    arming.arm()
    validation.ok = true
    validation.reason = 'armed'
    validation.ladder = result.ladder
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

  // Opening capture (effective-model-truth §5.3): synchronous per-message
  // emit at claim — per turn the LAST claimed message wins (the claim batch
  // claims pending next-step items first, then the next-turn message).
  // Subagent-guarded inside the runtime-state writers. `noteClaimedTurn`
  // tracks the last-claimed turn (AssembleContext has no turn field — the
  // assemble seam reads it).
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }: { agent?: unknown; message: UserMessage; turn: number }) => {
    captureClaimed(agent, message, turn)
    noteClaimedTurn(agent, turn)
  })
  const router = createRequestRouter(core, { validation, ensureArmed: tryArm, deps })
  // First moa pre-step listener: observe the sanitizer's published FROZEN
  // selection FIRST (effective-model-truth §5.2 part 2 — before anything
  // else, subagent-guarded), then the mount-race ensureArmed retry, then the
  // pending-row splice (the row was queued during this step's assemble, so
  // delivery lands in the SAME step as the overlay, §5.3).
  const observePreStep = async (payload: { agent?: unknown }, next: () => Promise<unknown>): Promise<unknown> => {
    if (!isSubagentAgent(payload.agent)) {
      const live = readPublishedSelection(payload.agent)
      if (live?.model !== undefined) observeLiveSelection(live)
    }
    if (!validation.ok) tryArm()
    return router.preStepListener(payload as never, next)
  }
  ctx.on('agent/pre-step', observePreStep as never)
  ctx.on('agent/request', router.listener)
  // The classification seam (effective-model-truth §5.3): an OUTER
  // `system-prompt/assemble` listener — plugin-apply registration happens
  // BEFORE the harness registers its assemble listener at agent creation
  // (t0 < t1, no prepend), so after `await next()` the harness has already
  // written variables.provider/model from the live selection.
  ctx.on('system-prompt/assemble', router.assembleListener as never)
  // Acceptance judge (§3.3/§3.4): capture-only `agent/turn-stopping`
  // listener — capture inputs synchronously, dispatch the judge DETACHED
  // (never blocks the waterfall; wakes the retry via agent.followup).
  const judge = createAcceptanceJudge(core, { validation, ensureArmed: tryArm, deps: buildJudgeDeps(ctx, read) })
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
function buildJudgeDeps(ctx: Context, readSettings: () => MoaSettings): JudgeDeps {
  return {
    readSettings,
    // Judge inputs read the shared runtime-state store (effective-model-truth
    // §5.3): the capture is written by the `agent/inbox/claimed` listener and
    // the sticky tier by the assemble seam — both keyed per turn.
    getCapturedOpening: (turnId) => getCapturedOpening(turnId),
    tierFor: (turnId) => tierFor(turnId),
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

/** The `llm` service, read defensively (cordis throws on `ctx.llm` without inject). */
function optionalLlm(ctx: Context): {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts: readonly { id: unknown }[] } }>
} | undefined {
  try {
    return ctx.get('llm') as ReturnType<typeof optionalLlm> | undefined
  } catch {
    return undefined
  }
}

/**
 * Wire the router's host seams off the plug context. Exported for the wiring
 * regression specs (the lazy-`llm` seam cannot be pinned through `apply`
 * without a live preset boot).
 */
export function buildDeps(ctx: Context, readSettings: () => MoaSettings): RouterDeps {
  return {
    // This tree's OWN settings reader (§2.2.1): a reader captured from a
    // sibling tree's context is exactly the cross-tree capture this split
    // removes.
    readSettings,
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
    // read equivalent to the TUI's rt.resolveEfforts. Resolved LAZILY per
    // call: an eager apply-time `ctx.llm` access throws in cordis without
    // `inject: ['llm']` (live-probed 2026-10-11: "cannot get property llm
    // without inject"), which silently unwired effort validation for the
    // process lifetime and degraded every tier-routed turn.
    resolveEfforts: (provider: string, model: string, signal: AbortSignal) => {
      const llm = optionalLlm(ctx)
      if (llm === undefined) return Promise.resolve(undefined)
      return llm.resolveModelInfo(provider, model, signal).then(
        (info) => info.reasoning?.efforts.map((level) => String(level.id)),
        () => undefined,
      )
    },
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
