/**
 * Shared staging for the launcher specs: fake codex stub under the repo
 * tests dir (outside every canonicalized writable root the launcher sees —
 * load-bearing for the CLI-path validation row), fake HOME with a fake
 * .codex, and a mkdtemp workspace/var pair from the TEST process tmpdir.
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PKG_DIR = join(import.meta.dirname, '..')
export const LAUNCHER = join(PKG_DIR, 'scripts', 'codex-rescue-run.mjs')
export const TESTS_DIR = import.meta.dirname
export const RUNTIME_DIR = join(TESTS_DIR, '.runtime')

/** Fake codex CLI: capture argv/stdin/CODEX_HOME, materialize -o, knobs. */
const STUB_SRC = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
let stdin = ''
try { stdin = readFileSync(0, 'utf8') } catch {}
appendFileSync(
  process.env.CODEX_STUB_CAPTURE,
  JSON.stringify({ argv, stdin, codexHome: process.env.CODEX_HOME }) + '\\n',
)
const oi = argv.indexOf('-o')
if (oi !== -1 && argv[oi + 1]) writeFileSync(argv[oi + 1], 'STUB LAST MESSAGE\\n')
if (process.env.CODEX_STUB_SLEEP_MS) {
  setTimeout(() => process.exit(0), Number(process.env.CODEX_STUB_SLEEP_MS))
} else {
  process.exitCode = Number(process.env.CODEX_STUB_EXIT ?? '0')
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
  const mkd = mkdtempSync(join(tmpdir(), 'codex-bridge-spec-'))
  const ws = join(mkd, 'ws')
  const varDir = join(mkd, 'var')
  const fakeHome = join(mkd, 'home')
  for (const d of [ws, varDir, fakeHome]) mkdirSync(d)
  mkdirSync(join(fakeHome, '.codex'))
  writeFileSync(join(fakeHome, '.codex', 'auth.json'), '{"fake":"auth"}\n')
  writeFileSync(join(fakeHome, '.codex', 'config.toml'), 'fake = true\n')
  const runtime = join(
    RUNTIME_DIR,
    `${process.pid}-${randomBytes(4).toString('hex')}`,
    'bin',
  )
  mkdirSync(runtime, { recursive: true })
  const stubBin = join(runtime, 'codex')
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
  const R = join(realpathSync(stage.varDir), `codex-rescue-home-${process.getuid()}`)
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
    CODEX_STUB_CAPTURE: stage.capturePath,
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
    const settle = (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ child, code, signal, stdout, stderr })
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
  // well past a casual budget (presubmit evidence, 2026-09-26).
  { timeoutMs = 30_000, stepMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

export function readCaptures(stage: Stage): Array<{ argv: string[]; stdin: string; codexHome?: string }> {
  try {
    return readFileSync(stage.capturePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
