import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { assert, atomicJson, exists, fail, hashFile, parseFlags, platformKey, posix, readJson, readUtf8, runCli, sha256, sha256Text, SCRIPTS_DIR } from './storage.lib.mjs'

// Mathlib environment provisioning (design §3.2, §4.2). Provisions
// `.math/env/<mathlibRev>-<platform>/` containing:
//   mathlib/       pinned Mathlib source tree (tarball, sha256-verified)
//   lean/          the Lean toolchain named by Mathlib's own lean-toolchain
//   wrapper/       wrapper lake project (lakefile.lean + lean-toolchain);
//                  user files, Dumper.lean and Inspector.lean all compile here
//   env.receipt.json  { pin, leanDigest, mathlibSha256, cacheArtifactSha256,
//                  platform, provisionedAt }
// Local-first: a valid receipt reuses the environment as-is; an invalid
// receipt is a HARD ERROR, never a silent rebuild (§3.2 receipt discipline).
// Oleans come from `lake exe cache get` — no Mathlib source build.
//
// The pin file mathlib-pin.json requires mathlib.sha256 (64 hex) and, for the
// toolchain download, a leanToolchain block { toolchain, platforms:
// { <platform>: { archiveUrl, sha256 } } } — provisioning is config-invalid
// until filled (offline agents cannot know these bytes; see evidence.md).
// All network/child-process paths sit behind injectable deps so tests never
// touch the network.

export const REASON_CODES = ['config-invalid', 'receipt-invalid', 'toolchain-missing', 'toolchain-mismatch', 'cache-missing', 'io']
export const PLATFORMS = ['linux-x64', 'darwin-arm64']
const HEX64 = /^[a-f0-9]{64}$/
const TOOLCHAIN_NAME = /^leanprover\/lean4:v[0-9]+\.[0-9]+\.[0-9]+$/

export const DEFAULT_PIN = join(SCRIPTS_DIR, 'mathlib-pin.json')
export const receiptPath = envDir => join(envDir, 'env.receipt.json')
export const envIdFor = (pin, platform) => `${pin.mathlib.rev}-${platform}`

// ---------------------------------------------------------------------------
// Pin and receipt validation
// ---------------------------------------------------------------------------
export function validatePin(pin, { requireSecrets = false } = {}) {
  assert(pin && typeof pin === 'object' && !Array.isArray(pin), 'pin must be an object')
  assert(pin.schemaVersion === 1, 'pin must be schemaVersion 1')
  const mathlib = pin.mathlib
  assert(mathlib && typeof mathlib === 'object', 'pin.mathlib must be an object')
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(mathlib.repo ?? ''), 'pin.mathlib.repo must be <owner>/<name>')
  assert(typeof mathlib.rev === 'string' && mathlib.rev.length > 0, 'pin.mathlib.rev must be a non-empty string')
  assert(typeof mathlib.sha256 === 'string', 'pin.mathlib.sha256 must be a string (fill it before provisioning)')
  if (mathlib.sha256 !== '') assert(HEX64.test(mathlib.sha256), 'pin.mathlib.sha256 must be lowercase sha256 hex')
  else if (requireSecrets) fail('config-invalid', 'mathlib-pin.json: mathlib.sha256 is empty; fill the pinned tarball sha256 before provisioning (see references/evidence.md)')
  assert(typeof pin.expectedLean === 'string', 'pin.expectedLean must be a string (validated when present)')
  if (pin.expectedLean !== '') assert(TOOLCHAIN_NAME.test(pin.expectedLean), 'pin.expectedLean must look like leanprover/lean4:vX.Y.Z')
  if (pin.leanToolchain !== undefined && pin.leanToolchain !== null) {
    const lean = pin.leanToolchain
    assert(TOOLCHAIN_NAME.test(lean.toolchain ?? ''), 'pin.leanToolchain.toolchain must look like leanprover/lean4:vX.Y.Z')
    for (const platform of PLATFORMS) {
      const entry = lean.platforms?.[platform]
      if (entry === undefined) continue
      assert(/^https:\/\//.test(entry.archiveUrl ?? '') && HEX64.test(entry.sha256 ?? ''), `pin.leanToolchain.platforms.${platform} needs {archiveUrl (https), sha256}`)
    }
  }
  return pin
}

export async function loadPin(path = DEFAULT_PIN) {
  return validatePin(await readJson(path, `pin file ${path}`))
}

/** Receipt fields per §4.2; `leanToolchain` records the toolchain actually provisioned. */
export function validateReceipt(receipt, pin, platform) {
  const problems = []
  const bad = detail => problems.push(detail)
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['receipt is not an object']
  if (receipt.schemaVersion !== 1) bad('schemaVersion must be 1')
  if (receipt.envId !== envIdFor(pin, platform)) bad(`envId ${JSON.stringify(receipt.envId)} does not match ${envIdFor(pin, platform)}`)
  if (receipt.platform !== platform) bad(`platform ${JSON.stringify(receipt.platform)} does not match ${platform}`)
  if (receipt.pin?.mathlib?.repo !== pin.mathlib.repo || receipt.pin?.mathlib?.rev !== pin.mathlib.rev) bad('pin identity (repo/rev) does not match mathlib-pin.json')
  if (!HEX64.test(receipt.mathlibSha256 ?? '')) bad('mathlibSha256 must be lowercase sha256 hex')
  else if (pin.mathlib.sha256 !== '' && receipt.mathlibSha256 !== pin.mathlib.sha256) bad('mathlibSha256 does not match mathlib-pin.json')
  if (!HEX64.test(receipt.leanDigest ?? '')) bad('leanDigest must be lowercase sha256 hex')
  if (!(receipt.cacheArtifactSha256 === null || HEX64.test(receipt.cacheArtifactSha256 ?? ''))) bad('cacheArtifactSha256 must be lowercase sha256 hex or null')
  if (typeof receipt.provisionedAt !== 'string' || Number.isNaN(Date.parse(receipt.provisionedAt))) bad('provisionedAt must be an ISO 8601 timestamp')
  return problems
}

// ---------------------------------------------------------------------------
// Injectable environment primitives (network, tar, child processes)
// ---------------------------------------------------------------------------
async function defaultDownload(url, destination) {
  let response
  try { response = await fetch(url, { redirect: 'follow' }) } catch (e) { fail('io', `download failed: ${e.message}`) }
  if (!response.ok || !response.body) fail(response.status === 404 ? 'toolchain-missing' : 'io', `download failed with HTTP ${response.status}`)
  const hash = createHash('sha256')
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk) } }),
    createWriteStream(destination),
  )
  return hash.digest('hex')
}

// Same reason as formal-design: decompress with node:zlib, not platform tar.
async function extractWith(decompress, archive, destination, { strip = 1 } = {}) {
  const args = ['-x', '-f', '-', '-C', destination]
  if (strip > 0) args.push(`--strip-components=${strip}`)
  const tar = spawn('tar', args, { stdio: ['pipe', 'ignore', 'inherit'], shell: false })
  const closed = new Promise((settle, reject) => {
    tar.once('error', e => reject(Object.assign(new Error('tar could not start'), { code: 'io', detail: `system tar could not start: ${e.code ?? 'unknown error'}` })))
    tar.once('close', code => code === 0 ? settle() : reject(Object.assign(new Error('extraction failed'), { code: 'io', detail: `archive extraction failed (tar exit ${code})` })))
  })
  try { await pipeline(createReadStream(archive), decompress(), tar.stdin) }
  catch { try { tar.kill('SIGKILL') } catch { /* already gone */ } throw Object.assign(new Error('decompression failed'), { code: 'io', detail: 'archive decompression failed; the pinned archive is not in the expected format' }) }
  await closed
}
const defaultExtractTarGz = (archive, destination, options) => extractWith(createGunzip, archive, destination, options)
const defaultExtractTarZst = (archive, destination, options) => extractWith(createZstdDecompress, archive, destination, options)

function defaultRun(cmd, args, { cwd }) {
  return new Promise(resolveRun => {
    let child
    try { child = spawn(cmd, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (e) { resolveRun({ exitCode: null, error: e.message, stdout: '', stderr: '' }); return }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', e => resolveRun({ exitCode: null, error: e.message, stdout, stderr }))
    child.once('close', exitCode => resolveRun({ exitCode, stdout, stderr }))
  })
}

/** Content digest of a directory tree: sha256 over sorted [relpath, sha256] pairs. */
export async function contentDigest(root) {
  const entries = []
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) entries.push([posix(relative(root, path)), await hashFile(path)])
    }
  }
  await walk(root)
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return sha256Text(JSON.stringify(entries))
}

// ---------------------------------------------------------------------------
// Status / verify
// ---------------------------------------------------------------------------
export async function envStatus({ dest, pinPath = DEFAULT_PIN, platform = platformKey() }, deps = {}) {
  const pin = validatePin(await readJson(pinPath, 'pin file'))
  const base = { envId: envIdFor(pin, platform), dest: resolve(dest), platform }
  if (!(await exists(dest))) return { subcommand: 'status', status: 'absent', ...base, receipt: null, problems: [] }
  if (!(await exists(receiptPath(dest)))) return { subcommand: 'status', status: 'invalid', ...base, receipt: null, problems: ['env.receipt.json is missing'] }
  let receipt
  try { receipt = await readJson(receiptPath(dest), 'env receipt') }
  catch { return { subcommand: 'status', status: 'invalid', ...base, receipt: null, problems: ['env.receipt.json is not valid JSON'] } }
  const problems = validateReceipt(receipt, pin, platform)
  return { subcommand: 'status', status: problems.length ? 'invalid' : 'provisioned', ...base, receipt, problems }
}

export async function verifyEnv({ dest, pinPath = DEFAULT_PIN, platform = platformKey() } = {}) {
  const pin = validatePin(await readJson(pinPath, 'pin file'))
  const status = await envStatus({ dest, pinPath, platform })
  if (status.status !== 'provisioned') fail('receipt-invalid', `environment receipt is ${status.status}: ${status.problems.join('; ')}`)
  const checks = {}
  checks.leanDigest = (await contentDigest(join(dest, 'lean'))) === status.receipt.leanDigest
  const manifest = join(dest, 'wrapper', 'lake-manifest.json')
  checks.cacheArtifact = status.receipt.cacheArtifactSha256 === null ? !(await exists(manifest)) : (await exists(manifest)) && (await hashFile(manifest)) === status.receipt.cacheArtifactSha256
  checks.mathlibSource = await exists(join(dest, 'mathlib', 'lean-toolchain'))
  const ok = Object.values(checks).every(Boolean)
  return { schemaVersion: 1, command: 'mathlib-env', subcommand: 'verify', status: ok ? 'verified' : 'mismatch', envId: status.envId, checks }
}

// ---------------------------------------------------------------------------
// Provision
// ---------------------------------------------------------------------------
async function prepareDestination(destination) {
  let stat
  try { stat = await fs.stat(destination) } catch (e) { if (e.code === 'ENOENT') { await fs.mkdir(destination, { recursive: true }); return true } throw e }
  if (!stat.isDirectory() || (await fs.readdir(destination)).length > 0) fail('config-invalid', 'env destination must be absent or an empty directory')
  return false
}

const WRAPPER_LAKEFILE = mathlibAbs => [
  'import Lake',
  'open Lake DSL',
  '',
  'package «math-attempt»',
  '',
  `require mathlib from ${JSON.stringify(mathlibAbs)}`,
  '',
  '@[default_target]',
  'lean_lib Attempt',
  '',
].join('\n')

export async function provision({ dest, pinPath = DEFAULT_PIN, platform = platformKey() }, deps = {}) {
  const { download = defaultDownload, extract = defaultExtractTarGz, extractLean = defaultExtractTarZst, run = defaultRun, progress = () => {}, now = () => new Date().toISOString() } = deps
  const pin = validatePin(await readJson(pinPath, 'pin file'), { requireSecrets: true })
  if (!platform || !PLATFORMS.includes(platform)) fail('toolchain-missing', `unsupported platform ${process.platform}-${process.arch}; supported: ${PLATFORMS.join(', ')}`)
  const envId = envIdFor(pin, platform)
  const destination = resolve(dest)

  // 1. local-first: reuse a valid receipt; an invalid receipt is a hard error.
  if (await exists(receiptPath(destination))) {
    const receipt = await readJson(receiptPath(destination), 'env receipt')
    const problems = validateReceipt(receipt, pin, platform)
    if (problems.length) fail('receipt-invalid', `existing environment receipt is invalid: ${problems.join('; ')} (never silently rebuilt; remove the directory to reprovision)`)
    return { schemaVersion: 1, command: 'mathlib-env', subcommand: 'provision', status: 'reused', envId, dest: destination, receipt }
  }
  const created = await prepareDestination(destination)
  const staged = []
  try {
    // 2. Mathlib source tarball (canonical archive), sha256 verified.
    const tarballUrl = `https://github.com/${pin.mathlib.repo}/archive/refs/tags/${pin.mathlib.rev}.tar.gz`
    const archive = join(tmpdir(), `mathlib-env-${randomUUID()}.tar.gz`)
    staged.push(archive)
    progress(`downloading ${tarballUrl}`)
    const mathlibSha256 = await download(tarballUrl, archive)
    if (mathlibSha256 !== pin.mathlib.sha256) fail('toolchain-mismatch', `Mathlib tarball sha256 ${mathlibSha256} does not match the pin`)
    progress('extracting Mathlib source')
    await fs.mkdir(join(destination, 'mathlib'), { recursive: true })
    await extract(archive, join(destination, 'mathlib'), { strip: 1 })

    // 3. Mathlib's own lean-toolchain selects the toolchain (§3.2 pin coupling).
    const toolchain = (await readUtf8(join(destination, 'mathlib', 'lean-toolchain'), 'mathlib lean-toolchain')).trim()
    if (!TOOLCHAIN_NAME.test(toolchain)) fail('toolchain-mismatch', `Mathlib lean-toolchain ${JSON.stringify(toolchain)} is not a leanprover/lean4:vX.Y.Z name`)
    if (pin.expectedLean !== '' && pin.expectedLean !== toolchain) fail('config-invalid', `expectedLean ${pin.expectedLean} does not match Mathlib's lean-toolchain ${toolchain}`)
    const leanPin = pin.leanToolchain
    if (!leanPin?.platforms?.[platform]) fail('config-invalid', `mathlib-pin.json lacks leanToolchain.platforms.${platform} {archiveUrl, sha256}; cannot provision the toolchain offline-safely`)
    if (leanPin.toolchain !== toolchain) fail('config-invalid', `leanToolchain.toolchain ${leanPin.toolchain} does not match Mathlib's lean-toolchain ${toolchain}`)

    // 4. Provision the toolchain (receipt discipline; sha256 verified).
    progress(`installing ${toolchain}`)
    const leanArchive = join(tmpdir(), `mathlib-env-lean-${randomUUID()}.tar.zst`)
    staged.push(leanArchive)
    const leanSha = await download(leanPin.platforms[platform].archiveUrl, leanArchive)
    if (leanSha !== leanPin.platforms[platform].sha256) fail('toolchain-mismatch', `Lean archive sha256 ${leanSha} does not match the pin`)
    await fs.mkdir(join(destination, 'lean'), { recursive: true })
    await extractLean(leanArchive, join(destination, 'lean'), { strip: 1 })
    const leanDigest = await contentDigest(join(destination, 'lean'))

    // 5. Wrapper lake project; user files and the metaprograms build here.
    const wrapper = join(destination, 'wrapper')
    await fs.mkdir(wrapper, { recursive: true })
    await fs.writeFile(join(wrapper, 'lean-toolchain'), toolchain + '\n')
    await fs.writeFile(join(wrapper, 'lakefile.lean'), WRAPPER_LAKEFILE(join(destination, 'mathlib')))

    // 6. Prebuilt oleans only (no source build); missing cache = pre-spend error.
    progress('fetching prebuilt oleans (lake exe cache get)')
    const cache = await run(join(destination, 'lean', 'bin', 'lake'), ['exe', 'cache', 'get'], { cwd: wrapper })
    if (cache.exitCode !== 0) fail('cache-missing', `lake exe cache get failed for ${pin.mathlib.rev} on ${platform}: ${(cache.stderr || cache.error || '').trim().slice(0, 400)}`)
    const manifestPath = join(wrapper, 'lake-manifest.json')
    const cacheArtifactSha256 = (await exists(manifestPath)) ? await hashFile(manifestPath) : null

    // 7. Receipt.
    const receipt = {
      schemaVersion: 1,
      envId,
      pin: { mathlib: { repo: pin.mathlib.repo, rev: pin.mathlib.rev, sha256: pin.mathlib.sha256 }, expectedLean: pin.expectedLean, leanToolchain: toolchain },
      leanDigest,
      mathlibSha256,
      cacheArtifactSha256,
      platform,
      provisionedAt: now(),
    }
    await atomicJson(receiptPath(destination), receipt)
    return { schemaVersion: 1, command: 'mathlib-env', subcommand: 'provision', status: 'provisioned', envId, dest: destination, receipt }
  } catch (error) {
    if (created) await fs.rm(destination, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    for (const path of staged) await fs.unlink(path).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Per-attempt build isolation (§4.2): every attempt compiles in its OWN build
// directory with its own copy of the wrapper lakefile pointing at the shared,
// immutable env; the env's Mathlib source, oleans and toolchain stay read-only.
// ---------------------------------------------------------------------------
export async function prepareAttemptBuild(envDir, buildDir, { io = fs } = {}) {
  const toolchainPath = join(envDir, 'wrapper', 'lean-toolchain')
  if (!(await exists(toolchainPath))) fail('toolchain-missing', `environment at ${envDir} has no wrapper project`)
  await io.mkdir(buildDir, { recursive: true })
  await io.copyFile(toolchainPath, join(buildDir, 'lean-toolchain'))
  await io.writeFile(join(buildDir, 'lakefile.lean'), WRAPPER_LAKEFILE(join(resolve(envDir), 'mathlib')))
  return { buildDir, envDir: resolve(envDir), lean: join(resolve(envDir), 'lean') }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'mathlib-env — provision and verify the pinned Mathlib environment (design §3.2, §4.2)',
  'usage: mathlib-env.mjs <subcommand> --dest <dir> [--pin <mathlib-pin.json>] [--platform linux-x64|darwin-arm64]',
  '  status     report absent|provisioned|invalid for the env dir',
  '  provision  local-first: reuse a valid receipt, else fetch+verify+wrapper+cache, then write the receipt',
  '  verify     re-check receipt fields and digests locally (offline)',
  'env-id = <mathlibRev>-<platform>. exit codes: 0 ok · 2 blocked (config-invalid, receipt-invalid, toolchain-missing, toolchain-mismatch, cache-missing, io) · single-line JSON on stdout',
].join('\n')

async function handle(argv) {
  const options = parseFlags(argv, ['dest', 'pin', 'platform'], { required: ['dest'] })
  if (options.help) return 'help'
  if (!options.subcommand) fail('config-invalid', 'a subcommand (status|provision|verify) is required')
  const common = { dest: options.dest, pinPath: options.pin ?? DEFAULT_PIN, platform: options.platform ?? platformKey() }
  switch (options.subcommand) {
    case 'status': return await envStatus(common)
    case 'provision': return await provision(common)
    case 'verify': return await verifyEnv(common)
    default: fail('config-invalid', `unknown subcommand ${options.subcommand}`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  return runCli('mathlib-env', HELP, argv, handle)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
