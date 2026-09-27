/**
 * Behavioral specs for the cc-grok-bridge PreToolUse allow hook (§3.2):
 * the hook is spawned as a real node subprocess with a JSON stdin payload.
 * Every FIXTURES row is re-anchored from the example canonical pair onto
 * the hook's own per-match derivation, so the shared fixture table stays
 * the single matcher source.
 *
 * Contract pinned here: allow = exactly one hookSpecificOutput JSON line
 * (NEVER a top-level `decision` — the codec drops that field); every
 * non-match/disarm/refusal = empty stdout, exit 0 (fail closed into the
 * unchanged permission flow, never a deny).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CANONICAL_LAUNCHER, CANONICAL_NODE, FIXTURES } from '../scripts/lib/argv.mjs'

const HOOK = join(dirname(import.meta.dirname), 'hooks', 'grok-review-allow.mjs')

/** The hook's own per-match anchor derivation, replicated here. */
const HOOK_NODE = realpathSync(process.execPath)
const HOOK_LAUNCHER = realpathSync(join(dirname(import.meta.dirname), 'scripts', 'grok-review-run.mjs'))

/** The escaped launcher path inside the `hostile install path` fixture row. */
const HOSTILE_ESCAPED_LAUNCHER = "/opt/dsh space/quote'\\''s/cc-grok-bridge/scripts/grok-review-run.mjs"

const ALLOW_OUTPUT = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'cc-grok-bridge: canonical review invocation (byte-pinned anchors, expansion-free)',
  },
}

let dir: string

interface RunResult {
  stdout: string
  stderr: string
  status: number | null
}

function runHook(payload: unknown, env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status }
}

function bashPayload(command: string, cwd: string = dir): Record<string, unknown> {
  return {
    session_id: 'spec',
    transcript_path: '',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'spec',
  }
}

/**
 * Re-anchor a fixture row's input from the example canonical pair onto the
 * hook's real anchors. The hostile-row's escaped quoted path is rewritten to
 * a single-quoted real launcher (its lexer result is the path text, which
 * then byte-equals HOOK_LAUNCHER).
 */
function reanchor(row: { input: string; launcher?: string }): string {
  let input = row.input.replaceAll(CANONICAL_NODE, HOOK_NODE).replaceAll(CANONICAL_LAUNCHER, HOOK_LAUNCHER)
  if (row.launcher !== undefined) input = input.replaceAll(HOSTILE_ESCAPED_LAUNCHER, HOOK_LAUNCHER)
  return input
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cc-grok-bridge-hook-'))
  dir = realpathSync(dir)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('grok-review-allow.mjs — shared FIXTURES table re-anchored onto the real hook', () => {
  for (const row of FIXTURES) {
    if (row.ok) {
      it(`allows fixture: ${row.name}`, () => {
        let command = reanchor(row)
        // prompt-file rows name /tmp/prompts/p.txt; replace it with a real
        // file inside the payload cwd so containment holds.
        if (row.value.prompt.kind === 'prompt-file') {
          const promptPath = join(dir, 'prompt.txt')
          writeFileSync(promptPath, 'review me')
          command = command.replaceAll('/tmp/prompts/p.txt', promptPath)
        }
        const res = runHook(bashPayload(command))
        expect(res.status, `stderr: ${res.stderr}`).toBe(0)
        const verdict = JSON.parse(res.stdout.trim()) as {
          decision?: unknown
          hookSpecificOutput?: Record<string, string>
        }
        expect(verdict.hookSpecificOutput).toEqual(ALLOW_OUTPUT.hookSpecificOutput)
        // Decision-channel trap: a top-level decision:"allow" is DROPPED by
        // the hook codec — the allow must live only in hookSpecificOutput.
        expect(verdict.decision).toBeUndefined()
        expect(Object.keys(verdict)).toEqual(['hookSpecificOutput'])
      })
    } else {
      it(`stays silent for fixture: ${row.name}`, () => {
        const res = runHook(bashPayload(reanchor(row)))
        expect(res.status).toBe(0)
        expect(res.stdout).toBe('')
      })
    }
  }
})

describe('grok-review-allow.mjs — arming and refusal', () => {
  const canonical = `${HOOK_NODE} ${HOOK_LAUNCHER} -- 'review the failing spec'`

  it('non-empty BASH_ENV disarms (silent)', () => {
    const res = runHook(bashPayload(canonical), { BASH_ENV: join(dir, 'evil.sh') })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('non-empty ENV disarms (silent)', () => {
    const res = runHook(bashPayload(canonical), { ENV: join(dir, 'env.sh') })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('a writable-root refusal: cwd containing the launcher refuses even a byte-perfect canonical command', () => {
    // The plugin's own repo dir contains the launcher script — it must NEVER
    // arm when the session workspace is that directory.
    const repoDir = dirname(dirname(HOOK_LAUNCHER))
    const res = runHook({ ...bashPayload(canonical), cwd: repoDir })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('platform win32 disarms (D17, injected via env-mirrored arming platform — the real hook process is POSIX, so this row pins the canonical.mjs unit and the hook silence path)', () => {
    // The real hook subprocess inherits the test platform (darwin/linux);
    // win32 arming is pinned by the canonical.mjs unit rows in
    // hook-context.spec.ts. Here we pin the hook still never denies.
    const res = runHook(bashPayload(canonical))
    expect(res.stdout).not.toContain('"deny"')
  })
})

describe('grok-review-allow.mjs — prompt-file containment', () => {
  const withPromptFile = (path: string) => `${HOOK_NODE} ${HOOK_LAUNCHER} --prompt-file ${path}`

  it('allows a prompt file inside the payload cwd', () => {
    const p = join(dir, 'inside.txt')
    writeFileSync(p, 'review me')
    const res = runHook(bashPayload(withPromptFile(p)))
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout.trim()).hookSpecificOutput).toEqual(ALLOW_OUTPUT.hookSpecificOutput)
  })

  it('stays silent for a prompt file outside the roots (/etc/hosts)', () => {
    const res = runHook(bashPayload(withPromptFile('/etc/hosts')))
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('stays silent for a symlink inside cwd pointing outside', () => {
    // The target must sit outside BOTH containment roots ({cwd, tmpdir}) —
    // the repo tests dir is outside tmp on any normal checkout.
    const outside = join(import.meta.dirname, 'outside-target.txt')
    try {
      writeFileSync(outside, 'escape')
      const link = join(dir, 'escape.txt')
      symlinkSync(outside, link)
      const res = runHook(bashPayload(withPromptFile(link)))
      expect(res.status).toBe(0)
      expect(res.stdout).toBe('')
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('resolves a relative prompt path against the payload cwd', () => {
    const p = join(dir, 'rel.txt')
    writeFileSync(p, 'review me')
    const res = runHook(bashPayload(withPromptFile('rel.txt')))
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout.trim()).hookSpecificOutput).toEqual(ALLOW_OUTPUT.hookSpecificOutput)
  })
})

describe('grok-review-allow.mjs — hostile stdin (silent exit 0, never a deny)', () => {
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

  it('missing tool_input is silent', () => {
    const res = runHook({ session_id: 'spec', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('non-string tool_input.command is silent', () => {
    const res = runHook(bashPayload(42))
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('a non-Bash tool is silent', () => {
    const res = runHook({ ...bashPayload(`${HOOK_NODE} ${HOOK_LAUNCHER} -- p`), tool_name: 'Edit' })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('the hook never emits a deny for any input', () => {
    for (const payload of ['garbage', bashPayload('echo hi'), '']) {
      const res = runHook(payload)
      expect(res.stdout).not.toContain('"deny"')
      expect(res.stdout).not.toContain('"block"')
    }
  })
})
