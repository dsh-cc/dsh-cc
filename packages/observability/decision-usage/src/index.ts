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

import type { Context } from '@deepseek-ai/cordis'
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
}
