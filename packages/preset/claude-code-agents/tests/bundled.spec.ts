import { describe, expect, it } from 'vitest'
import { discoverBundledAgents } from '@dsh-cc/claude-code-agents'

describe('discoverBundledAgents', () => {
  it('returns exactly explore and dsh-cc-guide, both bundled + haiku', () => {
    const agents = discoverBundledAgents()
    expect(agents.map(a => a.agentType).sort()).toEqual(['dsh-cc-guide', 'explore'])
    for (const agent of agents) {
      expect(agent.source).toBe('bundled')
      expect(agent.model).toBe('haiku')
      expect(agent.whenToUse.length).toBeGreaterThan(0)
      expect(agent.systemPrompt.length).toBeGreaterThan(0)
    }
  })
  it('explore allow-list is read-only harness names (Read→read+read_image)', () => {
    const explore = discoverBundledAgents().find(a => a.agentType === 'explore')!
    expect(explore.toolRestriction?.allow).toEqual(expect.arrayContaining(['read', 'read_image', 'glob', 'grep']))
    expect(explore.toolRestriction?.allow).not.toEqual(expect.arrayContaining(['write']))
    expect(explore.toolRestriction?.allow).not.toEqual(expect.arrayContaining(['edit']))
    expect(explore.toolRestriction?.allow).not.toEqual(expect.arrayContaining(['bash']))
    expect(explore.toolRestriction?.allow?.includes('write')).toBe(false)
    expect(explore.toolRestriction?.allow?.includes('edit')).toBe(false)
    expect(explore.toolRestriction?.allow?.includes('bash')).toBe(false)
  })
  it('dsh-cc-guide is also read-only', () => {
    const guide = discoverBundledAgents().find(a => a.agentType === 'dsh-cc-guide')!
    expect(guide.toolRestriction?.allow).toEqual(expect.arrayContaining(['read', 'read_image', 'glob', 'grep']))
    expect(guide.toolRestriction?.allow?.includes('write')).toBe(false)
  })
})
