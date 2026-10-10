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
import { createRequestRouter, validateArming, type ArmingValidation, type RouterDeps } from './router.ts'
import { DEFAULT_MOA_SETTINGS, registerSettings, type MoaSettings } from './settings.ts'
import { EscalationBookkeeping } from './state.ts'

export { SETTINGS_NAMESPACE, DEFAULT_MOA_SETTINGS, MAX_ESCALATIONS_CEILING, registerSettings, type MoaSettings, type JudgeRouteObject, type JudgeRouteSetting } from './settings.ts'
export { ArmingMachine, type RequestPair, type DisarmReason } from './arming.ts'
export { TIER_ALIASES, TIER_COUNT, resolveTiers, tierAt, nextTierUp, type TierResolution } from './tiers.ts'
export { DEFAULT_JUDGE_ROUTE, resolveJudgeRoute, resolveContextWindow, normalizeModelId, MOA_MODEL_CONTEXT_WINDOWS, MOA_DEFAULT_CONTEXT_WINDOW, type JudgeRouteResolution } from './judge-route.ts'
export { MOA_ESCALATION_KIND, isMoaEscalationMessage, EscalationBookkeeping, type EscalationState } from './state.ts'
export { moaNoticeSource } from './provenance.ts'
export { createOpeningCapture, CAPTURE_CAPACITY } from './capture.ts'
export { createRequestRouter, validateArming, textOf, requestHeaderOf, ROUTING_QUESTION, type RouterDeps, type RequestRouter, type RequestPayload, type ArmingValidation, type MoaRouteBackend } from './router.ts'

/** What the wiring slice consumes. */
export interface MoaCore {
  /** Live settings reader (hot-reloaded per use). */
  readSettings(): MoaSettings
  /** The MAIN-agent arming state machine (§3.1). */
  arming: ArmingMachine
  /** Per-session escalation bookkeeping (§4). */
  bookkeeping: EscalationBookkeeping
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
 * @param ctx - the plug context (agent-scoped when mounted per agent).
 */
export function apply(ctx: Context): void {
  const read = registerSettings(ctx) ?? (() => DEFAULT_MOA_SETTINGS)
  if (core !== undefined) return
  const arming = new ArmingMachine(() => read().enabled)
  core = { readSettings: read, arming, bookkeeping: new EscalationBookkeeping() }

  const routes = optionalRoutes(ctx)
  let validation: ArmingValidation = { ok: false, reason: 'moa disabled' }
  if (read().enabled) {
    arming.arm()
    validation = validateArming({ settings: read(), routes, logger: ctx.logger })
    if (!validation.ok) ctx.logger.warn(`moa: not armed — ${validation.reason}`)
  }

  const capture = createOpeningCapture()
  ctx.on('agent/pre-step', capture.listener as never)
  const router = createRequestRouter(core, { validation, deps: buildDeps(ctx, capture.getCapturedOpening) })
  ctx.on('agent/pre-step', router.preStepListener as never)
  ctx.on('agent/request', router.listener)
}

/** The `ccModelRoutes` service, read defensively (cordis throws when absent). */
function optionalRoutes(ctx: Context): ModelRoutes | undefined {
  try {
    return ctx.get('ccModelRoutes') as ModelRoutes | undefined
  } catch {
    return undefined
  }
}

/** Wire the router's host seams off the plug context. */
function buildDeps(ctx: Context, getCapturedOpening: RouterDeps['getCapturedOpening']): RouterDeps {
  const routes = optionalRoutes(ctx)
  let llm: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts: readonly { id: unknown }[] } }> } | undefined
  try {
    llm = (ctx as { llm?: unknown }).llm as typeof llm
  } catch {
    llm = undefined
  }
  return {
    getCapturedOpening,
    routes: () => routes,
    // Provider connection facts from the user-layer `llm-pi-ai` section
    // (gauge-backend precedent): the judge route's provider record must
    // carry a baseURL or the classify fail-opens with a warn-once.
    resolveBackend: (route: ResolvedRoute) => {
      try {
        const raw = readUserSection((ctx as { settings?: unknown }) as never, 'llm-pi-ai')
        const record = (raw?.providers as Record<string, { baseURL?: unknown } | undefined> | undefined)?.[route.provider ?? '']
        const baseURL = typeof record?.baseURL === 'string' && record.baseURL.length > 0 ? record.baseURL : undefined
        return baseURL === undefined ? undefined : { baseURL }
      } catch {
        return undefined
      }
    },
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
