/**
 * Shared staging for the launcher specs: fake grok stub under the repo
 * tests dir (outside every canonicalized writable root the launcher sees —
 * load-bearing for the CLI-path validation row), fake HOME with a fake
 * .grok, and a mkdtemp workspace/var pair from the TEST process tmpdir.
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PKG_DIR = join(import.meta.dirname, '..')
export const LAUNCHER = join(PKG_DIR, 'scripts', 'grok-review-run.mjs')
export const TESTS_DIR = import.meta.dirname
export const RUNTIME_DIR = join(TESTS_DIR, '.runtime')

/**
 * Fake grok CLI: capture argv/env/cwd and emit the launcher's expected JSON
 * success document on stdout. Knobs (env):
 *   GROK_STUB_CAPTURE    — capture file (argv/env/cwd, JSONL)
 *   GROK_STUB_SLEEP_MS   — hold the process open for N ms before exit 0
 *   GROK_STUB_EXIT       — process exit code (default 0)
 *   GROK_STUB_IGNORE_TERM— register an empty SIGTERM handler (sleeper that
 *                          only the group SIGKILL reaches)
 *   GROK_STUB_MODE=malformed — emit non-JSON stdout
 *   GROK_STUB_MODE=error-doc — emit {"type":"error","message":...} on stdout
 *                              and exit 1 (probed P3 shape)
 *   GROK_STUB_PIDFILE    — write our own pid there (group-liveness rows)
 */
const STUB_SRC = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(
  process.env.GROK_STUB_CAPTURE,
  JSON.stringify({ argv, cwd: process.cwd(), grokHome: process.env.GROK_HOME, xaiKey: process.env.XAI_API_KEY, sessionIdEnv: process.env.GROK_SESSION_ID, sandboxEnv: process.env.GROK_SANDBOX }) + '\\n',
)
if (process.env.GROK_STUB_PIDFILE) writeFileSync(process.env.GROK_STUB_PIDFILE, String(process.pid) + '\\n')
if (process.env.GROK_STUB_IGNORE_TERM) process.on('SIGTERM', () => {})
const doc = JSON.stringify({ text: 'REVIEW TEXT', sessionId: 'sess-abc123', num_turns: 3, total_cost_usd: 0.42 })
if (process.env.GROK_STUB_MODE === 'malformed') {
  process.stdout.write('not json at all\\n')
} else if (process.env.GROK_STUB_MODE === 'error-doc') {
  process.stdout.write(JSON.stringify({ type: 'error', message: 'Couldn\\u0027t create session: FS_PERMISSION_DENIED' }) + '\\n')
  process.exitCode = 1
} else if (process.env.GROK_STUB_MODE === 'big') {
  process.stdout.write('x'.repeat(16 * 1024 * 1024 + 64))
  process.exitCode = 0
} else {
  process.stdout.write(doc + '\\n')
}
if (process.env.GROK_STUB_SLEEP_MS) {
  setTimeout(() => process.exit(process.env.GROK_STUB_EXIT ? Number(process.env.GROK_STUB_EXIT) : (process.exitCode ?? 0)), Number(process.env.GROK_STUB_SLEEP_MS))
} else if (process.env.GROK_STUB_EXIT !== undefined) {
  process.exitCode = Number(process.env.GROK_STUB_EXIT)
}
`

export interface Stage {
  mkd: string
  ws: string
  varDir: string
  fakeHome: string
  runtime: string
  stubBin: string
  capturePath: string
}

/** Staged dirs are registered here and removed in afterEach by the specs. */
const stages: Stage[] = []

export function newStage(): Stage {
  const mkd = mkdtempSync(join(tmpdir(), 'grok-bridge-spec-'))
  const ws = join(mkd, 'ws')
  const varDir = join(mkd, 'var')
  const fakeHome = join(mkd, 'home')
  for (const d of [ws, varDir, fakeHome]) mkdirSync(d)
  mkdirSync(join(fakeHome, '.grok'))
  writeFileSync(join(fakeHome, '.grok', 'auth.json'), '{"fake":"auth"}\n')
  const runtime = join(
    RUNTIME_DIR,
    `${process.pid}-${randomBytes(4).toString('hex')}`,
    'bin',
  )
  mkdirSync(runtime, { recursive: true })
  const stubBin = join(runtime, 'grok')
  writeFileSync(stubBin, STUB_SRC)
  chmodSync(stubBin, 0o755)
  const stage: Stage = { mkd, ws, varDir, fakeHome, runtime, stubBin, capturePath: join(mkd, 'capture.jsonl') }
  stages.push(stage)
  return stage
}

export function cleanupStages(): void {
  for (const s of stages.splice(0)) rmSync(s.mkd, { recursive: true, force: true })
}

/** The launcher's canonical {R, H} pair for a stage (mirrors home.mjs). */
export function homePathsFor(stage: Stage): { R: string; H: string } {
  const R = join(realpathSync(stage.varDir), `grok-review-home-${process.getuid()}`)
  const H = join(
    R,
    createHash('sha256').update(realpathSync(stage.ws)).digest('hex').slice(0, 16),
  )
  return { R, H }
}

export function baseEnv(stage: Stage, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${stage.runtime}:${process.env.PATH ?? ''}`,
    TMPDIR: stage.varDir,
    HOME: stage.fakeHome,
    GROK_STUB_CAPTURE: stage.capturePath,
    ...extra,
  }
}

export interface RunResult {
  child: ReturnType<typeof spawn>
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/**
 * Spawn the launcher as a REAL node subprocess. `exitOnly` waits on 'exit'
 * instead of 'close' — needed when a surviving grandchild (sleeper stub)
 * inherits the stdio pipes and would hold 'close' open.
 */
export function spawnLauncher(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; exitOnly?: boolean },
): { child: ReturnType<typeof spawn>; done: Promise<RunResult> } {
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d
  })
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d
  })
  const done = new Promise<RunResult>((resolve) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ child, code, signal, stdout, stderr })
      // Free the child handle + pipes once settled: under exitOnly, the
      // launcher's 'exit' precedes its 'close', and a surviving grandchild
      // (the launcher's detached grok stub) can keep the child handle
      // registered past the test even after stream.destroy() — a forked
      // vitest worker then refuses to terminate (PR #166 CI red, twice;
      // dump: leaked ChildProcess pid=<sigterm-me launcher>, exitCode=130).
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
    }
    // A spawn-level failure (EAGAIN under full-suite load, ENOENT) emits
    // 'error' and neither 'exit' nor 'close' — settling on it keeps the
    // failure named instead of hanging to the test timeout.
    child.on('error', (e: Error) => {
      stderr += `spawn error: ${e.message}`
      settle(-1, null)
    })
    if (opts.exitOnly) child.on('exit', settle)
    else child.on('close', settle)
  })
  return { child, done }
}

export async function waitFor(
  fn: () => boolean,
  // 30s default: full-suite runs on a loaded box stall child-process startup
  // well past a casual budget.
  { timeoutMs = 30_000, stepMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

export function readCaptures(
  stage: Stage,
): Array<{ argv: string[]; cwd: string; grokHome?: string; xaiKey?: string; sessionIdEnv?: string; sandboxEnv?: string }> {
  try {
    return readFileSync(stage.capturePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
