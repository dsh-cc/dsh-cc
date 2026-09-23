import { describe, expect, it } from 'vitest'
import { PermissionsSchema } from '../src/permissions.ts'

/** Parse a permissions object or throw. */
function parse(value: unknown): unknown {
  // Schemastery schemas are callable; a rejected value throws.
  return (PermissionsSchema as unknown as (v: unknown) => unknown)(value)
}

describe('PermissionsSchema', () => {
  it('parses a complete Claude Code permissions object', () => {
    const value = {
      allow: ['Bash(*)', 'Edit'],
      deny: ['WebFetch'],
      ask: ['Bash(rm -rf *)'],
      defaultMode: 'acceptEdits',
      disableBypassPermissionsMode: 'disable',
      additionalDirectories: ['/workspace/other'],
      protectedFiles: ['.bashrc', '.msh/**'],
      dangerousPatterns: ['drop database'],
      mediumPatterns: [],
    }
    expect(parse(value)).toEqual(value)
  })

  it('parses protectedFiles and dangerousPatterns on their own', () => {
    const value = { protectedFiles: ['.ssh/**'], dangerousPatterns: ['sudo'] }
    expect(parse(value)).toEqual({
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      protectedFiles: ['.ssh/**'],
      dangerousPatterns: ['sudo'],
      mediumPatterns: [],
    })
  })

  it('parses an empty permissions object, normalizing missing arrays to empty', () => {
    expect(parse({})).toEqual({
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      protectedFiles: [],
      dangerousPatterns: [],
      mediumPatterns: [],
    })
  })

  it('preserves unknown fields (passthrough)', () => {
    const value = { allow: ['Read'], customField: { nested: 1 } }
    const result = parse(value) as Record<string, unknown>
    expect(result['allow']).toEqual(['Read'])
    expect(result['customField']).toEqual({ nested: 1 })
  })

  it('rejects a non-array allow', () => {
    expect(() => parse({ allow: 'Bash(*)' })).toThrow()
  })

  it('rejects an unknown defaultMode', () => {
    expect(() => parse({ defaultMode: 'bogus' })).toThrow()
  })

  it('parses defaultMode auto', () => {
    expect(parse({ defaultMode: 'auto' })).toMatchObject({ defaultMode: 'auto' })
  })

  it('rejects a disableBypassPermissionsMode value other than disable', () => {
    expect(() => parse({ disableBypassPermissionsMode: 'on' })).toThrow()
  })

  it('rejects a non-string array entry', () => {
    expect(() => parse({ additionalDirectories: [1] })).toThrow()
  })
})
