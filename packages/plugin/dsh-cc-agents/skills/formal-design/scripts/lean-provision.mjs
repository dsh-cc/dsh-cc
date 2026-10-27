import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createZstdDecompress } from 'node:zlib'
import { contentDigest, loadToolchain, platformKey } from './lean-fingerprint.lib.mjs'
import { PLATFORMS, fail } from './lean-manifest.lib.mjs'
import { atomicJson } from './storage.lib.mjs'

// Administrator-driven provisioning (design section 6). The runner never calls
// this: preflight and checks only read a receipt produced here.

function parseSyntax(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = ['dest', 'platform']
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || Object.hasOwn(options, flag.slice(2)) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('config-invalid', 'invalid, missing, unknown or duplicate argument')
    options[flag.slice(2)] = argv[i + 1]
  }
  if (!options.dest) fail('config-invalid', '--dest is required')
  return options
}

async function download(url, destination) {
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

async function extract(archive, destination) {
  // Decompress with node:zlib instead of relying on the platform tar's zstd
  // support: GNU tar before 1.31 has no --zstd even on hosts that ship zstd.
  const tar = spawn('tar', ['-x', '-f', '-', '-C', destination, '--strip-components=1'], { stdio: ['pipe', 'ignore', 'inherit'], shell: false })
  const closed = new Promise((settle, reject) => {
    tar.once('error', e => reject(Object.assign(new Error('tar could not start'), { code: 'io', detail: `system tar could not start: ${e.code ?? 'unknown error'}` })))
    tar.once('close', code => code === 0 ? settle() : reject(Object.assign(new Error('extraction failed'), { code: 'io', detail: `archive extraction failed (tar exit ${code})` })))
  })
  try { await pipeline(createReadStream(archive), createZstdDecompress(), tar.stdin) }
  catch { try { tar.kill('SIGKILL') } catch { /* already gone */ } throw Object.assign(new Error('decompression failed'), { code: 'io', detail: 'archive decompression failed; the pinned archive is not valid zstd' }) }
  await closed
}

async function prepareDestination(destination) {
  let stat
  try { stat = await fs.stat(destination) } catch (e) { if (e.code === 'ENOENT') { await fs.mkdir(destination, { recursive: true }); return } throw e }
  if (!stat.isDirectory() || (await fs.readdir(destination)).length > 0) fail('config-invalid', '--dest must be absent or an empty directory')
}

export async function provision(options, { progress = message => process.stderr.write(`${message}\n`) } = {}) {
  const pin = await loadToolchain()
  const platform = options.platform ?? platformKey()
  if (!platform) fail('toolchain-missing', `unsupported platform ${process.platform}-${process.arch}; supported: ${PLATFORMS.join(', ')}`)
  if (!PLATFORMS.includes(platform)) fail('config-invalid', `--platform must be one of ${PLATFORMS.join(', ')}`)
  const asset = pin.platforms[platform]
  const destination = resolve(options.dest)
  const archive = join(tmpdir(), `lean-provision-${randomUUID()}.tar.zst`)
  try {
    progress(`downloading ${asset.archiveUrl}`)
    const archiveSha256 = await download(asset.archiveUrl, archive)
    // Hash the downloaded bytes before extraction; metadata alone is not an
    // installation check.
    if (archiveSha256 !== asset.sha256) fail('toolchain-mismatch', `archive SHA-256 ${archiveSha256} does not match the pinned ${asset.sha256}`)
    await prepareDestination(destination)
    progress(`extracting into ${destination}`)
    await extract(archive, destination)
    try { if (!(await fs.stat(join(destination, 'bin', 'lean'))).isFile()) throw new Error() }
    catch { fail('io', 'extracted archive does not contain bin/lean') }
    progress('computing the installation content digest')
    const digest = await contentDigest(destination)
    const receipt = { schemaVersion: 1, toolchain: pin.toolchain, archiveSha256, contentDigest: digest }
    await atomicJson(`${destination}.receipt.json`, receipt)
    return { schemaVersion: 1, command: 'lean-provision', status: 'provisioned', toolchain: pin.toolchain, platform, archiveSha256, contentDigest: digest, root: destination, receipt: `${destination}.receipt.json` }
  } finally {
    await fs.unlink(archive).catch(() => {})
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseSyntax(argv) }
  catch (e) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'lean-provision', status: 'blocked', reason: 'config-invalid', detail: e.detail ?? 'invalid arguments' }) + '\n')
    return 2
  }
  if (options.help) {
    process.stdout.write('lean-provision --dest <dir> [--platform linux-x64|darwin-arm64]\n')
    return 0
  }
  try {
    process.stdout.write(JSON.stringify(await provision(options)) + '\n')
    return 0
  } catch (e) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'lean-provision', status: 'blocked', reason: e.code ?? 'io', detail: e.detail ?? 'provisioning failed' }) + '\n')
    return 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
