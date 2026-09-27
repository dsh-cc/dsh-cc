/**
 * Behavioral specs for the PR-3 SessionStart context hook
 * (`codex-rescue-context.mjs`), following the dsh-cc-shunt hooks.spec
 * subprocess pattern: the hook is spawned as a real node subprocess with a
 * JSON stdin payload.
 *
 * Pinned here:
 *  - ARMED payload → additionalContext whose canonical command line, lexed
 *    by the PR-1 shared lexer, resolves argv[0]/argv[1] BYTE-EQUAL to the
 *    derived canonical anchors (quoting round-trip, incl. a hostile
 *    launcher path with spaces and a `'` through the escaping helper).
 *  - REFUSED payload (session cwd = the plugin's own repo dir) → refused
 *    block carrying the machine reason.
 *  - Garbage stdin → silent exit 0.
 *  - The emitted JSON NEVER carries a top-level `decision` key.
 *  - Anchor lint (§5 one-source rule): BOTH hook scripts import
 *    canonical.mjs and neither re-implements the derivation (no second
 *    copy of the refusal-set literal outside canonical.mjs).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { arming, posixSingleQuote } from '../scripts/lib/canonical.mjs'
import { lexCommand } from '../scripts/lib/lexer.mjs'

const PLUGIN = dirname(import.meta.dirname)
const CONTEXT_HOOK = join(PLUGIN, 'hooks', 'codex-rescue-context.mjs')
const ALLOW_HOOK = join(PLUGIN, 'hooks', 'codex-rescue-allow.mjs')

/** The arming verdict the hook itself must derive for a given cwd. */
const armFor = (cwd: string) => arming(cwd, { hookUrl: pathToFileURL(CONTEXT_HOOK).href })

interface RunResult {
  stdout: string
  stderr: string
  status: number | null
}

function runHook(payload: unknown): RunResult {
  const res = spawnSync(process.execPath, [CONTEXT_HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env },
  })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status }
}

function sessionPayload(cwd: string): Record<string, unknown> {
  return {
    session_id: 'spec',
    transcript_path: '',
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
  }
}

/** Parse the hook's single output line into the payload + additionalContext. */
function parseContext(stdout: string): { decision?: unknown; hookSpecificOutput?: { additionalContext?: string } } {
  const lines = stdout.trim().split('\n')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]!)
}

let ws: string
beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-cc-codex-bridge-context-')))
})
afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('codex-rescue-context.mjs — armed payload', () => {
  it('emits exactly one additionalContext line whose canonical command lexes back to the anchors', () => {
    const arm = armFor(ws)
    expect(arm.armed).toBe(true)
    const res = runHook(sessionPayload(ws))
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    const parsed = parseContext(res.stdout)
    // Decision-channel trap: additionalContext must live ONLY in
    // hookSpecificOutput — never a top-level decision key.
    expect(parsed.decision).toBeUndefined()
    expect(Object.keys(parsed)).toEqual(['hookSpecificOutput'])
    const text = parsed.hookSpecificOutput!.additionalContext!
    expect(text).toContain('ARMED')
    // The canonical `-- <prompt>` form is the first invocation line.
    const canonicalLine = text.split('\n').find((l) => l.includes(" -- '"))!
    const lex = lexCommand(canonicalLine)
    expect(lex.ok).toBe(true)
    if (!lex.ok) return
    expect(lex.argv[0]!.text).toBe(arm.node)
    expect(lex.argv[1]!.text).toBe(arm.launcher)
    expect(lex.argv[0]!.expansion).toBe(false)
    expect(lex.argv[1]!.expansion).toBe(false)
  })

  it('exposes both invocation forms: --prompt-file and --last restricted to explicit continue', () => {
    const res = runHook(sessionPayload(ws))
    const text = parseContext(res.stdout).hookSpecificOutput!.additionalContext!
    expect(text).toContain('--prompt-file')
    expect(text).toContain('--last')
    expect(text.toLowerCase()).toContain('only when the user explicitly asks')
  })
})

describe('quoting round-trip — hostile launcher path through the escaping helper', () => {
  it('unit: the escaping helper output lexes back byte-equal (spaces + quote)', () => {
    const hostile = "/opt/dsh space/quote's/cc-codex-bridge/scripts/codex-rescue-run.mjs"
    const line = `${posixSingleQuote(process.execPath)} ${posixSingleQuote(hostile)} -- 'review the failing spec'`
    const lex = lexCommand(line)
    expect(lex.ok).toBe(true)
    if (!lex.ok) return
    expect(lex.argv[0]!.text).toBe(process.execPath)
    expect(lex.argv[1]!.text).toBe(hostile)
    expect(lex.argv[1]!.expansion).toBe(false)
  })

  it('e2e: the real subprocess line survives lexCommand byte-for-byte', () => {
    const res = runHook(sessionPayload(ws))
    const text = parseContext(res.stdout).hookSpecificOutput!.additionalContext!
    const promptFileLine = text.split('\n').find((l) => l.includes('--prompt-file'))!
    const lex = lexCommand(promptFileLine)
    expect(lex.ok).toBe(true)
    if (!lex.ok) return
    const arm = armFor(ws)
    expect(lex.argv[0]!.text).toBe(arm.node)
    expect(lex.argv[1]!.text).toBe(arm.launcher)
  })
})

describe('codex-rescue-context.mjs — refused payload', () => {
  it('cwd = the plugin repo dir (launcher under it) refuses with the machine reason in plain words', () => {
    const res = runHook(sessionPayload(PLUGIN))
    expect(res.status).toBe(0)
    const parsed = parseContext(res.stdout)
    expect(parsed.decision).toBeUndefined()
    const text = parsed.hookSpecificOutput!.additionalContext!
    expect(text).toContain('NOT armed')
    expect(text).toContain('anchor-under-writable-root')
    expect(text).toContain('normal, approval-requiring path')
  })
})

describe('codex-rescue-context.mjs — hostile stdin (silent exit 0)', () => {
  it('garbage stdin is silent', () => {
    const res = runHook('not json at all')
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('empty stdin is silent', () => {
    const res = runHook('')
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('never emits a deny/decision channel', () => {
    for (const payload of ['garbage', sessionPayload(ws), '']) {
      const res = runHook(payload)
      expect(res.stdout).not.toContain('"deny"')
      expect(res.stdout).not.toContain('"decision"')
    }
  })
})

describe('anchor lint — canonical.mjs is the one derivation source (§5)', () => {
  it('both hook scripts import canonical.mjs', () => {
    const allow = readFileSync(ALLOW_HOOK, 'utf8')
    const context = readFileSync(CONTEXT_HOOK, 'utf8')
    expect(allow).toContain("from '../scripts/lib/canonical.mjs'")
    expect(context).toContain("from '../scripts/lib/canonical.mjs'")
  })

  it('neither hook re-implements the derivation (no second refusal-set literal)', () => {
    for (const file of [ALLOW_HOOK, CONTEXT_HOOK]) {
      const src = readFileSync(file, 'utf8')
      // The distinctive refusal-set literals live ONLY in canonical.mjs:
      // no hook re-derives the anchor pair or the refusal roots.
      expect(src).not.toContain("'/tmp'")
      expect(src).not.toContain('process.execPath')
      expect(src).not.toContain('realpathSync')
    }
  })
})
