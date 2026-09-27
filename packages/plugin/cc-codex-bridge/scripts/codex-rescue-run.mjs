#!/usr/bin/env node
/**
 * §3.1 launcher for the codex-rescue-bridge.
 *
 *   codex-rescue-run.mjs [--last] -- <single-line prompt>
 *   codex-rescue-run.mjs [--last] --prompt-file <path>
 *
 * Redirects CODEX_HOME to a per-cwd shadow home under the canonical tmpdir
 * (§3.1 steps 1–4, scripts/lib/home.mjs), resolves and validates the Codex
 * CLI, spawns `codex exec --sandbox danger-full-access ... -` with the prompt
 * on stdin, and prints last-message.txt at the end.
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { parseArgv } from './lib/argv.mjs'
import { acquireLock, prepareHome, syncCredentials } from './lib/home.mjs'

const USAGE =
  'usage: codex-rescue-run.mjs [--last] -- <single-line prompt>\n' +
  '       codex-rescue-run.mjs [--last] --prompt-file <path>'

const die = (msg, code = 1) => {
  const e = new Error(`codex-rescue: ${msg}`)
  e.exitCode = code
  throw e
}

/** Canonicalized outer writable roots: {cwd, tmpdir, /tmp} (§3.1 step 6). */
function writableRoots() {
  const roots = []
  for (const p of [process.cwd(), os.tmpdir(), '/tmp']) {
    try {
      roots.push(realpathSync(p))
    } catch {
      /* absent root — nothing to confine against */
    }
  }
  return roots
}

const outsideRoots = (p, roots) => !roots.some((r) => p === r || p.startsWith(r + path.sep))

function resolveCodex(roots) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    let real
    try {
      real = realpathSync(path.join(dir, 'codex'))
    } catch {
      continue
    }
    // The executed binary must sit outside every canonicalized writable
    // root: nothing the model can write may become the CLI (§3.1 step 6).
    if (!outsideRoots(real, roots)) continue
    return real
  }
  die('codex CLI not found on PATH outside the writable roots')
}

const PROMPT_CAP = 256 * 1024

/**
 * --prompt-file (§3.1 step 5): O_NOFOLLOW open, fstat regular-file, read
 * from THAT same fd with the byte cap. The check→open ancestor-swap race is
 * the §4 accepted residual — this channel is hygiene-only (prompt text the
 * model could already read and inline itself), data egress into a networked
 * model run, not an egress gate.
 */
function readPromptFile(p) {
  let fd
  try {
    fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (e) {
    die(`prompt-file unreadable: ${e.message}`)
  }
  try {
    if (!fstatSync(fd).isFile()) die('prompt-file is not a regular file')
    if (fstatSync(fd).size > PROMPT_CAP) die(`prompt-file exceeds the ${PROMPT_CAP}-byte cap`)
    return readFileSync(fd).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Spawn codex with the prompt on a piped stdin, written then closed. */
function runCodex(codex, args, env, promptText) {
  return new Promise((resolve) => {
    const child = spawn(codex, args, { env, stdio: ['pipe', 'inherit', 'inherit'] })
    // Write the full prompt then CLOSE stdin — the EOF is the prompt
    // terminator (§5 write/close EOF path). Child stdout/stderr inherit;
    // CODEX_HOME lives only in this child env object, process.env is never
    // mutated.
    child.stdin.end(promptText)
    child.on('error', (e) => {
      console.error(`codex-rescue: spawn failed: ${e.message}`)
      resolve(1) // never throw from an event callback — the finally must run
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function main() {
  if (process.platform === 'win32') {
    // The design's probes (§2) targeted POSIX; fail loud instead of guessing.
    die('unsupported platform win32')
  }

  const roots = writableRoots()

  // Self-assert at startup (§3.1 step 6, critic F1 belt): the interpreter
  // must sit outside every writable root — one line of defense-in-depth
  // against a mismatched/PATH-swapped node.
  const selfNode = realpathSync(process.execPath)
  if (!outsideRoots(selfNode, roots)) {
    die('node interpreter sits inside a canonicalized writable root')
  }

  // Parse own argv with the shared grammar. Real argv has no shell quoting
  // left: map each arg to { text, expansion: false }.
  const launcherPath = realpathSync(fileURLToPath(import.meta.url))
  const words = [
    { text: selfNode, expansion: false },
    { text: launcherPath, expansion: false },
    ...process.argv.slice(2).map((a) => ({ text: a, expansion: false })),
  ]
  const parsed = parseArgv(words, { node: selfNode, launcher: launcherPath })
  if (!parsed.ok) die(`invalid invocation (${parsed.reason})\n${USAGE}`, 2)
  const { last, prompt } = parsed.value

  const { H } = prepareHome({ cwd: process.cwd(), tmpdir: os.tmpdir() })
  const releaseLock = acquireLock(H)
  try {
    syncCredentials(H)
    const codex = resolveCodex(roots)
    const promptText =
      prompt.kind === 'inline' ? prompt.text : readPromptFile(prompt.path)

    const args = [
      'exec',
      '--sandbox',
      'danger-full-access',
      '--cd',
      realpathSync(process.cwd()),
      '-o',
      path.join(H, 'last-message.txt'),
    ]
    if (last) args.push('resume', '--last')
    // The literal `-` selects stdin on BOTH shapes (fresh exec and
    // `resume --last`, per the 0.153.4 help text): prompt content is always
    // stdin data, so leading-dash prompts are never re-parsed as flags.
    args.push('-')

    const code = await runCodex(codex, args, { ...process.env, CODEX_HOME: H }, promptText)

    const outFile = path.join(H, 'last-message.txt')
    if (existsSync(outFile)) process.stdout.write(readFileSync(outFile))
    return code
  } finally {
    releaseLock()
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    console.error(e?.message ?? e)
    process.exitCode = e?.exitCode ?? 1
  },
)
