/**
 * Claude Code-style file-based memory: the memdir format and parser, the
 * `memory` system-prompt section, and dynamic recall by a forked side-query.
 *
 * All file access goes through the optional `ctx.fs` seam, so a remote or
 * sandboxed backend works unchanged; a providerless host mounts memory as a
 * no-op. Recall needs `ctx.subagents` and a registered one-shot provider;
 * absence of either skips recall without error.
 *
 * @module @dsh-cc/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelRoutes } from '@dsh-cc/model-aliases'
import { toAgentOptions } from '@dsh-cc/model-aliases'
import { resolveMemoryHome } from './paths.ts'
import { MemorySection } from './section.ts'
import { MemoryRecall, SubagentMemorySelector } from './recall.ts'
import { registerMemorySaveTool } from './save.ts'

export { parseMemoryFile } from './parser.ts'
export type { ParsedMemoryFile } from './parser.ts'
export { truncateEntrypointContent, ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES } from './truncate.ts'
export type { EntrypointTruncation } from './truncate.ts'
export { MEMORY_TYPES, parseMemoryType } from './types.ts'
export type { MemoryType, MemoryFrontmatter, MemoryIndexEntry } from './types.ts'
export { scanMemoryDirectory } from './scan.ts'
export type { MemoryDirectoryState } from './scan.ts'
export {
  resolveMemoryHome,
  resolveProjectMemoryRoot,
  resolveWorkspaceMemoryDir,
  canonicalMemoryRoot,
  projectSlug,
  cwdOf,
  gitExecSync,
  PROJECT_MEMORY_DIR,
  PROJECTS_DIR,
  GIT_PROBE_TIMEOUT_MS,
} from './paths.ts'
export type { MemoryGitExec, MemoryGitExecResult } from './paths.ts'
export { MemorySection, renderMemorySection, renderTeamMemorySection, renderLayers, saveGuidance, MEMORY_SECTION_NAME, MEMORY_SECTION_ORDER } from './section.ts'
export type { MemoryLayer } from './section.ts'
export { MemoryRecall, SubagentMemorySelector, extractSelectedNames, MAX_RECALL_MEMORIES } from './recall.ts'
export type { MemorySelector, RecallCandidate } from './recall.ts'
export { TeamMemoryError, sanitizePathKey, resolveTeamMemoryRoot, validateTeamMemKey, readTeamMemFile, TEAM_MEMORY_DIR, TEAM_ENTRYPOINT_NAME } from './team.ts'
export {
  MEMORY_SAVE_TOOL,
  MEMORY_SAVE_SCOPES,
  MemorySaveError,
  pointerLine,
  registerMemorySaveTool,
  renderTopicFile,
  upsertPointer,
} from './save.ts'
export type { MemorySaveArgs } from './save.ts'
export {
  MEMORY_WRITES_SCHEMA,
  WRITEBACK_MAX_FILE_BYTES,
  WRITEBACK_MAX_FILES,
  WRITEBACK_MAX_TOTAL_BYTES,
  memoryWritePolicy,
  validateMemoryWrites,
  writeMemoryFiles,
} from './writeback.ts'
export type { MemoryWrite, MemoryWritePolicy } from './writeback.ts'

export const name = 'memory'
/** Core services required for section registration and event listeners. */
export const inject = ['systemPrompt']

/** Memory plugin configuration. */
export interface Config {
  /**
   * Memory home root. Defaults to the harness home `memory/`. The home IS the
   * global layer; each repository's private layer lives at
   * `<home>/projects/<slug>` (slug encodes the canonical git root).
   */
  memoryHome?: string
  /** Whether the `memory` system-prompt section is registered (default true). */
  sectionEnabled?: boolean
  /** Whether dynamic recall runs on pre-step (default true). */
  recallEnabled?: boolean
  /** One-shot subagent provider used by recall (default `fork`). */
  recallProviderName?: string
  /** Optional small-model selection passed to the recall subagent. */
  recallAgentOptions?: unknown
  /**
   * Opt the recall selector into `resolve('haiku')`. Default false so
   * configuring `haiku` for typed agents does not silently cross-model
   * every recall fork. Ignored when `recallAgentOptions` is set.
   */
  recallUseSmallFast?: boolean
  /**
   * Whether team memory is enabled (default false). Enables a shared
   * per-workspace team directory (`<workspaceDir>/team`), renders the
   * triple-layer section, and validates all team-memory access. Off by
   * default: onboarding a team directory changes the persisted format and is
   * not safe in multi-tenant or untrusted-writer deployments (see README
   * residual).
   */
  teamEnabled?: boolean
}

export const Config: z<Config> = z.object({
  memoryHome: z.string(),
  sectionEnabled: z.boolean().default(true),
  recallEnabled: z.boolean().default(true),
  recallProviderName: z.string().default('fork'),
  recallAgentOptions: z.any(),
  recallUseSmallFast: z.boolean().default(false),
  teamEnabled: z.boolean().default(false),
})

/**
 * Resolve the recall selector's `agentOptions` stamp.
 *
 * Priority: explicit `recallAgentOptions` (raw overlay, NOT alias-resolved) →
 * `recallUseSmallFast` + the configured `haiku` alias → nothing (inherit).
 * @param c - the host context (gateway to the optional `ccModelRoutes`).
 * @param config - the memory plugin config.
 * @returns the `agentOptions` record, or `undefined` for inherit.
 */
function resolveRecallAgentOptions(c: Context, config: Config): unknown {
  if (config.recallAgentOptions !== undefined) return config.recallAgentOptions
  if (config.recallUseSmallFast !== true) return undefined
  const routes = c.get('ccModelRoutes') as ModelRoutes | undefined
  return toAgentOptions(routes?.resolve('haiku'))
}

/**
 * Register the `memory` system-prompt section and recall listener.
 * @param ctx - the host context carrying the system-prompt and agent seams.
 * @param config - memory behavior knobs.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Pass the raw configured root through: resolveMemoryHome appends `memory/`
  // ONLY for undefined/empty — handing it defaultDshHome() here would resolve
  // to the harness home itself and write memory files into its root.
  const home = resolveMemoryHome(config.memoryHome)
  if (config.sectionEnabled ?? true) {
    const section = new MemorySection(ctx, home, {
      teamEnabled: config.teamEnabled === true,
    })
    section.start()
    // The save channel: memory directories sit outside every session's
    // sandbox writable roots, so direct write/edit always fails; the tool
    // writes host-side instead. No-op on hosts without a tools service.
    registerMemorySaveTool(ctx, home, section)
    // Re-scan at each turn boundary so host-side writes (memory_save,
    // memory-consolidation's write-back, external edits) surface in the
    // section without a restart; refresh() self-dedupes unchanged content.
    ctx.on('agent/turn-stopping', ({ agent }) => {
      void section.refresh(agent)
    })
  }
  if (config.recallEnabled ?? true) {
    new MemoryRecall(ctx, home, {
      providerName: config.recallProviderName ?? 'fork',
      enabled: true,
      createSelector: (c, agent) => new SubagentMemorySelector(
        c,
        agent,
        config.recallProviderName ?? 'fork',
        resolveRecallAgentOptions(c, config),
      ),
    })
  }
}
