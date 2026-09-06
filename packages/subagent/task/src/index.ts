/**
 * Claude Code-compatible Task tool and per-workspace subagent catalog for the
 * DeepSeek Harness. Mounts:
 * - the `subagent_fork` tool (CC display name `Task`) with `subagent_type`
 *   dispatch over the session workspace's `.claude/agents` definitions;
 * - the `Available subagents` system-prompt section rendered per workspace;
 * - the reserved tool names that keep disabled harness rows restrictable;
 * - a pre-step strip listener that removes the harness `agent-instructions`
 *   workspace baseline from delegated children so each child keeps its own
 *   persona instead of also loading the parent's CLAUDE.md / AGENTS.md.
 *
 * The `ccModelRoutes` service (from `@dsh-cc/model-aliases`) supplies
 * the spawn-time alias resolver; when absent, every child inherits its
 * parent's route (the builtin fallback).
 *
 * @module @dsh-cc/subagent-task
 */

import type { Context } from '@deepseek-ai/cordis'
import { PinStore } from '@dsh-cc/subagent-resume-pins'
import {
  collectorFor,
  collectorsForSession,
  registeredCollectorCount,
} from './epoch-collector.ts'
import { SpawnPinCapture, type ResumePinsConfig } from './resume-capture.ts'
import { AgentRegistry } from './registry.ts'
import { registerTaskTool } from './tool.ts'
import { mountSettledNoticeSuppression } from './suppress-settled.ts'
import { mountAgentCatalog } from './catalog.ts'
import { mountStripWorkspaceInstructions } from './strip-instructions.ts'

export { AgentRegistry } from './registry.ts'
export {
  registerTaskTool,
  TASK_TOOL,
  MAX_LIVE_CONTINUABLE_CHILDREN,
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
  backgroundTasksDisabled,
} from './tool.ts'
export {
  collectFirstEpoch,
  collectorFor,
  collectorKey,
  registerCollector,
  unregisterCollector,
  collectorsForSession,
  registeredCollectorCount,
  markCollectedForSuppression,
  releaseCollectedForSuppression,
  isCollectedForSuppression,
} from './epoch-collector.ts'
export type {
  CollectorRegistration,
  EpochOutcome,
  EpochTerminal,
} from './epoch-collector.ts'
export { mountAgentCatalog } from './catalog.ts'
export {
  mountStripWorkspaceInstructions,
  isDelegated,
  isAgentInstructions,
} from './strip-instructions.ts'
export {
  isSubagentSettledNotice,
  mountSettledNoticeSuppression,
} from './suppress-settled.ts'
export type { ResumePinsConfig, CaptureInput } from './resume-capture.ts'
export { SpawnPinCapture, overlayRoute, probeWorkspace } from './resume-capture.ts'

/** Cordis plugin id. */
export const name = 'cc-subagent-task'

/** Section name for the background-subagent contract. */
export const BACKGROUND_SECTION_NAME = 'cc:subagent-background'

/** Order slot beside the catalog section (tool guidance owns 100–199). */
const BACKGROUND_SECTION_ORDER = 112

export const BACKGROUND_SECTION_TEXT = [
  '## Background subagents',
  '',
  '- Heuristic: if this turn\'s answer to the human depends on the child, omit `run_in_background`',
  '  (foreground — the call waits for the final text). If the human can keep talking while the',
  '  child works, pass `run_in_background: true`: the call returns promptly with a durable',
  '  `agentId` once the child accepts its first turn. Synthesize on the wake; do not poll.',
  '- A definition with `background: true` backgrounds on omit: the call returns',
  '  `{ status: \'async_launched\' }` immediately and the real result arrives later as a wake',
  '  message — there is NO inline result to use, so never compose on one. Pass',
  '  `run_in_background: false` when this turn needs that child\'s result: it forces',
  '  synchronous collection. Explicit true/false always win over the pin.',
  '- A background child\'s report — or its finish notice when it ends without reporting — arrives',
  '  as a waking message; do not poll.',
  '- Control the child by that id: `list_agents` for status, `send_message` to continue the same',
  '  conversation (only the agent that started the child may continue it), `interrupt_agent` to',
  '  stop its current turn.',
  '- A foreground wait may be user-promoted (Ctrl+B) to background while it runs: if a tool result',
  '  carries `status: \'async_launched\'` with `backgroundedByUser: true`, treat it exactly like a',
  '  background launch — the result arrives as a later wake; do not poll.',
  '- `subagent_type: "fork"` cannot run in the background (upstream harness issue #2124); use a',
  '  plain background spawn instead.',
  '- Exiting your session drains a background child\'s in-flight turn; its persisted session',
  '  survives and cold-resumes on the next `send_message`.',
].join('\n')

/**
 * Register the static background-loop system-prompt section (same contract the
 * Task tool description teaches, stated once so it survives description
 * trimming). No-op when the system-prompt seam is absent.
 * @param ctx - the plug context.
 * @returns the section disposer, or undefined when the seam is absent.
 */
export function mountBackgroundSection(ctx: Context): (() => void) | undefined {
  const seam = ctx.get('systemPrompt') as {
    section(def: { name: string; order: number; text: string }): () => void
  } | undefined
  if (seam === undefined) return undefined
  return seam.section({
    name: BACKGROUND_SECTION_NAME,
    order: BACKGROUND_SECTION_ORDER,
    text: BACKGROUND_SECTION_TEXT,
  })
}

/** Plugin configuration. */
export interface TaskPluginConfig {
  /**
   * Spawn-time resume-pin capture (plan §4.3/§4.5) for continuable background
   * children. Absent (default) → zero behavior change: no pin writes, no
   * preflight, identical spawns.
   */
  readonly resumePins?: ResumePinsConfig
}

/**
 * Mount the Task tool, the agents catalog, and the workspace-instruction
 * strip. Safe when either the tools or the system-prompt seam is absent
 * (the corresponding mount skips); the pre-step listener only needs
 * `ctx.on`, so it mounts regardless.
 * @param ctx - the plug context.
 * @param config - plugin configuration; omitted `resumePins` still arms capture
 * when the resume-pins plugin's `resumePinStore` service is mounted (plan
 * §4.10); with neither, capture is disabled.
 */
export function apply(ctx: Context, config: TaskPluginConfig = {}): void {
  const registry = new AgentRegistry()
  const pins = config.resumePins
  // Durability ordering (plan §4.6): when the resume-pins plugin is mounted
  // its `resumePinStore` is THE store — gate, overlay, and capture must share
  // one cache. Capture only falls back to its own config store/pinsRoot when
  // no plugin-provided store exists (keeps the standalone config path working).
  const sharedStore = ctx.get('resumePinStore') as PinStore | undefined
  // Production wiring (plan §4.10): the preset mounts the resume-pins plugin
  // ahead of this row, so its service store arms capture with NO extra Task
  // config. Explicit `resumePins` config still wins for standalone consumers.
  const capture =
    pins === undefined
      ? sharedStore !== undefined
        ? new SpawnPinCapture(ctx, sharedStore)
        : undefined
      : new SpawnPinCapture(ctx, sharedStore ?? pins.store ?? new PinStore(pins.pinsRoot))
  registerTaskTool(ctx, registry, capture)
  mountAgentCatalog(ctx, registry)
  mountBackgroundSection(ctx)
  mountStripWorkspaceInstructions(ctx)
  mountSettledNoticeSuppression(ctx)
  publishCollectorRegistry(ctx)
}

/**
 * Publish the Slice 3 promotion registry (collector doc §6) as the ROOT-realm
 * `ccCollectorRegistry` service so the TUI busy-branch — a host-plane sibling
 * that cannot resolve realm-interior mounts — queries the SAME live
 * registration map the Task tool's collect path populates. Mirrors the
 * command-agents `ccAgents` publication (CcPlugins pattern): first
 * publication provides the name; a reclaim after an unload takes the slot
 * back via `set`; the unload effect clears it so the TUI degrades to
 * "nothing promotable" instead of holding a dead registry.
 * @param ctx - the plug context.
 */
function publishCollectorRegistry(ctx: Context): void {
  const root = ctx.root as unknown as {
    get(key: string, optional?: boolean): unknown
    provide(key: string, value: unknown): void
    set(key: string, value: unknown): void
  }
  const registryService = {
    collectorFor,
    collectorsForSession,
    registeredCollectorCount,
  }
  if (root.get('ccCollectorRegistry', false) === undefined) {
    root.provide('ccCollectorRegistry', registryService)
  } else {
    root.set('ccCollectorRegistry', registryService)
  }
  ctx.effect(() => () => {
    if (root.get('ccCollectorRegistry', false) === registryService) root.set('ccCollectorRegistry', undefined)
  }, 'cc-subagent-task: clear host-realm ccCollectorRegistry publication on unload')
}
