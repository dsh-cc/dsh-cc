/**
 * The `shadow` comparison sidecar of dynamic recall (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Failure table and mode
 * switching", §"Privacy, caching and logging").
 *
 * Shadow mode keeps the legacy branch's selection and injection and runs the
 * decision model ALONGSIDE it. The comparison is a record only: it never
 * injects, never marks a path shown and never enters the delivered mirror. When
 * the decision is unavailable no comparison is emitted — an absent result is
 * never dressed up as a real one.
 *
 * The record holds fixed enum values and counts only: no query, no filename, no
 * path and no file content (memory adds no raw-text ledger).
 *
 * @module @dsh-cc/memory/recall-shadow
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { assignRecallTopicIds } from './recall-decision.ts'
import type { RecallDecisionInput, RecallTopic } from './recall-decision.ts'
import type { RecallDecisionSettings } from './recall-decision-settings.ts'
import { SystemOneRecallDecisionSelector } from './recall-decision-runner.ts'
import { scanRecallLayers, sortedTools } from './recall-coordinator-support.ts'
import type { RecallDecisionBinding } from './recall-coordinator-support.ts'
import { resolveRecallTurn } from './recall-query.ts'
import type { RecallMessageLike } from './recall-query.ts'

/**
 * The content-free shadow comparison record. Fixed values only: never a query, a
 * filename, a path or file content.
 *
 * `pool` is the caller's own (post-shown-filter) candidate count and `judged` the
 * decision arm's judged scope after pre-selection and trimming, so one record
 * shows how much of the pool the decision actually saw.
 */
export type RecallShadowRecord =
  | { kind: 'selected'; pool: number; judged: number; selected: number; greyDropped: number }
  | { kind: 'unavailable'; reason: string; pool: number; judged: number }
  | { kind: 'skipped'; reason: 'no-service' | 'no-origin' }

/** Injected collaborators of {@link compareShadowRecall}. */
export interface RecallShadowDeps {
  /** The memory home (the global layer root). */
  home: string
  /** Live SystemOne settings snapshot (its `mode` gates this sidecar). */
  readSettings(): RecallDecisionSettings
  /** Bind the decision runner for one agent; absent means no comparison. */
  decisionsFor(agent: Agent): RecallDecisionBinding | undefined
  /** Paths actually delivered in any mode (never re-injected). */
  delivered(agent: Agent): ReadonlySet<string>
  /** Recently used tool names for one agent. */
  recentTools(agent: Agent): readonly string[]
  /** Shown set of the agent's active-mode state, when one exists. */
  shown(agent: Agent): ReadonlySet<string> | undefined
  /** Comparison sink. */
  report(record: RecallShadowRecord): void
}

/**
 * Run one shadow comparison. Never throws for a decision fault: the baseline
 * branch's behaviour is untouched either way.
 * @param fileSystem - the host filesystem seam (absent skips the comparison).
 * @param memoryDir - the agent's canonical workspace memory directory.
 * @param deps - settings, binding and the delivery mirror.
 * @param agent - the recalling agent.
 * @param messages - the claimed pre-step message batch.
 * @param signal - the pre-step's cancellation signal.
 */
export async function compareShadowRecall(
  fileSystem: FileSystem,
  memoryDir: string,
  deps: RecallShadowDeps,
  agent: Agent,
  messages: readonly RecallMessageLike[],
  signal: AbortSignal,
): Promise<void> {
  const settings = deps.readSettings()
  if (settings.mode !== 'shadow') return
  const turn = resolveRecallTurn(agent, messages)
  if (turn === undefined) {
    deps.report({ kind: 'skipped', reason: 'no-origin' })
    return
  }
  const binding = deps.decisionsFor(agent)
  if (binding === undefined) {
    deps.report({ kind: 'skipped', reason: 'no-service' })
    return
  }
  const seeds = await scanRecallLayers(fileSystem, memoryDir, deps.home, signal)
  if (signal.aborted) return
  // The comparison judges the same fresh pool the baseline branch saw: already
  // delivered paths are out of every arm.
  const shown = new Set<string>([...deps.delivered(agent), ...(deps.shown(agent) ?? [])])
  const topics: RecallTopic[] = assignRecallTopicIds(seeds.filter(seed => !shown.has(seed.path)))
  const input: RecallDecisionInput = {
    query: turn.query,
    recentTools: sortedTools(deps.recentTools(agent)),
    topics,
  }
  const selection = await new SystemOneRecallDecisionSelector(binding, settings)
    .select(input, binding.scope(turn.originSeq), signal)
  if (selection.kind === 'cancelled') return
  if (selection.kind === 'selected') {
    deps.report({ kind: 'selected', pool: topics.length, judged: selection.judged, selected: selection.ids.length, greyDropped: selection.greyDropped })
    return
  }
  deps.report({ kind: 'unavailable', reason: selection.reason, pool: topics.length, judged: selection.judged })
}
