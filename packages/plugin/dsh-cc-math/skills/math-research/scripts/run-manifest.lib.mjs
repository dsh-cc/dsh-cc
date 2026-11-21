// Strict run-manifest validation (design §9.1) for the math-research scripts.
//
// DUPLICATION NOTE: this is a JavaScript port of
// packages/evaluation/math-eval/src/manifest.ts (validateRunManifest) and the
// constants of src/types.ts. The plugin must NOT import the evaluation
// package (the eval package stays model-facing; the plugin ships standalone),
// so the validator is duplicated here on purpose. Keep the two in sync when
// the §9.1 schema changes; both are pinned by their own structure tests.

const MANIFEST_DEFAULTS = {
  budget: { attempts: 8, tokens: 200000, wallClockMs: 1800000 },
  allowHumanFidelity: false,
  tierPolicy: 'main',
  discovery: null,
}
const RUN_MANIFEST_FIELDS = ['goal', 'budget', 'allowHumanFidelity', 'tierPolicy', 'discovery', 'trustedExamples', 'createdAt']
const BUDGET_FIELDS = ['attempts', 'tokens', 'wallClockMs']
const DISCOVERY_FIELDS = ['selectionK', 'convergenceG', 'rngSeed', 'populationSize', 'programLanguage', 'evaluatorSignature']
const TRUSTED_EXAMPLE_FIELDS = ['problemId', 'source', 'sha256']
const TIER_POLICIES = ['main', 'delegated']

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPositiveInteger = value => typeof value === 'number' && Number.isInteger(value) && value > 0
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0

function unknownFieldErrors(value, allowed, path) {
  if (!isPlainObject(value)) return [`${path}: expected an object`]
  return Object.keys(value).filter(key => !allowed.includes(key)).map(key => `${path}: unknown field "${key}"`).sort()
}

function validateBudget(raw, errors) {
  const budget = raw.budget
  if (budget === undefined) return { ...MANIFEST_DEFAULTS.budget }
  if (!isPlainObject(budget)) { errors.push('budget: expected an object'); return { ...MANIFEST_DEFAULTS.budget } }
  errors.push(...unknownFieldErrors(budget, BUDGET_FIELDS, 'budget'))
  const value = { ...MANIFEST_DEFAULTS.budget }
  for (const field of BUDGET_FIELDS) {
    const given = budget[field]
    if (given === undefined) continue
    if (!isPositiveInteger(given)) errors.push(`budget.${field}: expected a positive integer`)
    else value[field] = given
  }
  return value
}

function validateDiscovery(raw, errors) {
  const discovery = raw.discovery
  if (discovery === undefined || discovery === null) return MANIFEST_DEFAULTS.discovery
  if (!isPlainObject(discovery)) { errors.push('discovery: expected an object or null'); return MANIFEST_DEFAULTS.discovery }
  errors.push(...unknownFieldErrors(discovery, DISCOVERY_FIELDS, 'discovery'))
  const value = { selectionK: 0, convergenceG: 0, rngSeed: 0, populationSize: 0, programLanguage: '', evaluatorSignature: '' }
  for (const field of ['selectionK', 'populationSize']) {
    const given = discovery[field]
    if (!isPositiveInteger(given)) errors.push(`discovery.${field}: expected a positive integer`)
    else value[field] = given
  }
  if (typeof discovery.rngSeed !== 'number' || !Number.isInteger(discovery.rngSeed)) errors.push('discovery.rngSeed: expected an integer')
  else value.rngSeed = discovery.rngSeed
  if (typeof discovery.convergenceG !== 'number' || !Number.isFinite(discovery.convergenceG) || discovery.convergenceG <= 0) errors.push('discovery.convergenceG: expected a positive number')
  else value.convergenceG = discovery.convergenceG
  for (const field of ['programLanguage', 'evaluatorSignature']) {
    const given = discovery[field]
    if (!isNonEmptyString(given)) errors.push(`discovery.${field}: expected a non-empty string`)
    else value[field] = given
  }
  return value
}

function validateTrustedExamples(raw, errors) {
  const trusted = raw.trustedExamples
  if (trusted === undefined) return []
  if (!Array.isArray(trusted)) { errors.push('trustedExamples: expected an array'); return [] }
  return trusted.map((entry, index) => {
    const path = `trustedExamples[${index}]`
    if (!isPlainObject(entry)) { errors.push(`${path}: expected an object`); return { problemId: '', source: '', sha256: '' } }
    errors.push(...unknownFieldErrors(entry, TRUSTED_EXAMPLE_FIELDS, path))
    const cleaned = { problemId: '', source: '', sha256: '' }
    for (const field of TRUSTED_EXAMPLE_FIELDS) {
      const given = entry[field]
      if (!isNonEmptyString(given)) errors.push(`${path}.${field}: expected a non-empty string`)
      else cleaned[field] = given
    }
    return cleaned
  })
}

/**
 * Validate a raw manifest against the §9.1 strict schema: unknown fields
 * rejected at every level; absent budget/discovery/tierPolicy/
 * allowHumanFidelity/trustedExamples take the written defaults; `goal` and
 * `createdAt` are required. Returns { ok: true, value } or
 * { ok: false, errors: sorted } — never throws.
 */
export function validateRunManifest(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: ['manifest: expected an object'] }
  const errors = unknownFieldErrors(raw, RUN_MANIFEST_FIELDS, 'manifest')
  const goal = raw.goal
  if (!isNonEmptyString(goal)) errors.push('goal: expected a non-empty string')
  const createdAt = raw.createdAt
  if (!isNonEmptyString(createdAt) || Number.isNaN(Date.parse(createdAt))) errors.push('createdAt: expected an ISO 8601 timestamp string')
  const allowHumanFidelity = raw.allowHumanFidelity
  if (allowHumanFidelity !== undefined && typeof allowHumanFidelity !== 'boolean') errors.push('allowHumanFidelity: expected a boolean')
  const tierPolicy = raw.tierPolicy
  if (tierPolicy !== undefined && !TIER_POLICIES.includes(tierPolicy)) errors.push(`tierPolicy: expected one of ${TIER_POLICIES.join('|')}`)
  const value = {
    goal: isNonEmptyString(goal) ? goal : '',
    budget: validateBudget(raw, errors),
    allowHumanFidelity: typeof allowHumanFidelity === 'boolean' ? allowHumanFidelity : MANIFEST_DEFAULTS.allowHumanFidelity,
    tierPolicy: TIER_POLICIES.includes(tierPolicy) ? tierPolicy : MANIFEST_DEFAULTS.tierPolicy,
    discovery: validateDiscovery(raw, errors),
    trustedExamples: validateTrustedExamples(raw, errors),
    createdAt: isNonEmptyString(createdAt) ? createdAt : '',
  }
  if (errors.length > 0) return { ok: false, errors: errors.sort() }
  return { ok: true, value }
}

export const MANIFEST_FIELD_DEFAULTS = MANIFEST_DEFAULTS
