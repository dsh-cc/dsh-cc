/**
 * CC→harness tool-name translation: the canonical map, both translation
 * policies (strict fail-fast vs lenient drop-unknown), arg-spec stripping, and
 * the match-time alias index. Guards the hardcoded harness registry so a
 * registry change fails loudly instead of silently drifting.
 */

import { describe, expect, it } from 'vitest'
import {
  CC_TO_HARNESS_TOOLS,
  KNOWN_HARNESS_TOOLS,
  ccCanonicalToolName,
  ccToolAliases,
  translateToolNames,
} from '@dsh-cc/tools'

/**
 * The authoritative harness global tool set, mirrored here so a mismatch with
 * {@link CC_TO_HARNESS_TOOLS} fails the table test below (if the harness
 * registry changes, this test fails loudly rather than silently).
 */
const AUTHORITATIVE_HARNESS_TOOLS = [
  'EnterWorktree', 'ExitWorktree', 'NotebookEdit', 'Sleep', 'ToolSearch',
  'ask_user_question', 'bash', 'create_goal', 'edit', 'exit_plan_mode',
  'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list',
  'job_output', 'list_agents', 'ralph', 'read', 'read_image', 'send_message',
  'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal',
  'web_fetch', 'web_search', 'workflow', 'write',
]

describe('CC_TO_HARNESS_TOOLS', () => {
  it('maps every value to an authoritative harness tool name', () => {
    const known = new Set(AUTHORITATIVE_HARNESS_TOOLS)
    for (const name of Object.values(CC_TO_HARNESS_TOOLS)) {
      for (const harnessName of name) {
        expect(known.has(harnessName)).toBe(true)
      }
    }
  })

  it('aligns KNOWN_HARNESS_TOOLS with the authoritative registry', () => {
    expect([...KNOWN_HARNESS_TOOLS].sort()).toEqual([...AUTHORITATIVE_HARNESS_TOOLS].sort())
  })

  it('Read maps to both read and read_image (one-to-many)', () => {
    expect(CC_TO_HARNESS_TOOLS.Read).toEqual(['read', 'read_image'])
  })
})

describe('translateToolNames (strict)', () => {
  it('translates Read to both harness names in a deny-list context', () => {
    expect(translateToolNames(['Read'], 'strict')).toEqual(['read', 'read_image'])
  })

  it('passes unknown names through verbatim', () => {
    const input = ['LS', 'EnterPlanMode', 'mcp__github__foo', 'pwsh']
    expect(translateToolNames(input, 'strict')).toEqual(input)
  })

  it('strips an arg-spec from Bash', () => {
    expect(translateToolNames(['Bash(git status)'], 'strict')).toEqual(['bash'])
  })

  it('strips an arg-spec from WebFetch', () => {
    expect(translateToolNames(['WebFetch(domain:example.com)'], 'strict')).toEqual(['web_fetch'])
  })

  it('dedupes preserving first-occurrence order', () => {
    expect(translateToolNames(['Read', 'read', 'Grep'], 'strict')).toEqual(['read', 'read_image', 'grep'])
  })

  it('returns an empty array for empty input, never undefined', () => {
    expect(translateToolNames([], 'strict')).toEqual([])
  })
})

describe('translateToolNames (lenient)', () => {
  it('translates Read', () => {
    expect(translateToolNames(['Read'], 'lenient')).toEqual(['read', 'read_image'])
  })

  it('passes an existing harness name through', () => {
    expect(translateToolNames(['read'], 'lenient')).toEqual(['read'])
  })

  it('drops unknown names and collects diagnostics via onDiagnostic', () => {
    const diagnostics: string[] = []
    const result = translateToolNames(['LS', 'EnterPlanMode', 'mcp__github__foo'], 'lenient',
      message => { diagnostics.push(message) })
    expect(result).toBeUndefined()
    expect(diagnostics).toEqual([
      'dropping unknown tool name "LS" from CC tool list',
      'dropping unknown tool name "EnterPlanMode" from CC tool list',
      'dropping unknown tool name "mcp__github__foo" from CC tool list',
      'dropping all CC tool names — resulting tool restriction is empty',
    ])
  })

  it('returns undefined with a diagnostic when every input is dropped', () => {
    const diagnostics: string[] = []
    const result = translateToolNames(['LS'], 'lenient', message => { diagnostics.push(message) })
    expect(result).toBeUndefined()
    expect(diagnostics).toContain('dropping all CC tool names — resulting tool restriction is empty')
  })

  it('strips an arg-spec under lenient too', () => {
    expect(translateToolNames(['Bash(git status)'], 'lenient')).toEqual(['bash'])
  })

  it('ignores mixed known/unknown input: known passes, unknown drops', () => {
    const diagnostics: string[] = []
    expect(translateToolNames(['Bash', 'pwsh'], 'lenient', message => { diagnostics.push(message) }))
      .toEqual(['bash'])
    expect(diagnostics).toEqual(['dropping unknown tool name "pwsh" from CC tool list'])
  })
})

describe('ccToolAliases', () => {
  it('expands a harness tool to its CC aliases', () => {
    expect(ccToolAliases('read')).toEqual(['read', 'Read'])
    expect(ccToolAliases('read_image')).toEqual(['read_image', 'Read'])
    expect(ccToolAliases('bash')).toEqual(['bash', 'Bash'])
    expect(ccToolAliases('edit')).toEqual(['edit', 'Edit', 'MultiEdit'])
  })

  it('returns the CC name first for a CC name in the map', () => {
    expect(ccToolAliases('Bash')).toEqual(['Bash', 'bash'])
  })

  it('returns only the input for an unknown name', () => {
    expect(ccToolAliases('pwsh')).toEqual(['pwsh'])
  })
})

describe('ccCanonicalToolName', () => {
  it('maps a harness tool to its CC canonical name', () => {
    expect(ccCanonicalToolName('read')).toBe('Read')
    expect(ccCanonicalToolName('read_image')).toBe('Read')
    expect(ccCanonicalToolName('edit')).toBe('Edit')
    expect(ccCanonicalToolName('subagent')).toBe('Task')
    expect(ccCanonicalToolName('subagent_fork')).toBe('Task')
  })

  it('passes an already-CC or harness-only name through unchanged', () => {
    expect(ccCanonicalToolName('Bash')).toBe('Bash')
    expect(ccCanonicalToolName('pwsh')).toBe('pwsh')
    expect(ccCanonicalToolName('ralph')).toBe('ralph')
  })
})
