/**
 * Strict schema validators for dsh-cc-writing run artifacts (plan §5).
 *
 * Style: every validator returns {ok:true, value} with a normalized copy, or
 * {ok:false, code:"INVALID_INPUT", message, details} without throwing, so the
 * CLI can map failures to exit code 2. Unknown properties are rejected at
 * every level. Cross-artifact checks (brief vs plan vs run) are the caller's
 * responsibility; this module only sees one artifact at a time.
 */

export class InvalidInput extends Error {}

export function invalid(message) {
  throw new InvalidInput(message)
}

export function validate(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    if (error instanceof InvalidInput) return { ok: false, code: 'INVALID_INPUT', message: error.message, details: {} }
    throw error
  }
}

// ---------------------------------------------------------------- primitives

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const HASH_RE = /^[0-9a-f]{64}$/
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
export const QUESTION_ID_RE = /^q[1-9][0-9]*$/
export const SECTION_ID_RE = /^s[1-9][0-9]*$/
export const SOURCE_ID_RE = /^src[1-9][0-9]*$/

export function isUuidV4(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function isSha256Hex(value) {
  return typeof value === 'string' && HASH_RE.test(value)
}

export function isIso8601Utc(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value))
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject non-objects, missing required keys, and any key outside required ∪ optional. */
export function readObject(value, path, required, optional = []) {
  if (!isPlainObject(value)) invalid(`${path}: expected an object`)
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}: unknown property "${key}"`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${path}: missing required property "${key}"`)
  }
  return value
}

export function readString(value, path, { nullable = false, nonempty = true } = {}) {
  if (value === null && nullable) return null
  if (typeof value !== 'string') invalid(`${path}: expected a string`)
  if (nonempty && value.length === 0) invalid(`${path}: expected a nonempty string`)
  return value
}

export function readBoolean(value, path) {
  if (typeof value !== 'boolean') invalid(`${path}: expected a boolean`)
  return value
}

export function readInteger(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value)) invalid(`${path}: expected an integer`)
  if (value < min || value > max) invalid(`${path}: expected an integer in ${min}..${max}`)
  return value
}

export function readEnum(value, path, allowed) {
  if (!allowed.includes(value)) invalid(`${path}: expected one of ${allowed.join(', ')}`)
  return value
}

export function readLiteral(value, path, expected) {
  if (value !== expected) invalid(`${path}: expected ${JSON.stringify(expected)}`)
  return value
}

export function readArray(value, path) {
  if (!Array.isArray(value)) invalid(`${path}: expected an array`)
  return value
}

export function mapArray(value, path, fn) {
  return readArray(value, path).map((entry, index) => fn(entry, `${path}[${index}]`))
}

export function readStringArray(value, path) {
  return mapArray(value, path, (entry, at) => readString(entry, at))
}

export function readUnique(items, path, label) {
  const seen = new Set()
  for (const item of items) {
    if (seen.has(item)) invalid(`${path}: duplicate ${label} "${item}"`)
    seen.add(item)
  }
  return items
}

export function readUuid(value, path) {
  if (!isUuidV4(value)) invalid(`${path}: expected a UUID v4`)
  return value
}

export function readHash(value, path, { nullable = false } = {}) {
  if (value === null && nullable) return null
  if (!isSha256Hex(value)) invalid(`${path}: expected a 64-character lowercase hex SHA-256 hash`)
  return value
}

export function readIso(value, path, { nullable = false } = {}) {
  if (value === null && nullable) return null
  if (!isIso8601Utc(value)) invalid(`${path}: expected an ISO 8601 UTC timestamp`)
  return value
}

export function readIdPattern(value, path, pattern, label) {
  const id = readString(value, path)
  if (!pattern.test(id)) invalid(`${path}: expected an id matching ${label}`)
  return id
}

// -------------------------------------------------------------------- enums

export const OPERATIONS = ['write', 'review', 'edit']
export const LANGUAGES = ['zh', 'en']
export const PROFILES = ['technical', 'research', 'opinion', 'technical-ste']
export const EVIDENCE_MODES = ['ordinary', 'vwa']
export const PHASES = [
  'initialized',
  'researched',
  'planned',
  'drafted',
  'diagnosed',
  'structurally-revised',
  'language-revised',
  'checked',
  'finalized',
]
export const OUTCOMES = ['active', 'blocked', 'cancelled', 'completed']
export const PURPOSES = ['background', 'definition', 'evidence', 'inference', 'objection', 'recommendation', 'conclusion']
export const STAGES = ['structure', 'language', 'semantics']
export const CATEGORIES = [
  'unsupported-inference',
  'missing-premise',
  'contradiction',
  'scope',
  'coverage',
  'order',
  'repetition',
  'paragraph-purpose',
  'ambiguity',
  'verbosity',
  'register',
  'terminology',
  'citation-change',
  'number-change',
  'quote-change',
  'meaning-change',
]
export const FINDING_STATUSES = ['open', 'rejected']
export const SEVERITIES = ['major', 'minor']
export const PROPOSAL_INTENTS = ['structure', 'clarity', 'concision', 'style', 'semantic-repair']
export const CHANGE_TYPES = ['number', 'quotation', 'citation', 'link', 'code', 'term']
export const DISPOSITIONS = ['pending', 'expected', 'defect']
export const SEMANTIC_STATUSES = ['not-run', 'no-issue-found', 'issues-found', 'incomplete']
export const MECHANICAL_STATUSES = ['clean', 'changed']
export const LANGUAGE_INTENTS = ['clarity', 'concision-style']

