/**
 * Provider metadata carried on Claude Code skill candidates and definitions.
 * Consumers translate these into harness seams at activation time.
 *
 * @module
 */

import type { CcSkillSource } from './discovery.ts'

/** Full Claude Code skill metadata surfaces on `SkillCandidate.metadata`. */
export interface CcSkillMetadata {
  /** `allowed-tools` allow-list, translated to a `tools.restrict()` filter. */
  readonly allowedTools: readonly string[]
  /** Optional `argument-hint` usage hint. */
  readonly argumentHint?: string
  /** Named `arguments` placeholders in frontmatter order. */
  readonly arguments: readonly string[]
  /** Optional `version`. */
  readonly version?: string
  /** Resolved `model`; `inherit` is omitted (inherit the caller). */
  readonly model?: string
  /** `context: fork` selects subagent execution via `ctx.subagents.startActivation()`. */
  readonly executionContext?: 'fork'
  /** Optional `agent` target persona. */
  readonly agent?: string
  /** Optional `effort` level or integer. */
  readonly effort?: string
  /** `shell` inline-shell toggle (false forces inline shell off). */
  readonly shell?: boolean
  /** Raw validated `hooks` object, preserved verbatim. */
  readonly hooks?: unknown
  /** Gitignore-style `paths` for conditional activation. */
  readonly paths?: readonly string[]
  /** Whether this skill came from a legacy `.claude/commands/*.md` file. */
  readonly deprecated: boolean
  /** Discovery source bucket (`bundled` for in-package bundled skills). */
  readonly source: 'bundled' | CcSkillSource
  /** Unknown frontmatter keys, preserved for tolerant downstream consumers. */
  readonly unknown: Readonly<Record<string, unknown>>
}

/** Invocation policy resolved from Claude Code bool frontmatter. */
export interface CcInvocationPolicy {
  /** Whether the skill appears in model-facing catalogs. */
  readonly modelInvocable: boolean
  /** Whether a human may invoke the skill directly. */
  readonly userInvocable: boolean
}
