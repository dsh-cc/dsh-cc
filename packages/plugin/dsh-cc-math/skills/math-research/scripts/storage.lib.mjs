import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared helpers for the math-research M0 scripts (design
// docs/plans/2026-11-21-mathematical-research-harness.md §3.3): structured
// failure codes, sha256 utilities, canonical JSON for chain hashing, and
// atomic whole-file writes (temp + rename — no byte-append anywhere).
// Deliberately dependency-free and local to this plugin: the contract (§3.2)
// rules out cross-plugin imports, so the overlap with formal-design's
// storage/fingerprint libraries is intentional duplication, awaiting the
// shared `lean-runtime` follow-up (§11.4).

export const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url))

export function fail(code, detail) { throw Object.assign(new Error(detail), { code, detail }) }
export function assert(ok, detail, code = 'config-invalid') { if (!ok) fail(code, detail) }

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const sha256Text = text => sha256(Buffer.from(text, 'utf8'))
export async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function exists(path) { try { await fs.lstat(path); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
export async function readUtf8(path, label) {
  const bytes = await fs.readFile(path)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { fail('config-invalid', `${label} is not valid UTF-8`) }
}
export async function readJson(path, label) {
  const text = await readUtf8(path, label)
  try { return JSON.parse(text) }
  catch { fail('config-invalid', `${label} is not valid JSON`) }
}
export const posix = path => path.split(sep).join('/')

// ---------------------------------------------------------------------------
// Canonical JSON (sorted keys by Unicode code point, no whitespace) — the
// byte form the claim-ledger chain hash commits to, so a field reorder never
// changes the hash and any field edit always does (§6.3).
// ---------------------------------------------------------------------------
export function compareCodepoint(a, b) {
  const left = Array.from(a, c => c.codePointAt(0)); const right = Array.from(b, c => c.codePointAt(0))
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i]
  return left.length - right.length
}
export function canonicalJson(value) {
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'boolean') return value ? 'true' : 'false'
  if (kind === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('config-invalid', 'canonical JSON needs safe integers')
    return String(value)
  }
  if (kind === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (kind === 'object') {
    const keys = Object.keys(value).sort(compareCodepoint)
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  fail('config-invalid', 'unsupported value in canonical JSON')
}

// ---------------------------------------------------------------------------
// Atomic writes (§3.3): stage beside the target, fsync, rename. The whole
// file is rewritten on every update; there is no append path.
// ---------------------------------------------------------------------------
const temporary = path => join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
export async function atomicWrite(path, text, io = fs) {
  const temp = temporary(path)
  let handle
  try {
    handle = await io.open(temp, 'wx')
    await handle.writeFile(text)
    await handle.sync()
    await handle.close()
    handle = null
  } catch (e) {
    if (handle) await handle.close().catch(() => {})
    await io.unlink(temp).catch(() => {})
    throw e
  }
  try { await io.rename(temp, path) } catch (e) { await io.unlink(temp).catch(() => {}); throw e }
}
export const atomicJson = (path, value, io = fs) => atomicWrite(path, JSON.stringify(value) + '\n', io)

// ---------------------------------------------------------------------------
// CLI conventions: strict --flag value pairs, --help, single-line JSON on the
// result path, structured exit codes (formal-design lean-check precedent).
// ---------------------------------------------------------------------------
export function parseFlags(argv, allowed, { required = [], repeated = [], booleans = [] } = {}) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true, subcommand: null }
  const options = { help: false, subcommand: null }
  let i = 0
  if (argv[0] && !argv[0].startsWith('--')) { options.subcommand = argv[0]; i = 1 }
  while (i < argv.length) {
    const flag = argv[i]
    if (!flag.startsWith('--')) fail('config-invalid', `unexpected positional argument ${flag}`)
    const key = flag.slice(2)
    if (!allowed.includes(key)) fail('config-invalid', 'invalid, missing, unknown or duplicate argument')
    if (booleans.includes(key)) {
      if (Object.hasOwn(options, key)) fail('config-invalid', `duplicate argument --${key}`)
      options[key] = true
      i += 1
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail('config-invalid', 'invalid, missing, unknown or duplicate argument')
    if (!repeated.includes(key) && Object.hasOwn(options, key)) fail('config-invalid', `duplicate argument --${key}`)
    if (repeated.includes(key)) (options[key] ??= []).push(value)
    else options[key] = value
    i += 2
  }
  for (const key of required) if (!options[key]) fail('config-invalid', `--${key} is required`)
  return options
}
export const outputLine = value => process.stdout.write(JSON.stringify(value) + '\n')
export async function runCli(command, helpText, argv, handler) {
  let result
  try { result = await handler(argv) }
  catch (e) {
    outputLine({ schemaVersion: 1, command, status: 'blocked', reason: { code: e.code ?? 'io', detail: e.detail ?? e.message ?? `${command} failed` } })
    return 2
  }
  if (result === 'help') { process.stdout.write(helpText + '\n'); return 0 }
  if (result && typeof result === 'object' && 'exitCode' in result) { outputLine(result.report); return result.exitCode }
  outputLine(result)
  return 0
}

// ---------------------------------------------------------------------------
// Workspace root for all math-harness state (§3.1): `.math/` in the project
// cwd by default, relocatable with MATH_HOME, writability feature-detected.
// ---------------------------------------------------------------------------
export function mathRoot({ cwd = process.cwd(), env = process.env } = {}) {
  return env.MATH_HOME && env.MATH_HOME.trim() ? env.MATH_HOME : join(cwd, '.math')
}
export async function ensureWritable(root, io = fs) {
  try {
    await io.mkdir(root, { recursive: true })
    const probe = join(root, `.write-probe-${randomUUID()}`)
    await io.writeFile(probe, '', 'utf8')
    await io.unlink(probe)
  } catch { fail('config-invalid', `math state root ${root} is not writable; set MATH_HOME to a writable path`) }
}
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  return null
}
