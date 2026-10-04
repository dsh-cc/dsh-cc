import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyEphemeral, discoverBundledAgents, parseAgentMarkdown } from '@dsh-cc/claude-code-agents'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'

const REPO = join(import.meta.dirname, '../../../..')
const PLUGIN_AGENT = (pkg: string, name: string): string =>
  readFileSync(join(REPO, 'packages/plugin', pkg, 'agents', `${name}.md`), 'utf8')

const parse = (text: string, name = 'agent'): AgentDefinition =>
  parseAgentMarkdown(join('/tmp/agents', `${name}.md`), text, 'project')

const bundled = (name: string): AgentDefinition =>
  discoverBundledAgents().find(a => a.agentType === name)!

/** Build a definition whose allow list is exactly the given stored names. */
const withAllow = (...allow: string[]): AgentDefinition => ({
  agentType: 't',
  whenToUse: 't',
  systemPrompt: 't',
  source: 'project',
  baseDir: '/tmp',
  filename: 't',
  toolRestriction: { allow },
})

const md = (tools: string | undefined, extra = ''): string =>
  `---\ndescription: x${tools === undefined ? '' : `\ntools: ${tools}`}\n${extra}---\nBody`

describe('classifyEphemeral — in-tree real definitions', () => {
  const cases: ReadonlyArray<[string, AgentDefinition, boolean]> = [
    ['bundled explore', bundled('explore'), true],
    ['bundled dsh-cc-guide', bundled('dsh-cc-guide'), true],
    ['shunt-reader', parse(PLUGIN_AGENT('dsh-cc-shunt', 'shunt-reader'), 'shunt-reader'), true],
    ['shunt-writer', parse(PLUGIN_AGENT('dsh-cc-shunt', 'shunt-writer'), 'shunt-writer'), false],
    ['critic', parse(PLUGIN_AGENT('dsh-cc-agents', 'critic'), 'critic'), false],
    ['executor', parse(PLUGIN_AGENT('dsh-cc-agents', 'executor'), 'executor'), false],
    ['marathon', parse(PLUGIN_AGENT('dsh-cc-agents', 'marathon'), 'marathon'), false],
  ]
  for (const [label, definition, expected] of cases) {
    it(`${label} → ${expected ? 'ephemeral' : 'persistent'}`, () => {
      expect(classifyEphemeral(definition)).toBe(expected)
    })
  }
})

describe('classifyEphemeral — allow-list shapes', () => {
  const cases: ReadonlyArray<[string, AgentDefinition, boolean]> = [
    ['omitted tools (inherit-all)', parse(md(undefined)), false],
    ['deny-only', parseAgentMarkdown(
      '/tmp/agents/d.md',
      '---\ndescription: x\ndisallowedTools: [Write]\n---\nBody', 'project'), false],
    ['empty allow', withAllow(), false],
    ['MCP wildcard', withAllow('mcp__*'), false],
    ['bash', withAllow('bash'), false],
    ['write', withAllow('read', 'write'), false],
    ['other MCP name', withAllow('read', 'mcp__context7__query-docs'), false],
    ['unrelated serena tool', withAllow('read', 'mcp__serena__write_file'), false],
    ['serena trio with hash suffix', withAllow('read', 'mcp__serena__find_symbol_ab12cd34'), true],
    ['full read-only whitelist', withAllow('read', 'read_image', 'glob', 'grep', 'mcp__serena__find_symbol', 'mcp__serena__find_referencing_symbols', 'mcp__serena__get_symbols_overview'), true],
  ]
  for (const [label, definition, expected] of cases) {
    it(`${label} → ${expected ? 'ephemeral' : 'persistent'}`, () => {
      expect(classifyEphemeral(definition)).toBe(expected)
    })
  }

  it('classifies from the allow list only, never netting deny lists', () => {
    // `tools: [Read, Write]` + `disallowedTools: [Write]` stays persistent.
    const definition = parseAgentMarkdown(
      '/tmp/agents/n.md',
      '---\ndescription: x\ntools: [Read, Write]\ndisallowedTools: [Write]\n---\nBody', 'project')
    expect(definition.toolRestriction).toEqual({ allow: ['read', 'read_image', 'write'], deny: ['write'] })
    expect(classifyEphemeral(definition)).toBe(false)
  })

  it('comma-string tools and typo-dropped entries still classify through parse', () => {
    // Comma shorthand: "Read, Glob" → read/read_image/glob → ephemeral.
    expect(classifyEphemeral(parse(md('"Read, Glob"')))).toBe(true)
    // A typo'd entry passes through translateToolNames verbatim, so the
    // allow list holds it and classification flips to persistent.
    expect(classifyEphemeral(parse(md('[Read, Red]')))).toBe(false)
  })
})

describe('classifyEphemeral — frontmatter override', () => {
  it('ephemeral: true forces ephemeral for a writer', () => {
    expect(classifyEphemeral(parse(md('[Read, Write]', 'ephemeral: true\n')))).toBe(true)
  })

  it('ephemeral: false forces persistent for the read-only whitelist', () => {
    expect(classifyEphemeral(parse(md('[Read, Glob, Grep]', 'ephemeral: false\n')))).toBe(false)
  })

  it('an absent ephemeral field derives from the allow list', () => {
    expect(classifyEphemeral(parse(md('[Read, Glob, Grep]')))).toBe(true)
  })
})
