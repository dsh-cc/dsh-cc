/**
 * Strict run-manifest validation (docs/plans/2026-11-21-mathematical-research-harness.md
 * §9.1): unknown fields rejected, documented defaults applied, discovery
 * either absent-as-null or fully specified.
 *
 * Pure: no fs, no model calls. The run-directory writer lands with the
 * run-ledger wave; this module only decides validity.
 *
 * @module @dsh-cc/math-eval/manifest
 */

import {
  MANIFEST_DEFAULTS,
  RUN_MANIFEST_FIELDS,
  TIER_POLICIES,
  unknownFieldErrors,
  type Budget,
  type DiscoveryConfig,
  type RunManifest,
  type TierPolicy,
  type TrustedExample,
} from './types.js'

export type ManifestValidationResult =
  | { ok: true; value: RunManifest }
  | { ok: false; errors: string[] }

const BUDGET_FIELDS = ['attempts', 'tokens', 'wallClockMs'] as const
const DISCOVERY_FIELDS = [
  'selectionK',
  'convergenceG',
  'rngSeed',
  'populationSize',
  'programLanguage',
  'evaluatorSignature',
] as const
const TRUSTED_EXAMPLE_FIELDS = ['problemId', 'source', 'sha256'] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

function validateBudget(raw: Record<string, unknown>, errors: string[]): Budget {
  const budget = raw['budget']
  if (budget === undefined) return { ...MANIFEST_DEFAULTS.budget }
  if (!isPlainObject(budget)) {
    errors.push('budget: expected an object')
    return { ...MANIFEST_DEFAULTS.budget }
  }
  errors.push(...unknownFieldErrors(budget, BUDGET_FIELDS, 'budget'))
  const value = { ...MANIFEST_DEFAULTS.budget }
  for (const field of BUDGET_FIELDS) {
    const given = budget[field]
    if (given === undefined) continue
    if (!isPositiveInteger(given)) {
      errors.push(`budget.${field}: expected a positive integer`)
      continue
    }
    value[field] = given
  }
  return value
}

function validateDiscovery(raw: Record<string, unknown>, errors: string[]): DiscoveryConfig | null {
  const discovery = raw['discovery']
  if (discovery === undefined || discovery === null) {
    // `null` IS the documented default, so both spellings mean "discovery off".
    return MANIFEST_DEFAULTS.discovery
  }
  if (!isPlainObject(discovery)) {
    errors.push('discovery: expected an object or null')
    return MANIFEST_DEFAULTS.discovery
  }
  errors.push(...unknownFieldErrors(discovery, DISCOVERY_FIELDS, 'discovery'))
  const value: DiscoveryConfig = {
    selectionK: 0,
    convergenceG: 0,
    rngSeed: 0,
    populationSize: 0,
    programLanguage: '',
    evaluatorSignature: '',
  }
  for (const field of ['selectionK', 'populationSize'] as const) {
    const given = discovery[field]
    if (!isPositiveInteger(given)) errors.push(`discovery.${field}: expected a positive integer`)
    else value[field] = given
  }
  const rngSeed = discovery['rngSeed']
  if (typeof rngSeed !== 'number' || !Number.isInteger(rngSeed)) {
    errors.push('discovery.rngSeed: expected an integer')
  } else {
    value.rngSeed = rngSeed
  }
  const convergenceG = discovery['convergenceG']
  if (typeof convergenceG !== 'number' || !Number.isFinite(convergenceG) || convergenceG <= 0) {
    errors.push('discovery.convergenceG: expected a positive number')
  } else {
    value.convergenceG = convergenceG
  }
  for (const field of ['programLanguage', 'evaluatorSignature'] as const) {
    const given = discovery[field]
    if (!isNonEmptyString(given)) errors.push(`discovery.${field}: expected a non-empty string`)
    else value[field] = given
  }
  return value
}

function validateTierPolicy(raw: Record<string, unknown>, errors: string[]): TierPolicy {
  const tierPolicy = raw['tierPolicy']
  if (tierPolicy === undefined) return MANIFEST_DEFAULTS.tierPolicy
  if (!TIER_POLICIES.includes(tierPolicy as TierPolicy)) {
    errors.push(`tierPolicy: expected one of ${TIER_POLICIES.join('|')}`)
    return MANIFEST_DEFAULTS.tierPolicy
  }
  return tierPolicy as TierPolicy
}

function validateTrustedExamples(
  raw: Record<string, unknown>,
  errors: string[],
): TrustedExample[] {
  const trusted = raw['trustedExamples']
  if (trusted === undefined) return []
  if (!Array.isArray(trusted)) {
    errors.push('trustedExamples: expected an array')
    return []
  }
  const value: TrustedExample[] = []
  trusted.forEach((entry: unknown, index) => {
    const path = `trustedExamples[${index}]`
    if (!isPlainObject(entry)) {
      errors.push(`${path}: expected an object`)
      return
    }
    errors.push(...unknownFieldErrors(entry, TRUSTED_EXAMPLE_FIELDS, path))
    const cleaned: TrustedExample = { problemId: '', source: '', sha256: '' }
    for (const field of TRUSTED_EXAMPLE_FIELDS) {
      const given = entry[field]
      if (!isNonEmptyString(given)) errors.push(`${path}.${field}: expected a non-empty string`)
      else cleaned[field] = given
    }
    value.push(cleaned)
  })
  return value
}

/**
 * Validate a raw manifest against the §9.1 strict schema.
 *
 * - unknown fields are rejected at every level (top level, budget, discovery,
 *   trustedExamples entries);
 * - absent budget/discovery/tierPolicy/allowHumanFidelity/trustedExamples take
 *   the documented v4 defaults;
 * - `goal` and `createdAt` are required (the design lists no default for them).
 *
 * Returns the normalized manifest (defaults materialized) on success, or the
 * full sorted error list on failure — never throws.
 */
export function validateRunManifest(raw: unknown): ManifestValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['manifest: expected an object'] }
  }
  const errors: string[] = unknownFieldErrors(raw, RUN_MANIFEST_FIELDS, 'manifest')

  const goal = raw['goal']
  if (!isNonEmptyString(goal)) errors.push('goal: expected a non-empty string')

  const createdAt = raw['createdAt']
  if (!isNonEmptyString(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    errors.push('createdAt: expected an ISO 8601 timestamp string')
  }

  const allowHumanFidelity = raw['allowHumanFidelity']
  if (allowHumanFidelity !== undefined && typeof allowHumanFidelity !== 'boolean') {
    errors.push('allowHumanFidelity: expected a boolean')
  }

  const value: RunManifest = {
    goal: isNonEmptyString(goal) ? goal : '',
    budget: validateBudget(raw, errors),
    allowHumanFidelity:
      typeof allowHumanFidelity === 'boolean' ? allowHumanFidelity : MANIFEST_DEFAULTS.allowHumanFidelity,
    tierPolicy: validateTierPolicy(raw, errors),
    discovery: validateDiscovery(raw, errors),
    trustedExamples: validateTrustedExamples(raw, errors),
    createdAt: isNonEmptyString(createdAt) ? createdAt : '',
  }

  if (errors.length > 0) return { ok: false, errors: errors.sort() }
  return { ok: true, value }
}
