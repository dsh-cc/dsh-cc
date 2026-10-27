// Strict version-one Lean manifest contract (design section 5) and the raw
// JSON token grammar shared by every Lean JSON surface (design section 7).
// Deliberately dependency-free: producers and read-only auditors both import
// it, and nothing here may decide a verdict differently between the two.

export const ID = /^[a-z][a-z0-9-]{0,63}$/
export const REQUIREMENT_ID = /^REQ-[1-9][0-9]*$/
export const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/
export const MAX_STATEMENT_BYTES = 16384
// Fixed project layout (design section 4). Paths are model-relative.
export const PROOF_SOURCES = Object.freeze(['Model.lean', 'Properties.lean', 'Reference.lean'])
export const ADAPTER = 'conformance/adapter.mjs'
export const CORPUS = 'conformance/cases.jsonl'
export const COMMAND = Object.freeze(['node', ADAPTER])
export const COMPARISON = 'canonical-json'
// The pin check compares this against trimmed `lean --short-version` output.
export const LEAN_SPEC_VERSION = '4.35.0'
export const PLATFORMS = Object.freeze(['linux-x64', 'darwin-arm64'])
export const ALLOWED_AXIOMS = Object.freeze(['propext', 'Classical.choice', 'Quot.sound'])
// Closed reason-code list from design section 8.
export const REASON_CODES = Object.freeze(['config-invalid', 'unsafe-path', 'missing-input', 'toolchain-missing', 'toolchain-mismatch', 'io'])

export function fail(code, detail) { throw Object.assign(new Error(detail), { code, detail }) }
export function assert(ok, detail) { if (!ok) fail('config-invalid', detail) }

export function compareCodepoint(a, b) {
  const left = Array.from(a, c => c.codePointAt(0)); const right = Array.from(b, c => c.codePointAt(0))
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i]
  return left.length - right.length
}

// ---------------------------------------------------------------------------
// Raw JSON token grammar (section 7). Duplicate keys, numeric spelling and
// duplicate-ness are decided on the raw text before any value exists, so Lean
// and Node cannot disagree about tokens that a permissive parser collapses.
// ---------------------------------------------------------------------------
const CANONICAL_NUMBER = /^-?(?:0|[1-9][0-9]*)$/
const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const invalid = detail => fail('config-invalid', `invalid JSON: ${detail}`)
const scalar = value => LONE_SURROGATE.test(value) ? invalid('string is not a sequence of Unicode scalar values') : value
// Assignment through a property setter would let a "__proto__" key mutate the
// prototype chain instead of producing a plain key.
const define = (object, key, value) => { Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true }); return object }

export function parseJsonTokens(text) {
  if (typeof text !== 'string') invalid('document must be text')
  let i = 0
  const ws = () => { while (WHITESPACE.has(text[i])) i++ }
  const literal = (word, value) => { if (!text.startsWith(word, i)) invalid(`unexpected token at offset ${i}`); i += word.length; return value }
  const string = () => {
    const start = i; i++ // opening quote
    while (i < text.length) {
      const char = text[i]
      if (char === '\\') { i += 2; continue }
      if (char === '"') {
        i++
        let value
        try { value = JSON.parse(text.slice(start, i)) } catch { return invalid('malformed string escape or literal control character') }
        return scalar(value)
      }
      i++
    }
    return invalid('unterminated string')
  }
  const number = () => {
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(i))
    if (!match) return invalid(`invalid number at offset ${i}`)
    const raw = match[0]
    const next = text[i + raw.length]
    if (next === '.' || next === 'e' || next === 'E' || (next >= '0' && next <= '9')) invalid('fractions, exponents and leading zeros are not allowed')
    if (!CANONICAL_NUMBER.test(raw) || raw === '-0') invalid(`number ${raw} is not canonical`)
    const value = Number(raw)
    if (!Number.isSafeInteger(value)) invalid(`number ${raw} is outside the safe-integer range`)
    i += raw.length
    return value
  }
  const value = () => {
    ws()
    const char = text[i]
    if (char === '{') {
      i++; const object = {}; const keys = new Set()
      ws()
      if (text[i] === '}') { i++; return object }
      for (;;) {
        ws()
        if (text[i] !== '"') invalid(`expected object key at offset ${i}`)
        const key = string()
        if (keys.has(key)) invalid(`duplicate object key: ${key}`)
        keys.add(key); ws()
        if (text[i] !== ':') invalid('expected colon')
        i++
        define(object, key, value()); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return object }
        return invalid('expected comma or closing brace')
      }
    }
    if (char === '[') {
      i++; const array = []; ws()
      if (text[i] === ']') { i++; return array }
      for (;;) {
        array.push(value()); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return array }
        return invalid('expected comma or closing bracket')
      }
    }
    if (char === '"') return string()
    if (char === 't') return literal('true', true)
    if (char === 'f') return literal('false', false)
    if (char === 'n') return literal('null', null)
    if (char === '-' || (char >= '0' && char <= '9')) return number()
    return invalid(`unexpected token at offset ${i}`)
  }
  const result = value()
  ws()
  if (i !== text.length) invalid('trailing content after the JSON value')
  return result
}

// Canonical serialization: object keys sorted by Unicode code point, array
// order and scalar spelling preserved, no insignificant whitespace.
export function canonicalJson(value) {
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'boolean') return value ? 'true' : 'false'
  if (kind === 'number') {
    if (!Number.isSafeInteger(value)) invalid('canonical numbers must be safe integers')
    if (Object.is(value, -0)) invalid('canonical numbers must not be -0')
    return String(value)
  }
  if (kind === 'string') return JSON.stringify(scalar(value))
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (kind === 'object') {
    const keys = Object.keys(value).sort(compareCodepoint)
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return invalid('unsupported value in canonical JSON')
}

// ---------------------------------------------------------------------------
// Statement shape (section 5). The witness rule is the conservative syntactic
// top-level arrow test: a leading forall/∀ telescope binds variables before the
// matrix, so it must not hide an implication in that matrix.
// ---------------------------------------------------------------------------
const TELESCOPE = /^\s*(?:∀|forall)(?![\p{L}\p{N}_'])/u
function binderComma(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) return i
  }
  return -1
}
export function statementMatrix(statement) {
  let rest = statement
  for (;;) {
    const match = TELESCOPE.exec(rest)
    if (!match) return rest
    const comma = binderComma(rest, match[0].length)
    if (comma < 0) return rest.slice(match[0].length).trimStart()
    rest = rest.slice(comma + 1).trimStart()
  }
}
// Ceiling: arrows nested inside parenthesised subformulas also count. That only
// ever demands a witness, so the rule stays conservative.
export const hasTopLevelArrow = statement => /->|→/.test(statementMatrix(statement))

// ---------------------------------------------------------------------------
// Manifest (section 5).
// ---------------------------------------------------------------------------
function exact(value, keys, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const unknown = Object.keys(value).filter(key => !keys.includes(key))
  assert(unknown.length === 0, `${label} has unknown field(s): ${unknown.join(',')}`)
  const missing = keys.filter(key => !Object.hasOwn(value, key))
  assert(missing.length === 0, `${label} is missing field(s): ${missing.join(',')}`)
}
// Project-relative means repository-root-relative, and must stay a plain path:
// no absolute form, no traversal, no empty or dot segment, no backslashes.
export function projectRelativePath(path, label = 'declared path') {
  assert(typeof path === 'string' && path.length > 0, `${label} must be a nonempty string`)
  assert(!path.startsWith('/') && !path.includes('\\') && !/^[A-Za-z]:/.test(path), `${label} must be project-relative: ${path}`)
  assert(path.split('/').every(segment => segment && segment !== '.' && segment !== '..'), `${label} is unsafe: ${path}`)
  return path
}
const bytes = text => Buffer.byteLength(text, 'utf8')

export function parseLeanManifest(text) {
  const m = parseJsonTokens(text)
  assert(m !== null && typeof m === 'object' && !Array.isArray(m), 'manifest must be an object')
  const allowed = ['schemaVersion', 'backend', 'modelId', 'properties', 'limits', 'conformance']
  const unknown = Object.keys(m).filter(key => !allowed.includes(key))
  assert(unknown.length === 0, `manifest has unknown field(s): ${unknown.join(',')}`)
  assert(m.schemaVersion === 1 && m.backend === 'lean', 'manifest must be schemaVersion 1 with backend "lean"')
  assert(typeof m.modelId === 'string' && ID.test(m.modelId), 'modelId must match the model-id grammar')
  assert(Array.isArray(m.properties) && m.properties.length >= 1 && m.properties.length <= 64, 'properties must contain 1..64 entries')
  const ids = new Set()
  for (const property of m.properties) {
    exact(property, ['id', 'requirementId', 'declaration', 'statement', 'witnessDeclaration'], 'property')
    assert(typeof property.id === 'string' && ID.test(property.id) && !ids.has(property.id), 'property id invalid or duplicate')
    ids.add(property.id)
    assert(typeof property.requirementId === 'string' && REQUIREMENT_ID.test(property.requirementId), 'requirementId must match REQ-[1-9][0-9]*')
    assert(typeof property.declaration === 'string' && QUALIFIED.test(property.declaration), 'declaration must be a dot-separated Lean identifier')
    assert(typeof property.statement === 'string' && bytes(property.statement) >= 1 && bytes(property.statement) <= MAX_STATEMENT_BYTES, `statement must be 1..${MAX_STATEMENT_BYTES} UTF-8 bytes`)
    const arrow = hasTopLevelArrow(property.statement)
    if (property.witnessDeclaration === null) assert(!arrow, `property ${property.id} states a top-level implication and needs a witnessDeclaration`)
    else assert(typeof property.witnessDeclaration === 'string' && QUALIFIED.test(property.witnessDeclaration), 'witnessDeclaration must be null or a dot-separated Lean identifier')
    assert(arrow || property.witnessDeclaration === null, `property ${property.id} has no top-level implication, so witnessDeclaration must be null`)
  }
  exact(m.limits, ['proofTimeoutMs', 'conformanceTimeoutMs', 'maxHeartbeats', 'maxRecDepth', 'maxCases'], 'limits')
  const range = (name, min, max) => assert(Number.isInteger(m.limits[name]) && m.limits[name] >= min && m.limits[name] <= max, `${name} must be an integer in ${min}..${max}`)
  range('proofTimeoutMs', 1000, 600000); range('conformanceTimeoutMs', 1000, 600000)
  range('maxHeartbeats', 1000, 10000000); range('maxRecDepth', 128, 4096); range('maxCases', 1, 100000)
  if (Object.hasOwn(m, 'conformance')) {
    const c = m.conformance
    exact(c, ['adapter', 'corpus', 'implementationFiles', 'executionFiles', 'command', 'comparison'], 'conformance')
    assert(c.adapter === ADAPTER && c.corpus === CORPUS, `adapter and corpus must be exactly ${ADAPTER} and ${CORPUS}`)
    assert(Array.isArray(c.command) && c.command.length === COMMAND.length && c.command.every((part, index) => part === COMMAND[index]), `command must be exactly ${JSON.stringify(COMMAND)}`)
    assert(c.comparison === COMPARISON, `comparison must be ${COMPARISON}`)
    assert(Array.isArray(c.implementationFiles) && c.implementationFiles.length >= 1, 'implementationFiles must be a nonempty array')
    assert(Array.isArray(c.executionFiles), 'executionFiles must be an array')
    const paths = [...c.implementationFiles, ...c.executionFiles]
    for (const path of paths) projectRelativePath(path)
    assert(new Set(paths).size === paths.length, 'duplicate declared path across implementationFiles/executionFiles')
  }
  return m
}

export function sortBlockers(entries) {
  const sorted = [...entries].sort((a, b) => REASON_CODES.indexOf(a.code) - REASON_CODES.indexOf(b.code) || compareCodepoint(a.relativePath ?? '', b.relativePath ?? '') || compareCodepoint(a.detail, b.detail))
  const seen = new Set()
  return sorted.filter(b => { const key = JSON.stringify([b.code, b.detail]); if (seen.has(key)) return false; seen.add(key); return true }).map(({ code, detail }) => ({ code, detail }))
}
