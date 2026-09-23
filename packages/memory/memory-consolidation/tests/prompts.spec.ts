import { describe, expect, it } from 'vitest'
import { MEMORY_AGENT_TOOLS, MEMORY_TOOL_FILTER, DRIVER_INJECTED_TOOL } from '../src/tools.ts'
import { buildConsolidationPrompt, buildExtractionPrompt } from '../src/prompts.ts'

describe('MEMORY_TOOL_FILTER', () => {
  it('allows only read/search plus the structured-output report tool', () => {
    expect([...MEMORY_AGENT_TOOLS].sort()).toEqual(['glob', 'grep', 'read', 'read_image', 'structured_output'])
    // The filter is the prompt vocabulary minus the driver-injected
    // child-scoped tool (tools.restrict() throws on non-global names).
    expect(MEMORY_TOOL_FILTER.allow).toEqual(MEMORY_AGENT_TOOLS.filter(name => name !== DRIVER_INJECTED_TOOL))
    expect(MEMORY_TOOL_FILTER.allow).not.toContain(DRIVER_INJECTED_TOOL)
    // The forks hold no write capability; the plugin writes host-side.
    expect(MEMORY_AGENT_TOOLS).not.toContain('write')
    expect(MEMORY_AGENT_TOOLS).not.toContain('edit')
  })
})

describe('buildExtractionPrompt', () => {
  it('names the memory directory, tool filter, and message count', () => {
    const prompt = buildExtractionPrompt(3, '/mem', '- a.md: desc')
    expect(prompt).toContain('last 3 messages')
    expect(prompt).toContain('`/mem`')
    expect(prompt).toContain('a.md: desc')
    expect(prompt).toContain('user` | `feedback` | `project` | `reference`')
  })

  it('teaches the structured-output contract instead of write tools', () => {
    const prompt = buildExtractionPrompt(3, '/mem', '')
    expect(prompt).toContain('structured_output')
    expect(prompt).toContain('{ "writes": [{ "path", "content" }] }')
    expect(prompt).toContain('return an empty `writes` array')
    expect(prompt).not.toContain('write nothing at all')
  })
})

describe('buildConsolidationPrompt', () => {
  it('lists the sessions to review and the structured-output contract', () => {
    const prompt = buildConsolidationPrompt('/mem', '/transcripts', ['s1', 's2'])
    expect(prompt).toContain('`/mem`')
    expect(prompt).toContain('`/transcripts`')
    expect(prompt).toContain('- s1')
    expect(prompt).toContain('- s2')
    expect(prompt).toContain('structured_output')
    expect(prompt).toContain('read, read_image, grep, glob, structured_output')
  })

  it('prescribes the 5-phase workflow invariants', () => {
    const prompt = buildConsolidationPrompt('/mem', '/transcripts', ['s1'])
    // Phase 3: relative dates become absolute.
    expect(prompt).toContain('convert every relative date')
    expect(prompt).toContain('absolute date')
    // Phase 2: drift check names the workspace as the fork's cwd.
    expect(prompt).toContain("working directory IS the session's workspace")
    expect(prompt).toContain('contradiction between two memories')
    // Phase 4: hints are provenance only; transcripts are never opened.
    expect(prompt).toContain('never attempt to open or grep them')
    // Phase 5: index size target.
    expect(prompt).toContain('under 140 lines')
  })
})
