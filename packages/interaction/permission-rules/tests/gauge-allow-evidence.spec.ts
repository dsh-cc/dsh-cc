import { describe, expect, it, vi } from 'vitest'
import { collectGaugeAllowEvidence } from '../src/gauge-allow-evidence.ts'
import { parseRule } from '../src/parser.ts'
import type { PermissionRule } from '../src/types.ts'

const EXEC = { name: 'Bash', arguments: { command: 'python3 -c "print(1)"' } } as never

function rule(source: PermissionRule['source'], raw: string): PermissionRule {
  return parseRule(raw, 'allow', source)
}

function session(id: string, events: unknown[]) {
  return {
    id,
    snapshotEvents: vi.fn(() => events),
  } as never
}

const ALLOW_EVENT = (rule: string): unknown => ({
  type: 'permission/session-allow',
  data: { rule, scope: 'session', toolName: 'Bash', timestamp: 1 },
})

describe('collectGaugeAllowEvidence', () => {
  it('source filter: user scopes included, projectSettings/config excluded', () => {
    const rules = [
      rule('userSettings', 'Bash(git status)'),
      rule('localSettings', 'Bash(npm test)'),
      rule('cliArg', 'Bash(ls:*)'),
      rule('policySettings', 'Bash(make:*)'),
      rule('flagSettings', 'Bash(docker:*)'),
      rule('projectSettings', 'Bash(curl:*)'),
      rule('config', 'Bash(wget:*)'),
              rule('curated', 'Bash(evil:*)'),
    ]
    const lines = collectGaugeAllowEvidence({ exec: EXEC, rules, session: undefined })
    expect(lines).toEqual([
      'Pre-authorized: Bash(git status)',
      'Pre-authorized: Bash(npm test)',
      'Pre-authorized: Bash(ls:*)',
      'Pre-authorized: Bash(make:*)',
      'Pre-authorized: Bash(docker:*)',
    ])
  })

  it('relevance: tool filtered through ccToolAliases; whole-tool rules included', () => {
    const lines = collectGaugeAllowEvidence({
      exec: EXEC,
      rules: [rule('userSettings', 'Bash'), rule('userSettings', 'Read'), rule('userSettings', 'Bash(python3:*)')],
      session: undefined,
    })
    expect(lines).toEqual(['Pre-authorized: Bash', 'Pre-authorized: Bash(python3:*)'])
  })

  it('session grants render the this-session label and follow static order', () => {
    const lines = collectGaugeAllowEvidence({
      exec: EXEC,
      rules: [rule('userSettings', 'Bash(git status)')],
      session: session('grant-order', [ALLOW_EVENT('Bash(python3:*)'), ALLOW_EVENT('Bash(uv run:*)')]),
    })
    expect(lines).toEqual([
      'Pre-authorized: Bash(git status)',
      'Pre-authorized this session: Bash(python3:*)',
      'Pre-authorized this session: Bash(uv run:*)',
    ])
  })

  it('memoized grant fold: same (sessionId, length) skips the refold', () => {
    const events = [ALLOW_EVENT('Bash(python3:*)')]
    const s = session('memo', events)
    const first = collectGaugeAllowEvidence({ exec: EXEC, rules: [], session: s })
    // Second call with the SAME id but a DIFFERENT same-length events array
    // (a malformed grant): the memo must still serve the first fold — the
    // new array is never folded.
    const other = session('memo', [{ type: 'permission/session-allow', data: { rule: 'Bash(bad' } }])
    const second = collectGaugeAllowEvidence({ exec: EXEC, rules: [], session: other })
    expect(second).toEqual(first)
    // A new grant appends an event → length changes → refold (cache rotation
    // rides this via classificationKey).
    events.push(ALLOW_EVENT('Bash(pip:*)'))
    const third = collectGaugeAllowEvidence({ exec: EXEC, rules: [], session: s })
    expect(third).toEqual([...first, 'Pre-authorized this session: Bash(pip:*)'])
  })

  it('malformed grant entries are tolerated (no throw into the escalation path)', () => {
    const lines = collectGaugeAllowEvidence({
      exec: EXEC,
      rules: [],
      session: session('malformed', [ALLOW_EVENT('Bash(not closed'), { type: 'permission/session-allow' }, { type: 'other' }]),
    })
    expect(lines).toEqual([])
  })

  it('block budget: many lines collapse to one remainder line', () => {
    // Doc-frozen budgets: ≤24 lines AND ≤128 estimated tokens; with realistic
    // line costs the token budget binds first — both must hold on the result.
    const rules = Array.from({ length: 30 }, (_, i) => rule('userSettings', `Bash(cmd${i}:*)`))
    const lines = collectGaugeAllowEvidence({ exec: EXEC, rules, session: undefined })
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(lines.length).toBeLessThan(30)
    expect(lines.at(-1)).toBe(`…and ${30 - (lines.length - 1)} more pre-authorized rules`)
    expect(lines[0]).toBe('Pre-authorized: Bash(cmd0:*)')
  })

  it('line cap 160 chars per line', () => {
    const lines = collectGaugeAllowEvidence({
      exec: EXEC,
      rules: [rule('userSettings', `Bash(${'x'.repeat(400)})`)],
      session: undefined,
    })
    expect(lines[0]!.length).toBe(160)
    expect(lines[0]!.endsWith('…')).toBe(true)
  })

  it('block token budget (≤128) truncates with the remainder line', () => {
    const rules = Array.from({ length: 8 }, (_, i) => rule('userSettings', `Bash(${'word '.repeat(20)}cmd${i})`))
    const lines = collectGaugeAllowEvidence({ exec: EXEC, rules, session: undefined })
    expect(lines.length).toBeLessThan(8)
    expect(lines.at(-1)).toMatch(/^…and \d+ more pre-authorized rules$/)
    expect(lines.filter((line) => line.startsWith('Pre-authorized')).length).toBeLessThanOrEqual(7)
  })

  it('deterministic order across repeated calls', () => {
    const rules = [rule('localSettings', 'Bash(b:*)'), rule('userSettings', 'Bash(a:*)')]
    const s = session('deterministic', [ALLOW_EVENT('Bash(c:*)')])
    const first = collectGaugeAllowEvidence({ exec: EXEC, rules, session: s })
    const second = collectGaugeAllowEvidence({ exec: EXEC, rules, session: s })
    expect(first).toEqual(second)
    expect(first).toEqual([
      'Pre-authorized: Bash(b:*)',
      'Pre-authorized: Bash(a:*)',
      'Pre-authorized this session: Bash(c:*)',
    ])
  })
})
