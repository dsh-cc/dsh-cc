/**
 * Dynamic recall: an `agent/pre-step` listener that selects relevant memory and
 * injects the selected bodies through `agent.inject()`. Topic files already
 * delivered this session are never re-injected. Recall runs for top-level agents
 * only — a forked child (including the legacy selector itself) never recalls, so
 * no chain of memory-recall subagents can form. Best-effort: absence of the
 * subagent service or provider skips recall without error.
 *
 * Three dispatch modes (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Failure table and mode
 * switching"):
 * - `off` (default): the legacy generative selector (its query is the genuine
 *   user text only — see `genuineUserQuery`; before the 2026-11-10 fix it also
 *   carried harness notice text the retired denylist never excluded).
 * - `shadow`: that legacy baseline PLUS a SystemOne comparison which is recorded
 *   and never injected.
 * - `active`: `RecallCoordinator` (SystemOne `noul` questions, legacy fallback).
 * The DeliveredRecallPaths mirror records what was actually injected in every
 * mode, so a mode switch never delivers the same memory twice.
 * @module @dsh-cc/memory/recall
 */

import { resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scanMemoryDirectory } from './scan.ts'
import { cwdOf, resolveWorkspaceMemoryDir } from './paths.ts'
import { RecallCoordinator } from './recall-coordinator.ts'
import type { RecallDecisionBinding } from './recall-coordinator-support.ts'
import { DEFAULT_RECALL_DECISION_SETTINGS } from './recall-decision-settings.ts'
import type { RecallDecisionMode, RecallDecisionSettings } from './recall-decision-settings.ts'
import { compareShadowRecall } from './recall-shadow.ts'
import type { RecallShadowRecord } from './recall-shadow.ts'
import { genuineUserQuery } from './recall-query.ts'
import type { RecallMessageLike } from './recall-query.ts'
import { SubagentMemorySelector } from './recall-selector.ts'
import type { MemorySelector } from './recall-selector.ts'

// The injected-source inventory is defined once in `./recall-query.ts`; it is
// no longer the genuine test for recall (the structural allowlist is) but is
// re-exported here because other packages pin its contents against this anchor.
export { INJECTED_SOURCE_DENYLIST } from './recall-query.ts'
export { MAX_RECALL_MEMORIES, RECALL_FILES_SCHEMA, SubagentMemorySelector } from './recall-selector.ts'
export type { MemorySelector, RecallCandidate } from './recall-selector.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    memory: { kind: 'memory' }
  }
}

// The canonical `tools/post-execute` waterfall signature comes from
// @dsh-cc/tools (a real dependency since save.ts); memory only observes
// tool usage for recall suppression and delegates to `next()` unchanged.

/** Warn-once-per-process flag for the late-idle drop (boxed so it can flip). */
const lateIdleInjectFlag = { done: false }

/** Log through the host logger when available, else the console; at most once. */
function warnOnce(flag: { done: boolean }, ctx: Context, message: string): void {
  if (flag.done) return
  flag.done = true
  const logger = (ctx as { logger?: { warn?: (format: string) => void } }).logger
  if (typeof logger?.warn === 'function') logger.warn(message)
  else console.warn(message)
}

/** The per-agent recall coordinator. Holds the shown-path set per agent. */
export class MemoryRecall {
  private readonly state = new WeakMap<Agent, { shown: Set<string>; inFlight: boolean; lastQuery: string }>()
  private readonly providerName: string
  private readonly createSelector: (ctx: Context, agent: Agent) => MemorySelector
  /**
   * Paths actually injected successfully this session, per agent, in EVERY mode
   * (design §"Failure table and mode switching"). This mirror — never a
   * historically mis-marked `shown` set — is the cross-mode seed for `active`'s
   * initial shown and for the legacy branch's shown set.
   */
  private readonly delivered = new WeakMap<Agent, Set<string>>()
  /**
   * Recently used tool names, per agent. A call made on behalf of another agent
   * (a subagent, a workflow worker) must not make the current agent's selector
   * suppress reference docs it never used; calls the host did not attribute keep
   * the historical host-wide set.
   */
  private readonly tools = new WeakMap<Agent, Set<string>>()
  private readonly unattributedTools = new Set<string>()
  private readonly readSettings: () => RecallDecisionSettings
  private readonly decisionsFor: ((agent: Agent) => RecallDecisionBinding | undefined) | undefined
  private readonly disposers: Array<() => void> = []
  private coordinator: RecallCoordinator | undefined
  private lastMode: RecallDecisionMode = 'off'

  /**
   * Register the `agent/pre-step` and `tools/post-execute` listeners.
   * @param ctx - host context with `fs`, `subagents`, and the agent channel.
   * @param home - the memory home: the global directory and the root under
   *   which each agent's workspace directory (`projects/<slug>`) is resolved.
   * @param options - provider name, whether recall is enabled, an optional
   *   selector factory (defaults to {@link SubagentMemorySelector}; inject a fake
   *   for deterministic tests), the SystemOne settings reader and the optional
   *   decision binding. Without them the mode stays `off` and the legacy branch
   *   runs exactly as before.
   */
  constructor(
    private readonly ctx: Context,
    private readonly home: string,
    options: {
      providerName?: string
      enabled?: boolean
      createSelector?: (ctx: Context, agent: Agent) => MemorySelector
      /** Live SystemOne settings snapshot; absent keeps the mode at `off`. */
      readSettings?: () => RecallDecisionSettings
      /** Bind the optional decision runner; absent degrades `active` to legacy. */
      decisionsFor?: (agent: Agent) => RecallDecisionBinding | undefined
    } = {},
  ) {
    this.providerName = options.providerName ?? 'fork'
    this.createSelector = options.createSelector
      ?? ((ctx, agent) => new SubagentMemorySelector(ctx, agent, this.providerName))
    this.readSettings = options.readSettings ?? (() => DEFAULT_RECALL_DECISION_SETTINGS)
    this.decisionsFor = options.decisionsFor
    if (options.enabled ?? true) {
      this.disposers.push(
        this.ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next)),
      )
    }
    // Track tools used this session so recall can suppress reference-doc
    // memories for the tools the agent is already exercising. This is a
    // waterfall observer: it must delegate to `next()` so the tools pipeline
    // continues unchanged. Attribution is per `exec.agent`.
    this.disposers.push(
      this.ctx.on('tools/post-execute', (exec, _result, next) => {
        if (exec.name.length > 0) this.recordTool(exec.agent, exec.name)
        return next()
      }),
    )
  }

  /** Remove both the pre-step and post-execute listeners. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.unattributedTools.clear()
    this.coordinator?.dispose()
  }

  /**
   * Drop one agent's per-agent state (Agent dispose). Paths are forgotten, so a
   * later agent object never inherits another agent's recall history.
   * @param agent - the disposed agent.
   */
  release(agent: Agent): void {
    this.state.delete(agent)
    this.delivered.delete(agent)
    this.tools.delete(agent)
    this.coordinator?.release(agent)
  }

  /**
   * Seed the delivered-path mirror for one agent. Only canonical full paths that
   * were actually delivered may enter: the mirror is what stops a mode switch
   * from injecting the same memory twice (design §"Failure table and mode
   * switching"). Non-absolute, empty and duplicate entries are ignored.
   * @param agent - the agent whose deliveries are being reported.
   * @param paths - canonical absolute paths of injected memory files.
   */
  seedShown(agent: Agent, paths: readonly string[]): void {
    const delivered = this.deliveredFor(agent)
    for (const path of paths) {
      if (typeof path !== 'string' || !path.startsWith('/')) continue
      delivered.add(resolvePath(path))
    }
  }

  /** The delivered-path mirror of one agent (live read-only view). */
  private deliveredFor(agent: Agent): Set<string> {
    let delivered = this.delivered.get(agent)
    if (delivered === undefined) {
      delivered = new Set()
      this.delivered.set(agent, delivered)
    }
    return delivered
  }

  /** Record one tool call for the agent it ran on behalf of. */
  private recordTool(agent: Agent | undefined, name: string): void {
    if (agent === undefined) {
      this.unattributedTools.add(name)
      return
    }
    let tools = this.tools.get(agent)
    if (tools === undefined) {
      tools = new Set()
      this.tools.set(agent, tools)
    }
    tools.add(name)
  }

  /** The tool names visible to one agent: its own, plus unattributed calls. */
  private toolsFor(agent: Agent): readonly string[] {
    const own = this.tools.get(agent)
    if (this.unattributedTools.size === 0) return own === undefined ? [] : [...own]
    return [...new Set([...this.unattributedTools, ...(own ?? [])])]
  }

  /** Mark paths as actually delivered: the mirror and both modes' shown sets. */
  private recordDelivered(agent: Agent, paths: readonly string[]): void {
    if (paths.length === 0) return
    const delivered = this.deliveredFor(agent)
    const legacy = this.state.get(agent)
    for (const path of paths) {
      delivered.add(path)
      legacy?.shown.add(path)
    }
  }

  /** The current dispatch mode; a broken settings layer degrades to `off`. */
  private mode(): RecallDecisionMode {
    try {
      return this.readSettings().mode
    } catch {
      return 'off'
    }
  }

  /** The lazily created active coordinator (also hosts the shadow sidecar). */
  private coordinatorFor(): RecallCoordinator {
    this.coordinator ??= new RecallCoordinator(this.ctx, {
      home: this.home,
      readSettings: this.readSettings,
      decisionsFor: agent => this.decisionsFor?.(agent),
      createSelector: (c, agent) => this.createSelector(c, agent),
      delivered: agent => this.deliveredFor(agent),
      recordDelivered: (agent, paths) => this.recordDelivered(agent, paths),
      recentTools: agent => this.toolsFor(agent),
    })
    return this.coordinator
  }

  private async onPreStep(
    {
      agent,
      messages,
      signal,
    }: {
      agent: Agent
      messages: ReadonlyArray<{ content: readonly { type: string; text?: string }[]; source?: { kind?: string } }>
      signal: AbortSignal
    },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    // Recall enriches top-level agents only. Every agent runs this same
    // waterfall — including the forked memory-recall selector itself — so
    // recalling inside a subagent would spawn another selector whose own
    // pre-step recalls again: an unbounded chain of memory-recall subagents.
    const header = agent.session.header
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return decision
    // Fire-and-forget: recall is model-visible enrichment, never worth an
    // unhandled rejection in the host — any fault inside skips quietly.
    void this.maybeRecall(agent, messages, signal, this.createSelector(this.ctx, agent))
      .catch(() => {})
    return decision
  }

  /**
   * Dispatch one pre-step by the configured mode (design §"Failure table and
   * mode switching"): `off` runs the legacy branch exactly as before, `shadow`
   * runs the legacy branch AND a comparison sidecar, `active` hands the turn to
   * the SystemOne coordinator.
   */
  private async maybeRecall(
    agent: Agent,
    messages: readonly RecallMessageLike[],
    signal: AbortSignal,
    selector: MemorySelector,
  ): Promise<void> {
    const mode = this.mode()
    const previous = this.lastMode
    this.lastMode = mode
    // Leaving `active`: cancel the new controller and clear its completed set
    // BEFORE the legacy branch takes over, so no stale decision injects later.
    if (previous === 'active' && mode !== 'active') this.coordinator?.cancel(agent)
    if (mode === 'active') {
      this.coordinatorFor().run(agent, messages, signal)
      return
    }
    if (mode === 'shadow') this.runShadow(agent, messages, signal)
    await this.legacyRecall(agent, messages, signal, selector)
  }

  /**
   * The `shadow` sidecar: the decision runs for comparison only and NEVER
   * injects. The record is a fixed-enum shape — no query, filename, path or
   * content — and an unavailable decision reports its reason instead of a
   * fabricated comparison.
   */
  private runShadow(agent: Agent, messages: readonly RecallMessageLike[], signal: AbortSignal): void {
    const fileSystem = this.ctx.get('fs')
    if (fileSystem === undefined) return
    let memoryDir: string
    try {
      memoryDir = resolveWorkspaceMemoryDir(this.home, cwdOf(agent))
    } catch {
      return
    }
    void compareShadowRecall(fileSystem, memoryDir, {
      home: this.home,
      readSettings: this.readSettings,
      decisionsFor: target => this.decisionsFor?.(target),
      delivered: target => this.deliveredFor(target),
      recentTools: target => this.toolsFor(target),
      shown: target => this.coordinator?.shownOf(target),
      report: record => this.reportShadow(record),
    }, agent, messages, signal).catch(() => {})
  }

  /** Emit one shadow record through the host logger (never the console). */
  private reportShadow(record: RecallShadowRecord): void {
    const logger = (this.ctx as { logger?: { info?: (format: string) => void } }).logger
    if (typeof logger?.info !== 'function') return
    logger.info(`memory-recall shadow ${JSON.stringify(record)}`)
  }

  /** The legacy generative-selection branch (the baseline of `off` and `shadow`). */
  private async legacyRecall(
    agent: Agent,
    messages: readonly RecallMessageLike[],
    signal: AbortSignal,
    selector: MemorySelector,
  ): Promise<void> {
    const fileSystem = this.ctx.get('fs')
    if (fileSystem === undefined) return
    // Build the query ONLY from genuine user input: the structural allowlist
    // in `genuineUserQuery` (source absent or kind 'user') excludes every
    // injected message — harness notices, memory bodies, subagent-child
    // notices — so a query built from injected text cannot re-trigger recall.
    // Since the 2026-11-10 origin fix this also excludes injected notices the
    // retired denylist never carried (cc-shell-glue, moa, …).
    const query = genuineUserQuery(messages)
    if (query.length === 0) return
    // Recall spans both layers: the agent's workspace directory and the
    // global directory. Shown-tracking keys on full paths, so identical
    // filenames across layers never collide.
    const workspaceDir = resolveWorkspaceMemoryDir(this.home, cwdOf(agent))
    const [workspaceScan, globalScan] = await Promise.all([
      scanMemoryDirectory(fileSystem, workspaceDir, signal),
      scanMemoryDirectory(fileSystem, this.home, signal),
    ])
    const topics = [...workspaceScan.topics, ...globalScan.topics]
    if (topics.length === 0) return
    let entry = this.state.get(agent)
    if (entry === undefined) {
      // The cross-mode seed: paths another mode (or seedShown) actually
      // delivered are shown here too, so a mode switch never re-injects them.
      entry = { shown: new Set(this.deliveredFor(agent)), inFlight: false, lastQuery: '' }
      this.state.set(agent, entry)
    }
    for (const path of this.deliveredFor(agent)) entry.shown.add(path)
    // Per-agent query dedupe: the identical pending text re-presented (e.g.
    // the same turn context claimed again) must not spawn another selector.
    if (entry.lastQuery === query) return
    entry.lastQuery = query
    const fresh = topics.filter(topic => !entry.shown.has(topic.path))
    if (fresh.length === 0) return
    // Pre-step fires once per step while a turn runs; a pending selection must
    // not pile up overlapping selectors for the same agent.
    if (entry.inFlight) return
    entry.inFlight = true
    try {
      const selected = await selector.select(
        query,
        fresh.map(topic => ({ path: topic.path, filename: topic.filename, description: topic.frontmatter.description })),
        signal,
        this.toolsFor(agent),
      )
      if (signal.aborted || selected.length === 0) return
      // Late-inject idle guard: a selection that settles after turn end is
      // stale enrichment for a turn that no longer exists. Harness inject is
      // a durable next-step splice for top-level agents — at idle it would
      // strand in the inbox and contaminate whichever turn comes next. Drop
      // BEFORE the shown-marking loop: marking here would permanently
      // suppress these topics (the next turn's fresh filter excludes them).
      if (agent.status === 'idle') {
        warnOnce(lateIdleInjectFlag, this.ctx,
          'memory-recall: selector settled after the turn ended; dropping recall to avoid stranding an inject in the inbox')
        return
      }
      const byFilename = new Map(topics.map(topic => [topic.filename, topic]))
      const bodies: string[] = []
      // Paths whose non-empty body is about to be injected: the mirror records
      // exactly these once the injection succeeded (never an undelivered one).
      const deliveredPaths: string[] = []
      for (const filename of selected) {
        const topic = byFilename.get(filename)
        if (topic === undefined) continue
        entry.shown.add(topic.path)
        const raw = await readOptionalText(fileSystem, topic.path, signal)
        if (raw !== undefined && raw.trim().length > 0) {
          bodies.push(`## Memory: ${topic.frontmatter.name}\n\n${raw.trim()}`)
          deliveredPaths.push(topic.path)
        }
      }
      signal.throwIfAborted()
      if (bodies.length === 0) return
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: bodies.join('\n\n') }],
        source: { kind: 'memory' },
      }))
      this.recordDelivered(agent, deliveredPaths)
    } finally {
      entry.inFlight = false
    }
  }
}

async function readOptionalText(fs: FileSystem, path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const target = signal !== undefined
      ? await fs.resolve(path, { signal })
      : await fs.resolve(path)
    return await fs.readText(target, signal)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && ((error as { code?: string }).code === 'FS_NOT_FOUND'
        || (error as { code?: string }).code === 'ENOENT')) return undefined
    throw error
  }
}
