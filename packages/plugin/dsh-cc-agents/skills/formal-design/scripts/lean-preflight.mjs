import { spawn } from 'node:child_process'
import { constants as fsConstants, realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contentDigest, inside, loadToolchain, platformKey, posix, readUtf8, receiptPath } from './lean-fingerprint.lib.mjs'
import { ADAPTER, CORPUS, LEAN_SPEC_VERSION, PLATFORMS, PROOF_SOURCES, REASON_CODES, assert, fail, parseJsonTokens, parseLeanManifest, projectRelativePath, sortBlockers } from './lean-manifest.lib.mjs'

const MB = 1024 * 1024
const SOURCE_LIMIT = MB
const PROOF_INPUT_LIMIT = 10 * MB
const CORPUS_LIMIT = 20 * MB
const CORPUS_LINE_LIMIT = 64 * 1024
const DECLARED_LIMIT = 50 * MB
const MODEL_PATH = /^specs\/lean\/([a-z][a-z0-9-]{0,63})$/
const BRIDGE_PATH = /^specs\/formal\/([a-z][a-z0-9-]{0,63})\/bridge\.json$/
// Generated artifacts live in the model directory (design section 4) but are
// never proof inputs; implementation.md is an acceptance record.
const GENERATED = ['implementation.md', 'evidence.json', 'current-run.json', 'conformance-evidence.json']
const ALLOWED_ENTRIES = new Set(['design.md', 'checks.json', ...PROOF_SOURCES, ...GENERATED, 'conformance'])
const FORBIDDEN_BUILD = name => /\.olean$/.test(name) || /^lakefile\./.test(name) || name === 'lake-manifest.json'
// design section 6: manifest options are runner-owned, so the project may not
// set them and may not reach for a kernel-bypass option.
const FORBIDDEN_SOURCE = [/set_option\s+maxHeartbeats\b/, /set_option\s+maxRecDepth\b/, /set_option\s+debug\./]
const RECEIPT_FIELDS = ['schemaVersion', 'toolchain', 'archiveSha256', 'contentDigest']

export function parseLeanSyntax(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = ['project', 'model', 'lean-root', 'bridge']
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || Object.hasOwn(options, flag.slice(2)) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('config-invalid', 'invalid, missing, unknown or duplicate argument')
    options[flag.slice(2)] = argv[i + 1]
  }
  if (!options.project || !options.model) fail('config-invalid', '--project and --model are required')
  return options
}

// design section 6: inherit PATH and standard locale variables only. Every
// Lean/tool override variable (LEAN_PATH, LEAN_SRC_PATH, LEAN_SYSROOT, ...)
// is dropped by construction rather than by an ignore list.
export function leanEnvironment(base = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(base)) if (key === 'PATH' || /^(?:LANG|LANGUAGE|LC_[A-Z]+|TZ)$/.test(key)) env[key] = value
  return env
}

export async function safePath(root, path) {
  if (!inside(root, path)) fail('unsafe-path', 'path escapes project')
  let current = root
  for (const segment of relative(root, path).split('/').filter(Boolean)) {
    current = join(current, segment)
    let stat
    try { stat = await fs.lstat(current) } catch (e) { if (e.code === 'ENOENT') break; throw e }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (current !== path && !stat.isDirectory())) fail('unsafe-path', `unsafe path: ${posix(relative(root, current))}`)
  }
}

export async function inspectLeanModel(project, model) {
  const match = typeof model === 'string' && MODEL_PATH.exec(model)
  if (!match) fail('unsafe-path', 'model must be specs/lean/<model-id>')
  let root
  try { root = await fs.realpath(project); if (!(await fs.stat(root)).isDirectory()) throw new Error() }
  catch { fail('unsafe-path', 'project must be an existing directory') }
  const path = join(root, model)
  await safePath(root, path)
  let stat
  try { stat = await fs.stat(path) } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fail('missing-input', 'model directory is missing'); throw e }
  if (!stat.isDirectory()) fail('unsafe-path', 'model must be an existing directory')
  // A `.olean`, Lake file or top-level build manifest anywhere in the model
  // directory is a blocked configuration failure, never a proof input.
  const scan = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const label = posix(relative(root, full))
      if (entry.isSymbolicLink()) fail('unsafe-path', `unsafe path: ${label}`)
      if (FORBIDDEN_BUILD(entry.name)) fail('config-invalid', `project build artifact is not permitted: ${label}`)
      if (entry.isDirectory()) { await scan(full); continue }
      if (!entry.isFile()) fail('unsafe-path', `model entry is not a regular file: ${label}`)
    }
  }
  await scan(path)
  const entries = new Set()
  for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    if (!ALLOWED_ENTRIES.has(entry.name)) fail('config-invalid', `unexpected model entry: ${posix(relative(root, join(path, entry.name)))}`)
    entries.add(entry.name)
  }
  return { root, model: path, modelRelative: model, modelId: match[1], entries }
}

async function requireRegularFile(path, label) {
  let stat
  try { stat = await fs.stat(path) } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fail('missing-input', `required input is missing: ${label}`); throw e }
  if (!stat.isFile()) fail('unsafe-path', `required input is not a regular file: ${label}`)
  return stat.size
}

async function checkLayout(paths, manifest) {
  const relativePath = name => posix(relative(paths.root, join(paths.model, name)))
  for (const name of ['design.md', 'checks.json', ...PROOF_SOURCES]) await requireRegularFile(join(paths.model, name), relativePath(name))
  // design.md is a proof input, so it must be readable text like the rest.
  await readUtf8(join(paths.model, 'design.md'), 'design.md')
  if (!Object.hasOwn(manifest, 'conformance')) return {}
  const declared = manifest.conformance
  const dir = join(paths.model, 'conformance')
  let stat
  try { stat = await fs.stat(dir) } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fail('missing-input', `conformance inputs are missing: ${posix(relative(paths.root, dir))}`); throw e }
  if (!stat.isDirectory()) fail('config-invalid', 'conformance must be a directory')
  await requireRegularFile(join(paths.model, ADAPTER), relativePath(ADAPTER))
  await requireRegularFile(join(paths.model, CORPUS), relativePath(CORPUS))
  const names = (await fs.readdir(dir)).sort()
  if (names.join(',') !== 'adapter.mjs,cases.jsonl') fail('config-invalid', 'conformance must contain exactly adapter.mjs and cases.jsonl')
  return { declared, corpusPath: join(paths.model, CORPUS) }
}

async function checkSizes(paths, manifest, layout) {
  let proofTotal = 0
  const proofSizes = { 'design.md': await requireRegularFile(join(paths.model, 'design.md'), 'design.md') }
  for (const name of PROOF_SOURCES) {
    const size = await requireRegularFile(join(paths.model, name), name)
    if (size > SOURCE_LIMIT) fail('config-invalid', `${name} exceeds 1 MiB`)
    proofSizes[name] = size
  }
  proofSizes['checks.json'] = await requireRegularFile(join(paths.model, 'checks.json'), 'checks.json')
  for (const size of Object.values(proofSizes)) proofTotal += size
  if (proofTotal > PROOF_INPUT_LIMIT) fail('config-invalid', 'proof inputs exceed 10 MiB total')
  if (layout.corpusPath) {
    const text = await readUtf8(layout.corpusPath, 'corpus')
    if (Buffer.byteLength(text, 'utf8') > CORPUS_LIMIT) fail('config-invalid', 'corpus exceeds 20 MiB')
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (lines.length > manifest.limits.maxCases) fail('config-invalid', `corpus has ${lines.length} lines, over maxCases ${manifest.limits.maxCases}`)
    for (const line of lines) if (Buffer.byteLength(line, 'utf8') > CORPUS_LINE_LIMIT) fail('config-invalid', 'corpus line exceeds 64 KiB')
  }
  if (!manifest.conformance) return
  // Existence is validated at conformance preflight only; existing declared
  // inputs still count against the 50 MiB execution bound.
  let declaredTotal = 0
  for (const path of [...manifest.conformance.implementationFiles, ...manifest.conformance.executionFiles]) {
    projectRelativePath(path)
    let stat
    try { stat = await fs.stat(join(paths.root, path)) } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e }
    if (stat.isFile()) declaredTotal += stat.size
  }
  if (declaredTotal > DECLARED_LIMIT) fail('config-invalid', 'source/execution inputs exceed 50 MiB total')
}

async function checkSources(paths) {
  for (const name of PROOF_SOURCES) {
    const text = await readUtf8(join(paths.model, name), name)
    for (const pattern of FORBIDDEN_SOURCE) if (pattern.test(text)) fail('config-invalid', `${name} sets a runner-owned or kernel-bypass option (${pattern.source})`)
  }
}

export async function resolveLeanRoot(option, env = process.env) {
  const configured = option ?? env.FORMAL_DESIGN_LEAN_ROOT
  if (!configured) fail('toolchain-missing', 'no Lean tool root: pass --lean-root or set FORMAL_DESIGN_LEAN_ROOT')
  let root
  try { root = await fs.realpath(configured) } catch { fail('toolchain-missing', `Lean tool root is not accessible: ${configured}`) }
  const binary = join(root, 'bin', 'lean')
  try { if (!(await fs.stat(binary)).isFile()) throw new Error('not regular') } catch { fail('toolchain-missing', 'Lean installation is missing bin/lean') }
  try { await fs.access(binary, fsConstants.X_OK) } catch { fail('toolchain-missing', 'Lean binary is not executable') }
  return root
}

// The pinned release prints a long header for --version and the bare version
// for --short-version (design section 6), so only --short-version is a pin.
export function probeLeanVersion(binary, { timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    let child, settled = false, timer, killTimer
    const chunks = []
    const settle = result => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); resolve(result) }
    const stop = (code, detail) => {
      try { child.kill('SIGTERM') } catch { settle({ code, detail }); return }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 2000)
      settle({ code, detail })
    }
    try { child = spawn(binary, ['--short-version'], { env: leanEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], shell: false }) }
    catch { settle({ code: 'toolchain-missing', detail: 'Lean binary could not be started' }); return }
    timer = setTimeout(() => stop('io', `lean --short-version exceeded ${timeoutMs}ms`), timeoutMs)
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.stderr.on('data', () => { /* diagnostics only; the pin is stdout */ })
    child.once('error', error => settle({ code: error.code === 'ENOENT' ? 'toolchain-missing' : 'io', detail: 'Lean binary could not be started' }))
    child.once('close', (exitCode, signal) => {
      if (exitCode !== 0 || signal) return settle({ code: 'toolchain-mismatch', detail: `lean --short-version failed (${signal ?? 'nonzero exit'})` })
      settle({ version: Buffer.concat(chunks).toString('utf8').trim() })
    })
  })
}

export async function checkInstallation(root, pin, platform, digest = contentDigest) {
  const path = receiptPath(root)
  let text
  try { text = await readUtf8(path, 'installation receipt', 'toolchain-mismatch') }
  catch (e) {
    if (e.code === 'ENOENT') fail('toolchain-missing', 'installation receipt is missing')
    if (REASON_CODES.includes(e.code) && e.code !== 'io') { throw e }
    fail('io', 'installation receipt is unreadable')
  }
  let receipt
  try { receipt = parseJsonTokens(text) } catch { fail('toolchain-mismatch', 'installation receipt is not a valid canonical JSON object') }
  assert(receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt), 'installation receipt must be an object')
  if (Object.keys(receipt).sort().join(',') !== [...RECEIPT_FIELDS].sort().join(',')) fail('toolchain-mismatch', `installation receipt fields must be exactly ${RECEIPT_FIELDS.join(',')}`)
  if (receipt.schemaVersion !== 1) fail('toolchain-mismatch', 'installation receipt schemaVersion must be 1')
  if (receipt.toolchain !== pin.toolchain) fail('toolchain-mismatch', 'installation receipt toolchain does not match the pin')
  if (typeof receipt.archiveSha256 !== 'string' || receipt.archiveSha256 !== pin.platforms[platform].sha256) fail('toolchain-mismatch', 'installation receipt archive SHA-256 does not match the pinned archive')
  if (typeof receipt.contentDigest !== 'string') fail('toolchain-mismatch', 'installation receipt contentDigest must be a string')
  let observed
  try { observed = await digest(root) } catch (e) { fail(['toolchain-missing', 'io'].includes(e.code) ? e.code : 'io', e.detail ?? 'installation content digest failed') }
  if (receipt.contentDigest !== observed) fail('toolchain-mismatch', 'installed content digest does not match the verified receipt')
  return receipt
}

export async function leanPreflight(options, { env = process.env, platform: platformName = process.platform, arch = process.arch, pin: readPin = loadToolchain, probe = probeLeanVersion, digest = contentDigest } = {}) {
  const blockers = []
  const add = (error, code = 'io') => blockers.push({ code: REASON_CODES.includes(error.code) ? error.code : code, detail: error.detail ?? error.message ?? 'preflight step failed' })
  const attempt = async fn => { try { return await fn() } catch (e) { add(e); return undefined } }

  let pin, paths, manifest, layout
  pin = await attempt(readPin)
  paths = options.project && options.model ? await attempt(() => inspectLeanModel(options.project, options.model)) : undefined
  if (paths) {
    manifest = await attempt(async () => {
      const parsed = parseLeanManifest(await readUtf8(join(paths.model, 'checks.json'), 'checks.json'))
      if (parsed.modelId !== paths.modelId) fail('config-invalid', 'manifest modelId must equal the model directory name')
      return parsed
    })
  }
  if (paths && manifest) {
    layout = await attempt(() => checkLayout(paths, manifest))
    await attempt(() => checkSizes(paths, manifest, layout ?? {}))
    await attempt(() => checkSources(paths))
  }
  if (options.bridge !== undefined) {
    if (!BRIDGE_PATH.test(options.bridge)) blockers.push({ code: 'config-invalid', detail: '--bridge must be specs/formal/<feature-id>/bridge.json' })
    else if (paths) await attempt(async () => {
      await safePath(paths.root, join(paths.root, options.bridge))
      await requireRegularFile(join(paths.root, options.bridge), options.bridge)
    })
  }

  let leanRoot, toolchain = null
  const platform = platformKey(platformName, arch)
  if (!platform) blockers.push({ code: 'toolchain-missing', detail: `unsupported platform ${platformName}-${arch}; supported: ${PLATFORMS.join(', ')}` })
  leanRoot = await attempt(() => resolveLeanRoot(options['lean-root'], env))
  if (leanRoot && pin && platform) {
    const observed = await attempt(() => probe(join(leanRoot, 'bin', 'lean')))
    if (observed?.version !== undefined && observed.version !== LEAN_SPEC_VERSION) blockers.push({ code: 'toolchain-mismatch', detail: `lean --short-version reported ${JSON.stringify(observed.version)}, expected ${LEAN_SPEC_VERSION}` })
    else if (observed?.code) blockers.push({ code: REASON_CODES.includes(observed.code) ? observed.code : 'io', detail: observed.detail })
    if (!observed?.code && observed?.version === LEAN_SPEC_VERSION) {
      const receipt = await attempt(() => checkInstallation(leanRoot, pin, platform, digest))
      if (receipt) toolchain = { toolchain: pin.toolchain, platform, archiveSha256: receipt.archiveSha256, contentDigest: receipt.contentDigest, version: observed.version }
    }
  }
  const ordered = sortBlockers(blockers)
  const output = {
    schemaVersion: 1,
    command: 'lean-preflight',
    status: ordered.length ? 'blocked' : 'ready',
    reason: ordered[0]?.code ?? 'ready',
    blockers: ordered,
    model: paths?.modelRelative ?? options.model ?? null,
    leanRoot: leanRoot ?? null,
    toolchain,
    // Declared implementation bindings are recorded as planned: proof preflight
    // does not require the implementation to exist yet (design sections 5, 9).
    plannedImplementationFiles: manifest?.conformance?.implementationFiles ?? [],
    bridge: options.bridge ?? null,
  }
  return { options, paths, manifest, pin, leanRoot, toolchain, output }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseLeanSyntax(argv) }
  catch (e) {
    const detail = e.detail ?? 'invalid arguments'
    process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'lean-preflight', status: 'blocked', reason: 'config-invalid', blockers: [{ code: 'config-invalid', detail }], model: null, leanRoot: null, toolchain: null, plannedImplementationFiles: [], bridge: null }) + '\n')
    return 2
  }
  if (options.help) {
    process.stdout.write('lean-preflight --project <root> --model specs/lean/<id> --lean-root <root> [--bridge specs/formal/<id>/bridge.json]\n')
    return 0
  }
  try {
    const { output } = await leanPreflight(options)
    process.stdout.write(JSON.stringify(output) + '\n')
    return output.status === 'ready' ? 0 : 2
  } catch (e) {
    const reason = REASON_CODES.includes(e.code) ? e.code : 'io'
    process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'lean-preflight', status: 'blocked', reason, blockers: [{ code: reason, detail: e.detail ?? 'preflight failed' }], model: options.model ?? null, leanRoot: null, toolchain: null, plannedImplementationFiles: [], bridge: options.bridge ?? null }) + '\n')
    return 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
