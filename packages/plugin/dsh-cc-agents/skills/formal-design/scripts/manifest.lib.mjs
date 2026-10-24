// Dependency-free contracts shared by the producer and read-only auditor.
export const RESERVED = Object.freeze(['SPECIFICATION', 'CONSTANT', 'CONSTANTS', 'INVARIANT', 'PROPERTIES', 'PROPERTY', 'CONSTRAINT', 'ACTION_CONSTRAINT', 'SYMMETRY', 'VIEW', 'CHECK_DEADLOCK', 'INIT', 'NEXT', 'CONSTRAINTS', 'ACTION_CONSTRAINTS', 'INVARIANTS', 'TYPE', 'TYPE_CONSTRAINT'])
export const ID = /^[a-z][a-z0-9-]{0,63}$/
export const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/
export function fail(code, detail) { throw Object.assign(new Error(detail), { code, detail }) }
export function assert(ok, detail) { if (!ok) fail('config-invalid', detail) }
export function object(value, keys, label = 'object') {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), `${label} fields must be exactly ${keys.join(',')}`)
}
// A recursive JSON grammar pass detects decoded duplicate keys before JSON.parse.
// JSON.parse still provides the final syntax/value validation.
export function parseJson(text) {
  let i = 0
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++ }
  function string() {
    const start = i++
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i))
    }
    throw new Error('unterminated JSON string')
  }
  function value() {
    ws()
    if (text[i] === '{') {
      i++; ws(); const keys = new Set()
      if (text[i] === '}') { i++; return }
      while (i < text.length) {
        ws(); if (text[i] !== '"') throw new Error('expected JSON key')
        const key = string(); if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`); keys.add(key)
        ws(); if (text[i++] !== ':') throw new Error('expected colon'); value(); ws()
        const end = text[i++]; if (end === '}') return; if (end !== ',') throw new Error('expected comma')
      }
    } else if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return }
      while (i < text.length) { value(); ws(); const end = text[i++]; if (end === ']') return; if (end !== ',') throw new Error('expected comma') }
    } else if (text[i] === '"') { string(); return }
    else { const m = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i)); if (!m) throw new Error('invalid JSON value'); i += m[0].length; return }
    throw new Error('incomplete JSON')
  }
  try { value(); ws(); if (i !== text.length) throw new Error('trailing JSON'); return JSON.parse(text) }
  catch (e) { fail('config-invalid', `invalid JSON: ${e.message}`) }
}
const identifier = x => typeof x === 'string' && IDENT.test(x) && !RESERVED.includes(x)
export function canonicalValue(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 512, 'constant must be a string of 1..512 characters')
  const atom = x => /^(?:0|[1-9][0-9]*)$/.test(x) ? BigInt(x) <= 2147483647n : identifier(x)
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1)
    if (!inner) return '{}'
    const parts = inner.split(/, ?/)
    assert(parts.every(atom), 'invalid finite set constant')
    return `{${parts.join(', ')}}`
  }
  assert(atom(value), 'invalid constant atom'); return value
}
export function parseManifest(text) {
  const m = parseJson(text)
  object(m, ['schemaVersion', 'modelId', 'module', 'cases'], 'manifest')
  assert(m.schemaVersion === 1 && typeof m.modelId === 'string' && ID.test(m.modelId) && identifier(m.module), 'invalid manifest identity')
  assert(Array.isArray(m.cases) && m.cases.length >= 1 && m.cases.length <= 16, 'cases length must be 1..16')
  const ids = new Set()
  for (const c of m.cases) {
    object(c, ['id', 'coverage', 'specification', 'constants', 'invariants', 'properties', 'limits'], 'case')
    assert(typeof c.id === 'string' && ID.test(c.id) && !ids.has(c.id), 'case id invalid or duplicate'); ids.add(c.id)
    assert(['core', 'expansion'].includes(c.coverage) && identifier(c.specification), 'invalid coverage or specification')
    assert(c.constants !== null && typeof c.constants === 'object' && !Array.isArray(c.constants), 'constants must be an object')
    for (const [k, v] of Object.entries(c.constants)) { assert(identifier(k), 'invalid constant identifier'); canonicalValue(v) }
    for (const k of ['invariants', 'properties']) assert(Array.isArray(c[k]) && c[k].every(identifier) && new Set(c[k]).size === c[k].length, `invalid ${k}`)
    assert(c.invariants.length > 0, 'an invariant is required')
    object(c.limits, ['timeoutMs', 'heapMiB'], 'limits')
    assert(Number.isInteger(c.limits.timeoutMs) && c.limits.timeoutMs >= 1000 && c.limits.timeoutMs <= 600000, 'timeoutMs out of range')
    assert(Number.isInteger(c.limits.heapMiB) && c.limits.heapMiB >= 256 && c.limits.heapMiB <= 4096, 'heapMiB out of range')
  }
  assert(m.cases.some(c => c.coverage === 'core'), 'at least one core case is required')
  return m
}
export function compare(a, b) {
  const aa = Array.from(a, c => c.codePointAt(0)); const bb = Array.from(b, c => c.codePointAt(0))
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i]
  return aa.length - bb.length
}
export function generateCfg(c) {
  return [`SPECIFICATION ${c.specification}`, ...(Object.keys(c.constants).length ? ['CONSTANTS', ...Object.keys(c.constants).sort(compare).map(k => `${k} = ${canonicalValue(c.constants[k])}`)] : []), ...c.invariants.map(x => `INVARIANT ${x}`), ...c.properties.map(x => `PROPERTY ${x}`), 'CHECK_DEADLOCK TRUE', ''].join('\n')
}
const priority = ['usage-invalid', 'model-path-unsafe', 'unsupported-platform', 'config-invalid', 'input-limit', 'config-drift', 'java-missing', 'java-version', 'jar-missing', 'jar-checksum', 'io']
export function sortBlockers(entries) {
  const sorted = [...entries].sort((a, b) => priority.indexOf(a.code) - priority.indexOf(b.code) || compare(a.relativePath ?? '', b.relativePath ?? '') || compare(a.caseId ?? '', b.caseId ?? '') || compare(a.detail, b.detail))
  const seen = new Set()
  return sorted.filter(b => { const k = JSON.stringify([b.code, b.detail]); if (seen.has(k)) return false; seen.add(k); return true }).map(({ code, detail }) => ({ code, detail }))
}
