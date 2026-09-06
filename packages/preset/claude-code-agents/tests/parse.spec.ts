import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseAgentJson,
  parseAgentMarkdown,
  splitFrontmatter,
} from '@dsh-cc/claude-code-agents'

const MD = (name: string): string => join('/tmp/agents', `${name}.md`)

const MINIMAL_MD = `---
description: Handles git chores when asked
---
You should use git freely.`

describe('splitFrontmatter', () => {
  it('splits a leading frontmatter block from the markdown body', () => {
    const { frontmatter, content } = splitFrontmatter(MINIMAL_MD)
    expect(frontmatter).toEqual({ description: 'Handles git chores when asked' })
    expect(content).toMatch(/^You should use git freely/)
  })

  it('returns empty frontmatter and trimmed body for text without a delimiter', () => {
    const { frontmatter, content } = splitFrontmatter('Just a body with no metadata')
    expect(frontmatter).toEqual({})
    expect(content).toBe('Just a body with no metadata')
  })

  it('treats an unclosed leading delimiter as body', () => {
    const { frontmatter, content } = splitFrontmatter('---\nnever closed')
    expect(frontmatter).toEqual({})
    expect(content).toBe('---\nnever closed')
  })

  it('throws on a delimited but unparsable YAML block', () => {
    expect(() => splitFrontmatter('---\n: not: [valid\n---\nbody'))
      .toThrow(/invalid YAML frontmatter/)
  })

  it('throws when the frontmatter decodes to a non-object', () => {
    expect(() => splitFrontmatter('---\n- just\n- a\n- list\n---\nbody'))
      .toThrow(/frontmatter must be a YAML object/)
  })
})

describe('parseAgentMarkdown', () => {
  it('builds an agent whose id is the basename and body is the system prompt', () => {
    const agent = parseAgentMarkdown(MD('git'), MINIMAL_MD, 'project')
    expect(agent.agentType).toBe('git')
    expect(agent.source).toBe('project')
    expect(agent.whenToUse).toBe('Handles git chores when asked')
    expect(agent.systemPrompt).toMatch(/^You should use git freely/)
    expect(agent.baseDir).toBe('/tmp/agents')
    expect(agent.filename).toBe('git')
  })

  it('lets the frontmatter prompt override the markdown body', () => {
    const text = '---\ndescription: x\nprompt: Explicit prompt\n---\nIgnored body'
    const agent = parseAgentMarkdown(MD('a'), text, 'user')
    expect(agent.systemPrompt).toBe('Explicit prompt')
  })

  it('translates every known frontmatter field', () => {
    const text = `---
name: Git Expert
description: Handles git
tools: [Read, Bash]
disallowedTools: [Write]
skills: [code-review]
mcpServers: [slack]
model: deepseek-reasoner
effort: high
permissionMode: acceptEdits
maxTurns: 4
initialPrompt: Start by listing changed files
background: true
memory: project
isolation: worktree
---
Body`
    const agent = parseAgentMarkdown(MD('git'), text, 'project')
    expect(agent.agentType).toBe('git')
    expect(agent.whenToUse).toBe('Handles git')
    expect(agent.toolRestriction).toEqual({ allow: ['read', 'read_image', 'bash'], deny: ['write'] })
    expect(agent.skills).toEqual(['code-review'])
    expect(agent.mcpServers).toEqual(['slack'])
    expect(agent.model).toBe('deepseek-reasoner')
    expect(agent.effort).toBe('high')
    expect(agent.permissionMode).toBe('acceptEdits')
    expect(agent.maxTurns).toBe(4)
    expect(agent.initialPrompt).toBe('Start by listing changed files')
    expect(agent.background).toBe(true)
    expect(agent.memory).toBe('project')
    expect(agent.isolation).toBe('worktree')
    // Unknown fields are ignored, not forwarded.
    expect(agent).not.toHaveProperty('modelName', expect.anything())
    expect(agent).not.toHaveProperty('color')
  })

  it('accepts a numeric effort', () => {
    const text = '---\ndescription: x\neffort: 3\n---\nBody'
    expect(parseAgentMarkdown(MD('effort'), text, 'user').effort).toBe(3)
  })

  it('surfaces a bad known field value with the file path', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\nmaxTurns: -1\n---\nBody', 'project'))
      .toThrow(/maxTurns must be a positive integer/)
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\nbackground: nope\n---\nBody', 'project'))
      .toThrow(/background must be a boolean/)
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\npermissionMode: sudo\n---\nBody', 'project'))
      .toThrow(/permissionMode must be one of default, acceptEdits, bypassPermissions, plan/)
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\nisolation: remote\n---\nBody', 'project'))
      .toThrow(/isolation must be one of worktree/)
  })

  it('throws when description is missing', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ntools: [Read]\n---\nBody', 'project'))
      .toThrow(/missing required "description"/)
  })

  it('throws when model is not a non-empty string', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\nmodel: 42\n---\nBody', 'project'))
      .toThrow(/model must be a non-empty string/)
  })

  it('throws when name is declared but not a string', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\nname: 42\n---\nBody', 'project'))
      .toThrow(/name must be a string/)
  })

  it('accepts a comma-separated string tool list and splits it on commas', () => {
    const agent = parseAgentMarkdown(MD('git'), '---\ndescription: x\ntools: "Bash, Read"\n---\nBody', 'project')
    expect(agent.toolRestriction).toEqual({ allow: ['bash', 'read', 'read_image'] })
  })

  it('accepts a comma-separated disallowedTools string with stray whitespace', () => {
    const agent = parseAgentMarkdown(MD('git'), '---\ndescription: x\ndisallowedTools: " Write , Edit "\n---\nBody', 'project')
    expect(agent.toolRestriction).toEqual({ deny: ['write', 'edit'] })
  })

  it('parses the codex-rescue plugin agent frontmatter (string tools)', () => {
    const codexRescue = `---
name: codex-rescue
description: Rescues a stuck task with Codex
tools: Bash
---
Delegate to Codex.`
    const agent = parseAgentMarkdown(MD('codex-rescue'), codexRescue, 'project')
    expect(agent.agentType).toBe('codex-rescue')
    expect(agent.toolRestriction).toEqual({ allow: ['bash'] })
  })

  it('still throws when a tool list field is neither a string nor an array', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\ntools: 42\n---\nBody', 'project'))
      .toThrow(/tools must be an array of strings/)
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\ndisallowedTools: [7]\n---\nBody', 'project'))
      .toThrow(/disallowedTools must name strings/)
  })

  it('throws when skills holds a non-string element', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\nskills: [42]\n---\nBody', 'project'))
      .toThrow(/skills must name strings/)
  })

  it('throws when mcpServers holds a non-string element', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\nmcpServers: [1]\n---\nBody', 'project'))
      .toThrow(/mcpServers must name strings/)
  })

  it('throws when initialPrompt is not a non-empty string', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\ninitialPrompt: 7\n---\nBody', 'project'))
      .toThrow(/initialPrompt must be a non-empty string/)
  })

  it('passes hooks through unmodified when it is an object', () => {
    const text = '---\ndescription: x\nhooks:\n  Stop:\n    - matcher: done\n      hooks:\n        - type: command\n          command: echo ok\n---\nBody'
    const agent = parseAgentMarkdown(MD('hooked'), text, 'project')
    expect(agent.hooks).toEqual({
      Stop: [{ matcher: 'done', hooks: [{ type: 'command', command: 'echo ok' }] }],
    })
  })

  it('throws when hooks is not an object', () => {
    expect(() => parseAgentMarkdown(MD('git'), '---\ndescription: x\nhooks: [no]\n---\nBody', 'project'))
      .toThrow(/hooks must be an object/)
  })
})

describe('parseAgentJson', () => {
  const JSON_DIR = join('/tmp/agents', 'json')
  const jsonPath = (name: string): string => join(JSON_DIR, `${name}.json`)

  it('builds an agent from a JSON object, using prompt as the system prompt', () => {
    const text = JSON.stringify({
      description: 'Handles reviews',
      prompt: 'You review PRs',
      tools: ['Read', 'Bash'],
    })
    const agent = parseAgentJson(jsonPath('reviewer'), text, 'user')
    expect(agent.agentType).toBe('reviewer')
    expect(agent.whenToUse).toBe('Handles reviews')
    expect(agent.systemPrompt).toBe('You review PRs')
    expect(agent.toolRestriction).toEqual({ allow: ['read', 'read_image', 'bash'] })
    expect(agent.source).toBe('user')
    expect(agent.baseDir).toBe(JSON_DIR)
    expect(agent.filename).toBe('reviewer')
  })

  it('throws on malformed JSON', () => {
    expect(() => parseAgentJson(jsonPath('bad'), '{not json', 'project'))
      .toThrow(/invalid JSON/)
  })

  it('throws when the JSON value is not an object', () => {
    expect(() => parseAgentJson(jsonPath('bad'), '[1,2]', 'project'))
      .toThrow(/agent JSON must be an object/)
  })

  it('throws when prompt is missing', () => {
    expect(() => parseAgentJson(jsonPath('bad'), '{"description": "x"}', 'project'))
      .toThrow(/missing required "prompt"/)
  })

  it('rejects a bad known field with the file path', () => {
    expect(() => parseAgentJson(jsonPath('bad'), '{"description":"x","prompt":"y","memory":"global"}', 'project'))
      .toThrow(/memory must be one of user, project, local/)
  })
})
