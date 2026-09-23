import { describe, expect, it } from 'vitest'
import { contentSubsumes, parseRuleSafe, ruleSubsumes } from '../src/subsumption.ts'
import type { PermissionRule } from '../src/types.ts'

const ALLOW = 'allow' as const
const USER = 'user' as const
const PROJECT = 'project' as const

function rule(
  ruleString: string,
  behavior: 'allow' | 'deny' | 'ask' = ALLOW,
  source: typeof USER | typeof PROJECT = USER,
): PermissionRule {
  const parsed = parseRuleSafe(ruleString, behavior, source)
  if (parsed === undefined) throw new Error(`malformed test rule: ${ruleString}`)
  return parsed
}

describe('parseRuleSafe', () => {
  it('parses a content rule with behavior/source as caller-supplied context', () => {
    expect(parseRuleSafe('Bash(git )', ALLOW, USER)).toEqual({
      toolName: 'Bash',
      content: 'git ',
      matcher: { kind: 'prefix', prefix: 'git ' },
      behavior: ALLOW,
      source: USER,
    })
  })

  it('parses a whole-tool rule without content', () => {
    expect(parseRuleSafe('Bash', ALLOW, USER)).toEqual({ toolName: 'Bash', behavior: ALLOW, source: USER })
  })

  it('returns undefined for malformed rules instead of throwing', () => {
    expect(parseRuleSafe('', ALLOW, USER)).toBeUndefined()
    expect(parseRuleSafe('Bash(grep', ALLOW, USER)).toBeUndefined()
    expect(parseRuleSafe('Bash(grep)extra', ALLOW, USER)).toBeUndefined()
  })

  it('parses the legacy prefix form to a prefix including the colon', () => {
    expect(parseRuleSafe('Bash(grep:*)', ALLOW, USER)?.matcher).toEqual({ kind: 'prefix', prefix: 'grep:' })
  })
})

describe('contentSubsumes', () => {
  it('subsumes prefix chains', () => {
    expect(contentSubsumes({ kind: 'prefix', prefix: 'git' }, { kind: 'prefix', prefix: 'git status' })).toBe(true)
    expect(contentSubsumes({ kind: 'prefix', prefix: 'git status' }, { kind: 'prefix', prefix: 'git' })).toBe(false)
  })

  it('subsumes the legacy grep:* form under Bash(grep)', () => {
    expect(contentSubsumes({ kind: 'prefix', prefix: 'grep' }, { kind: 'prefix', prefix: 'grep:' })).toBe(true)
  })

  it('subsumes equal wildcard values only', () => {
    expect(contentSubsumes({ kind: 'wildcard', pattern: 'npm *' }, { kind: 'wildcard', pattern: 'npm *' })).toBe(true)
    expect(contentSubsumes({ kind: 'wildcard', pattern: 'npm *' }, { kind: 'wildcard', pattern: 'npm install *' })).toBe(false)
  })

  it('subsumes equal domain values only', () => {
    expect(contentSubsumes({ kind: 'domain', hostname: 'example.com' }, { kind: 'domain', hostname: 'example.com' })).toBe(true)
    expect(contentSubsumes({ kind: 'domain', hostname: 'example.com' }, { kind: 'domain', hostname: 'api.example.com' })).toBe(false)
  })

  it('never subsumes across matcher kinds', () => {
    expect(contentSubsumes({ kind: 'prefix', prefix: 'npm *' }, { kind: 'wildcard', pattern: 'npm *' })).toBe(false)
    expect(contentSubsumes({ kind: 'wildcard', pattern: '*' }, { kind: 'prefix', prefix: 'npm' })).toBe(false)
  })
})

describe('ruleSubsumes', () => {
  it('subsumes prefix chains of the same tool/behavior/source', () => {
    expect(ruleSubsumes(rule('Bash(git )'), rule('Bash(git status )'))).toBe(true)
  })

  it('subsumes the legacy grep:* form under Bash(grep)', () => {
    expect(ruleSubsumes(rule('Bash(grep)'), rule('Bash(grep:*)'))).toBe(true)
  })

  it('compares unescaped matcher values, not raw escaped strings', () => {
    // `\(\)` unescapes to `()`; the escaped and unescaped spellings dedup.
    expect(ruleSubsumes(rule('Bash(foo())'), rule('Bash(foo\\(\\))'))).toBe(true)
    expect(ruleSubsumes(rule('Bash(foo\\(\\))'), rule('Bash(foo())'))).toBe(true)
  })

  it('requires equal behavior', () => {
    expect(ruleSubsumes(rule('Bash(git )', 'allow'), rule('Bash(git status )', 'deny'))).toBe(false)
  })

  it('requires equal source', () => {
    expect(ruleSubsumes(rule('Bash(git )', ALLOW, USER), rule('Bash(git status )', ALLOW, PROJECT))).toBe(false)
  })

  it('requires equal toolName in exact authored spelling', () => {
    expect(ruleSubsumes(rule('Bash(git )'), rule('bash(git status )'))).toBe(false)
  })

  it('never subsumes whole-tool over content rules', () => {
    expect(ruleSubsumes(rule('Bash'), rule('Bash(git status )'))).toBe(false)
  })

  it('subsumes identical rules', () => {
    expect(ruleSubsumes(rule('Bash(git )'), rule('Bash(git )'))).toBe(true)
  })
})
