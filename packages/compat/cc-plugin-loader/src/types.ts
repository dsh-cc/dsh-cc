/**
 * Load semantics for a Claude Code plugin manifest in the harness.
 *
 * Defines the typed subset of `plugin.json` this loader translates, plus the
 * structural report a mount returns so a host UI can present per-component
 * outcome. Shapes mirror Claude Code's `PluginManifestSchema` for the
 * component fields the loader consumes.
 *
 * @module
 */

/** One manifest-declared slash command, inline or pointing at a markdown file. */
export interface CcCommand {
  /** Command name (lowercase kebab), key in the manifest's `commands` record. */
  readonly name: string
  /** Human-readable command description. */
  readonly description?: string
  /** Path to a command markdown file, relative to the plugin root. */
  readonly source?: string
  /** Inline markdown body that serves as the command content. */
  readonly content?: string
  /** Argument placeholder hint, surfaced to the user. */
  readonly argumentHint?: string
  /** Default model for the command's execution. */
  readonly model?: string
  /** Tools allowed while the command runs. */
  readonly allowedTools?: readonly string[]
}

/** A Claude Code sub-agent, loaded from `agents/` or an inline path. */
export interface CcAgentRef {
  /** Path to the agent file(s), relative to the plugin root. */
  readonly paths: readonly string[]
}

/** A Claude Code skill entry, loaded from `skills/` or an inline path. */
export interface CcSkillRef {
  /** Skill directories or files, relative to the plugin root. */
  readonly paths: readonly string[]
}

/** A Claude Code MCP server configuration, keyed by server name. */
export interface CcMcpServer {
  readonly [key: string]: unknown
}

/** The typed subset of a Claude Code `plugin.json` manifest. */
export interface CcPluginManifest {
  /** Unique kebab-case plugin identifier (must not contain spaces). */
  readonly name: string
  /** Dialect of the winning manifest (plan §3.1), resolver-injected. */
  readonly flavor: PluginFlavor
  /** Warnings produced during resolution (e.g. dual-manifest precedence). */
  readonly warnings: readonly string[]
  /** Semantic version, optional. */
  readonly version?: string
  /** Brief user-facing description, optional. */
  readonly description?: string
  /** Creator metadata, surfaced verbatim, optional. */
  readonly author?: unknown
  /** Slash commands from the manifest `commands` field. */
  readonly commands: readonly CcCommand[]
  /** True when the manifest declared `commands` (even as an empty list). */
  readonly commandsDeclared: boolean
  /** Agent file paths from the manifest `agents` field. */
  readonly agents: readonly string[]
  /** Skill paths from the manifest `skills` field. */
  readonly skills: readonly string[]
  /**
   * When true, do not scan the default `skills/` directory — the listed
   * `skills` paths replace it (marketplace-root overlay).
   */
  readonly skillsReplaceDefault: boolean
  /** Whether the plugin ships a `hooks/` directory or inline `hooks`. */
  readonly hooks?: unknown
  /** MCP server definitions (inline record, or keys from an `.mcp.json`). */
  readonly mcpServers: Readonly<Record<string, CcMcpServer>>
  /** Path to an `.mcp.json` file when the manifest referenced one. */
  readonly mcpServersPath?: string
  /** Settings to merge on enable, allowlisted before writing. */
  readonly settings: Readonly<Record<string, unknown>>
}

/** Dialect of the winning manifest (plan §3.1): CC layout or Cursor layout. */
export type PluginFlavor = 'cc' | 'cursor'

/** The six component kinds a plugin can contribute. */
export type ComponentKind = 'commands' | 'agents' | 'skills' | 'hooks' | 'mcpServers' | 'settings'

/** Per-component load outcome counts and reasons for a mount. */
export interface ComponentResult {
  /** The component kind this result describes. */
  readonly kind: ComponentKind
  /** Components successfully mounted. */
  readonly loaded: number
  /** Components skipped because their host seam was absent or disallowed. */
  readonly skipped: number
  /** Components that failed to mount. */
  readonly failed: number
  /** Human-readable reasons, one per skipped or failed component. */
  readonly reasons: readonly string[]
}

/** Structural result of mounting one CC plugin. */
export interface PluginLoadReport {
  /** The mounted plugin's manifest name. */
  readonly name: string
  /** Dialect of the winning manifest. */
  readonly flavor: PluginFlavor
  /** Resolution-level warnings (e.g. dual-manifest precedence); distinct from skipped reasons. */
  readonly warnings: readonly string[]
  /** Per-component outcome. */
  readonly components: readonly ComponentResult[]
}
