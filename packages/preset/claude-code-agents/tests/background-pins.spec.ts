import { describe, expect, it } from 'vitest'
import { discoverBundledAgents } from '@dsh-cc/claude-code-agents'

// Slice 1 repo guard remnant (docs/plans/2026-09-05-continuable-background-ux.md
// §3.1, §3.3): every BUNDLED agent stays unpinned, so omitting
// run_in_background keeps its foreground-collect default. The repo's project
// agents (deep-reasoner/fast-worker) were removed in the subagent-cleanup
// cutover — their background asymmetry now lives in the official plugin
// (dsh-cc-agents:critic pins background: true; executor deliberately ships
// NO pin so a mutating agent defaults to foreground), guarded by
// packages/compat/cc-plugin-loader/tests/dsh-cc-agents.spec.ts.

describe('background pins (bundled agents)', () => {
  it('keeps every bundled agent unpinned', () => {
    const pinned = discoverBundledAgents()
      .filter(a => a.background === true)
      .map(a => a.agentType)
    expect(pinned, 'bundled agents must stay unpinned (§3.1 deliberate deviation)').toEqual([])
  })
})
