#!/usr/bin/env node
/**
 * Live smoke test for subagent fork tool availability across agent routes.
 *
 * Motivation: a subagent routed to a non-Claude model once failed silently —
 * the model believed the ToolSearch description ("filesystem tools are
 * deferred, search to load them"), searched an empty deferred pool, and
 * concluded it had no tools, never attempting a direct `read`. Unit tests pin
 * the harness side (empty pool ⇒ no ToolSearch, honest empty-result copy);
 * this script pins the *model-behavior* side against real providers.
 *
 * For each agent type in the cwd's `.claude/agents` (plus a plain-fork
 * baseline), it runs `dsh --profile headless` with a task that delegates
 * reading a fixture file to that subagent type — WITHOUT coaching the child
 * to bypass tool search, so the original trap would reproduce — and asserts
 * the child returns the fixture's sentinel token.
 *
 * Opt-in: requires DSH_CC_LIVE_E2E=1 (spends real LLM calls). Not part of
 * `pnpm test`. Usage:
 *
 *   DSH_CC_LIVE_E2E=1 node scripts/smoke-subagent-routes.mjs [--agent <type>] [--timeout <ms>] [--profile <name>]
 *
 * Profile note: the booted profile must carry the dsh-cc bundles (the stock
 * `headless` profile does NOT — it lacks the CC preset and the Task tool).
 * The `dsh-tui` profile has them but requires a TTY, so create a headless
 * variant (copy ~/.dsh/profiles/headless, add "@dsh-cc/bundle-permissions"
 * and "@dsh-cc/bundle-shell" to its dsh.profile.bundles, then
 * `dsh plugin --profile <name> install`) and pass it via --profile.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TIMEOUT_DEFAULT = 300_000

function parseArgs(argv) {
  const opts = { agent: undefined, timeout: TIMEOUT_DEFAULT, profile: 'headless' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--agent') opts.agent = argv[++index]
    else if (argv[index] === '--timeout') opts.timeout = Number(argv[++index])
    else if (argv[index] === '--profile') opts.profile = argv[++index]
  }
  return opts
}

/** Agent type names declared in the cwd's .claude/agents directory. */
function agentTypes(cwd) {
  let files
  try {
    files = readdirSync(join(cwd, '.claude', 'agents'))
  } catch {
    return []
  }
  return files
    .filter(file => file.endsWith('.md'))
    .map(file => {
      const head = readFileSync(join(cwd, '.claude', 'agents', file), 'utf8').slice(0, 2000)
      const match = head.match(/^name:\s*(\S+)/m)
      return match ? match[1] : file.replace(/\.md$/, '')
    })
}

/** Run one headless dsh task, resolving { ok, output }. */
function runHeadless(prompt, cwd, timeout, profile) {
  return new Promise((resolve) => {
    const child = spawn('dsh', ['--profile', profile, prompt], { cwd, env: process.env })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, output: `${output}\n[smoke] timed out after ${timeout}ms` })
    }, timeout)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output })
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, output: String(error) })
    })
  })
}

async function main() {
  if (process.env.DSH_CC_LIVE_E2E !== '1') {
    console.log('skipped: set DSH_CC_LIVE_E2E=1 to run live subagent-route smoke tests (spends real LLM calls)')
    return
  }
  const opts = parseArgs(process.argv.slice(2))
  const cwd = process.cwd()

  const dir = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
  const sentinel = `SMOKE-${randomBytes(4).toString('hex').toUpperCase()}`
  const fixture = join(dir, 'fixture.txt')
  writeFileSync(fixture, `${sentinel}\n`)

  // Baseline plain fork plus every declared agent type. The child's prompt
  // deliberately does NOT mention tool search or direct invocation: the
  // failure mode this guards against was an uncoached model trapping itself.
  const cases = [
    { label: '(plain fork)', delegate: 'omit subagent_type' },
    ...agentTypes(cwd).map(type => ({ label: type, delegate: `subagent_type "${type}"` })),
  ].filter(entry => opts.agent === undefined || entry.label === opts.agent)

  if (cases.length === 0) {
    console.error('no agent types found (run from a workspace with .claude/agents, or check --agent)')
    process.exitCode = 2
    rmSync(dir, { recursive: true, force: true })
    return
  }

  const failures = []
  for (const entry of cases) {
    const prompt = [
      `Delegate a smoke probe: call the subagent_fork tool with ${entry.delegate}, description "smoke probe",`,
      `and prompt: "Read the file ${fixture} and reply with exactly the token on its first line, nothing else."`,
      'When the child returns, print only the token it reported. If the delegation fails, print "DELEGATION-FAILED:" followed by the error.',
    ].join(' ')
    process.stdout.write(`[smoke] ${entry.label} ... `)
    const { ok, output } = await runHeadless(prompt, cwd, opts.timeout, opts.profile)
    const found = output.includes(sentinel)
    console.log(found ? 'ok' : 'FAIL')
    if (!found) {
      failures.push({ label: entry.label, ok, tail: output.trim().split('\n').slice(-15).join('\n') })
    }
  }

  rmSync(dir, { recursive: true, force: true })
  if (failures.length > 0) {
    console.error(`\n${failures.length} route(s) failed:`)
    for (const failure of failures) {
      console.error(`\n--- ${failure.label} (exit-ok=${failure.ok}) ---\n${failure.tail}`)
    }
    process.exitCode = 1
  } else {
    console.log(`\nall ${cases.length} route(s) passed`)
  }
}

await main()
