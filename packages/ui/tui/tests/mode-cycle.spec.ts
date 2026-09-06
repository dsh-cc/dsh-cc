import { describe, expect, it } from 'vitest'
import { isPermissionMode, nextPermissionMode, PERMISSION_CYCLE } from '@dsh-cc/tui/mode-cycle.ts'

describe('nextPermissionMode', () => {
  it('cycles the five CC modes in /permissions order', () => {
    expect(PERMISSION_CYCLE).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    expect(nextPermissionMode('default')).toBe('acceptEdits')
    expect(nextPermissionMode('acceptEdits')).toBe('plan')
    expect(nextPermissionMode('plan')).toBe('auto')
    expect(nextPermissionMode('auto')).toBe('bypassPermissions')
    expect(nextPermissionMode('bypassPermissions')).toBe('default')
  })

  it('skips bypassPermissions when that mode is disabled', () => {
    expect(nextPermissionMode('auto', true)).toBe('default')
    expect(nextPermissionMode('bypassPermissions', true)).toBe('default')
  })

  it('starts at default for an unknown current mode', () => {
    expect(nextPermissionMode('nope')).toBe('default')
  })
})

describe('isPermissionMode', () => {
  it('accepts advertised ids only', () => {
    expect(isPermissionMode('plan')).toBe(true)
    expect(isPermissionMode('full')).toBe(false)
  })
})
