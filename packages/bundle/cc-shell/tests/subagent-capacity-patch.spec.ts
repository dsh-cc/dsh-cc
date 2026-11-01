/**
 * cc-shell subagent capacity override: the stock `subagent` row is restated at
 * the TOP LEVEL of the bundle patch so the documented 25-live-children budget
 * survives upstream's tree-wide resident pool (whose stock default is 8).
 * A restatement inside `- insert:` would compose a duplicate loader entry id
 * and boot hard-fails, so the placement is part of the contract.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PATCH = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
const NAME = '@deepseek-ai/dsh-subagent'

describe('cc-shell subagent capacity override', () => {
  it('restates the stock subagent row at the top level', () => {
    const blocks = PATCH.split(/^- id: /m).slice(1)
    const row = blocks.find(block => block.startsWith('subagent\n'))
    expect(row, 'a top-level `- id: subagent` row must exist').toBeDefined()
    // Top-level means the row starts at column 0 with `- id:` (the split above);
    // a nested row would be indented and would not produce this block boundary.
    expect(row).toContain(`name: '${NAME}'`)
  })

  it('lifts the documented 25-child budget above the stock default', () => {
    const config = /^- id: subagent\n(?:[ \t]+.*\n?)*?[ \t]+maxActiveSubagents: (\d+)$/m.exec(PATCH)?.[1]
    // The upstream schema default is 8; the override exists precisely because
    // the documented cc budget is larger, so the literal is the contract.
    expect(config).toBe('25')
  })

  it('keeps the row out of the insert list', () => {
    const insert = /^- insert:\n((?:[ \t]+.*\n?)*)/m.exec(PATCH)?.[1] ?? ''
    expect(insert).not.toContain('id: subagent\n')
  })
})
