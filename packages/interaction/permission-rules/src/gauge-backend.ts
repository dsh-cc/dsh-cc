/**
 * Classifier backend resolution (design doc §4.4/§4.5, PR-B unit B2b):
 * composes the §4.5 route-name policy with per-backend connection facts.
 * A chat route resolves exactly as today (`resolveChatRoute`); an armed or
 * explicit-`gauge` route assembles the System One lane from the merged alias
 * entry, the calling agent's request header, the `llm-pi-ai` provider
 * record, and the credential-ref chain (upstream precedent
 * `llm-pi-ai/src/index.ts:179-184`).
 *
 * The apiKey is NEVER logged or audited — it only rides the in-process
 * backend info into the request headers.
 *
 * @module @dsh-cc/permission-rules/gauge-backend
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@dsh-cc/tools'
import { resolveDetailedAlias } from '@dsh-cc/model-aliases'
import { readUserSection } from '@dsh-cc/settings-ns'
import { resolveGaugeContextWindow } from './gauge-adapter.ts'
import { pickGaugeRouteName, type ClassifierBackend, type PolicyWarn } from './route-policy.ts'
import type { ClassifierRoute } from './llm-classifier.ts'

/** Warn-once key: gauge is armed but does not resolve to a usable route. */
export const GAUGE_UNRESOLVABLE_KEY = 'permission-rules:gauge-unresolvable'
const GAUGE_UNRESOLVABLE_MESSAGE =
  'gauge alias is configured but does not resolve to a usable System One route (missing provider record or baseURL); falling back to haiku'

/**
 * Warn-once key: a known model's registry context window shadows a differing
 * provider-record value (design doc §4.3). ONE process-global string shared
 * across models and both lanes, by design.
 */
export const GAUGE_WINDOW_MISMATCH_KEY = 'permission-rules:gauge-window-mismatch'

/** One resolved classifier backend for a call: today's chat lane or the System One gauge lane. */
export type ClassifierBackendRoute =
  | { backend: 'chat'; route: ClassifierRoute }
  | { backend: 'systemone'; provider: string; model: string; baseURL: string; apiKey?: string; contextWindow?: number }

/** Assembled System One connection facts (the gauge lane without its tag). */
export type SystemOneInfo = {
  provider: string
  model: string
  baseURL: string
  apiKey?: string
  contextWindow?: number
}

/** Shared backend-deps face: classifier and probe sections carry the same fields. */
export type GaugeBackendDeps = {
  /** The configured section `route` (verbatim, including `'gauge'`). */
  route: string | undefined
  /** The configured section `backend` (default `'haiku'` at the caller). */
  backend: ClassifierBackend
  /** Per-process warn-once emitter (plugin-owned). */
  warnOnce: PolicyWarn
  /** Explicit window override from `permissions.autoMode.gaugeContextWindow`. */
  gaugeContextWindow?: number
  /** Today's chat-route resolution, verbatim. */
  resolveChatRoute(exec: ToolExecution, name: string): ClassifierRoute | undefined
}

/** The `llm-pi-ai` provider record face (structural read; absence tolerated). */
interface GaugeProviderRecord {
  baseURL?: unknown
  apiKeyEnv?: unknown
  contextWindow?: unknown
}

/**
 * Assemble the System One connection facts (PR-C shared extraction).
 * Returns `null` when unresolvable — the caller owns the fallback; the
 * {@link GAUGE_UNRESOLVABLE_KEY} warn-once fires here so every consumer
 * warns identically. Never throws.
 */
export async function assembleSystemOneBackend(
  ctx: Context,
  exec: ToolExecution,
  deps: { warnOnce: PolicyWarn; gaugeContextWindow?: number },
): Promise<SystemOneInfo | null> {
  // Mirror pre-execute's resolveDetailedRoute: the calling agent's logged
  // request header fills a missing provider/model (half-written routes
  // cannot blend across layers, so one missing field means inheritance).
  const parent = exec.agent?.session.requestHeader()?.config as
    | { provider?: string; model?: string }
    | undefined
  const resolved = resolveDetailedAlias(ctx, 'gauge').route
  const provider = resolved?.provider ?? parent?.provider
  const model = resolved?.model ?? parent?.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return null

  // Provider connection facts from the `llm-pi-ai` user override — the same
  // user-layer section the TUI provider flows read. Q3 disposition (bridge,
  // migration plan addendum): the rc.2 adapter reads its own entry Config, so
  // the bridge's user-override read seam is the source of truth here, not the
  // namespace's resolved value. Structural read.
  const settings = ctx.get('settings') as { describe?: () => ReadonlyArray<{ ns?: unknown; user?: unknown }> } | undefined
  const raw = readUserSection(settings, 'llm-pi-ai')
  const providers = (raw as { providers?: unknown } | undefined)?.providers
  const record = (typeof providers === 'object' && providers !== null
    ? (providers as Record<string, unknown>)[provider]
    : undefined) as GaugeProviderRecord | undefined
  const baseURL = typeof record?.baseURL === 'string' && record.baseURL.length > 0 ? record.baseURL : undefined
  if (record === undefined || baseURL === undefined) {
    deps.warnOnce(GAUGE_UNRESOLVABLE_KEY, GAUGE_UNRESOLVABLE_MESSAGE)
    return null
  }

  // Per-model window resolution (design doc §4.2): settings override >
  // measured registry (known models) > provider record > default. The record
  // is provider-scoped and stale for known models behind one gateway, so the
  // registry shadows it with a single warn-once (§4.3).
  const resolution = resolveGaugeContextWindow(model, {
    ...(deps.gaugeContextWindow === undefined ? {} : { settingsOverride: deps.gaugeContextWindow }),
    ...(typeof record.contextWindow === 'number' ? { recordValue: record.contextWindow } : {}),
  })
  if (resolution.mismatch !== undefined) {
    deps.warnOnce(
      GAUGE_WINDOW_MISMATCH_KEY,
      `gauge model "${model}" has a known context window ${resolution.mismatch.registry}; provider record contextWindow=${resolution.mismatch.record} is ignored — set permissions.autoMode.gaugeContextWindow to override deliberately`,
    )
  }

  return {
    provider,
    model,
    baseURL,
    ...(await resolveApiKey(ctx, record)),
    contextWindow: resolution.window,
  }
}

/**
 * Resolve the effective classifier backend for one call (§4.5 composition,
 * pinned wiring): pick the route NAME via the policy helper, then either
 * resolve the chat route as today or assemble the System One lane from the
 * alias + provider record. An unresolvable gauge emits the
 * {@link GAUGE_UNRESOLVABLE_KEY} warn-once and falls back to the haiku chat
 * route (undefined if that fails too — today's unarmed contract, no extra
 * warning). Never throws.
 */
export async function resolveClassifierBackend(
  ctx: Context,
  exec: ToolExecution,
  deps: GaugeBackendDeps,
): Promise<ClassifierBackendRoute | undefined> {
  const name = pickGaugeRouteName(ctx, deps.route, deps.backend)
  if (name !== 'gauge') {
    // An unresolvable chat route stays `undefined` — today's unarmed/disarm
    // contract, unchanged.
    const route = deps.resolveChatRoute(exec, name)
    return route === undefined ? undefined : { backend: 'chat', route }
  }
  const gauge = await assembleSystemOneBackend(ctx, exec, deps)
  if (gauge !== null) return { backend: 'systemone', ...gauge }
  const route = deps.resolveChatRoute(exec, 'haiku')
  return route === undefined ? undefined : { backend: 'chat', route }
}

/**
 * PR-C: resolve the effective PI-probe backend for one call — the SAME
 * §4.5 policy as the classifier over the `probe` section (explicit
 * `probe.route` > `probe.backend` auto-armed gauge > haiku). An unresolvable
 * gauge falls back to the haiku chat route exactly as the classifier does
 * (warn-once inside the assembly). Never throws.
 */
export async function resolveProbeBackend(
  ctx: Context,
  exec: ToolExecution,
  deps: GaugeBackendDeps,
): Promise<ClassifierBackendRoute | undefined> {
  return resolveClassifierBackend(ctx, exec, deps)
}

/**
 * Credential-ref resolution (upstream `llm-pi-ai` precedent, :179-184): try
 * the credentials service first, then `process.env[apiKeyEnv]`. Both missing
 * ⇒ omit the key entirely — the local gateway may serve unauthenticated
 * (probe-confirmed), so a miss is not an error here. Never logs the value.
 */
async function resolveApiKey(ctx: Context, record: GaugeProviderRecord): Promise<{ apiKey?: string } | undefined> {
  const ref = record.apiKeyEnv
  if (typeof ref !== 'string' || ref.length === 0) return undefined
  let fromCredentials: string | undefined
  try {
    const credentials = ctx.get('credentials') as
      | { resolve?: (r: string) => Promise<{ value?: string } | undefined> }
      | undefined
    if (typeof credentials?.resolve === 'function') {
      fromCredentials = (await credentials.resolve(ref))?.value
    }
  } catch {
    // Credential resolution fault: fall through to the env spelling.
  }
  const hit = fromCredentials ?? process.env[ref]
  if (hit === undefined || hit.length === 0) return undefined
  return { apiKey: hit }
}
