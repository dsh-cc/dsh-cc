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
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type { ModelRoutes } from '@dsh-cc/model-aliases'
import { toAgentOptions } from '@dsh-cc/model-aliases'
import { resolveMemoryHome } from './paths.ts'
import { MemorySection } from './section.ts'
import { MemoryRecall, SubagentMemorySelector } from './recall.ts'
import { registerRecallDecisionSettings } from './recall-decision-settings.ts'
import type { RecallDecisionBinding, SystemOneDecisionsLike } from './recall-coordinator-support.ts'
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
export {
  titleSidecarPath,
  writeTitleSidecar,
  readTitleSidecar,
  TITLE_SIDECAR_MAX_CODE_POINTS,
} from './title-sidecar.ts'
export type { TitleSidecarOptions } from './title-sidecar.ts'
export { MemorySection, renderMemorySection, renderTeamMemorySection, renderLayers, saveGuidance, MEMORY_SECTION_NAME, MEMORY_SECTION_ORDER } from './section.ts'
export type { MemoryLayer } from './section.ts'
export { MemoryRecall, SubagentMemorySelector, MAX_RECALL_MEMORIES, RECALL_FILES_SCHEMA } from './recall.ts'
export type { MemorySelector, RecallCandidate } from './recall.ts'
export { INJECTED_SOURCE_DENYLIST, resolveRecallTurn } from './recall-query.ts'
export type { RecallMessageLike, RecallTurn } from './recall-query.ts'
export { COMPLETED_KEY_CAP, RecallCoordinator } from './recall-coordinator.ts'
export type { RecallCoordinatorOptions, RecallState, RecallTicket } from './recall-coordinator.ts'
export type { RecallDecisionBinding, SystemOneDecisionsLike } from './recall-coordinator-support.ts'
export type { RecallShadowDeps, RecallShadowRecord } from './recall-shadow.ts'
export {
  DEFAULT_RECALL_DECISION_SECTION,
  DEFAULT_RECALL_DECISION_SETTINGS,
  SETTINGS_NAMESPACE,
  recallDecisionSettings,
  registerRecallDecisionSettings,
  validateRecallDecisionSettings,
} from './recall-decision-settings.ts'
export type {
  RecallDecisionMode,
  RecallDecisionSection,
  RecallDecisionSettings,
} from './recall-decision-settings.ts'
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
export {
  MemoryIndexConflictError,
  carveEntrypointRoom,
  commitMemoryWrites,
  mergeIndexContent,
  pointerAdditions,
  readIndexStrict,
} from './index-commit.ts'
export type { CommitResult } from './index-commit.ts'
export { PRESSURE_FILE, readPressure, armPressure, markPressureForced, clearPressure } from './pressure.ts'
export type { PressureState } from './pressure.ts'

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
 * Resolve the optional SystemOne decision service PER USE (issue #368).
 *
 * The SystemOne decision service is OPTIONAL (S1-02's plugin provides it):
 * absent, the recall feature degrades to the legacy branch and the plugin still
 * mounts. Memory never imports the hosting plugin — the face is structural
 * (`SystemOneDecisionsLike`).
 *
 * The preset loader mounts a group's children concurrently (`Promise.all`), so
 * a strict `ctx.get` at apply time cannot see a sibling whose fiber is not
 * ACTIVE yet — an apply-time capture would be structurally `undefined` in
 * every real boot. Reading at use time (a pre-step or a coordinator turn, long
 * after the mount sweep) observes the provider as it is at that instant: a
 * provider that is absent, unreadable, mid-reload or unloading reads as
 * "no decision service" for that use, never as a stale pinned instance.
 *
 * `forAgent` sits INSIDE the guard: it mints the quota/lock scope and can
 * realistically throw (memory-consolidation guards the same call); a throwing
 * provider must read as absent, never reject into the fire-and-forget sidecar.
 *
 * @param ctx - the plugin context whose realm carries the isolate name.
 * @returns a per-use resolver returning the agent's binding, or `undefined`.
 */
export function recallDecisionsFor(ctx: Context): (agent: Agent) => RecallDecisionBinding | undefined {
  return (agent: Agent) => {
    try {
      return (ctx.get('systemoneDecisions' as never) as SystemOneDecisionsLike | undefined)?.forAgent(agent)
    } catch {
      return undefined
    }
  }
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
    const readSettings = registerRecallDecisionSettings(ctx)
    const recall = new MemoryRecall(ctx, home, {
      providerName: config.recallProviderName ?? 'fork',
      enabled: true,
      createSelector: (c, agent) => new SubagentMemorySelector(
        c,
        agent,
        config.recallProviderName ?? 'fork',
        resolveRecallAgentOptions(c, config),
      ),
      readSettings,
      // One bound runner per Agent; the service mints the decision scope itself.
      // Resolved PER USE (issue #368): the preset loader mounts a group's
      // children concurrently, and a strict `ctx.get` at apply time cannot see
      // a sibling whose fiber is not ACTIVE yet — a one-shot apply-time capture
      // is structurally `undefined` in every real boot.
      decisionsFor: recallDecisionsFor(ctx),
    })
    // Lifecycle: the plugin context owns the listeners, and an agent's own
    // disposal drops its per-agent recall state (shown/completed/running).
    ctx.effect(() => () => recall.dispose())
    ctx.on('agent/disposed', ({ agent }) => recall.release(agent))
  }
}
