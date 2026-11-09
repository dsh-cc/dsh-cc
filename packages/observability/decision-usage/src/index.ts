/**
 * `@dsh-cc/decision-usage` — the SystemOne decision runtime host adapter
 * (design docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md).
 *
 * The cordis plugin registers the trusted `systemone-decisions` settings
 * namespace and provides the optional `ctx.systemoneDecisions` service. A
 * missing service is equivalent to unavailable/unconfigured; mounting the
 * service triggers no request and enables no business.
 *
 * @module @dsh-cc/decision-usage
 */

import { Context } from '@deepseek-ai/cordis'
import { resolveDetailedAlias } from '@dsh-cc/model-aliases'
import { readUserSection } from '@dsh-cc/settings-ns'
import { dshHomeFn } from '@dsh-cc/sidecar-io'
import { registerSettings } from './settings.ts'
import { createSystemOneDecisionsService } from './service.ts'
import type { DecisionProviderRecord, SystemOneDecisionsService } from './service.ts'

export {
  DEFAULT_DECISION_SETTINGS,
  DEFAULT_LEDGER_MAX_BYTES,
  DEFAULT_MAX_ATTEMPTS_PER_SESSION,
  DEFAULT_MAX_INPUT_TOKENS_PER_SESSION,
  DEFAULT_MAX_OUTPUT_TOKENS_PER_SESSION,
  DEFAULT_MAX_RETRIES,
  MAX_ACTUAL_MODEL_ID_CHARS,
  MAX_RETRIES_LIMIT,
  MIN_LEDGER_MAX_BYTES,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  decisionMaxRetries,
  decisionSessionLimits,
  parseDecisionSettings,
  registerSettings,
} from './settings.ts'
export type {
  DecisionCapabilityRowSettings,
  DecisionSessionLimits,
  DecisionSettingsReader,
  SystemOneDecisionsSettings,
} from './settings.ts'

export { matchDecisionCapability, resolveDecisionRoute, toDecisionCapability } from './route.ts'
export type { DecisionAliasRoute, DecisionCapability, DecisionRouteConnection, DecisionRouteDeps } from './route.ts'

export {
  LEDGER_DIR_NAME,
  LEDGER_FREEZE_REASON_CODES,
  LOCK_FILE_NAME,
  USAGE_FILE_NAME,
  appendDecisionRow,
  decisionUsageDir,
  findLease,
  isDecisionLedgerRow,
  lockFilePath,
  projectDecisionLedger,
  readDecisionLedger,
  usageFilePath,
} from './ledger.ts'
export type {
  DecisionLeaseProjection,
  DecisionLedgerFreezeCode,
  DecisionLedgerProjection,
  DecisionLedgerReport,
} from './ledger.ts'

export {
  createDecisionQuota,
  DecisionQuotaError,
  LOCK_RETRY_INTERVAL_MS,
  LOCK_WAIT_BUDGET_MS,
} from './quota.ts'
export type {
  DecisionQuota,
  DecisionQuotaLimits,
  DecisionQuotaOptions,
  DecisionQuotaReport,
  QuotaFault,
  QuotaRejection,
} from './quota.ts'

export { createSystemOneDecisionsService } from './service.ts'
export type { DecisionProviderRecord, DecisionUsageServiceDeps, SystemOneDecisionsService } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional SystemOne decision service; absence == unavailable/unconfigured. */
    systemoneDecisions?: SystemOneDecisionsService
    /**
     * Root-realm bridge to {@link Context.systemoneDecisions} (design
     * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Preset
     * wiring (root-realm bridge)"): the same service republished to the root
     * realm so consumers mounted OUTSIDE the `cc-services` isolate group (for
     * example `memory-consolidation`) can reach it. Still optional: absence
     * means unavailable/unconfigured, never a fallback route.
     */
    ccSystemoneDecisions?: SystemOneDecisionsService
  }
}

export const name = 'decision-usage'

/** The `llm-pi-ai` settings namespace the provider records live under (upstream precedent). */
export const PROVIDER_RECORD_NAMESPACE = 'llm-pi-ai'

/** Read the trusted provider record for one provider key (readUserSection idiom). */
function readProviderRecord(ctx: Context, provider: string): DecisionProviderRecord | undefined {
  try {
    const settings = ctx.get('settings') as { describe?: () => ReadonlyArray<{ ns?: unknown; user?: unknown }> } | undefined
    const raw = readUserSection(settings, PROVIDER_RECORD_NAMESPACE)
    const providers = (raw as { providers?: unknown } | undefined)?.providers
    if (typeof providers !== 'object' || providers === null) return undefined
    const record = (providers as Record<string, unknown>)[provider]
    return typeof record === 'object' && record !== null
      ? (record as DecisionProviderRecord)
      : undefined
  } catch {
    return undefined
  }
}

/** Credentials-service read (gauge-backend precedent); never logs the value. */
async function resolveCredential(ctx: Context, ref: string): Promise<string | undefined> {
  try {
    const credentials = ctx.get('credentials') as
      | { resolve?: (r: string) => Promise<{ value?: string } | undefined> }
      | undefined
    if (typeof credentials?.resolve === 'function') {
      const hit = (await credentials.resolve(ref))?.value
      return hit !== undefined && hit.length > 0 ? hit : undefined
    }
  } catch {
    // Credential resolution fault: the env spelling fallback lives in the service.
  }
  return undefined
}

/** The root-realm bridge name (see {@link publishRootBridge}). */
export const ROOT_BRIDGE_NAME = 'ccSystemoneDecisions'

/**
 * Republish this tree's service to the ROOT realm under
 * {@link ROOT_BRIDGE_NAME} (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Preset wiring
 * (root-realm bridge)").
 *
 * `decision-usage` is mounted inside the `cc-services` group with
 * `isolate: { systemoneDecisions: true }`, while `memory-consolidation` is
 * mounted outside that group (its forks must keep inheriting the parent route),
 * so the isolated name is not resolvable from a consumer's realm and adding it
 * to `inject` would deadlock that plugin's activation. The bridge closes the
 * gap with the `ccPluginManager` register-if-absent idiom: `root.provide` when
 * the root slot is empty, `root.set` when some tree already published, plus a
 * fiber effect that clears the publication on unload ONLY when it still points
 * at this tree's instance.
 *
 * A publication owned by the ROOT fiber is not "leaked" by the preset mount
 * gate (that gate flags store entries owned by a fiber INSIDE the mount), so
 * this does not need a new isolate key. The trade-off is conscious and
 * documented in the yml row: when two preset trees coexist the root slot has
 * one publisher and the second publishes over it, so per-tree quota isolation
 * is traded for consumer reachability — quota is keyed by projectKey+sessionId,
 * which is stable across trees. Consumers must therefore re-read the service
 * per use instead of caching it.
 * @param ctx - the mounting context (the publication goes to `ctx.root`).
 * @param service - this tree's service instance.
 */
function publishRootBridge(ctx: Context, service: SystemOneDecisionsService): void {
  const root = ctx.root
  // Read the slot directly instead of a strict `get`: a service provided by a
  // fiber that is not ACTIVE yet is still "already registered" for `provide`,
  // and `provide` on a registered name throws.
  const rootKey = root[Context.isolate][ROOT_BRIDGE_NAME]
  const existing = rootKey === undefined ? undefined : root.reflect.store[rootKey]
  try {
    if (existing === undefined) root.provide(ROOT_BRIDGE_NAME, service)
    else root.set(ROOT_BRIDGE_NAME, service)
  } catch {
    // A refused publication leaves the bridge absent, which the optional
    // contract already reads as unavailable; it must never break mounting.
  }
  ctx.fiber.effect(
    () => () => {
      if (root.get(ROOT_BRIDGE_NAME, false) === service) root.set(ROOT_BRIDGE_NAME, undefined)
    },
    `${ROOT_BRIDGE_NAME}: clear root-realm publication on unload`,
  )
}

/**
 * Mount the plugin. Degrade-don't-fail: an absent settings service leaves the
 * namespace reader returning undefined (no route resolves); an absent
 * dshHomePath leaves reserves failing closed; a duplicate/absent provide
 * never breaks mounting.
 */
export function apply(ctx: Context): void {
  const readSettings = registerSettings(ctx)
  const homeFn = dshHomeFn(ctx)
  const service = createSystemOneDecisionsService({
    readSettings,
    ...(homeFn !== undefined ? { home: () => homeFn() } : {}),
    resolveAlias(alias) {
      try {
        return resolveDetailedAlias(ctx, alias).route
      } catch {
        return undefined
      }
    },
    readProviderRecord: (provider) => readProviderRecord(ctx, provider),
    resolveCredential: (ref) => resolveCredential(ctx, ref),
  })
  try {
    ctx.provide('systemoneDecisions', service)
  } catch {
    // A duplicate mount or a provider that refuses contributes nothing; the
    // optional-service contract treats absence as unavailable/unconfigured.
  }
  publishRootBridge(ctx, service)
}
