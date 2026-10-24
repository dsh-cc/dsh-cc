import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, fail, parseJson, generateCfg } from './manifest.lib.mjs'
export const SCRIPTS = fileURLToPath(new URL('.', import.meta.url))
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const posix = p => p.split(sep).join('/')
export const inside = (root, p) => p === root || p.startsWith(root + sep)
export async function exists(path) { try { await fs.lstat(path); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
export async function hashFile(path, algorithm = 'sha256') {
  const h = createHash(algorithm)
  for await (const chunk of createReadStream(path)) h.update(chunk)
  return h.digest('hex')
}
export async function safePath(root, path, code = 'model-path-unsafe') {
  if (!inside(root, path)) fail(code, 'path escapes project')
  let p = root
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    p = join(p, segment)
    let st
    try { st = await fs.lstat(p) } catch (e) { if (e.code === 'ENOENT') break; throw e }
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (p !== path && !st.isDirectory())) fail(code, `unsafe path: ${posix(relative(root, p))}`)
  }
}
async function walk(root, dir, files) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('model-path-unsafe', `unsafe model input: ${posix(relative(root, p))}`)
    if (entry.isDirectory()) await walk(root, p, files)
    else files.push(posix(relative(root, p)))
  }
}
export async function inspectProject(project, model) {
  if (typeof model !== 'string' || !/^specs\/tla\/[a-z][a-z0-9-]{0,63}$/.test(model)) fail('model-path-unsafe', 'model must be specs/tla/<model-id>')
  let root
  try { root = await fs.realpath(project); if (!(await fs.stat(root)).isDirectory()) throw new Error() }
  catch { fail('model-path-unsafe', 'project must be an existing directory') }
  const path = join(root, model)
  await safePath(root, path)
  try { if (!(await fs.stat(path)).isDirectory()) fail('model-path-unsafe', 'model must be an existing directory') }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fail('model-path-unsafe', 'model must be an existing directory'); throw e }
  // Validate all output ancestors before lock creation, including prior evidence/logs.
  for (const p of [join(root, '.formal-design'), join(path, 'evidence.json'), join(path, 'current-run.json')]) await safePath(root, p)
  if (await exists(join(root, '.formal-design'))) {
    const scan = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); await safePath(root, p); if (e.isDirectory()) await scan(p) } }
    await scan(join(root, '.formal-design'))
  }
  const files = []; await walk(path, path, files)
  for (const f of files) {
    if ((f.endsWith('.tla') && f.includes('/')) || /\.(class|jar|java)$/i.test(f)) fail('config-invalid', `unsupported model file: ${f}`)
  }
  return { root, model: path, modelRelative: model, modelId: model.split('/')[2], files }
}
export async function enumerate(model, manifest, allowMissing = false) {
  const files = []; await walk(model, model, files)
  for (const f of files) if ((f.endsWith('.tla') && f.includes('/')) || /\.(class|jar|java)$/i.test(f)) fail('config-invalid', `unsupported model file: ${f}`)
  const paths = ['design.md', 'checks.json', ...files.filter(f => f.endsWith('.tla')), ...manifest.cases.map(c => `cases/${c.id}.cfg`)].sort(compare)
  if (!files.includes(`${manifest.module}.tla`)) fail('config-invalid', 'entry module is missing')
  let total = 0
  const inputFiles = []
  for (const path of paths) {
    let st
    try { st = await fs.stat(join(model, path)) } catch (e) { if (e.code === 'ENOENT' && allowMissing && path.endsWith('.cfg')) continue; throw e }
    if (!st.isFile()) fail('model-path-unsafe', `input must be regular: ${path}`)
    total += st.size
    if (st.size > 1024 * 1024 || total > 10 * 1024 * 1024) fail('input-limit', 'input exceeds 1 MiB/file or 10 MiB total')
    inputFiles.push({ path, sha256: await hashFile(join(model, path)) })
  }
  return inputFiles
}
export async function fingerprint(model, manifest) {
  const inputFiles = await enumerate(model, manifest)
  return { inputFiles, inputDigest: digestEntries(inputFiles) }
}
export const digestEntries = entries => sha256(Buffer.from(JSON.stringify(entries.map(({ path, sha256 }) => [path, sha256]))))
export async function runnerIdentity(scripts = SCRIPTS) {
  const packageRoot = resolve(scripts, '../../..')
  const npm = parseJson(await fs.readFile(join(packageRoot, 'package.json'), 'utf8'))
  const plugin = parseJson(await fs.readFile(join(packageRoot, '.claude-plugin/plugin.json'), 'utf8'))
  if (npm.name !== '@dsh-cc/plugin-dsh-cc-agents' || plugin.name !== 'dsh-cc-agents' || typeof npm.version !== 'string' || !npm.version || npm.version !== plugin.version) fail('config-invalid', 'invalid plugin/package identity')
  const files = []; await walk(scripts, scripts, files)
  const entries = await Promise.all(files.filter(f => f.endsWith('.mjs')).sort(compare).map(async path => ({ path, sha256: await hashFile(join(scripts, path)) })))
  const toolchainBytes = await fs.readFile(join(scripts, 'toolchain.json'))
  const toolchain = parseJson(toolchainBytes.toString())
  if (Object.keys(toolchain).sort().join(',') !== 'downloadUrl,sha1,version' || !/^[a-f0-9]{40}$/.test(toolchain.sha1) || typeof toolchain.version !== 'string' || typeof toolchain.downloadUrl !== 'string') fail('config-invalid', 'invalid toolchain pin')
  return { runnerDigest: digestEntries(entries), runnerPackage: { name: npm.name, version: npm.version }, toolchainDigest: sha256(toolchainBytes), toolchainVersion: toolchain.version, toolchain }
}
export async function cfgState(paths, manifest) {
  const missing = []; const blockers = []
  for (const c of manifest.cases) {
    const path = `cases/${c.id}.cfg`; const full = join(paths.model, path)
    if (!await exists(full)) missing.push(path)
    else if (!(await fs.readFile(full)).equals(Buffer.from(generateCfg(c)))) blockers.push({ code: 'config-drift', detail: `${paths.modelRelative}/${path} differs from generated bytes`, relativePath: `${paths.modelRelative}/${path}`, caseId: c.id })
  }
  return { missing, blockers }
}
