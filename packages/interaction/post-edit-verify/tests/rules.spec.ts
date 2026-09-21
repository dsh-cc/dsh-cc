import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@dsh-cc/tools'
import { matchRule, type VerifyRule } from '../src/rules.ts'

const CWD = '/repo'

function execWith(filePath: unknown): ToolExecution {
  return {
    name: 'edit',
    arguments: filePath === undefined ? {} : { file_path: filePath },
  } as unknown as ToolExecution
}

const rules: VerifyRule[] = [
  { glob: 'packages/**/*.ts', command: 'tsc -b', timeoutMs: 60000 },
  { glob: '**/*.ts', command: 'eslint' },
]

describe('matchRule', () => {
  it('returns undefined when the call has no file_path', () => {
    expect(matchRule(rules, execWith(undefined), CWD)).toBeUndefined()
    expect(matchRule(rules, execWith({ file_path: '/repo/a.ts' }), CWD)).toBeUndefined()
  })

  it('returns undefined when no rule matches', () => {
    expect(matchRule(rules, execWith('/repo/README.md'), CWD)).toBeUndefined()
  })

  it('matches a relative-style glob against a path under the session cwd', () => {
    expect(matchRule(rules, execWith('/repo/packages/a/src/index.ts'), CWD)?.command).toBe('tsc -b')
  })

  it('falls back to absolute-path matching when the path is outside the session cwd', () => {
    const outside: VerifyRule[] = [{ glob: '/other/**/*.ts', command: 'fmt' }]
    expect(matchRule(outside, execWith('/other/x/a.ts'), CWD)?.command).toBe('fmt')
    expect(matchRule(outside, execWith('/other/x/a.ts'), undefined)?.command).toBe('fmt')
  })

  it('is first-match-wins in rule order', () => {
    expect(matchRule(rules, execWith('/repo/packages/a/b.ts'), CWD)?.command).toBe('tsc -b')
    expect(matchRule([...rules].reverse(), execWith('/repo/packages/a/b.ts'), CWD)?.command).toBe('eslint')
  })

  it('passes timeout-ms through', () => {
    expect(matchRule(rules, execWith('/repo/packages/a/b.ts'), CWD)?.timeoutMs).toBe(60000)
    expect(matchRule(rules, execWith('/repo/x.ts'), CWD)?.timeoutMs).toBeUndefined()
  })

  it('matches a path given as already-relative', () => {
    expect(matchRule(rules, execWith('packages/a/b.ts'), CWD)?.command).toBe('tsc -b')
  })
})
