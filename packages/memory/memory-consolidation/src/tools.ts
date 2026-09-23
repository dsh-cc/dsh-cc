/**
 * Model-facing tool restrictions for memory subagents.
 *
 * Extraction and dream forks REVIEW broadly but hold no write capability: the
 * memory directory lives outside the session workspace, so model-side writes
 * are fenced by the fs sandbox with no escalation path from a background job.
 * Instead the forks report their file set through the driver-injected
 * `structured_output` tool and the plugin performs the writes host-side (see
 * `writeback.ts`).
 *
 * Invariants:
 * - `tools.restrict()` validates only inherited/global tool names and THROWS
 *   on unknown ones (harness core/tools, src/index.ts restrict + restrictable
 *   names construction: inherited layers only, a scope's own registrations
 *   stay visible and are deliberately excluded from restrictableNames).
 * - The `structured_output` tool is injected child-scoped by the in-process
 *   driver for `outputSchema`-declaring requests and stays visible regardless
 *   of the filter — so it must NOT be allow-listed (naming it here throws
 *   deterministically in deployments without a global StructuredOutput tool).
 * - Precedent: the recall lane passes `toolFilter: { allow: ['read'] }` with
 *   `outputSchema` (packages/memory/memory/src/recall.ts) and its children
 *   still call the injected `structured_output`.
 *
 * `read_image` pairs with `read` to mirror Claude Code's `Read`, which covers
 * both text and images (the harness splits image reading into its own tool).
 * @module @dsh-cc/memory-consolidation/tools
 */

/** Prompt-facing tool vocabulary a memory subagent may exercise (feeds prompts.ts). */
export const MEMORY_AGENT_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'grep',
  'glob',
  'structured_output',
]

/** The tool the driver injects child-scoped per `outputSchema`; never host-global. */
export const DRIVER_INJECTED_TOOL = 'structured_output'

/** A `toolFilter` value usable as a subagent-start request restriction. */
export const MEMORY_TOOL_FILTER: { allow: readonly string[] } = {
  allow: MEMORY_AGENT_TOOLS.filter(name => name !== DRIVER_INJECTED_TOOL),
}
