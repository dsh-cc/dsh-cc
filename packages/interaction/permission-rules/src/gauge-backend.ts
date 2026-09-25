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
import { pickClassifierRouteName, type ClassifierBackend, type PolicyWarn } from './route-policy.ts'
import type { ClassifierRoute } from './llm-classifier.ts'

/** Warn-once key: gauge is armed but does not resolve to a usable route. */
export const GAUGE_UNRESOLVABLE_KEY = 'permission-rules:gauge-unresolvable'
const GAUGE_UNRESOLVABLE_MESSAGE =
  'gauge alias is configured but does not resolve to a usable System One route (missing provider record or baseURL); falling back to haiku'

/** One resolved classifier backend for a call: today's chat lane or the System One gauge lane. */
export type ClassifierBackendRoute =
  | { backend: 'chat'; route: ClassifierRoute }
  | { backend: 'systemone'; provider: string; model: string; baseURL: string; apiKey?: string; contextWindow?: number }

export type ClassifierBackendDeps = {
  /** The configured `classifier.route` (verbatim, including `'gauge'`). */
  route: string | undefined
  /** The configured `classifier.backend` (default `'haiku'` at the caller). */
  backend: ClassifierBackend
  /** Per-process warn-once emitter (plugin-owned). */
  warnOnce: PolicyWarn
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
  deps: ClassifierBackendDeps,
): Promise<ClassifierBackendRoute | undefined> {
  const name = pickClassifierRouteName(ctx, deps.route, deps.backend)
  if (name !== 'gauge') {
    // An unresolvable chat route stays `undefined` — today's unarmed/disarm
    // contract, unchanged.
    const route = deps.resolveChatRoute(exec, name)
    return route === undefined ? undefined : { backend: 'chat', route }
  }
  const gauge = await resolveGaugeBackend(ctx, exec)
  if (gauge !== undefined) return { backend: 'systemone', ...gauge }
  deps.warnOnce(GAUGE_UNRESOLVABLE_KEY, GAUGE_UNRESOLVABLE_MESSAGE)
  const route = deps.resolveChatRoute(exec, 'haiku')
  return route === undefined ? undefined : { backend: 'chat', route }
}

/** Assemble the System One connection facts; `undefined` ⇒ unresolvable. */
async function resolveGaugeBackend(
  ctx: Context,
  exec: ToolExecution,
): Promise<{ provider: string; model: string; baseURL: string; apiKey?: string; contextWindow?: number } | undefined> {
  // Mirror pre-execute's resolveDetailedRoute: the calling agent's logged
  // request header fills a missing provider/model (half-written routes
  // cannot blend across layers, so one missing field means inheritance).
  const parent = exec.agent?.session.requestHeader()?.config as
    | { provider?: string; model?: string }
    | undefined
  const resolved = resolveDetailedAlias(ctx, 'gauge').route
  const provider = resolved?.provider ?? parent?.provider
  const model = resolved?.model ?? parent?.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return undefined

  // Provider connection facts from the `llm-pi-ai` namespace — the same
  // namespace the TUI provider flows read (design §4.3). Structural read.
  const settings = ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
  const raw = typeof settings?.get === 'function' ? settings.get('llm-pi-ai') : undefined
  const providers = (raw as { providers?: unknown } | undefined)?.providers
  const record = (typeof providers === 'object' && providers !== null
    ? (providers as Record<string, unknown>)[provider]
    : undefined) as GaugeProviderRecord | undefined
  const baseURL = typeof record?.baseURL === 'string' && record.baseURL.length > 0 ? record.baseURL : undefined
  if (record === undefined || baseURL === undefined) return undefined

  return {
    provider,
    model,
    baseURL,
    ...(await resolveApiKey(ctx, record)),
    ...(typeof record.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {}),
  }
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
