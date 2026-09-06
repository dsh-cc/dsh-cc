import { describe, expect, it, vi } from 'vitest'
import type { CcSkillMetadata } from '@dsh-cc/skill-loader'
import {
  skillToolRestriction,
  resolveSkillExecution,
  activationFor,
  applySkillRestriction,
  type AgentScope,
} from '../src/skill-semantics.ts'

function metadata(overrides: Partial<CcSkillMetadata> = {}): CcSkillMetadata {
  return {
    allowedTools: [],
    arguments: [],
    deprecated: false,
    source: 'additional',
    unknown: {},
    ...overrides,
  }
}

describe('skillToolRestriction', () => {
  it('returns undefined for an empty or missing allow-list', () => {
    expect(skillToolRestriction(metadata({ allowedTools: [] }))).toBeUndefined()
  })

  it('returns undefined when the allow-list admits every tool', () => {
    expect(skillToolRestriction(metadata({ allowedTools: ['*'] }))).toBeUndefined()
  })

  it('builds an allow-only restriction from a named list', () => {
    expect(skillToolRestriction(metadata({ allowedTools: ['read', 'write'] }))).toEqual({
      allow: ['read', 'write'],
    })
  })
})

describe('resolveSkillExecution / fork downgrade', () => {
  it('routes an inline skill inline even when subagents exist', () => {
    expect(resolveSkillExecution(metadata({}), true)).toBe('inline')
  })

  it('routes a fork skill to fork when the subagent seam exists', () => {
    expect(resolveSkillExecution(metadata({ executionContext: 'fork' }), true)).toBe('fork')
  })

  it('downgrades a fork skill to inline when subagents are absent', () => {
    expect(resolveSkillExecution(metadata({ executionContext: 'fork' }), false)).toBe('inline')
  })
})

describe('activationFor', () => {
  it('combines restriction, execution, and shell control', () => {
    const activation = activationFor(metadata({
      allowedTools: ['read'],
      executionContext: 'fork',
      shell: false,
    }), true)
    expect(activation.restriction).toEqual({ allow: ['read'] })
    expect(activation.execution).toBe('fork')
    expect(activation.forbidInlineShell).toBe(true)
  })

  it('forbids inline shell when shell is false', () => {
    expect(activationFor(metadata({ shell: false }), false).forbidInlineShell).toBe(true)
  })

  it('allows inline shell by default', () => {
    expect(activationFor(metadata({}), false).forbidInlineShell).toBe(false)
  })
})

describe('applySkillRestriction', () => {
  it('applies a scoped restrict to the agent and returns a disposer', () => {
    const restrict = vi.fn(() => () => {})
    const agent: AgentScope = { tools: { restrict } }
    const disposer = applySkillRestriction(metadata({ allowedTools: ['read'] }), agent)
    expect(restrict).toHaveBeenCalledWith({ allow: ['read'] })
    expect(typeof disposer).toBe('function')
  })

  it('does not restrict an agent for a skill with no allow-list', () => {
    const restrict = vi.fn()
    const agent: AgentScope = { tools: { restrict } }
    const disposer = applySkillRestriction(metadata({ allowedTools: [] }), agent)
    expect(restrict).not.toHaveBeenCalled()
    expect(typeof disposer).toBe('function')
  })

  it('lifts the restriction when the returned disposer runs', () => {
    const lifted = vi.fn()
    const agent: AgentScope = { tools: { restrict: () => lifted } }
    const disposer = applySkillRestriction(metadata({ allowedTools: ['read'] }), agent)
    disposer()
    expect(lifted).toHaveBeenCalledTimes(1)
  })
})
