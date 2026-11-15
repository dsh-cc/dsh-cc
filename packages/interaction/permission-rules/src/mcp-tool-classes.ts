/**
 * Deterministic read-only / workspace-write classification for MCP tool calls.
 *
 * Pure: no I/O, no settings loading, no cordis context. The caller supplies the
 * stamped registration identity (`ToolDefinition.mcp`), the plugin-local
 * `permissions.mcpToolClasses` settings section, the executing definition, and
 * whether server-authored annotations are trusted.
 *
 * Precedence per tool (design D3): a settings entry REPLACES the curated entry
 * for its server; otherwise the curated table can only assert `readOnly`;
 * otherwise server-authored `readOnlyHint` (opt-in, never for a server that has
 * a curated or settings entry) can assert `readOnly`.
 *
 * @module @dsh-cc/permission-rules/mcp-tool-classes
 */

/** One MCP tool's auto-mode permission class. */
export type McpToolClass = 'readOnly' | 'workspaceWrite'

/** Which input produced a classification, for audit and evidence. */
export type McpToolClassSource = 'settings' | 'curated' | 'annotation'

/** A resolved classification: class and provenance are always co-present. */
export interface McpToolClassResolution {
  /** The resolved class. */
  mcpClass: McpToolClass
  /** Which layer classified it. */
  mcpClassSource: McpToolClassSource
}

/**
 * The whole `permissions.mcpToolClasses` section: one entry per server name.
 * `false` disables classification for that server (annotations included); an
 * object lists the tools the deployment asserts per class.
 */
export type McpToolClassesSettings = Record<
  string,
  { readOnlyTools?: string[]; workspaceWriteTools?: string[] } | false
>

/**
 * Curated `readOnly` tool names per server, keyed by server name, matched on the
 * server-local raw tool name.
 *
 * Structurally `readOnly`-only: there is no `workspaceWrite` list to populate, so
 * no code path in this module can assert `workspaceWrite` from a table entry
 * (design D3: a server *name* is not evidence of confinement — `workspaceWrite`
 * is an explicit deployment assertion and settings-only).
 */
const CURATED_READ_ONLY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  // Live-pinned 2026-11-15 (design §7). `restart_language_server` (process side
  // effect) and every write tool are deliberately absent: they stay
  // unclassified unless a trusted settings layer lists them in
  // `workspaceWriteTools`.
  serena: [
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
  ],
}

/**
 * Resolve one MCP tool's classification.
 *
 * Server identity comes ONLY from the stamped registration metadata
 * (`ToolDefinition.mcp`, passed as `input`) — a public tool name is never
 * parsed. When no identity is stamped (a native tool, or a definition the
 * execution cannot see) the call is unclassified: fail-safe, never throws.
 *
 * @param input - stamped `{ serverName, rawName }` identity, or undefined.
 * @param settings - the `permissions.mcpToolClasses` section, or undefined.
 * @param definition - the executing definition's annotation metadata, or undefined.
 * @param opts - `trustAnnotations` is `permissions.trustMcpAnnotations` (default false).
 * @returns the class plus its source, or undefined when unclassified.
 */
export function resolveMcpToolClass(
  input: { serverName: string; rawName: string } | undefined,
  settings: McpToolClassesSettings | undefined,
  definition: { annotations?: { readOnlyHint?: boolean } } | undefined,
  opts: { trustAnnotations: boolean },
): McpToolClassResolution | undefined {
  // No stamped identity: nothing to key settings or the curated table on, and
  // "this server has no curated/settings entry" is unverifiable — fail safe.
  if (input === undefined) return undefined

  // 1. Settings entry — present (even as `false`) REPLACES the curated entry
  // entirely, and also suppresses the annotation fallback.
  if (settings !== undefined && Object.hasOwn(settings, input.serverName)) {
    const entry = settings[input.serverName]
    if (entry === undefined || entry === false) return undefined
    const readOnly = entry.readOnlyTools?.includes(input.rawName) === true
    const workspaceWrite = entry.workspaceWriteTools?.includes(input.rawName) === true
    // Listed in both classes: the settings contradict each other — fail safe.
    if (readOnly && workspaceWrite) return undefined
    if (readOnly) return { mcpClass: 'readOnly', mcpClassSource: 'settings' }
    if (workspaceWrite) return { mcpClass: 'workspaceWrite', mcpClassSource: 'settings' }
    return undefined
  }

  // 2. Curated table — `readOnly` hits only; a curated server's unlisted tools
  // stay unclassified instead of falling through to annotations (§7).
  const curated = CURATED_READ_ONLY_TOOLS[input.serverName]
  if (curated !== undefined) {
    if (curated.includes(input.rawName)) return { mcpClass: 'readOnly', mcpClassSource: 'curated' }
    return undefined
  }

  // 3. Annotation fallback — opt-in, never for a server with a curated or
  // settings entry (server-authored `tools/list` must not self-attest).
  if (!opts.trustAnnotations) return undefined
  if (definition?.annotations?.readOnlyHint === true) {
    return { mcpClass: 'readOnly', mcpClassSource: 'annotation' }
  }
  return undefined
}
