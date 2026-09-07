import { describe, expect, it, vi } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { formatCommandHelp, helpable, isHelpRequest } from '@dsh-cc/command-usage'

describe('isHelpRequest', () => {
  it.each([
    ['', false],
    ['help', true],
    ['  HELP  ', true],
    ['-h', true],
    ['--help', true],
    ['help me', true],
    ['helper', false],
    ['x help', false],
    ['list', false],
  ])('isHelpRequest(%j) === %j', (raw, expected) => {
    expect(isHelpRequest(raw)).toBe(expected)
  })
})

describe('formatCommandHelp', () => {
  it('renders a minimal spec with usage omitted', () => {
    expect(formatCommandHelp({ name: 'x', description: 'Does one thing' })).toBe(
      '/x — Does one thing\nUsage:\n  /x',
    )
  })

  it('renders one usage line', () => {
    expect(
      formatCommandHelp({ name: 'x', description: 'Does one thing', usage: '[<value>]' }),
    ).toBe('/x — Does one thing\nUsage:\n  /x\n  /x [<value>]')
  })

  it('renders multiple usage lines', () => {
    expect(
      formatCommandHelp({
        name: 'x',
        description: 'Does one thing',
        usage: ['[list]', '[add <value>]'],
      }),
    ).toBe('/x — Does one thing\nUsage:\n  /x\n  /x [list]\n  /x [add <value>]')
  })

  it('aligns the subcommand summary column across entries', () => {
    const text = formatCommandHelp({
      name: 'x',
      description: 'Does one thing',
      usage: '[list | add <preset-id>]',
      subcommands: [
        { word: 'list', summary: 'Show items' },
        { word: 'add', args: '<preset-id>', summary: 'Add one' },
      ],
      notes: ['Notes are one line each.'],
    })
    expect(text).toBe(
      [
        '/x — Does one thing',
        'Usage:',
        '  /x',
        '  /x [list | add <preset-id>]',
        'Subcommands:',
        '  list             Show items',
        '  add <preset-id>  Add one',
        'Notes:',
        '  Notes are one line each.',
      ].join('\n'),
    )
  })

  it('has no trailing newline', () => {
    const text = formatCommandHelp({ name: 'x', description: 'Does one thing', notes: ['last'] })
    expect(text.endsWith('\n')).toBe(false)
  })
})

describe('helpable', () => {
  const makeDef = (): CommandDefinition => ({
    name: 'x',
    description: 'Does one thing',
    input: { hint: '[<value>]' },
    handler: vi.fn(() => ({ kind: 'success', text: 'ran' })),
  })

  it('answers a help request with formatted help text', () => {
    const def = makeDef()
    const wrapped = helpable(def)
    const result = wrapped.handler({
      commandId: 'c1' as never,
      agent: {} as never,
      rawInput: '  --help  ',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(result).toEqual({
      kind: 'success',
      text: '/x — Does one thing\nUsage:\n  /x\n  /x [<value>]',
    })
    expect((result as { kind: 'success'; text?: string }).text).toContain('/x')
    expect((result as { kind: 'success'; text?: string }).text).toContain('Usage:')
    expect(def.handler).not.toHaveBeenCalled()
  })

  it('delegates non-help invocations untouched', () => {
    const def = makeDef()
    const wrapped = helpable(def)
    const invocation = {
      commandId: 'c1' as never,
      agent: {} as never,
      rawInput: 'list all',
      attachments: [],
      signal: new AbortController().signal,
    }
    const result = wrapped.handler(invocation)
    expect(result).toEqual({ kind: 'success', text: 'ran' })
    expect(def.handler).toHaveBeenCalledWith(invocation)
  })

  it('does not mutate the original definition', () => {
    const def = makeDef()
    const snapshot = { ...def, input: { ...def.input } }
    helpable(def, { usage: '[a | b]' })
    expect(def).toEqual(snapshot)
  })

  it('lets extras.usage win over input.hint', () => {
    const def = makeDef()
    const wrapped = helpable(def, { usage: '[a | b]' })
    const result = wrapped.handler({
      commandId: 'c1' as never,
      agent: {} as never,
      rawInput: 'help',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect((result as { kind: 'success'; text?: string }).text).toContain('  /x [a | b]')
  })

  it('derives usage from input.hint without extras', () => {
    const def = makeDef()
    const wrapped = helpable(def)
    const result = wrapped.handler({
      commandId: 'c1' as never,
      agent: {} as never,
      rawInput: 'help',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect((result as { kind: 'success'; text?: string }).text).toContain('  /x [<value>]')
  })
})
