/**
 * Shared vocabulary for loading Claude Code's `.claude/agents/*.md` and
 * `*.json` sub-agent definitions into the harness. The loader is a pure,
 * filesystem-only translation: it produces one {@link AgentDefinition} per
 * dispatched agent file, computing the effective tool restriction and the
 * system prompt exactly as the source frontmatter declares them, so a later
 * consumer (an agent preset row, a subagent driver) can mount them without
 * re-reading agent semantics.
 *
 * Fields deliberately mirror the Claude Code agent schema so an existing
 * `.claude/agents` tree ports without rewriting. Unknown frontmatter keys are
 * ignored, not forwarded, so a definition authored against a newer Claude
 * Code release degrades to the supported subset rather than failing to load.
 *
 * @module @dsh-cc/claude-code-agents/types
 */

/**
 * The layer an agent definition was discovered under; the precedence is
 * `bundled` < `user` < `project` — a user-layer agent shadows its bundled
 * namesake, and a project-layer agent shadows both.
 */
export type AgentSource = 'user' | 'project' | 'bundled'

/**
 * The per-scope tool filter the loader computes from `tools` and
 * `disallowedTools`. Structurally matches `@dsh-cc/tools`'s
 * `ToolRestriction` (an `allow`/`deny` pair that intersects with sibling
 * restrictions), so the value can be handed to a scoped `ctx.tools.restrict()`
 * without translation. The loader declares it locally to stay dependency-free.
 */
export interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  readonly allow?: readonly string[]
  /** Global tool names removed from visibility. */
  readonly deny?: readonly string[]
}

/** Effort level accepted from frontmatter, modelled on CC's effort levels. */
export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
] as const

/** A valid `effort` is one of the named levels or a positive integer. */
export type Effort = (typeof EFFORT_LEVELS)[number] | number

/** Permission mode the agent demands, mirrored from CC's permission modes. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const

/** A valid `permissionMode`. */
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Persistent memory scope an agent carries across sessions. */
export const MEMORY_SCOPES = ['user', 'project', 'local'] as const

/** A valid `memory` scope. */
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/** The isolation modes the loader accepts; only `worktree` is portable. */
export const ISOLATION_MODES = ['worktree'] as const

/** A valid `isolation`. */
export type IsolationMode = (typeof ISOLATION_MODES)[number]

/**
 * One loaded Claude Code agent definition: the validated, translated record
 * the loader returns and a consumer mounts.
 */
export interface AgentDefinition {
  /** Unique agent type name, taken from the file's basename without extension. */
  readonly agentType: string
  /** The frontmatter `description`, surfaced as the model's when-to-use guide. */
  readonly whenToUse: string
  /** The system prompt: the markdown body, or the frontmatter `prompt` override. */
  readonly systemPrompt: string
  /** The layer this definition was discovered under. */
  readonly source: AgentSource
  /** The agent's own parent directory (the `.claude/agents` dir that held it). */
  readonly baseDir: string
  /** Original file basename without extension (`{agentType}` for `.md`). */
  readonly filename: string
  /** Effective tool restriction; present when `tools` and/or `disallowedTools` were. */
  readonly toolRestriction?: ToolRestriction
  /** Skill names to preload, in declaration order. */
  readonly skills?: readonly string[]
  /** MCP server names this agent requires, referenced by name only. */
  readonly mcpServers?: readonly string[]
  /** Hooks declarations, passed through unmodified. */
  readonly hooks?: Record<string, unknown>
  /** `model` as written, normalized lowercased-and-trimmed; `'inherit'` is literal. */
  readonly model?: string
  /** Reasoning effort overrides, when declared. */
  readonly effort?: Effort
  /** Permission mode the agent selects when it starts. */
  readonly permissionMode?: PermissionMode
  /** Maximum agentic turns before stopping. */
  readonly maxTurns?: number
  /** Initial prompt delivered as the first inbox message. */
  readonly initialPrompt?: string
  /** Whether spawned runs should default to the background. */
  readonly background?: boolean
  /** Persistent memory scope. */
  readonly memory?: MemoryScope
  /** Isolation mode; `worktree` requires a provider that supports it. */
  readonly isolation?: IsolationMode
}
