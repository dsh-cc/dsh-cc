/**
 * Consumer-side wiring of Claude Code skill semantics onto harness seams.
 *
 * The skill-claude-code package translates frontmatter into pure metadata; this
 * module is the consumer that turns that metadata into actionable registrations
 * at mount time: an `allowed-tools` allow-list into a scoped `tools.restrict()`,
 * `paths` into a path activator, `context: fork` into subagent routing, and a
 * MCP source into a forced-off inline shell. Each piece is effect-scoped and
 * returns a disposer so unmounting the plugin recalls everything.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ccPathMatcher,
  ccRestriction,
  registerPathActivator,
  type CcSkillMetadata,
} from '@dsh-cc/skill-loader'
import type { ToolRestriction } from '@dsh-cc/tools'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

/** The agent-scope surface a skill needs to apply a scoped tool restriction. */
export interface AgentScope {
  /** Scoped tool registry; `restrict` masks global tools for this agent. */
  tools: {
    /**
     * Restrict the global tools visible to this agent scope.
     * @param filter - the `allow`/`deny` mask to apply.
     * @returns the exact disposer that lifts the restriction.
     */
    restrict(filter: ToolRestriction): () => void
  }
}

/** How a skill's body executes when activated. */
export type SkillExecution = 'inline' | 'fork'

/** The resolved activation descriptor a host consumes for one skill. */
export interface SkillActivation {
  /** Scoped tool restriction to apply on activation, or `undefined` when none. */
  readonly restriction: ToolRestriction | undefined
  /** Whether the skill's body runs in a subagent or inline. */
  readonly execution: SkillExecution
  /** Whether inline shell substitution is forbidden (MCP-sourced or `shell: false`). */
  readonly forbidInlineShell: boolean
}

/** The provider label RUNTIME skills using this loader carry. */
export const PROVIDER = 'cc-plugin-loader'

/**
 * Resolve the tool restriction for a skill from its `allowed-tools` allow-list.
 * Names are translated leniently; unknown names are dropped with a diagnostic
 * (routed to `console.warn`) rather than crashing the session.
 * @param metadata - the skill's translated CC metadata.
 * @returns an allow-only restriction, or `undefined` when nothing to restrict.
 */
export function skillToolRestriction(metadata: CcSkillMetadata): ToolRestriction | undefined {
  return ccRestriction(metadata.allowedTools, (message: string): void => {
    // No logging seam reaches here; surface dropped-name diagnostics on stderr.
    console.warn(`[cc-plugin-loader] ${message}`)
  })
}

/**
 * Resolve how a skill executes, honoring `context: fork` and the availability
 * of the subagent seam. A `fork` skill degrades to inline when the subagent
 * seam is absent so it still activates rather than failing.
 * @param metadata - the skill's translated CC metadata.
 * @param subagentsPresent - whether the subagent seam is mounted.
 * @returns `'fork'` when the skill demands fork and the seam exists, else `'inline'`.
 */
export function resolveSkillExecution(
  metadata: CcSkillMetadata,
  subagentsPresent: boolean,
): SkillExecution {
  if (metadata.executionContext !== 'fork') return 'inline'
  return subagentsPresent ? 'fork' : 'inline'
}

/**
 * Whether a skill forbids inline shell substitution. A `shell: false` field, or
 * an MCP-sourced skill (marked `shell: false` by its producer because it cannot
 * run a local shell), must not open an inline shell.
 * @param metadata - the skill's translated CC metadata.
 * @returns whether inline shell is forbidden.
 */
export function forbidsInlineShell(metadata: CcSkillMetadata): boolean {
  return metadata.shell === false
}

/**
 * Build the full activation descriptor for a skill, mirroring the four
 * consumer-side wires. Pure and deterministic so it is directly testable.
 * @param metadata - the skill's translated CC metadata.
 * @param subagentsPresent - whether the subagent seam is mounted.
 * @returns the resolved activation descriptor.
 */
export function activationFor(metadata: CcSkillMetadata, subagentsPresent: boolean): SkillActivation {
  return {
    restriction: skillToolRestriction(metadata),
    execution: resolveSkillExecution(metadata, subagentsPresent),
    forbidInlineShell: forbidsInlineShell(metadata),
  }
}

/**
 * Register a skill's path-conditional activator on `fs/observed`. The returned
 * disposer is folder-scoped and effect-safe through `ctx.on(...)`.
 * @param ctx - active context carrying the `fs/observed` event.
 * @param skill - the loaded skill definition (carries CC metadata).
 * @param projectRoot - the project/plugin root whose touched files activate the skill.
 * @returns the exact disposer that removes the activator.
 */
export function registerSkillPathActivator(
  ctx: Context,
  skill: SkillDefinition,
  projectRoot: string,
): () => void {
  const metadata = skill.metadata as CcSkillMetadata | undefined
  const paths = metadata?.paths ?? []
  if (paths.length === 0) {
    return () => {}
  }
  return registerPathActivator(ctx, {
    projects: [{ root: projectRoot, matcher: ccPathMatcher(paths), skillNames: [skill.name] }],
    onActivate: () => {},
  })
}

/**
 * Apply a skill's `allowed-tools` restriction to a scoped agent. Returns the
 * restriction disposer, or a no-op when the skill carries no restriction.
 * @param metadata - the skill's translated CC metadata.
 * @param agent - the scoped agent whose tool surface to mask.
 * @returns the disposer that lifts the restriction.
 */
export function applySkillRestriction(
  metadata: CcSkillMetadata,
  agent: AgentScope,
): () => void {
  const restriction = skillToolRestriction(metadata)
  if (restriction === undefined) return () => {}
  return agent.tools.restrict(restriction)
}
