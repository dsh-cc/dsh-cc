import { describe, expect, it } from 'vitest'
import {
  resolveMcpToolClass,
  type McpToolClassesSettings,
  type McpToolClassResolution,
} from '../src/mcp-tool-classes.ts'

/** Shorthand for the stamped identity argument the executor passes. */
const identity = (serverName: string, rawName: string) => ({ serverName, rawName })

/** Annotation-carrying definition, as the MCP bridge stamps it. */
const annotated = (readOnlyHint: boolean | undefined) => ({
  annotations: readOnlyHint === undefined ? {} : { readOnlyHint },
})

/** Resolution with annotation trust OFF — the default posture. */
const resolveUntrusted = (
  serverName: string,
  rawName: string,
  settings?: McpToolClassesSettings,
  definition?: { annotations?: { readOnlyHint?: boolean } },
): McpToolClassResolution | undefined =>
  resolveMcpToolClass(identity(serverName, rawName), settings, definition, { trustAnnotations: false })

/** Resolution with annotation trust ON (the opt-in setting). */
const resolveTrusted = (
  serverName: string,
  rawName: string,
  settings?: McpToolClassesSettings,
  definition?: { annotations?: { readOnlyHint?: boolean } },
): McpToolClassResolution | undefined =>
  resolveMcpToolClass(identity(serverName, rawName), settings, definition, { trustAnnotations: true })

describe('curated serena table (§7) — readOnly only', () => {
  const curatedReadOnly = [
    'initial_instructions',
    'find_symbol',
    'find_referencing_symbols',
    'find_declaration',
    'find_implementations',
    'get_symbols_overview',
    'get_diagnostics_for_file',
    'search_for_pattern',
    'list_mcp_resources',
    'read_mcp_resource',
  ]

  for (const rawName of curatedReadOnly) {
    it(`classifies serena ${rawName} as curated readOnly`, () => {
      expect(resolveUntrusted('serena', rawName)).toEqual({ mcpClass: 'readOnly', mcpClassSource: 'curated' })
    })
  }

  for (const rawName of ['insert_before_symbol', 'replace_symbol_body', 'replace_content', 'rename_symbol', 'restart_language_server']) {
    it(`leaves serena ${rawName} unclassified (curated never asserts workspaceWrite)`, () => {
      expect(resolveUntrusted('serena', rawName)).toBeUndefined()
    })
  }

  it('is scoped to the serena server name — another server gets nothing', () => {
    expect(resolveUntrusted('other', 'find_symbol')).toBeUndefined()
    expect(resolveUntrusted('serena-2', 'find_symbol')).toBeUndefined()
  })

  it('does not match a curated name under a different server', () => {
    expect(resolveUntrusted('github', 'get_symbols_overview')).toBeUndefined()
  })
})

describe('settings precedence (settings > curated > annotation)', () => {
  it('a settings readOnlyTools entry outranks the curated table', () => {
    const settings: McpToolClassesSettings = { serena: { readOnlyTools: ['replace_content'] } }
    // Replace_content is unclassified by the curated table but settings says readOnly.
    expect(resolveUntrusted('serena', 'replace_content', settings))
      .toEqual({ mcpClass: 'readOnly', mcpClassSource: 'settings' })
  })

  it('a settings entry replaces the curated entry entirely', () => {
    // Curated says find_symbol is readOnly; the settings entry for serena does
    // not list it, and the entry REPLACES the curated entry — so unclassified.
    const settings: McpToolClassesSettings = { serena: { workspaceWriteTools: ['replace_content'] } }
    expect(resolveUntrusted('serena', 'find_symbol', settings)).toBeUndefined()
  })

  it('a settings workspaceWriteTools entry yields workspaceWrite', () => {
    const settings: McpToolClassesSettings = { serena: { workspaceWriteTools: ['replace_content'] } }
    expect(resolveUntrusted('serena', 'replace_content', settings))
      .toEqual({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' })
  })

  it('`false` disables the server: unclassified and no annotation fallback', () => {
    const settings: McpToolClassesSettings = { serena: false }
    expect(resolveUntrusted('serena', 'find_symbol', settings)).toBeUndefined()
    // Even trusted annotations cannot resurrect a disabled server.
    expect(resolveTrusted('serena', 'replace_content', settings, annotated(true))).toBeUndefined()
  })

  it('an empty settings object replaces the curated table with nothing', () => {
    const settings: McpToolClassesSettings = { serena: {} }
    expect(resolveUntrusted('serena', 'find_symbol', settings)).toBeUndefined()
    // The settings entry also suppresses the annotation fallback.
    expect(resolveTrusted('serena', 'replace_content', settings, annotated(true))).toBeUndefined()
  })

  it('a tool listed in both lists is a conflict — unclassified (fail-safe)', () => {
    const settings: McpToolClassesSettings = {
      serena: { readOnlyTools: ['replace_content'], workspaceWriteTools: ['replace_content'] },
    }
    expect(resolveUntrusted('serena', 'replace_content', settings)).toBeUndefined()
    // The conflict is per tool: siblings keep their own classification.
    expect(resolveUntrusted('serena', 'find_symbol', settings)).toBeUndefined()
  })

  it('settings for another server do not affect this server', () => {
    const settings: McpToolClassesSettings = { other: { workspaceWriteTools: ['find_symbol'] } }
    expect(resolveUntrusted('serena', 'find_symbol', settings))
      .toEqual({ mcpClass: 'readOnly', mcpClassSource: 'curated' })
  })

  it('only settings can produce workspaceWrite', () => {
    const settings: McpToolClassesSettings = { other: { workspaceWriteTools: ['write_file'] } }
    expect(resolveUntrusted('other', 'write_file', settings))
      .toEqual({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' })
    expect(resolveUntrusted('serena', 'write_file', undefined)).toBeUndefined()
  })
})

describe('annotation fallback — opt-in, curated/settings-suppressed', () => {
  it('classifies readOnlyHint=true for an uncurated server when trusted', () => {
    expect(resolveTrusted('github', 'list_issues', undefined, annotated(true)))
      .toEqual({ mcpClass: 'readOnly', mcpClassSource: 'annotation' })
  })

  it('ignores readOnlyHint=true when trust is off', () => {
    expect(resolveUntrusted('github', 'list_issues', undefined, annotated(true))).toBeUndefined()
  })

  it('ignores readOnlyHint=false even when trusted', () => {
    expect(resolveTrusted('github', 'delete_issue', undefined, annotated(false))).toBeUndefined()
  })

  it('ignores a missing readOnlyHint', () => {
    expect(resolveTrusted('github', 'list_issues', undefined, annotated(undefined))).toBeUndefined()
  })

  it('ignores a missing definition', () => {
    expect(resolveTrusted('github', 'list_issues')).toBeUndefined()
  })

  it('ignores an unknown identity (fail-safe unclassified)', () => {
    expect(resolveMcpToolClass(undefined, undefined, annotated(true), { trustAnnotations: true })).toBeUndefined()
  })

  it('the curated table suppresses annotations for a curated server (§7 write tools)', () => {
    // serena owns a curated entry, so its unlisted tools stay unclassified and
    // are releasable ONLY through explicit workspaceWriteTools configuration.
    expect(resolveTrusted('serena', 'replace_content', undefined, annotated(true))).toBeUndefined()
    expect(resolveTrusted('serena', 'replace_content', { serena: { workspaceWriteTools: ['replace_content'] } }, annotated(true)))
      .toEqual({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' })
  })

  it('does not shadow a curated hit with annotation provenance', () => {
    expect(resolveTrusted('serena', 'find_symbol', undefined, annotated(false)))
      .toEqual({ mcpClass: 'readOnly', mcpClassSource: 'curated' })
  })
})
