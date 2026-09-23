import { describe, expect, it, vi } from 'vitest'
import { WORK_DISCARDING, enrichContext } from '../src/enrichment.ts'

const runner = (output: string | Error) => async () => {
  if (output instanceof Error) throw output
  return output
}

describe('WORK_DISCARDING', () => {
  it.each([
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git clean -fdx',
    'git checkout -- src/a.ts',
    'git restore src/a.ts',
    'rm -rf build',
    'rm -f file.txt',
    'rmdir /tmp/x',
  ])('matches work-discarding command: %s', (command) => {
    expect(WORK_DISCARDING.some(pattern => pattern.test(command))).toBe(true)
  })

  it.each([
    'git status',
    'git checkout -b feature',
    'ls',
    'echo hi',
  ])('does not match benign command: %s', (command) => {
    expect(WORK_DISCARDING.some(pattern => pattern.test(command))).toBe(false)
  })
})

describe('enrichContext', () => {
  it('non-matching command ⇒ empty string, runner never called', async () => {
    const run = vi.fn(runner('M foo'))
    expect(await enrichContext('git status', run)).toBe('')
    expect(run).not.toHaveBeenCalled()
  })

  it('dirty tree ⇒ "uncommitted-work snapshot:" prefix, output capped at 512 chars', async () => {
    const run = vi.fn(runner(' M a.ts\n?? b.ts'))
    const out = await enrichContext('git reset --hard', run)
    expect(out.startsWith('uncommitted-work snapshot:')).toBe(true)
    expect(out).toContain('M a.ts')
    expect(run).toHaveBeenCalledWith(expect.any(String), { timeoutMs: 1000 })
    const big = await enrichContext('git clean -fdx', runner('x'.repeat(2000)))
    expect(big.length).toBeLessThanOrEqual('uncommitted-work snapshot:\n'.length + 512)
  })

  it('clean tree ⇒ "working tree clean"', async () => {
    expect(await enrichContext('rm -f x', runner(''))).toBe('working tree clean')
    expect(await enrichContext('rmdir d', runner('   \n'))).toBe('working tree clean')
  })

  it('runner failure ⇒ empty string, never throws', async () => {
    expect(await enrichContext('git reset --hard', runner(new Error('not a git repo')))).toBe('')
  })

  it('no runner ⇒ empty string', async () => {
    expect(await enrichContext('git reset --hard', undefined)).toBe('')
  })
})
