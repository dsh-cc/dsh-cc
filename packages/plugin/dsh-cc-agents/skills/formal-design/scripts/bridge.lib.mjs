// Strict combined TLA+/Lean bridge contract (design section 10). Dependency-free
// beyond the shared token grammar so both backends' producers and the read-only
// combined auditor decide the same thing from the same bytes.
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  ID, REQUIREMENT_ID, QUALIFIED, assert, canonicalJson, compareCodepoint, fail, parseJsonTokens, projectRelativePath,
} from './lean-manifest.lib.mjs'
import { hashFile } from './lean-fingerprint.lib.mjs'

// specs/formal/<feature-id>/bridge.json, project-relative (section 10).
export const BRIDGE_PATH = /^specs\/formal\/([a-z][a-z0-9-]{0,63})\/bridge\.json$/
export const TLA_MODEL = /^specs\/tla\/[a-z][a-z0-9-]{0,63}$/
export const LEAN_MODEL = /^specs\/lean\/[a-z][a-z0-9-]{0,63}$/
// TLA+ operator names use the TLA identifier grammar; Lean names the shared
// dot-separated identifier grammar.
export const TLA_OPERATOR = /^[A-Za-z][A-Za-z0-9_]*$/
// The bridge case ID grammar is the corpus grammar: both exclude underscores, so
// hyphen-to-underscore for Bridge_<id> stays injective.
export const BRIDGE_CASE_ID = ID
export const CASE_FILE_LIMIT = 1024 * 1024
export const BRIDGE_LIMIT = 10 * 1024 * 1024
export const MAX_OPERATIONS = 64
const ERROR_CODE = /^[a-z][a-z0-9-]{0,63}$/
const OPERATION_FIELDS = ['id', 'requirementId', 'tlaOperator', 'leanFunction', 'propertyIds', 'domain', 'casesFile', 'implementationFiles']
const CASE_FIELDS = ['id', 'input', 'expected', 'tlaExpression']

function exact(value, fields, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const keys = Object.keys(value)
  assert(keys.length === fields.length && fields.every(field => Object.hasOwn(value, field)), `${label} fields must be exactly ${fields.join(',')}`)
  return value
}

export const bridgePathFor = featureId => `specs/formal/${featureId}/bridge.json`
// Deterministic sibling derived from the declared path; never read from Markdown.
export const bridgeMarkdownFor = bridgeRelative => bridgeRelative.replace(/bridge\.json$/, 'bridge.md')
// Bridge_<id> with every hyphen replaced by an underscore (section 10).
export const derivedInvariant = id => `Bridge_${id.replace(/-/g, '_')}`

// The conformance protocol result (section 7) again, for bridge `expected`.
// Kept local so the TLC side never loads the Lean conformance stack.
function validateExpected(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: expected must be an object`)
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === 'ok') return
  if (keys.length === 1 && keys[0] === 'error') {
    exact(value.error, ['code'], `${label}: expected error`)
    assert(typeof value.error.code === 'string' && ERROR_CODE.test(value.error.code), `${label}: expected error code must match [a-z][a-z0-9-]{0,63}`)
    return
  }
  fail('config-invalid', `${label}: expected must be exactly {"ok": ...} or {"error": {"code": ...}}`)
}

export function parseBridge(text) {
  const bridge = parseJsonTokens(text)
  exact(bridge, ['schemaVersion', 'featureId', 'tlaModel', 'leanModel', 'operations'], 'bridge')
  assert(bridge.schemaVersion === 1, 'bridge schemaVersion must be 1')
  assert(typeof bridge.featureId === 'string' && ID.test(bridge.featureId), 'bridge featureId must match the model-id grammar')
  assert(typeof bridge.tlaModel === 'string' && TLA_MODEL.test(bridge.tlaModel), 'bridge tlaModel must be specs/tla/<id>')
  assert(typeof bridge.leanModel === 'string' && LEAN_MODEL.test(bridge.leanModel), 'bridge leanModel must be specs/lean/<id>')
  assert(Array.isArray(bridge.operations) && bridge.operations.length >= 1 && bridge.operations.length <= MAX_OPERATIONS, `bridge operations must contain 1..${MAX_OPERATIONS} rows`)
  const ids = new Set()
  for (const row of bridge.operations) {
    exact(row, OPERATION_FIELDS, 'bridge operation')
    assert(typeof row.id === 'string' && BRIDGE_CASE_ID.test(row.id) && !ids.has(row.id), 'bridge operation id invalid or duplicate')
    ids.add(row.id)
    assert(typeof row.requirementId === 'string' && REQUIREMENT_ID.test(row.requirementId), 'bridge requirementId must match REQ-[1-9][0-9]*')
    assert(typeof row.tlaOperator === 'string' && TLA_OPERATOR.test(row.tlaOperator), 'bridge tlaOperator must be a TLA identifier')
    assert(typeof row.leanFunction === 'string' && QUALIFIED.test(row.leanFunction), 'bridge leanFunction must be a dot-separated Lean identifier')
    assert(Array.isArray(row.propertyIds) && row.propertyIds.length > 0 && row.propertyIds.every(id => typeof id === 'string' && ID.test(id)), 'bridge propertyIds must be a nonempty list of property ids')
    assert(new Set(row.propertyIds).size === row.propertyIds.length, 'bridge propertyIds must be unique')
    assert(typeof row.domain === 'string' && row.domain.trim().length > 0, 'bridge domain must be a nonempty explanation')
    projectRelativePath(row.casesFile, 'bridge casesFile')
    assert(row.casesFile.endsWith('.json'), 'bridge casesFile must be a JSON file path')
    assert(Array.isArray(row.implementationFiles), 'bridge implementationFiles must be an array')
    for (const path of row.implementationFiles) projectRelativePath(path, 'bridge implementationFiles')
    assert(new Set(row.implementationFiles).size === row.implementationFiles.length, 'bridge implementationFiles must be unique')
  }
  return bridge
}

async function regularFile(root, path) {
  const absolute = join(root, path)
  let stat
  try { stat = await fs.lstat(absolute) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('missing-input', `bridge input is missing: ${path}`)
    throw error
  }
  if (stat.isSymbolicLink()) fail('unsafe-path', `bridge input must not be a symlink: ${path}`)
  if (!stat.isFile()) fail('unsafe-path', `bridge input must be a regular file: ${path}`)
  return stat
}

/**
 * Read and validate the bridge package header and enumerate bridge.json,
 * bridge.md and every declared casesFile with regular-file and size checks
 * (section 10). Returns the sorted {path, sha256} entries used by both backends'
 * input enumerations.
 */
export async function loadBridge(root, bridgeRelative) {
  assert(typeof bridgeRelative === 'string' && BRIDGE_PATH.test(bridgeRelative), '--bridge must be specs/formal/<feature-id>/bridge.json')
  let raw
  try { raw = await fs.readFile(join(root, bridgeRelative), 'utf8') } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('missing-input', `bridge.json is missing: ${bridgeRelative}`)
    throw error
  }
  const bridge = parseBridge(raw)
  const markdown = bridgeMarkdownFor(bridgeRelative)
  const casesFiles = [...new Set(bridge.operations.map(({ casesFile }) => casesFile))]
  const paths = [...new Set([bridgeRelative, markdown, ...casesFiles])].sort(compareCodepoint)
  const entries = []
  let total = 0
  for (const path of paths) {
    const stat = await regularFile(root, path)
    // Case files are capped individually; the package total covers the rest.
    if (path !== bridgeRelative && path !== markdown && stat.size > CASE_FILE_LIMIT) fail('config-invalid', `bridge case file exceeds 1 MiB: ${path}`)
    total += stat.size
    if (total > BRIDGE_LIMIT) fail('config-invalid', 'bridge package exceeds 10 MiB')
    entries.push({ path, sha256: await hashFile(join(root, path)) })
  }
  return { bridge, bridgeRelative, markdown, casesFiles, entries }
}

/** The loaded bridge applies to the model being checked (section 10). */
export function bridgeMatchesModel(loaded, modelRelative) {
  if (typeof modelRelative !== 'string') return false
  if (modelRelative.startsWith('specs/tla/')) return loaded.bridge.tlaModel === modelRelative
  if (modelRelative.startsWith('specs/lean/')) return loaded.bridge.leanModel === modelRelative
  return false
}

// The selected Lean manifest's implementation closure: its declared
// implementationFiles entries (section 5).
export function implementationClosure(manifest) {
  return new Set(manifest.conformance?.implementationFiles ?? [])
}

/**
 * Validate every declared cases file against the selected Lean manifest and the
 * committed Lean corpus (section 10): strict row schema, ID equality with a
 * committed corpus case, canonical input equality, protocol-shaped expected, and
 * the operation-level propertyIds/covers join.
 */
export async function validateBridgeContract(root, loaded, { manifest, corpus }) {
  const properties = new Set(manifest.properties.map(({ id }) => id))
  const closure = implementationClosure(manifest)
  const byId = new Map(corpus.map(entry => [entry.id, entry]))
  for (const row of loaded.bridge.operations) {
    for (const id of row.propertyIds) assert(properties.has(id), `bridge operation ${row.id} names an undeclared property: ${id}`)
    for (const path of row.implementationFiles) assert(closure.has(path), `bridge operation ${row.id} binds a file outside the Lean implementation closure: ${path}`)
    const joined = byId.get(row.id)
    assert(joined, `bridge operation ${row.id} does not name a committed Lean corpus case`)
    assert(canonicalJson([...row.propertyIds].sort(compareCodepoint)) === canonicalJson([...joined.covers].sort(compareCodepoint)), `bridge operation ${row.id} propertyIds must equal the corpus case covers set`)
  }
  const seen = new Set()
  const rows = []
  for (const casesFile of loaded.casesFiles) {
    let bytes
    try { bytes = await fs.readFile(join(root, casesFile)) } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('missing-input', `bridge cases file is missing: ${casesFile}`)
      throw error
    }
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('config-invalid', `bridge cases file is not valid UTF-8: ${casesFile}`) }
    let values
    try { values = parseJsonTokens(text) } catch (error) { fail('config-invalid', `${casesFile}: ${error.detail ?? 'invalid JSON'}`) }
    assert(Array.isArray(values), `bridge cases file must be an array: ${casesFile}`)
    values.forEach((value, index) => {
      const label = `${casesFile} row ${index + 1}`
      exact(value, CASE_FIELDS, label)
      assert(typeof value.id === 'string' && BRIDGE_CASE_ID.test(value.id), `${label}: id must match the corpus case-id grammar`)
      assert(!seen.has(value.id), `${label}: duplicate bridge case id ${value.id}`)
      seen.add(value.id)
      const joined = byId.get(value.id)
      assert(joined, `${label}: id must equal a committed Lean corpus case id`)
      assert(canonicalJson(value.input) === canonicalJson(joined.input), `${label}: input is not canonically equal to the corpus case input`)
      validateExpected(value.expected, label)
      assert(typeof value.tlaExpression === 'string' && value.tlaExpression.trim().length > 0, `${label}: tlaExpression must be authored source text`)
      rows.push({ casesFile, id: value.id, input: value.input, expected: value.expected, tlaExpression: value.tlaExpression })
    })
  }
  return { rows }
}

// A complete cfg identifier token: delimited by whitespace or line boundaries
// (section 10). Bridge_a must not be satisfied by Bridge_a_b.
export function cfgDeclares(cfgText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s])${escaped}(?=[\\s]|$)`, 'm').test(cfgText)
}

// A complete TLA+ identifier token in a module's source text.
export function moduleDeclares(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'm').test(source)
}
