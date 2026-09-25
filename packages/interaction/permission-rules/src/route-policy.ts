/**
 * Route policy for the auto-mode classifier (design doc §4.5): picks the
 * effective classifier route name. Priority: an explicit `classifier.route`
 * wins verbatim; otherwise `backend: 'haiku'` (the default) always uses the
 * chat classifier; `backend: 'auto'` picks the `gauge` System One lane only
 * when gauge is ARMED — configured (inspector verdict `route` via
 * `configured`/`one-hop`) AND its merged alias entry carries the systemone
 * protocol (explicit `protocol` field or the `llmbox_systemone/` model-id
 * family prefix). Every other shape falls back to `'haiku'` silently.
 *
 * The gauge probe uses the inspector face (warning-free by construction);
 * when the `ccModelRoutes` service is unmounted it mirrors the overlay
 * fallback over `createModelInspector`. The protocol bit is never read from
 * the route — inspector results cannot carry it — but from the merged alias
 * map entry (settings overlay; the blessed arming form lives in settings).
 * The helper NEVER calls `resolveDetailed('gauge')` merely to test
 * inheritance (spurious inherit warning).
 *
 * @module @dsh-cc/permission-rules/route-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import {
  MODEL_ALIASES_NAMESPACE,
  createModelInspector,
  mergeAliasMaps,
  type AliasInspection,
  type AliasTarget,
} from '@dsh-cc/model-aliases'

/** Classifier backend selection applied when `classifier.route` is unset. */
export type ClassifierBackend = 'haiku' | 'auto'

/**
 * Warn-once key: the gauge alias is configured in string form as a
 * provider/model pair — alias strings are model ids, so this cannot arm
 * gauge; the object form is required.
 */
export const GAUGE_STRING_PAIR_KEY = 'permission-rules:gauge-string-pair'
const GAUGE_STRING_PAIR_MESSAGE =
  'gauge alias value looks like a provider/model pair; alias strings are model ids — use the object form {"provider","model","protocol":"systemone"}'

/** Per-process warn-once ledger, keyed by policy warning key. */
const warned = new Set<string>()

/** A policy warn-once: emit `message` under `key` at most once per process. */
export type PolicyWarn = (key: string, message: string) => void

/**
 * Build a per-process warn-once emitter over the given warn sink.
 * @param warn - the sink (typically `ctx.logger.warn`).
 */
export function createWarnOnce(warn: (message: string) => void): PolicyWarn {
  return (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }
}

/** Test hook: clear the per-process warn-once ledger. */
export function resetPolicyWarned(): void {
  warned.clear()
}

/**
 * Protocol arming check on the merged alias entry for `gauge`: object form
 * with `protocol: 'systemone'`, or the model-id family prefix heuristic.
 * A string entry NEVER arms (indistinguishable from a chat misconfig —
 * flagged with the gauge-string-pair warn-once instead).
 */
function isSystemOneEntry(entry: AliasTarget | undefined): boolean {
  if (entry === undefined || entry === null || typeof entry === 'string') return false
  return entry.protocol === 'systemone' || entry.model.includes('llmbox_systemone/')
}

/** Read the merged `model-aliases` overlay map from the settings provider. */
function readOverlayAliases(ctx: Context): ReadonlyMap<string, AliasTarget> {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  const overlay = settings?.get?.(MODEL_ALIASES_NAMESPACE) as
    | (Record<string, AliasTarget | null> & { warnOnInherit?: boolean })
    | undefined
  return mergeAliasMaps(undefined, overlay)
}

/**
 * Pick the effective classifier route name (§4.5 policy):
 * explicit route > backend auto (gauge when armed) > haiku.
 * @param ctx - the host context.
 * @param explicit - the configured `classifier.route` (verbatim when set,
 *   including `gauge` — resolution failure is the pre-execute layer's business).
 * @param backend - the configured `classifier.backend`.
 * @returns the route NAME (not a resolved route).
 */
export function pickClassifierRouteName(
  ctx: Context,
  explicit: string | undefined,
  backend: ClassifierBackend,
): string {
  if (explicit !== undefined) return explicit
  if (backend !== 'auto') return 'haiku'

  const aliases = readOverlayAliases(ctx)
  const routes = ctx.get('ccModelRoutes') as
    | { inspect(model: string | undefined): AliasInspection }
    | undefined
  // Inspector face for configured-ness — warning-free by construction. When
  // the service is unmounted, mirror the overlay fallback over the inspector.
  const verdict =
    routes !== undefined
      ? routes.inspect('gauge')
      : createModelInspector(() => aliases, { warn: () => {} })('gauge')

  // String-form gauge pair: not armable — warn once and fall back.
  if (verdict.kind === 'literal' && verdict.route?.model?.includes('/') === true) {
    createWarnOnce((message) => ctx.logger.warn(message))(GAUGE_STRING_PAIR_KEY, GAUGE_STRING_PAIR_MESSAGE)
    return 'haiku'
  }

  const configured = verdict.kind === 'route' && (verdict.via === 'configured' || verdict.via === 'one-hop')
  const armed = configured && isSystemOneEntry(aliases.get('gauge'))
  return armed ? 'gauge' : 'haiku'
}
