import { spawn as nodeSpawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { assert, exists, fail, mathRoot, parseFlags, runCli } from './storage.lib.mjs'

// L1 computation sandbox for generated Python/sympy checks (design §4.4) with
// HONEST isolation semantics:
//   full    network-isolated (Linux CI runners with a network namespace /
//           no-egress): results are authoritative — a failing check may serve
//           as counterexample evidence.
//   partial in-session, any platform: fresh temp cwd under .math/, the outer
//           workspace-write sandbox bounds writes, wall+CPU limits, 60s
//           timeout — but network isolation is NOT guaranteed (macOS nested
//           sandbox is denied), so results are ADVISORY ONLY.
// The tier is detected and recorded BEFORE execution; there is no silent
// downgrade. A partial run that claims `fail` is a ledger error — that rule
// is enforced by the claim layer (Wave 3 claim integration); this script
// records `isolation: partial` and flags the fail advisory: true.
// Absent Python >=3.10 with sympy, the result is `not-applicable`, never
// `pass` or `fail` (tri-state per §4.4).

export const DEFAULT_TIMEOUT_MS = 60000
const CPU_LIMIT_SECONDS = 60

/** full = MATH_EVAL_ISOLATION=full, or the documented CI netns marker on Linux. */
export function detectIsolationTier({ env = process.env, platform = process.platform } = {}) {
  if (env.MATH_EVAL_ISOLATION === 'full') return 'full'
  if (platform === 'linux' && env.CI === 'true' && env.MATH_EVAL_NETNS === '1') return 'full'
  return 'partial'
}

// Default process primitives (injectable: tests never spawn or touch Python).
async function defaultProbePython(run) {
  const version = await run('python3', ['--version'])
  if (version.exitCode !== 0) return { python: null, sympy: false }
  const match = /Python (\d+)\.(\d+)\.(\d+)/.exec(`${version.stdout}${version.stderr}`)
  if (!match) return { python: null, sympy: false }
  const [major, minor] = [Number(match[1]), Number(match[2])]
  if (major < 3 || (major === 3 && minor < 10)) return { python: `${major}.${minor}.${match[3]}`, sympy: false, tooOld: true }
  const probe = await run('python3', ['-c', 'import sympy'])
  return { python: `${major}.${minor}.${match[3]}`, sympy: probe.exitCode === 0 }
}

function defaultSpawn(command, args, { cwd, timeoutMs }) {
  return new Promise(resolveRun => {
    const argv = process.platform === 'linux'
      ? ['prlimit', `--cpu=${CPU_LIMIT_SECONDS}`, '--', command, ...args]
      : [command, ...args]
    let child
    try { child = nodeSpawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (e) { resolveRun({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: e.message }); return }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 2000).unref()
    }, timeoutMs)
    child.once('error', e => { clearTimeout(timer); resolveRun({ exitCode: null, stdout: String(stdout), stderr: String(stderr), timedOut: false, spawnError: e.message }) })
    child.once('close', exitCode => { clearTimeout(timer); resolveRun({ exitCode, stdout: String(stdout), stderr: String(stderr), timedOut }) })
  })
}

const TAIL = 4000
const trim = text => (text.length > TAIL ? `…${text.slice(-TAIL)}` : text)

/**
 * Run one generated checker. Contract for the checker: exit 0 when every
 * check passes, non-zero otherwise; stdout/stderr preserved (tail-bounded).
 */
export async function runSympyCheck({ script, workRoot, timeoutMs = DEFAULT_TIMEOUT_MS }, deps = {}) {
  const { spawnCheck = defaultSpawn, probe = null, env = process.env, io = fs } = deps
  const isolation = detectIsolationTier({ env })
  const probePython = probe ?? (() => defaultProbePython(defaultSpawnSimple))
  const pythonInfo = await probePython()
  if (!pythonInfo.python || !pythonInfo.sympy) {
    return {
      schemaVersion: 1,
      command: 'sympy-run',
      status: 'not-applicable',
      // No claim either way: tri-state per §4.4. Tier still recorded.
      isolation,
      advisory: true,
      reason: pythonInfo.tooOld ? `python ${pythonInfo.python} is older than 3.10` : 'python3 >=3.10 with sympy is unavailable',
      python: pythonInfo,
    }
  }
  const root = workRoot ?? join(mathRoot({ env }), 'sympy')
  await io.mkdir(root, { recursive: true })
  // Fresh temp cwd under the math state root (never the problem dir).
  const cwd = join(root, `run-${randomUUID()}`)
  await io.mkdir(cwd, { recursive: true })
  const started = Date.now()
  const result = await spawnCheck(resolve(script), [], { cwd, timeoutMs })
  const elapsedMs = Date.now() - started
  const timedOut = Boolean(result.timedOut)
  const failed = !timedOut && (result.exitCode === null || result.exitCode !== 0)
  const status = timedOut || result.spawnError ? 'error' : failed ? 'fail' : 'pass'
  return {
    schemaVersion: 1,
    command: 'sympy-run',
    status,
    isolation,
    // Advisory = partial tier. A partial `fail` is advisory only and may
    // never become computation_verified:fail or falsification evidence; the
    // claim layer treats that misuse as a ledger error.
    advisory: isolation === 'partial',
    timedOut,
    exitCode: result.exitCode ?? null,
    elapsedMs,
    cwd,
    python: pythonInfo,
    stdoutTail: trim(result.stdout ?? ''),
    stderrTail: trim((result.spawnError ? `spawn error: ${result.spawnError}\n` : '') + (result.stderr ?? '')),
  }
}

function defaultSpawnSimple(command, args) {
  return defaultSpawn(command, args, { cwd: process.cwd(), timeoutMs: 15000 })
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'sympy-run — sandboxed sympy computation check with honest isolation tiers (design §4.4)',
  'usage: sympy-run.mjs --script <checker.py> [--work-root <dir>] [--timeout-ms n]',
  '  tier: full = MATH_EVAL_ISOLATION=full (or CI Linux netns marker); otherwise partial (advisory only)',
  '  the checker exits 0 on pass, non-zero on fail; 60s default wall timeout, fresh temp cwd under .math/',
  '  without python3 >=3.10 + sympy the status is not-applicable (tri-state, never pass/fail)',
  'exit codes: 0 pass/fail recorded · 3 error (timeout/spawn) · 2 config-invalid · single-line JSON on stdout',
].join('\n')

async function handle(argv, deps = {}) {
  const options = parseFlags(argv, ['script', 'work-root', 'timeout-ms'], { required: ['script'] })
  if (options.help) return 'help'
  if (!(await exists(options.script))) fail('config-invalid', `checker script ${options.script} does not exist`)
  const timeoutMs = options['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(options['timeout-ms'])
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) fail('config-invalid', '--timeout-ms must be an integer in 1000..600000')
  const result = await runSympyCheck({ script: options.script, workRoot: options['work-root'] ?? null, timeoutMs }, deps)
  return { exitCode: result.status === 'error' ? 3 : 0, report: result }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli('sympy-run', HELP, argv, (args => handle(args, deps)))
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
