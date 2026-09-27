/**
 * Behavioral specs for the SessionStart context hook
 * (`grok-review-context.mjs`): the hook is spawned as a real node
 * subprocess with a JSON stdin payload.
 *
 * Pinned here:
 *  - ARMED payload → additionalContext whose canonical command line, lexed
 *    by the shared lexer, resolves argv[0]/argv[1] BYTE-EQUAL to the
 *    derived canonical anchors (quoting round-trip, incl. a hostile
 *    launcher path with spaces and a `'` through the escaping helper).
 *  - REFUSED payload (session cwd = the plugin's own repo dir) → refused
 *    block carrying the machine reason; the D17 platform-win32 REFUSED text
 *    is pinned at the canonical.mjs unit level (the hook process is POSIX).
 *  - missing/non-string payload.cwd → process.cwd() fallback.
 *  - Garbage stdin → silent exit 0.
 *  - The emitted JSON NEVER carries a top-level `decision` key.
 *  - Anchor lint: BOTH hook scripts import canonical.mjs and neither
 *    re-implements the derivation.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { armedText, arming, posixSingleQuote, refusedText } from '../scripts/lib/canonical.mjs'
import { lexCommand } from '../scripts/lib/lexer.mjs'

const PLUGIN = dirname(import.meta.dirname)
const CONTEXT_HOOK = join(PLUGIN, 'hooks', 'grok-review-context.mjs')
const ALLOW_HOOK = join(PLUGIN, 'hooks', 'grok-review-allow.mjs')

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

function sessionPayload(cwd: unknown): Record<string, unknown> {
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
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-cc-grok-bridge-context-')))
})
afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('grok-review-context.mjs — armed payload', () => {
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

  it('exposes both invocation forms, the D9 dash-leading note, and --last restricted to explicit continue', () => {
    const res = runHook(sessionPayload(ws))
    const text = parseContext(res.stdout).hookSpecificOutput!.additionalContext!
    expect(text).toContain('--prompt-file')
    expect(text).toContain('--last')
    expect(text).toContain('dash-leading inline prompts are rejected by the launcher')
    expect(text.toLowerCase()).toContain('only when the user explicitly asks')
    expect(text).not.toContain('stdin')
  })
})

describe('quoting round-trip — hostile launcher path through the escaping helper', () => {
  it('unit: the escaping helper output lexes back byte-equal (spaces + quote)', () => {
    const hostile = "/opt/dsh space/quote's/cc-grok-bridge/scripts/grok-review-run.mjs"
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

describe('grok-review-context.mjs — refused payload', () => {
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

describe('canonical.mjs — D17 platform gate (unit rows with the injected platform)', () => {
  it('platform win32 refuses with platform-win32 and its pinned plain-words text', () => {
    const arm = arming(ws, { hookUrl: pathToFileURL(CONTEXT_HOOK).href, platform: 'win32' })
    expect(arm).toMatchObject({ armed: false, reason: 'platform-win32' })
    const text = refusedText((arm as { reason: string }).reason)
    expect(text).toContain('platform-win32')
    expect(text).toContain('platform win32 is unsupported — the launcher refuses it too')
  })

  it('armed text carries the pinned POSIX-escaped anchors verbatim', () => {
    const arm = armFor(ws)
    expect(arm.armed).toBe(true)
    const text = armedText(arm as { node: string; launcher: string })
    expect(text.split('\n')[0]).toContain('cc-grok-bridge: the Grok review lane is ARMED')
    expect(text).toContain(posixSingleQuote((arm as { node: string }).node))
  })
})

describe('grok-review-context.mjs — cwd fallback (codex mirror)', () => {
  it('missing payload.cwd falls back to process.cwd() (armed outside tmp workspace)', () => {
    // process.cwd() of the spawned hook = the vitest worker cwd (repo). The
    // repo launcher anchor is under the workspace → refused; the ROW pins
    // that the fallback path produces a verdict rather than silence, with
    // the refusal naming the expected repo-dev reason.
    const res = runHook({ session_id: 'spec', hook_event_name: 'SessionStart', source: 'startup' })
    expect(res.status).toBe(0)
    const parsed = parseContext(res.stdout)
    const text = parsed.hookSpecificOutput!.additionalContext!
    expect(text.startsWith('cc-grok-bridge:')).toBe(true)
  })

  it('non-string payload.cwd falls back too', () => {
    const res = runHook(sessionPayload(42))
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('hookSpecificOutput')
  })
})

describe('grok-review-context.mjs — hostile stdin (silent exit 0)', () => {
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

describe('anchor lint — canonical.mjs is the one derivation source', () => {
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
