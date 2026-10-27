import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED_AXIOMS, PLATFORMS, canonicalJson, compareCodepoint, fail, parseJsonTokens } from './lean-manifest.lib.mjs'

export const SCRIPTS = fileURLToPath(new URL('.', import.meta.url))
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const posix = path => path.split(sep).join('/')
export const inside = (root, path) => path === root || path.startsWith(root + sep)
export async function exists(path) { try { await fs.lstat(path); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
export async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
// Invalid UTF-8 is rejected instead of being silently replaced (section 5).
export async function readUtf8(path, label, code = 'config-invalid') {
  const bytes = await fs.readFile(path)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { fail(code, `${label} is not valid UTF-8`) }
}
// Existing digestEntries algorithm (design section 8): SHA-256 over the JSON
// array of sorted, project-relative [path, sha256] pairs. Kept order-preserving
// so callers hash exactly the sorted list they publish.
export const digestEntries = entries => sha256(Buffer.from(JSON.stringify(entries.map(({ path, sha256 }) => [path, sha256]))))
export const canonicalDigest = value => sha256(Buffer.from(canonicalJson(value)))

// design section 8: executionDigest hashes the canonical JSON object
// { files, node, proofInputDigest }.
export function executionDigestPayload(files, nodeIdentity, proofInputDigest) {
  return { files: files.map(({ path, sha256 }) => [path, sha256]), node: nodeIdentity, proofInputDigest }
}
export const executionDigest = (files, nodeIdentity, proofInputDigest) => canonicalDigest(executionDigestPayload(files, nodeIdentity, proofInputDigest))

// Design section 6 platform names, derived from the runtime rather than from
// operating-system release names.
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  return null
}

export async function loadToolchain(dir = SCRIPTS) {
  let text
  try { text = await fs.readFile(join(dir, 'lean-toolchain.json'), 'utf8') }
  catch (e) { throw Object.assign(new Error(e.code === 'ENOENT' ? 'lean-toolchain.json is missing' : 'lean-toolchain.json is unreadable'), { code: 'toolchain-missing', detail: e.code === 'ENOENT' ? 'lean-toolchain.json is missing' : 'lean-toolchain.json is unreadable' }) }
  const pin = parseJsonTokens(text)
  const fields = ['schemaVersion', 'toolchain', 'platforms', 'allowedAxioms']
  if (pin === null || typeof pin !== 'object' || Array.isArray(pin) || Object.keys(pin).sort(compareCodepoint).join(',') !== [...fields].sort(compareCodepoint).join(',')) fail('config-invalid', `toolchain pin fields must be exactly ${fields.join(',')}`)
  if (pin.schemaVersion !== 1 || typeof pin.toolchain !== 'string' || !/^leanprover\/lean4:v[0-9]+\.[0-9]+\.[0-9]+$/.test(pin.toolchain)) fail('config-invalid', 'invalid toolchain pin identity')
  const platforms = pin.platforms
  if (platforms === null || typeof platforms !== 'object' || Array.isArray(platforms) || Object.keys(platforms).sort(compareCodepoint).join(',') !== [...PLATFORMS].sort(compareCodepoint).join(',')) fail('config-invalid', `toolchain pin platforms must be exactly ${PLATFORMS.join(',')}`)
  for (const name of PLATFORMS) {
    const entry = platforms[name]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort(compareCodepoint).join(',') !== 'archiveUrl,sha256') fail('config-invalid', `platform ${name} must contain exactly archiveUrl and sha256`)
    if (typeof entry.archiveUrl !== 'string' || !/^https:\/\//.test(entry.archiveUrl) || !entry.archiveUrl.endsWith('.tar.zst')) fail('config-invalid', `platform ${name} archiveUrl must be an https .tar.zst URL`)
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('config-invalid', `platform ${name} sha256 must be lowercase hex`)
  }
  if (!Array.isArray(pin.allowedAxioms) || pin.allowedAxioms.length !== ALLOWED_AXIOMS.length || !pin.allowedAxioms.every((name, index) => name === ALLOWED_AXIOMS[index])) fail('config-invalid', `allowedAxioms must be exactly ${JSON.stringify(ALLOWED_AXIOMS)}`)
  return pin
}

// ---------------------------------------------------------------------------
// Installation content digest (design section 6). Enumeration is shared by
// provisioning and preflight so both hash the same tree the same way.
// ---------------------------------------------------------------------------
const SHARED_LIBRARY = /\.(?:so|dylib|dll)(?:\.[0-9.]+)?$/
async function entry(root, path) {
  const stat = await fs.lstat(path)
  const relativePath = posix(relative(root, path))
  if (stat.isSymbolicLink()) {
    let target
    try { target = await fs.realpath(path) } catch { fail('io', `dangling symlink in installation: ${relativePath}`) }
    // A symlink resolving outside the root is not part of the verified tree.
    if (!inside(root, target)) fail('io', `installation symlink escapes the root: ${relativePath}`)
    const targetStat = await fs.stat(target)
    if (targetStat.isDirectory()) {
      const entries = []
      await walkInstall(root, target, entries, relativePath)
      return entries
    }
    if (!targetStat.isFile()) fail('io', `installation entry is not a regular file: ${relativePath}`)
    // Hashed as the target's bytes, recorded under the symlink's relative path.
    return [{ path: relativePath, sha256: await hashFile(target) }]
  }
  if (!stat.isFile()) fail('io', `installation entry is not a regular file: ${relativePath}`)
  return [{ path: relativePath, sha256: await hashFile(path) }]
}
async function walkInstall(root, dir, entries, display = posix(relative(root, dir))) {
  for (const child of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, child.name)
    const published = `${display}/${child.name}`
    if (child.isSymbolicLink()) {
      let target
      try { target = await fs.realpath(path) } catch { fail('io', `dangling symlink in installation: ${published}`) }
      if (!inside(root, target)) fail('io', `installation symlink escapes the root: ${published}`)
      const stat = await fs.stat(target)
      if (stat.isDirectory()) { await walkInstall(root, target, entries, published); continue }
      if (!stat.isFile()) fail('io', `installation entry is not a regular file: ${published}`)
      entries.push({ path: published, sha256: await hashFile(target) })
      continue
    }
    if (child.isDirectory()) { await walkInstall(root, path, entries, published); continue }
    if (!child.isFile()) fail('io', `installation entry is not a regular file: ${published}`)
    entries.push({ path: published, sha256: await hashFile(path) })
  }
}

export async function installationEntries(root) {
  let stat
  try { stat = await fs.stat(root) } catch { fail('toolchain-missing', 'Lean installation root is missing') }
  if (!stat.isDirectory()) fail('toolchain-missing', 'Lean installation root must be a directory')
  const entries = []
  // bin/ and lib/ recursively, plus any top-level shared runtime library.
  for (const name of ['bin', 'lib']) {
    const dir = join(root, name)
    let dirStat
    try { dirStat = await fs.stat(dir) } catch { fail('toolchain-missing', `Lean installation is missing ${name}/`) }
    if (!dirStat.isDirectory()) fail('toolchain-missing', `Lean installation ${name}/ must be a directory`)
    await walkInstall(root, dir, entries)
  }
  for (const child of await fs.readdir(root, { withFileTypes: true })) {
    if (child.name === 'bin' || child.name === 'lib') continue
    if (SHARED_LIBRARY.test(child.name)) entries.push(...await entry(root, join(root, child.name)))
  }
  return entries.sort((a, b) => compareCodepoint(a.path, b.path))
}

export const contentDigest = async root => canonicalDigest(await installationEntries(root))

export const receiptPath = leanRoot => `${resolve(leanRoot)}.receipt.json`
