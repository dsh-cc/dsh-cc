/**
 * The active recall coordinator (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Query generations and
 * when shown takes effect", §"Failure table and mode switching").
 *
 * One coordinator serves every agent; all mutable state is per-Agent in a
 * WeakMap, identified by `scopeKey` (canonical memoryDir + sessionId — never the
 * decision budget's projectKey). The correctness-critical core is the
 * dispatch-key lifecycle, verified in `specs/tla/memory-recall-dispatch`:
 *
 * - `shown` and the delivered mirror are written ONLY after `agent.inject()`
 *   succeeded synchronously, and only for paths whose content was non-empty.
 * - a new ticket key increments the generation, replaces the single pending
 *   slot and aborts the running task; a superseded task's `finally` cleans only
 *   its own generation and starts at most one newest ticket.
 * - every terminal outcome of one dispatch key (empty selection, empty content,
 *   read failure, content-hash mismatch, thrown injection) marks that key
 *   terminal, so the same input is never paid for twice; a stale generation
 *   writes nothing at all.
 *
 * Privacy: the runner receives the query and candidate metadata only — never
 * file content, never an absolute path, never a content hash.
 *
 * @module @dsh-cc/memory/recall-coordinator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DECISION_LANE_ALIAS } from '@dsh-cc/systemone'
import type { DecisionRouteIdentity, DecisionScope } from '@dsh-cc/systemone'
import { cwdOf, resolveWorkspaceMemoryDir } from './paths.ts'
import type { MemorySelector } from './recall-selector.ts'
import { assignRecallTopicIds } from './recall-decision.ts'
import type { RecallDecisionInput } from './recall-decision.ts'
import { adaptLegacyRecallSelection, selectRecallWithFallback } from './recall-decision-runner.ts'
import type { RecallDecisionSettings } from './recall-decision-settings.ts'
import {
  recallDispatchKey,
  recallLocalKey,
  recallManifestHash,
  recallQueryHash,
  recallSettingsHash,
  recallToolsHash,
  sha256Hex,
} from './recall-dispatch-key.ts'
import { readOptionalText, scanRecallLayers, sessionIdOf, sortedTools } from './recall-coordinator-support.ts'
import type { RecallDecisionBinding } from './recall-coordinator-support.ts'
import { resolveRecallTurn } from './recall-query.ts'
import type { RecallMessageLike } from './recall-query.ts'

/** How many dispatch keys one session remembers (design: per-session LRU, cap 16). */
export const COMPLETED_KEY_CAP = 16

/** Per-Agent recall state (design code block, §"Query generations…"). */
export interface RecallState {
  /** Canonical `memoryDir + sessionId`; NOT the decision budget projectKey. */
  scopeKey: string
  generation: number
  /** Canonical full paths already delivered to the model this session. */
  shown: Set<string>
  /** Recently used tool names, per agent (never a plugin-level set). */
  recentTools: Set<string>
  /** The in-flight task, if any. Its `generation`/`key` name the slot's owner. */
  running?: { generation: number; key: string; controller: AbortController } | undefined
  /** The single pending ticket; newest wins. */
  pending?: RecallTicket | undefined
  /** Dispatch keys that reached a terminal state (per-session LRU, cap 16). */
  completed: Set<string>
}

/** One recall ticket: the local key, its origin and the generation it belongs to. */
export interface RecallTicket {
  /** Local key from `(memoryDir, sessionId, originSeq, queryHash)`. */
  key: string
  /** Seq of this turn's `turn/start` event; the decision scope origin (issue #359 redesign — a user-message seq is not persisted until after the pre-step waterfall). */
  originSeq: number
  /** The query text (host-side; never logged). */
  query: string
  /** The generation this ticket was issued under. */
  generation: number
}

/** Injected collaborators of {@link RecallCoordinator}. */
export interface RecallCoordinatorOptions {
  /** The memory home (the global layer root). */
  home: string
  /** Live SystemOne settings snapshot. */
  readSettings(): RecallDecisionSettings
  /** Bind the decision runner for one agent; absent degrades `active` to legacy. */
  decisionsFor(agent: Agent): RecallDecisionBinding | undefined
  /** The legacy selector used on a fallback. */
  createSelector(ctx: Context, agent: Agent): MemorySelector
  /** Paths actually delivered in ANY mode (the integration mirror). */
  delivered(agent: Agent): ReadonlySet<string>
  /** Record paths this coordinator just delivered (mirror + legacy shown). */
  recordDelivered(agent: Agent, paths: readonly string[]): void
  /** Recently used tool names for one agent. */
  recentTools(agent: Agent): readonly string[]
}

/** Warn-once-per-process flag for the late-idle drop (boxed so it can flip). */
const lateIdleFlag = { done: false }

/** Log through the host logger when available, else the console; at most once. */
function warnLateIdle(ctx: Context): void {
  if (lateIdleFlag.done) return
  lateIdleFlag.done = true
  const message = 'memory-recall: selection settled after the turn ended; dropping recall to avoid stranding an inject in the inbox'
  const logger = (ctx as { logger?: { warn?: (format: string) => void } }).logger
  if (typeof logger?.warn === 'function') logger.warn(message)
  else console.warn(message)
}

/**
 * The active-mode recall coordinator. Never injects anything a stale generation,
 * an idle agent or a failed checkpoint produced, and never records a path as
 * shown before its injection succeeded.
 */
export class RecallCoordinator {
  private readonly states = new WeakMap<Agent, RecallState>()
  /** Controllers of in-flight tasks; a plugin dispose aborts all of them. */
  private readonly running = new Set<AbortController>()
  private disposed = false

  /**
   * Create a coordinator.
   * @param ctx - host context carrying the `fs` seam.
   * @param options - settings, decision binding, legacy selector and the
   *   delivered-path mirror.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: RecallCoordinatorOptions,
  ) {}

  /**
   * Offer one pre-step's claimed batch to the coordinator.
   *
   * The ticket is obtained SYNCHRONOUSLY; scanning starts only after it exists.
   * A duplicate key that is already running or pending returns without a
   * request. A new key increments the generation, replaces pending and aborts the
   * running task — whose own `finally` then starts at most one newest ticket.
   * @param agent - the recalling agent.
   * @param messages - the claimed pre-step message batch.
   * @param signal - the pre-step's cancellation signal.
   */
  run(agent: Agent, messages: readonly RecallMessageLike[], signal: AbortSignal): void {
    if (this.disposed) return
    const state = this.stateFor(agent)
    const turn = resolveRecallTurn(agent, messages)
    // No genuine query (an injected-only batch) or no turn anchor in the log:
    // send no request and write no completed entry. There is no later
    // pre-step retry — later steps of the same turn claim nothing new — so a
    // turn that cannot resolve now simply does not dispatch this round.
    if (turn === undefined) return
    const key = recallLocalKey(
      this.memoryDirOf(agent),
      sessionIdOf(agent),
      turn.originSeq,
      recallQueryHash(turn.query),
    )
    if (state.pending?.key === key || state.running?.key === key) return
    state.generation += 1
    const ticket: RecallTicket = {
      key,
      originSeq: turn.originSeq,
      query: turn.query,
      generation: state.generation,
    }
    state.pending = ticket
    const superseded = state.running
    if (superseded !== undefined) {
      // Supersede: the old task's finally starts the newest pending ticket.
      superseded.controller.abort()
      return
    }
    this.start(agent, state, ticket, signal)
  }

  /**
   * Drop one agent's state: abort the in-flight task and forget the pending,
   * running and completed slots (Agent dispose, or leaving `active`).
   * @param agent - the agent whose state is dropped.
   */
  cancel(agent: Agent): void {
    const state = this.states.get(agent)
    if (state === undefined) return
    state.running?.controller.abort()
    state.running = undefined
    state.pending = undefined
    state.completed.clear()
  }

  /** Forget one agent entirely (Agent dispose). */
  release(agent: Agent): void {
    this.cancel(agent)
    this.states.delete(agent)
  }

  /** The agent's current shown set, when it has active-mode state. */
  shownOf(agent: Agent): ReadonlySet<string> | undefined {
    return this.states.get(agent)?.shown
  }

  /** Abort every in-flight task and drop all per-agent state (plugin dispose). */
  dispose(): void {
    this.disposed = true
    for (const controller of this.running) controller.abort()
    this.running.clear()
  }

  /** The per-agent state, recreated when the scope key moved (or absent). */
  private stateFor(agent: Agent): RecallState {
    const scopeKey = this.scopeKeyOf(agent)
    const existing = this.states.get(agent)
    if (existing !== undefined) {
      if (existing.scopeKey === scopeKey) return existing
      // A scope change invalidates every slot; shown re-seeds from the mirror.
      existing.running?.controller.abort()
      existing.running = undefined
      existing.pending = undefined
      existing.completed.clear()
    }
    const state: RecallState = {
      scopeKey,
      generation: 0,
      shown: new Set(this.options.delivered(agent)),
      recentTools: new Set(this.options.recentTools(agent)),
      completed: new Set(),
    }
    this.states.set(agent, state)
    return state
  }

  /** The canonical memory directory of one agent's workspace layer. */
  private memoryDirOf(agent: Agent): string {
    try {
      return resolveWorkspaceMemoryDir(this.options.home, cwdOf(agent))
    } catch {
      return this.options.home
    }
  }

  /** `canonical memoryDir + sessionId`: the state identity, never a budget key. */
  private scopeKeyOf(agent: Agent): string {
    return `${this.memoryDirOf(agent)}\u0000${sessionIdOf(agent)}`
  }

  /** Start one ticket as the sole in-flight task of its agent. */
  private start(agent: Agent, state: RecallState, ticket: RecallTicket, outerSignal?: AbortSignal): void {
    const controller = new AbortController()
    const slot = { generation: ticket.generation, key: ticket.key, controller }
    state.running = slot
    if (ticket.key === state.pending?.key) state.pending = undefined
    if (outerSignal !== undefined) {
      if (outerSignal.aborted) controller.abort()
      else outerSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    this.running.add(controller)
    void this.execute(agent, state, ticket, controller.signal)
      .catch(() => {
        // Recall is enrichment: a fault skips quietly, never an unhandled rejection.
      })
      .finally(() => {
        this.running.delete(controller)
        // A superseded task's finally cleans ONLY its own generation: the slot is
        // cleared by identity, so a newer task is never disowned.
        if (state.running === slot) state.running = undefined
        if (this.disposed) return
        const next = state.pending
        if (next !== undefined && state.generation === next.generation) this.start(agent, state, next)
      })
  }

  /**
   * Whether this ticket may still act: the generation, the per-agent state and
   * the scope key are unchanged, the task was not cancelled, and the agent is not
   * idle. A failed check writes no `shown` and no `completed`.
   */
  private isCurrent(agent: Agent, state: RecallState, ticket: RecallTicket, signal: AbortSignal): boolean {
    if (this.disposed || signal.aborted) return false
    if (state.generation !== ticket.generation) return false
    if (this.states.get(agent) !== state) return false
    if (this.scopeKeyOf(agent) !== state.scopeKey) return false
    return agent.status !== 'idle'
  }

  /** Record one dispatch key as terminal, keeping the per-session LRU bounded. */
  private markCompleted(state: RecallState, key: string): void {
    state.completed.delete(key)
    state.completed.add(key)
    while (state.completed.size > COMPLETED_KEY_CAP) {
      const oldest = state.completed.values().next().value
      if (oldest === undefined) return
      state.completed.delete(oldest)
    }
  }

  /** The one selection pipeline of a ticket: scan → complete the key → select → read → inject. */
  private async execute(agent: Agent, state: RecallState, ticket: RecallTicket, signal: AbortSignal): Promise<void> {
    if (!this.isCurrent(agent, state, ticket, signal)) return
    const fileSystem = this.ctx.get('fs')
    if (fileSystem === undefined) return
    const settings = this.options.readSettings()
    const seeds = await scanRecallLayers(fileSystem, this.memoryDirOf(agent), this.options.home, signal)
    // A checkpoint before reading content: everything below may inject.
    if (!this.isCurrent(agent, state, ticket, signal)) return
    // Shown is refreshed from the mirror on every read: a delivery made by
    // another mode (or a seedShown call) is never re-injected here.
    for (const path of this.options.delivered(agent)) state.shown.add(path)
    const topics = assignRecallTopicIds(seeds.filter(seed => !state.shown.has(seed.path)))
    const recentTools = sortedTools(this.options.recentTools(agent))
    state.recentTools = new Set(recentTools)
    // Only a COMPLETE dispatch key is checked against `completed`.
    const binding = this.options.decisionsFor(agent)
    const scope: DecisionScope | undefined = binding?.scope(ticket.originSeq)
    const identity: DecisionRouteIdentity | undefined = binding === undefined || scope === undefined
      ? undefined
      : binding.identifyRoute(DECISION_LANE_ALIAS, scope)
    const dispatchKey = recallDispatchKey({
      localKey: ticket.key,
      manifestHash: recallManifestHash(seeds),
      toolsHash: recallToolsHash(recentTools),
      route: identity,
      settingsHash: recallSettingsHash(settings),
    })
    if (state.completed.has(dispatchKey)) {
      // Re-touch: an LRU hit keeps this key alive for the next duplicate.
      this.markCompleted(state, dispatchKey)
      return
    }
    const input: RecallDecisionInput = { query: ticket.query, recentTools, topics }
    const legacy = this.options.createSelector(this.ctx, agent)
    // Without a bound scope nothing is dispatched: the legacy selection, adapted
    // exactly once over the complete pool, IS this round's fallback.
    const dispatch = scope === undefined || binding === undefined
      ? {
        kind: 'fallback' as const,
        reason: 'unavailable-unconfigured',
        legacy: await adaptLegacyRecallSelection(input, legacy, settings, signal),
      }
      : await selectRecallWithFallback(input, scope, signal, { runner: binding, settings, legacy })
    if (!this.isCurrent(agent, state, ticket, signal)) return
    if (dispatch.kind === 'cancelled') return
    // `skipped` is the design's no-request state and belongs to `off`, which the
    // coordinator never runs; treat it as a no-op round.
    if (dispatch.kind === 'skipped') return
    // A fallback whose adapted legacy selection was skipped does nothing at all.
    if (dispatch.kind === 'fallback' && dispatch.legacy.kind === 'skipped') return
    const ids = dispatch.kind === 'selected'
      ? dispatch.ids
      : dispatch.kind === 'fallback' && dispatch.legacy.kind === 'selected' ? dispatch.legacy.ids : []
    const byId = new Map(topics.map(topic => [topic.id, topic]))
    const bodies: string[] = []
    const delivered: string[] = []
    let contentChanged = false
    for (const id of ids) {
      const topic = byId.get(id)
      if (topic === undefined) continue
      let raw: string | undefined
      try {
        raw = await readOptionalText(fileSystem, topic.path, signal)
      } catch {
        // A read fault delivers nothing for this path, and it is never marked
        // shown: a later round (new origin or changed manifest) may retry it.
        continue
      }
      if (raw === undefined) continue
      // The scanned hash must still describe the bytes on disk: mixing an old
      // description with new content is forbidden, so the WHOLE result goes.
      if (sha256Hex(raw) !== topic.contentHash) {
        contentChanged = true
        break
      }
      if (raw.trim().length === 0) continue
      bodies.push(`## Memory: ${topic.name}\n\n${raw.trim()}`)
      delivered.push(topic.path)
    }
    // A checkpoint after reading: nothing may inject past a moved generation.
    if (!this.isCurrent(agent, state, ticket, signal)) return
    if (contentChanged) {
      this.markCompleted(state, dispatchKey)
      return
    }
    if (bodies.length === 0) {
      // An empty selection (or one whose every entry was undeliverable) is a valid
      // terminal: the same input must not be paid for again.
      this.markCompleted(state, dispatchKey)
      return
    }
    if (agent.status === 'idle') {
      warnLateIdle(this.ctx)
      return
    }
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: bodies.join('\n\n') }],
        source: { kind: 'memory' },
      }))
    } catch {
      // A thrown injection delivers nothing: the key is terminal, no path shown.
      this.markCompleted(state, dispatchKey)
      return
    }
    // Inject succeeded synchronously: only now do the delivered paths become shown.
    for (const path of delivered) state.shown.add(path)
    this.options.recordDelivered(agent, delivered)
    this.markCompleted(state, dispatchKey)
  }
}
