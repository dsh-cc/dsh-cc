import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldPlanMode, foldSandboxMode } from '../src/mode.ts'

/** Build a synthetic log event (the fold face only reads type + data). */
const event = (type: string, data: unknown): SessionEvent =>
  ({ type, data }) as unknown as SessionEvent

describe('foldPlanMode', () => {
  it('folds an empty log to false', () => {
    expect(foldPlanMode([])).toBe(false)
  })

  it('takes the last plan/mode event (last-wins)', () => {
    const events = [
      event('plan/mode', { active: true }),
      event('permission/mode', { mode: 'default' }),
      event('plan/mode', { active: false }),
    ]
    expect(foldPlanMode(events)).toBe(false)
  })

  it('skips non-matching events', () => {
    const events = [
      event('permission/mode', { mode: 'plan' }),
      event('sandbox/mode', { mode: 'danger-full-access' }),
      event('plan/mode', { active: true }),
      event('user/message', {}),
    ]
    expect(foldPlanMode(events)).toBe(true)
  })
})

describe('foldSandboxMode', () => {
  it('folds an empty log to undefined', () => {
    expect(foldSandboxMode([])).toBeUndefined()
  })

  it('takes the last sandbox/mode event regardless of source (incl. delegation)', () => {
    const events = [
      event('sandbox/mode', { mode: 'workspace-write', source: 'manual' }),
      event('permission/mode', { mode: 'bypassPermissions' }),
      event('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' }),
    ]
    expect(foldSandboxMode(events)).toBe('danger-full-access')
  })

  it('skips non-matching events', () => {
    const events = [
      event('permission/mode', { mode: 'default' }),
      event('plan/mode', { active: true }),
      event('sandbox/mode', { mode: 'workspace-write' }),
    ]
    expect(foldSandboxMode(events)).toBe('workspace-write')
  })
})
