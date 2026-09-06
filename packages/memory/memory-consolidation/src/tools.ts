/**
 * Model-facing tool restrictions for memory subagents.
 *
 * Extraction and dream forks REVIEW broadly but hold no write capability: the
 * memory directory lives outside the session workspace, so model-side writes
 * are fenced by the fs sandbox with no escalation path from a background job.
 * Instead the forks report their file set through the driver-injected
 * `structured_output` tool and the plugin performs the writes host-side (see
 * `writeback.ts`). `structured_output` is allow-listed defensively: the driver
 * installs it AFTER the tool filter is applied, so a name-level filter must
 * not shadow it.
 *
 * `read_image` pairs with `read` to mirror Claude Code's `Read`, which covers
 * both text and images (the harness splits image reading into its own tool).
 * @module @dsh-cc/memory-consolidation/tools
 */

/** Harness tool names a memory subagent may exercise. */
export const MEMORY_AGENT_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'grep',
  'glob',
  'structured_output',
]

/** A `toolFilter` value usable as a subagent-start request restriction. */
export const MEMORY_TOOL_FILTER: { allow: readonly string[] } = {
  allow: MEMORY_AGENT_TOOLS,
}
