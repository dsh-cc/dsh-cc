import { describe, expect, it } from 'vitest'
import { permissionSettingsSchema, type PermissionSettings } from '../src/settings-schema.ts'

/** Parse a plugin settings section or throw (schemastery schemas are callable). */
function parse(value: unknown): PermissionSettings & Record<string, unknown> {
  return (permissionSettingsSchema() as unknown as (v: unknown) => PermissionSettings & Record<string, unknown>)(value)
}

/**
 * The plugin-local `permissions` schema is the consumer that VALIDATES the MCP
 * classification surface (design D5; the cascade schema only preserves unknown
 * fields — a different contract, pinned in the settings package). Absence is
 * preserved like `autoMode`: an unset key stays absent, never defaulted.
 */
describe('permissionSettingsSchema — MCP classification surface (design D5)', () => {
  it('keeps both keys absent when the section does not carry them', () => {
    const parsed = parse({})
    expect('mcpToolClasses' in parsed).toBe(false)
    expect('trustMcpAnnotations' in parsed).toBe(false)
  })

  it('parses the D5 matrix: partial entries, false, and the trust flag', () => {
    const parsed = parse({
      mcpToolClasses: {
        serena: { readOnlyTools: ['find_symbol'], workspaceWriteTools: ['replace_content'] },
        'untrusted-server': false,
        'read-only-only': { readOnlyTools: ['search'] },
        'write-only': { workspaceWriteTools: ['apply'] },
        empty: {},
      },
      trustMcpAnnotations: true,
    })
    expect(parsed.mcpToolClasses).toEqual({
      serena: { readOnlyTools: ['find_symbol'], workspaceWriteTools: ['replace_content'] },
      'untrusted-server': false,
      'read-only-only': { readOnlyTools: ['search'] },
      'write-only': { workspaceWriteTools: ['apply'] },
      empty: {},
    })
    expect(parsed.trustMcpAnnotations).toBe(true)
  })

  it('accepts an explicit false trust flag (absence-preserving, no default materialized)', () => {
    expect(parse({ trustMcpAnnotations: false }).trustMcpAnnotations).toBe(false)
  })

  it('rejects malformed values (schemastery)', () => {
    expect(() => parse({ mcpToolClasses: { serena: true } })).toThrow()
    expect(() => parse({ mcpToolClasses: { serena: { readOnlyTools: 'find_symbol' } } })).toThrow()
    expect(() => parse({ mcpToolClasses: { serena: { workspaceWriteTools: [1] } } })).toThrow()
    expect(() => parse({ mcpToolClasses: [] })).toThrow()
    expect(() => parse({ trustMcpAnnotations: 'yes' })).toThrow()
  })
})
