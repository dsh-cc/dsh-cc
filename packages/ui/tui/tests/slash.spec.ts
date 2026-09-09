import { describe, expect, it } from 'vitest'
import { LOCAL_COMMANDS, parseSlash } from '@dsh-cc/tui/slash.ts'

describe('LOCAL_COMMANDS', () => {
  it('has an entry for every TUI-owned slash name', () => {
    const names = LOCAL_COMMANDS.map(c => c.name).sort()
    expect(names).toEqual([
      'agents', 'clear', 'copy', 'effort', 'exit', 'export-md', 'model', 'new', 'onboard', 'provider', 'quit', 'reset', 'resume', 'tui-help', 'usage',
    ])
  })

  it('every entry has a non-empty description', () => {
    for (const cmd of LOCAL_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0)
    }
  })

  it('clear describes a new empty conversation, not a screen wipe', () => {
    const clear = LOCAL_COMMANDS.find(c => c.name === 'clear')
    expect(clear).toBeDefined()
    expect(clear!.description.toLowerCase()).toMatch(/new conversation|empty context/)
    expect(clear!.description.toLowerCase()).not.toMatch(/transcript rows/)
    expect(LOCAL_COMMANDS.find(c => c.name === 'new')?.description).toBe('Alias of /clear')
    expect(LOCAL_COMMANDS.find(c => c.name === 'reset')?.description).toBe('Alias of /clear')
  })

  it('resume carries an argument hint', () => {
    const resume = LOCAL_COMMANDS.find(c => c.name === 'resume')
    expect(resume?.argumentHint).toBeDefined()
    expect(resume!.argumentHint!.length).toBeGreaterThan(0)
  })

  it('agents is listed with a background-agents description', () => {
    const agents = LOCAL_COMMANDS.find(c => c.name === 'agents')
    expect(agents).toBeDefined()
    expect(agents!.description.toLowerCase()).toContain('agents')
    expect(agents!.argumentHint).toContain('stop')
  })

  it('usage is listed with a panel description', () => {
    const usage = LOCAL_COMMANDS.find(c => c.name === 'usage')
    expect(usage).toBeDefined()
    expect(usage!.description.toLowerCase()).toContain('panel')
  })

  it('effort is listed with a level argument hint', () => {
    const effort = LOCAL_COMMANDS.find(c => c.name === 'effort')
    expect(effort).toBeDefined()
    expect(effort!.argumentHint).toBe('<level|default>')
    expect(effort!.description.toLowerCase()).toContain('reasoning effort')
  })
})

describe('parseSlash', () => {
  it('treats a non-slash line as none', () => {
    expect(parseSlash('hello')).toEqual({ kind: 'none' })
  })

  it('keeps TUI-owned names local', () => {
    expect(parseSlash('/quit')).toEqual({ kind: 'local', name: 'quit', rawInput: '' })
    expect(parseSlash('/exit now')).toEqual({ kind: 'local', name: 'exit', rawInput: 'now' })
    expect(parseSlash('/clear')).toEqual({ kind: 'local', name: 'clear', rawInput: '' })
    expect(parseSlash('/new')).toEqual({ kind: 'local', name: 'new', rawInput: '' })
    expect(parseSlash('/reset')).toEqual({ kind: 'local', name: 'reset', rawInput: '' })
    expect(parseSlash('/resume sess-1')).toEqual({ kind: 'local', name: 'resume', rawInput: 'sess-1' })
    expect(parseSlash('/model 2')).toEqual({ kind: 'local', name: 'model', rawInput: '2' })
    expect(parseSlash('/agents')).toEqual({ kind: 'local', name: 'agents', rawInput: '' })
    expect(parseSlash('/export-md /tmp/notes.md')).toEqual({
      kind: 'local', name: 'export-md', rawInput: '/tmp/notes.md',
    })
    expect(parseSlash('/copy')).toEqual({ kind: 'local', name: 'copy', rawInput: '' })
    expect(parseSlash('/usage')).toEqual({ kind: 'local', name: 'usage', rawInput: '' })
    expect(parseSlash('/effort high')).toEqual({ kind: 'local', name: 'effort', rawInput: 'high' })
    expect(parseSlash('/effort')).toEqual({ kind: 'local', name: 'effort', rawInput: '' })
  })

  it('forwards unknown names to the harness catalog', () => {
    expect(parseSlash('/permissions')).toEqual({ kind: 'harness', line: '/permissions' })
    expect(parseSlash('/permissions plan')).toEqual({ kind: 'harness', line: '/permissions plan' })
    expect(parseSlash('/status')).toEqual({ kind: 'harness', line: '/status' })
    expect(parseSlash('/cost')).toEqual({ kind: 'harness', line: '/cost' })
  })
})
