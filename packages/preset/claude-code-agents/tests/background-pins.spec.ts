import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverBundledAgents,
  findProjectAgentsDir,
  loadAgentsDir,
} from '@dsh-cc/claude-code-agents'

// Slice 1 repo guard (docs/plans/2026-09-05-continuable-background-ux.md §3.1, §3.3):
// exactly deep-reasoner and fast-worker are pinned `background: true`; every other
// agent in the repo (project layer and bundled) stays unpinned so omitting
// run_in_background keeps its foreground-collect default.

const BACKGROUND_PINNED = ['deep-reasoner', 'fast-worker']

const repoAgentsDir = await findProjectAgentsDir(join(fileURLToPath(import.meta.url), '..'))

describe('background pins (Slice 1 repo guard)', () => {
  it('resolves the repo project agents dir', () => {
    expect(repoAgentsDir).toBeDefined()
  })

  it('pins deep-reasoner and fast-worker with background: true', async () => {
    const agents = await loadAgentsDir(repoAgentsDir!, 'project')
    for (const name of BACKGROUND_PINNED) {
      const agent = agents.find(a => a.agentType === name)
      expect(agent, `${name}.md must exist in .claude/agents`).toBeDefined()
      expect(agent?.background, `${name} must pin background: true`).toBe(true)
    }
  })

  it('keeps every other project agent unpinned', async () => {
    const agents = await loadAgentsDir(repoAgentsDir!, 'project')
    const drifted = agents
      .filter(a => !BACKGROUND_PINNED.includes(a.agentType) && a.background === true)
      .map(a => a.agentType)
    expect(drifted, `unexpected background pins: ${drifted.join(', ')}`).toEqual([])
  })

  it('keeps every bundled agent unpinned', () => {
    const pinned = discoverBundledAgents()
      .filter(a => a.background === true)
      .map(a => a.agentType)
    expect(pinned, 'bundled agents must stay unpinned (§3.1 deliberate deviation)').toEqual([])
  })
})
