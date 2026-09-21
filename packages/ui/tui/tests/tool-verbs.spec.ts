import { describe, expect, it } from 'vitest'
import { toolVerb, verbIsRedundant } from '@dsh-cc/tui/tool-verbs.ts'

describe('toolVerb', () => {
  it('maps bash and shell to Running (case-insensitive)', () => {
    expect(toolVerb('bash')).toBe('Running')
    expect(toolVerb('shell')).toBe('Running')
    expect(toolVerb('Bash')).toBe('Running')
    expect(toolVerb('SHELL')).toBe('Running')
  })

  it('maps read to Reading', () => {
    expect(toolVerb('read')).toBe('Reading')
    expect(toolVerb('Read')).toBe('Reading')
  })

  it('maps write to Writing', () => {
    expect(toolVerb('write')).toBe('Writing')
  })

  it('maps edit to Editing', () => {
    expect(toolVerb('Edit')).toBe('Editing')
  })

  it('maps glob, grep, and search to Searching', () => {
    expect(toolVerb('glob')).toBe('Searching')
    expect(toolVerb('grep')).toBe('Searching')
    expect(toolVerb('search')).toBe('Searching')
  })

  it('maps fetch and web to Fetching', () => {
    expect(toolVerb('fetch')).toBe('Fetching')
    expect(toolVerb('web')).toBe('Fetching')
  })

  it('maps task and agent to Delegating', () => {
    expect(toolVerb('task')).toBe('Delegating')
    expect(toolVerb('agent')).toBe('Delegating')
  })

  it('maps todo to Tracking', () => {
    expect(toolVerb('todo')).toBe('Tracking')
  })

  it('defaults to Calling for unknown names', () => {
    expect(toolVerb('mcp_custom_tool')).toBe('Calling')
    expect(toolVerb('')).toBe('Calling')
    expect(toolVerb('multiedit')).toBe('Calling')
  })
})

describe('verbIsRedundant', () => {
  const cases: Array<[string, string, boolean]> = [
    ['Read packages/a.md', 'read', true],
    ['Read docs/plans/x.md (43 - 117)', 'read', true],
    ['Write foo.ts', 'write', true],
    ['Edit foo.ts', 'edit', true],
    ['Glob *.ts', 'glob', true],
    ['Grep foo', 'grep', true],
    ['read', 'read', false],
    ['Readme notes', 'read', false],
    ['Reading list', 'read', false],
    ['ls -la', 'bash', false],
    // Accepted false positive: title is self-describing.
    ['bash build.sh', 'bash', true],
    ['List background jobs', 'job_list', false],
    ['List background jobs', '', false],
    ['', 'read', false],
    ['mcp__foo__bar results', 'mcp__foo__bar', true],
    ['mcp__foo__barista x', 'mcp__foo__bar', false],
  ]
  for (const [title, name, expected] of cases) {
    it(`verbIsRedundant(${JSON.stringify(title)}, ${JSON.stringify(name)}) -> ${expected}`, () => {
      expect(verbIsRedundant(title, name)).toBe(expected)
    })
  }
})
