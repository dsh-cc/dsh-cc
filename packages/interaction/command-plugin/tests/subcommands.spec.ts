import { describe, expect, it } from 'vitest'
import { parsePluginArgv } from '../src/subcommands.ts'

describe('parsePluginArgv — grammar table', () => {
  const commandCases: ReadonlyArray<{ args: string[], expected: Record<string, unknown> }> = [
    { args: [], expected: { kind: 'mounted' } },
    {
      args: ['list'],
      expected: { kind: 'command', command: { verb: 'list' } },
    },
    {
      args: ['list', '--enabled'],
      expected: { kind: 'command', command: { verb: 'list', filter: 'enabled' } },
    },
    {
      args: ['list', '--disabled'],
      expected: { kind: 'command', command: { verb: 'list', filter: 'disabled' } },
    },
    {
      args: ['install', 'foo@bar'],
      expected: { kind: 'command', command: { verb: 'install', arg: 'foo@bar' } },
    },
    {
      args: ['install', 'foo', '--scope', 'project'],
      expected: { kind: 'command', command: { verb: 'install', arg: 'foo', scope: 'project' } },
    },
    {
      args: ['uninstall', 'foo@bar', '--scope=local'],
      expected: { kind: 'command', command: { verb: 'uninstall', arg: 'foo@bar', scope: 'local' } },
    },
    {
      args: ['enable', 'foo'],
      expected: { kind: 'command', command: { verb: 'enable', arg: 'foo' } },
    },
    {
      args: ['disable', 'foo', '--scope', 'user'],
      expected: { kind: 'command', command: { verb: 'disable', arg: 'foo', scope: 'user' } },
    },
    {
      args: ['update', 'foo'],
      expected: { kind: 'command', command: { verb: 'update', arg: 'foo' } },
    },
    {
      args: ['marketplace', 'list'],
      expected: { kind: 'command', command: { verb: 'marketplace-list' } },
    },
    {
      args: ['marketplace', 'add', 'owner/repo'],
      expected: { kind: 'command', command: { verb: 'marketplace-add', arg: 'owner/repo' } },
    },
    {
      args: ['marketplace', 'add', '/tmp/mkt', '--scope', 'local'],
      expected: { kind: 'command', command: { verb: 'marketplace-add', arg: '/tmp/mkt', scope: 'local' } },
    },
    {
      args: ['marketplace', 'remove', 'bar'],
      expected: { kind: 'command', command: { verb: 'marketplace-remove', arg: 'bar' } },
    },
    {
      args: ['marketplace', 'update'],
      expected: { kind: 'command', command: { verb: 'marketplace-update' } },
    },
    {
      args: ['marketplace', 'update', 'bar'],
      expected: { kind: 'command', command: { verb: 'marketplace-update', arg: 'bar' } },
    },
  ]
  for (const { args, expected } of commandCases) {
    it(`parses /plugin ${args.join(' ') || '(bare)'}`, () => {
      expect(parsePluginArgv(args)).toEqual(expected)
    })
  }
})

describe('parsePluginArgv — malformed inputs', () => {
  const parseErrorCases: ReadonlyArray<{ args: string[], usageForm: string }> = [
    { args: ['install'], usageForm: 'install <plugin[@mkt]> [--scope user|project|local]' },
    { args: ['uninstall'], usageForm: 'uninstall <plugin[@mkt]> [--scope user|project|local]' },
    { args: ['enable'], usageForm: 'enable <plugin[@mkt]> [--scope user|project|local]' },
    { args: ['disable', 'foo', 'extra'], usageForm: 'disable <plugin[@mkt]> [--scope user|project|local]' },
    { args: ['install', 'foo', '--scope', 'bogus'], usageForm: 'install <plugin[@mkt]> [--scope user|project|local]' },
    { args: ['list', '--bogus'], usageForm: 'list [--enabled|--disabled]' },
    { args: ['list', '--enabled', '--disabled'], usageForm: 'list [--enabled|--disabled]' },
    { args: ['marketplace', 'add'], usageForm: 'marketplace add <source> [--scope user|project|local]' },
    { args: ['marketplace', 'remove'], usageForm: 'marketplace remove <name>' },
    { args: ['marketplace', 'remove', 'bar', 'extra'], usageForm: 'marketplace remove <name>' },
  ]
  for (const { args, usageForm } of parseErrorCases) {
    it(`parse-errors on /plugin ${args.join(' ')}`, () => {
      const outcome = parsePluginArgv(args)
      expect(outcome.kind).toBe('parse-error')
      if (outcome.kind !== 'parse-error') return
      expect(outcome.message).toBe(`Usage: /plugin ${usageForm}`)
    })
  }

  it('routes unknown subcommands to the help grammar block', () => {
    expect(parsePluginArgv(['frobnicate'])).toEqual({ kind: 'help' })
    expect(parsePluginArgv(['marketplace'])).toEqual({ kind: 'help' })
    expect(parsePluginArgv(['marketplace', 'bogus'])).toEqual({ kind: 'help' })
  })
})
