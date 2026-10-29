import { describe, expect, it } from 'vitest'
import { buildTaskGrant, validateDescriptor } from '../src/task-grant.ts'
import { grantAdmitsCommand } from '../src/task-grant-match.ts'
import { splitShellCommand } from '../src/shell-segments.ts'
import { parseTaskGrantGitInvocation } from '../src/task-grant-git.ts'

function descriptor(rule: string) {
  return { rules: [rule], tools: [], writePaths: ['docs'], sandboxEscalation: true }
}

function grant() {
  return buildTaskGrant({
    root: '/work', branch: 'topic', goalId: null,
    face: validateDescriptor(descriptor('Bash(git push)')),
  })
}

describe('task-grant Git invocation boundaries', () => {
  it.each([
    'git', 'git -C . push', 'git -C. push', 'git --no-pager push',
    'git --git-dir=.git push', 'git -cuser.name=x commit',
    'git -C . -c user.name=x commit', 'git --config-env=core.hooksPath=HOOKS commit',
    'FOO=1 git commit', 'FOO=1 git push', 'GIT_CONFIG_COUNT=1 git add',
    'GIT_DIR=.git git add',
  ])('rejects ambiguous/config-changing descriptor prefix %s', prefix => {
    expect(() => validateDescriptor(descriptor(`Bash(${prefix})`))).toThrow()
  })

  it.each([
    'git -C . push origin topic --force', 'git -C. push origin topic --force',
    'git --no-pager push origin topic --force', 'git -cfoo=bar push origin topic --force',
    'git --config-env=foo=BAR push origin topic --force',
    'FOO=1 git push origin topic --force', 'GIT_CONFIG_COUNT=1 git add docs/a.md',
  ])('never falls back to a broad persisted rule for %s', command => {
    // Persisted session payloads may predate descriptor validation hardening.
    const legacy = { ...grant(), rules: [`Bash(${command})`, 'Bash(git)'] }
    expect(grantAdmitsCommand(legacy, command, 'Bash')).toBe(false)
  })

  it('retains ordinary Git commands and harmless raw assignment matching', () => {
    const ordinary = { ...grant(), rules: ['Bash(git add)', 'Bash(git commit)', 'Bash(git push)'] }
    expect(grantAdmitsCommand(ordinary, 'git add docs/a.md', 'Bash')).toBe(true)
    expect(grantAdmitsCommand(ordinary, 'git commit -m "update docs"', 'Bash')).toBe(true)
    expect(grantAdmitsCommand(ordinary, 'git push origin topic', 'Bash')).toBe(true)
    expect(grantAdmitsCommand(ordinary, 'git push origin "topic"', 'Bash')).toBe(false)
    const assigned = { ...grant(), rules: ['Bash(FOO=1 git add)'] }
    expect(validateDescriptor(descriptor('Bash(FOO=1 git add)')).contentScope).toBe('any')
    expect(grantAdmitsCommand(assigned, 'FOO=1 git add docs/a.md', 'Bash')).toBe(true)
  })

  it('decodes literal quoted/escaped commit argv for content checks', () => {
    const result = splitShellCommand('git commit "-a" -m "update docs"')
    expect(result.kind).toBe('segments')
    if (result.kind !== 'segments') return
    expect(parseTaskGrantGitInvocation(result.segments[0]!)).toEqual({
      kind: 'git', subcommand: 'commit', args: ['-a', '-m', 'update docs'],
    })
  })
})
