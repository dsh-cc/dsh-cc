import { describe, expect, it } from 'vitest'
import { resolveInstalledPluginId } from '../src/resolve-id.ts'
import { PluginManagerError } from '../src/errors.ts'

const keys = ['formatter@internal', 'dark-mode@anthropics', 'dark-mode@internal']

function idOf(fn: () => string): PluginManagerError {
  try {
    fn()
  } catch (error) {
    return error as PluginManagerError
  }
  throw new Error('expected to throw')
}

describe('resolveInstalledPluginId', () => {
  it('exact `<name>@<marketplace>` key match wins', () => {
    expect(resolveInstalledPluginId('dark-mode@internal', keys)).toBe('dark-mode@internal')
    expect(resolveInstalledPluginId('formatter@internal', keys)).toBe('formatter@internal')
  })

  it('bare name resolves iff exactly one installed key has that name part', () => {
    expect(resolveInstalledPluginId('formatter', keys)).toBe('formatter@internal')
  })

  it('unknown name → exact catalog string with sorted installed list', () => {
    const error = idOf(() => resolveInstalledPluginId('nope', keys))
    expect(error).toBeInstanceOf(PluginManagerError)
    expect(error.message).toBe(
      'Unknown plugin "nope". Installed: dark-mode@anthropics, dark-mode@internal, formatter@internal',
    )
  })

  it('unknown name with no installed keys → …none', () => {
    const error = idOf(() => resolveInstalledPluginId('nope', []))
    expect(error.message).toBe('Unknown plugin "nope". Installed: none')
  })

  it('ambiguous bare name → exact catalog string', () => {
    const error = idOf(() => resolveInstalledPluginId('dark-mode', keys))
    expect(error.message).toBe(
      'Plugin name "dark-mode" is ambiguous: dark-mode@anthropics, dark-mode@internal. Use the full <name>@<marketplace> id.',
    )
  })
})
