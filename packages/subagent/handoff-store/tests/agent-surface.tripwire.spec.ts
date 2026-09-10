/**
 * Tool-surface tripwire for the subagent handoff pair (design doc
 * docs/plans/2026-09-10-subagent-handoff-store.md §2's blocking fact):
 * the target agents declare frontmatter `tools:` whitelists and the Task
 * plugin's restriction semantics INTERSECT with the registered surface
 * (packages/subagent/task/src/sanitize-filter.ts) — a tool missing from the
 * whitelist is silently unavailable to the child. So the whitelist edit IS
 * the enforcement point: this spec pins that the delegation agents
 * (critic/executor/marathon) declare handoff_put + handoff_get, and that the
 * cheap-lane shunt agents still EXCLUDE them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HANDOFF_GET_TOOL, HANDOFF_PUT_TOOL } from '../src/tools.ts'

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')

function frontmatterTools(rel: string): string[] {
  const text = readFileSync(join(repoRoot, 'packages/plugin', rel), 'utf8')
  const line = text.split('\n').find((l) => l.startsWith('tools:'))
  expect(line, `${rel}: no tools: frontmatter`).toBeDefined()
  return (line!.slice('tools:'.length).match(/[A-Za-z0-9_]+/g) ?? [])
}

describe('handoff tool whitelist tripwire', () => {
  it('critic/executor/marathon whitelists contain handoff_put and handoff_get', () => {
    for (const agent of ['dsh-cc-agents/agents/critic.md', 'dsh-cc-agents/agents/executor.md', 'dsh-cc-agents/agents/marathon.md']) {
      for (const tool of [HANDOFF_PUT_TOOL, HANDOFF_GET_TOOL]) {
        expect(frontmatterTools(agent), `${agent} missing ${tool}`).toContain(tool)
      }
    }
  })

  it('shunt-reader/shunt-writer whitelists still EXCLUDE the pair', () => {
    for (const agent of ['dsh-cc-shunt/agents/shunt-reader.md', 'dsh-cc-shunt/agents/shunt-writer.md']) {
      for (const tool of [HANDOFF_PUT_TOOL, HANDOFF_GET_TOOL]) {
        expect(frontmatterTools(agent), `${agent} unexpectedly gained ${tool}`).not.toContain(tool)
      }
    }
  })

  it('the registering plugin names the pair exactly', () => {
    const src = readFileSync(join(repoRoot, 'packages/subagent/handoff-store/src/tools.ts'), 'utf8')
    expect(src).toMatch(/name: HANDOFF_PUT_TOOL/)
    expect(src).toMatch(/name: HANDOFF_GET_TOOL/)
  })
})
