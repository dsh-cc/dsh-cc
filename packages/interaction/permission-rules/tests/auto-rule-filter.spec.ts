import { describe, expect, it } from 'vitest'
import { parseRule } from '../src/parser.ts'
import { autoSuspendedReason, filterAutoAllowRules } from '../src/auto-rule-filter.ts'
import { EMPTY_RULE_SET, type PermissionRuleSet } from '../src/types.ts'

function rules(overrides: Partial<PermissionRuleSet> = {}): PermissionRuleSet {
  return { allow: [], deny: [], ask: [], bypassImmune: [], ...overrides }
}

function allowStrings(list: string[]): PermissionRuleSet {
  return rules({ allow: list.map(raw => parseRule(raw, 'allow', 'config')) })
}

describe('filterAutoAllowRules', () => {
  it('suspends a whole-tool Bash allow (alias map membership)', () => {
    const out = filterAutoAllowRules(allowStrings(['Bash', 'bash', 'Edit']), { classifyAllShell: false })
    expect(out.allow.map(rule => rule.toolName)).toEqual(['Edit'])
  })

  it('suspends whole-tool PowerShell/pwsh allows spelled literally (case-insensitive)', () => {
    const out = filterAutoAllowRules(allowStrings(['PowerShell', 'pwsh', 'PWSH', 'Edit']), { classifyAllShell: false })
    expect(out.allow.map(rule => rule.toolName)).toEqual(['Edit'])
  })

  it('suspends bash content allows whose literal pre-star text is shorter than 3 chars', () => {
    const out = filterAutoAllowRules(allowStrings(['Bash(cu*)', 'Bash( *)', 'Bash(cURL *)']), { classifyAllShell: false })
    // `cURL ` has 4 fixed leading chars — narrow enough to stay in force.
    expect(out.allow.map(rule => rule.content)).toEqual(['cURL *'])
  })

  it('keeps a narrow bash content allow with a 3+ char pre-star text', () => {
    // `Bash(npm publish:*)`-style narrow rules stay in force in auto mode.
    const out = filterAutoAllowRules(allowStrings(['Bash(npm publish:*)']), { classifyAllShell: false })
    expect(out.allow).toHaveLength(1)
  })

  it('keeps a `Bash(*)`-normalized whole-tool rule handled by the whole-tool clause (suspended)', () => {
    const out = filterAutoAllowRules(allowStrings(['Bash(*)']), { classifyAllShell: false })
    expect(out.allow).toHaveLength(0)
  })

  it('suspends interpreter first tokens (bare `Bash(python)` included)', () => {
    const out = filterAutoAllowRules(allowStrings([
      'Bash(python)', 'Bash(python:*)', 'Bash(python *)', 'Bash(node script.js)',
      'Bash(ruby)', 'Bash(npm publish:*)',
    ]), { classifyAllShell: false })
    expect(out.allow.map(rule => rule.content)).toEqual(['npm publish:*'])
  })

  it('suspends package-runner forms (npm run/exec, pnpm, yarn, bun, bunx, npx, uv run, pipx run)', () => {
    const out = filterAutoAllowRules(allowStrings([
      'Bash(npm run build)', 'Bash(npm exec *)', 'Bash(pnpm install)', 'Bash(pnpm dlx *)',
      'Bash(yarn run dev)', 'Bash(bun run *)', 'Bash(bunx *)', 'Bash(npx *)', 'Bash(uv run *)',
      'Bash(pipx run *)', 'Bash(npm publish:*)',
    ]), { classifyAllShell: false })
    expect(out.allow.map(rule => rule.content)).toEqual(['npm publish:*'])
  })

  it('suspends every Task/Agent/subagent/subagent_fork spelling, whole-tool and content', () => {
    const out = filterAutoAllowRules(allowStrings([
      'Task', 'Agent', 'subagent', 'subagent_fork', 'Task(prompt)',
    ]), { classifyAllShell: false })
    expect(out.allow).toHaveLength(0)
  })

  it('classifyAllShell sweeps every bash and PowerShell allow (whole-tool and content)', () => {
    const out = filterAutoAllowRules(allowStrings([
      'Bash', 'Bash(npm install)', 'Bash(npm publish:*)', 'PowerShell', 'pwsh', 'pwsh(Get-ChildItem)', 'Edit',
    ]), { classifyAllShell: true })
    expect(out.allow.map(rule => rule.toolName)).toEqual(['Edit'])
  })

  it('leaves deny, ask, and bypassImmune lists untouched', () => {
    const input = rules({
      allow: [parseRule('Bash', 'allow', 'config')],
      deny: [parseRule('Bash', 'deny', 'config')],
      ask: [parseRule('Bash', 'ask', 'config')],
      bypassImmune: [parseRule('Edit(.git*)', 'deny', 'config')],
    })
    const out = filterAutoAllowRules(input, { classifyAllShell: false })
    expect(out.deny).toEqual(input.deny)
    expect(out.ask).toEqual(input.ask)
    expect(out.bypassImmune).toEqual(input.bypassImmune)
  })

  it('returns an empty allow list for the empty rule set', () => {
    expect(filterAutoAllowRules(EMPTY_RULE_SET, { classifyAllShell: false })).toEqual(EMPTY_RULE_SET)
  })
})

describe('autoSuspendedReason (D6 cause categories)', () => {
  const reason = (raw: string, classifyAllShell = false) =>
    autoSuspendedReason(parseRule(raw, 'allow', 'config'), { classifyAllShell })

  it('reports whole-tool for whole-tool bash and PowerShell allows', () => {
    expect(reason('Bash')).toBe('whole-tool')
    expect(reason('PowerShell')).toBe('whole-tool')
    expect(reason('pwsh')).toBe('whole-tool')
  })

  it('reports short-head for effectively blanket bash content allows', () => {
    expect(reason('Bash(cu*)')).toBe('short-head')
    expect(reason('Bash( *)')).toBe('short-head')
  })

  it('reports interpreter for interpreter first tokens', () => {
    expect(reason('Bash(python:*)')).toBe('interpreter')
    expect(reason('Bash(node script.js)')).toBe('interpreter')
    expect(reason('Bash(ruby)')).toBe('interpreter')
  })

  it('reports package-runner for package-runner first tokens', () => {
    expect(reason('Bash(npm run build)')).toBe('package-runner')
    expect(reason('Bash(pnpm dlx *)')).toBe('package-runner')
    expect(reason('Bash(npx *)')).toBe('package-runner')
  })

  it('reports subagent for every Task/Agent/subagent spelling, whole-tool and content', () => {
    expect(reason('Task')).toBe('subagent')
    expect(reason('subagent_fork')).toBe('subagent')
    expect(reason('Task(prompt)')).toBe('subagent')
  })

  it('classify-all-shell reports only when no more specific category applies', () => {
    // Precedence: whole-tool/interpreter beat classify-all-shell.
    expect(reason('Bash', true)).toBe('whole-tool')
    expect(reason('Bash(python:*)', true)).toBe('interpreter')
    // A lark-cli-style long-head bash rule: suspended only by the sweep.
    expect(reason('Bash(npm publish:*)', true)).toBe('classify-all-shell')
    expect(reason('Bash(npm publish:*)', false)).toBeUndefined()
    expect(reason('pwsh(Get-ChildItem)', true)).toBe('classify-all-shell')
  })

  it('reports undefined for non-suspended rules', () => {
    expect(reason('Edit')).toBeUndefined()
    expect(reason('Edit(.git*)')).toBeUndefined()
    expect(reason('Bash(npm publish:*)', false)).toBeUndefined()
  })
})

describe('D4 safe short-head exemption (SAFE_SHORT_HEADS)', () => {
  const reason = (raw: string, classifyAllShell = false) =>
    autoSuspendedReason(parseRule(raw, 'allow', 'config'), { classifyAllShell })

  it('exempts `cd` and `ls` short-head rules in every form', () => {
    expect(filterAutoAllowRules(
      allowStrings(['Bash(cd)', 'Bash(cd )', 'Bash(ls)', 'Bash(ls )']),
      { classifyAllShell: false },
    ).allow.map(rule => rule.content)).toEqual(['cd', 'cd ', 'ls', 'ls '])
    expect(reason('Bash(cd)')).toBeUndefined()
    expect(reason('Bash(ls )')).toBeUndefined()
  })

  it('keeps every other short head suspended (rm, mv, fd, wc, sh)', () => {
    expect(filterAutoAllowRules(
      allowStrings(['Bash(rm )', 'Bash(mv )', 'Bash(fd)', 'Bash(wc)', 'Bash(sh)']),
      { classifyAllShell: false },
    ).allow).toHaveLength(0)
    expect(reason('Bash(wc)')).toBe('short-head')
  })

  it('wildcard short heads are ineligible (literal prefix only)', () => {
    // D4 eligibility needs a literal prefix matcher: `Bash(cd *)`/`Bash(ls *)`
    // are wildcards and stay suspended, while `Bash(cd:*)` is a 3-char prefix
    // head that legitimately stays in force (never inside the <3 scope).
    expect(filterAutoAllowRules(
      allowStrings(['Bash(cd *)', 'Bash(ls *)', 'Bash(cd:*)']),
      { classifyAllShell: false },
    ).allow.map(rule => rule.content)).toEqual(['cd:*'])
  })

  it('interpreter/package-runner/whole-tool/classifyAllShell behavior is unchanged', () => {
    expect(reason('Bash(python:*)')).toBe('interpreter')
    expect(reason('Bash(npm run build)')).toBe('package-runner')
    expect(reason('Bash')).toBe('whole-tool')
    expect(reason('Bash(cd)', true)).toBe('classify-all-shell')
  })
})
