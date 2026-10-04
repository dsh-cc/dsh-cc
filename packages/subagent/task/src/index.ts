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
import { PluginAgentIndex } from './plugin-agents.ts'
import { registerTaskTool } from './tool.ts'
import { registerReleaseAgentTool } from './release-agent.ts'
import { mountSettledNoticeSuppression } from './suppress-settled.ts'
import { mountAgentCatalog } from './catalog.ts'
import { createOneShotLedger } from './one-shot-ledger.ts'
import { mountSubagentChildNotice } from './one-shot-notice.ts'
import { mountStripWorkspaceInstructions } from './strip-instructions.ts'
import { mountActorContractGate } from './actor-contract-gate.ts'
import { armGraceFromPin, mountGraceWindow } from './grace-window.ts'
import { mountGraceSettledNotice } from './grace-settled-notice.ts'
import {
  isTombstoned,
  tombstoneReadyRow,
  clearTombstone,
  isReleased,
  isReleasing,
} from '@dsh-cc/command-agents/release'
import type { ResumePin } from '@dsh-cc/subagent-resume-pins'

export { AgentRegistry } from './registry.ts'
export { PluginAgentIndex } from './plugin-agents.ts'
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
export { createOneShotLedger, DEFAULT_ACTIVE_TTL_MS, DEFAULT_ENDED_TTL_MS, INTERNAL_LABELS } from './one-shot-ledger.ts'
export type { OneShotLedgerRow } from './one-shot-ledger.ts'
export { mountSubagentChildNotice, foldChildNotice, CHILD_NOTICE_SOURCE_KIND } from './one-shot-notice.ts'
export {
  armEphemeralTtl,
  EPHEMERAL_TTL_MS_DEFAULT,
  EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS,
  EPHEMERAL_TTL_TIMEOUT_STOP_REASON,
  EPHEMERAL_TTL_KILL_COPY,
} from './ephemeral-reaper.ts'
export type { EphemeralReaperLedger, EphemeralTtlDeps } from './ephemeral-reaper.ts'
export {
  armGraceFromPin,
  armGraceWindow,
  cancelPendingGrace,
  graceEntryOf,
  graceWindowClause,
  graceWindowFromPin,
  promoteGraceTier,
  recordGraceEntry,
  resolveGraceWindowMs,
  resetGraceWindow,
  isGraceRecorded,
  pendingGraceTimers,
  mountGraceWindow,
  FOREGROUND_AUTO_RELEASE_MS,
  BACKGROUND_AUTO_RELEASE_MS,
} from './grace-window.ts'
export type { DispatchTier, GraceArmEntry } from './grace-window.ts'
export { mountGraceSettledNotice } from './grace-settled-notice.ts'

/**
 * One-shot subagent visibility (memory-recall hardening follow-ups W2a/c):
 * the shared `subagent/start`/`subagent/end` ledger plus the parent-scoped
 * `agent/pre-step` notice, mounted on ONE context. Safe on a context without
 * an `agents` service — parentage then stays unresolvable and nothing is
 * ever injected.
 * @param ctx - the plug context.
 * @returns an unmount callback.
 */
export function mountOneShotVisibility(ctx: Context, ledger?: ReturnType<typeof createOneShotLedger>): () => void {
  const agents = ctx.get('agents') as import('./one-shot-ledger.ts').OneShotLedgerDeps['agents']
  const owned = ledger ?? createOneShotLedger({ bus: ctx, agents })
  const offNotice = mountSubagentChildNotice(ctx, owned)
  return () => {
    owned.dispose()
    offNotice()
  }
}

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
  '- When you delegate: one task, one instance. A new task is always a fresh `subagent_fork`',
  '  spawn call (a plain spawn — never the `fork` subagent_type, which inherits your context),',
  '  even when an idle child of the same type is listed. `send_message` continues the target\'s',
  '  current assignment only; the child resumes inside its full prior conversation with its',
  '  original definition snapshot, so never use it to hand an agent you started a new task.',
  '  (A child reporting its own result to its parent via `send_message` is always fine.)',
  '- Control the child by that id: `list_agents` for status, `send_message` to continue its current',
  '  assignment (only the agent that started the child may continue it), `interrupt_agent` to',
  '  stop its current turn.',
  '- A foreground wait may be user-promoted (Ctrl+B) to background while it runs: if a tool result',
  '  carries `status: \'async_launched\'` with `backgroundedByUser: true`, treat it exactly like a',
  '  background launch — the result arrives as a later wake; do not poll.',
  '- `subagent_type: "fork"` cannot run in the background (upstream harness issue #2124); use a',
  '  plain background spawn instead.',
  '- Exiting your session drains every background child\'s in-flight turn (whole-forest teardown); its persisted session survives on disk — a child that settled on its own stays cold-resumable, but a DRAINED child does not resume on the next send_message (known upstream gap; cross-session resume after a drain is unverified).',
  '- A background child holds one of 25 live-child capacity slots while it is running; settled children free theirs automatically. A settled child auto-releases after its inactivity grace window (foreground deliveries 30 minutes, background 2 hours; a definition\'s `autoReleaseMs` frontmatter overrides this, `0` disables) — after expiry its send_message is refused, so send_message promptly if you plan to continue it. release_agent <id> remains the interactive override for a RUNNING child: it evicts the resident activation (and resident descendants\') one-way — same-session continuation is unavailable after release; its persisted session survives; eviction is cooperative — a cancel-resistant turn keeps its slot until it settles.',
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
  // One PluginAgentIndex serves both dispatch and catalog; it reads the seam
  // lazily on every call so effect-scoped plugin mounts after apply() are seen.
  const pluginIndex = new PluginAgentIndex(ctx)
  // One ledger instance is shared: the §3.4 TTL reaper (kill log) and the
  // one-shot visibility mount read the same runId-keyed rows.
  const agents = ctx.get('agents') as import('./one-shot-ledger.ts').OneShotLedgerDeps['agents']
  const ledger = createOneShotLedger({ bus: ctx, agents })
  registerTaskTool(ctx, registry, capture, pluginIndex, ledger)
  registerReleaseAgentTool(ctx)
  mountActorContractGate(ctx)
  mountAgentCatalog(ctx, registry, pluginIndex)
  mountBackgroundSection(ctx)
  mountStripWorkspaceInstructions(ctx)
  mountSettledNoticeSuppression(ctx)
  mountGraceSettledNotice(ctx)
  mountOneShotVisibility(ctx, ledger)
  mountGraceWindowAutoRelease(ctx, capture)
  publishCollectorRegistry(ctx)
  publishOneShotLedger(ctx, ledger)
  publishReleaseMarkers(ctx)
}

/**
 * R8/R9: mount the grace-window listeners (fire dependencies: the live agents
 * registry for the fire-time liveness recheck, the release-module tombstone
 * ops, the ctx logger) and derive resume arming from the pin store — a ready
 * row is armed on resume IFF its resume pin exists and is readable (missing/
 * unreadable → left alone, fail-safe toward retention). The arm-registry is
 * process-local and empty before this; the window runs from resume load time
 * (documented). No cross-session cleanup: process exit fires nothing.
 * @param ctx - the plug context.
 * @param capture - the spawn pin capture (its store may be undefined).
 */
function mountGraceWindowAutoRelease(ctx: Context, capture: SpawnPinCapture | undefined): void {
  const off = mountGraceWindow(ctx as never, {
    agents: ctx.get('agents') as { get(id: string): { status?: string } | undefined } | undefined,
    tombstone: childId => {
      tombstoneReadyRow(childId)
    },
    clearTombstone: childId => {
      clearTombstone(childId)
    },
    warn: message => ctx.logger?.warn?.(message),
  })
  ctx.effect(() => off, 'cc-subagent-task: grace-window lifecycle listeners')
  // Resume arming (§3.8/§3.9): precedence pin.autoReleaseMs !== undefined →
  // that value; else pin.dispatchTier === 'foreground' → 30m; else 2h (legacy
  // pins, both fields absent, read tier-indistinguishable → 2h fail-safe).
  const store = capture?.store
  if (store === undefined) return
  for (const childId of store.ids()) {
    const pin = store.read(childId)
    if (pin === undefined || 'kind' in pin) continue // missing/corrupt → leave alone
    const live = pin as ResumePin
    if (live.mode !== 'continuable-background') continue
    if (live.resume?.state !== 'ok') continue
    // Pin-eligible ready row: armed from resume load time (documented).
    armGraceFromPin({
      childId,
      parentSessionId: live.parentSessionId,
      dispatchTier: live.dispatchTier,
      autoReleaseMs: live.autoReleaseMs,
    })
  }
}

/**
 * Publish the process-local release markers as the ROOT-realm
 * `ccReleaseMarkers` service so the resume-pins plugin's send_message
 * pre-execute gate (a sibling that cannot import command-agents) reads the
 * SAME tombstone state the grace window writes. CcPlugins pattern.
 * @param ctx - the plug context.
 */
function publishReleaseMarkers(ctx: Context): void {
  const root = ctx.root as unknown as {
    get(key: string, optional?: boolean): unknown
    provide(key: string, value: unknown): void
    set(key: string, value: unknown): void
  }
  const markers = { isTombstoned, isReleased, isReleasing }
  if (root.get('ccReleaseMarkers', false) === undefined) {
    root.provide('ccReleaseMarkers', markers)
  } else {
    root.set('ccReleaseMarkers', markers)
  }
  ctx.effect(() => () => {
    if (root.get('ccReleaseMarkers', false) === markers) root.set('ccReleaseMarkers', undefined)
  }, 'cc-subagent-task: clear host-realm ccReleaseMarkers publication on unload')
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

/**
 * Publish the shared one-shot ledger as the ROOT-realm `ccOneShotLedger`
 * service so sibling plugins (the `/resume` filter) can ask which sessions
 * are ephemeral one-shot children without a package dependency. CcPlugins
 * pattern, mirroring {@link publishCollectorRegistry}.
 * @param ctx - the plug context.
 * @param ledger - the shared runId-keyed ledger.
 */
function publishOneShotLedger(ctx: Context, ledger: ReturnType<typeof createOneShotLedger>): void {
  const root = ctx.root as unknown as {
    get(key: string, optional?: boolean): unknown
    provide(key: string, value: unknown): void
    set(key: string, value: unknown): void
  }
  const ledgerService = {
    /** Child session ids whose latest ledger row reads mode `one-shot`. */
    oneShotChildIds(): ReadonlySet<string> {
      return new Set(ledger.rows().filter(row => row.mode === 'one-shot').map(row => row.id))
    },
  }
  if (root.get('ccOneShotLedger', false) === undefined) {
    root.provide('ccOneShotLedger', ledgerService)
  } else {
    root.set('ccOneShotLedger', ledgerService)
  }
  ctx.effect(() => () => {
    if (root.get('ccOneShotLedger', false) === ledgerService) root.set('ccOneShotLedger', undefined)
  }, 'cc-subagent-task: clear host-realm ccOneShotLedger publication on unload')
}
