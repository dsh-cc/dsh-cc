import { describe, expect, it } from 'vitest'
import { parseRule } from '../src/parser.ts'
import { filterAutoAllowRules } from '../src/auto-rule-filter.ts'
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
