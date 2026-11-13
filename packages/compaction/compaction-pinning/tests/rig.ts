/**
 * Shared live rig for the detect/restore specs (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Verification).
 *
 * The rig is the progress-rebuild one: REAL agent loop + REAL session log +
 * REAL surface validator, only the model mocked. Session events therefore come
 * through the same publication path production uses, and every append the
 * plugin makes is checked by the real `{ surfaceOp: 'append' }` validator.
 *
 * The compaction lifecycle is driven by durable log events appended directly,
 * exactly as the engine records them (`commitCompactionBody` /
 * the failed-commit catch in the harness
 * `packages/compaction/compaction-basic/src/region.ts`), including the
 * checkpoint replacement's `sourceEventSeqs` citation of the summary seq.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import * as Plugin from '../src/index.ts'

// The two pinned kinds already exist as producers; the specs declare the same
// merge augmentation their producers do (turn-rules/src/wiring.ts,
// post-edit-verify/src/recovery-wiring.ts).
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'turn-rules': { kind: 'turn-rules' } & ContextFormed
    'edit-recovery-hint': { kind: 'edit-recovery-hint' } & ContextFormed
  }
}

// The `compaction/*` events are declared by the harness compaction plugin
// (packages/compaction/compaction/src/types.ts in the pinned harness copy —
// `compaction/end` carries ONLY `{compactionId, sourceCommandId?, turn,
// error?}`; `shadowedSeqs` lives on `compaction/summary`). Declared locally so
// the specs can append the real shapes without taking a devDependency on the
// harness compaction package.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'compaction/start': { compactionId: string; sourceCommandId?: string; turn: number | null }
    'compaction/summary': {
      compactionId: string
      summary: { type: 'text'; text: string }[]
      shadowedRange: { start: number; end: number }
      shadowedSeqs: number[]
      shadowedTokenCount: number
      provider: string
      model: string
    }
    'compaction/end': { compactionId: string; sourceCommandId?: string; turn: number | null; error?: string }
  }
}

/** The governance source kinds under test. */
export type GovernanceKind = 'turn-rules' | 'edit-recovery-hint'

/** One governance message, built through the real factory. */
export function governanceMessage(text: string, kind: GovernanceKind = 'turn-rules'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: kind === 'turn-rules' ? { kind: 'turn-rules' } : { kind: 'edit-recovery-hint' },
  })
}

/** A plain human prompt (not a pinned kind). */
export function humanMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Live settings, default-derived (four-surface discipline: never a literal). */
export function rigSettings(
  overrides: Partial<Plugin.CompactionPinningSettings> = {},
): Plugin.CompactionPinningSettings {
  return { ...Plugin.DEFAULT_COMPACTION_PINNING_SETTINGS, ...overrides }
}

/** The real-composition rig: real loop, real session, mocked model only. */
export interface Rig {
  ctx: Context
  agent: Agent
  states: Plugin.PinningStateRegistry
  seen: SessionEvent[]
  settings: Plugin.CompactionPinningSettings
}

/**
 * Build the rig.
 * @param overrides - settings overrides.
 * @param options.mountPlugin - mount the plugin under test (default true).
 * @returns the live rig.
 */
export async function liveRig(
  overrides: Partial<Plugin.CompactionPinningSettings> = {},
  options: { mountPlugin?: boolean } = {},
): Promise<Rig> {
  const settings = rigSettings(overrides)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
  // Subscribe BEFORE agent creation: session events dispatch to the session's
  // captured emit scope, so late subscribers see nothing.
  const seen: SessionEvent[] = []
  ctx.on('session/event', (_session: unknown, event: SessionEvent) => { seen.push(event) }, { global: true })
  const states = Plugin.createPinningStateRegistry(() => settings)
  if (options.mountPlugin !== false) {
    await ctx.plugin(Plugin, { readSettings: () => settings, states })
  }
  const agent = await ctx.agentLoop.create(SessionId('cp-root'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, states, seen, settings }
}

/** Publish one `user/message` through the real session append path. */
export function publish(agent: Agent, message: UserMessage): SessionEvent & { seq: number } {
  return agent.session.append('user/message', message, { surfaceOp: 'append' }) as SessionEvent & { seq: number }
}

/** Turn the loop's clock forward the way the loop does (one `turn/start`). */
export function startTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

/** Options for one scripted compaction transaction. */
export interface CompactionScript {
  /** Owner recorded on start/end (`null` = the idle paths: manual, cost-gate). */
  turn?: number | null
  /** Explicit seqs to report as shadowed (default: the live surface nodes). */
  shadowedSeqs?: number[]
  /** Append the checkpoint replacement (default true; `false` = the F3 window). */
  checkpoint?: boolean
  /** Append `compaction/end` carrying `error` (the F1 failed-commit path). */
  failEnd?: boolean
  /** Omit `compaction/end` entirely (the F2/F3 double-failure window). */
  omitEnd?: boolean
  /** Explicit lifecycle id (defaults to a per-rig counter). */
  compactionId?: string
}

/** What one scripted compaction recorded. */
export interface CompactionRecord {
  compactionId: string
  startSeq: number
  summarySeq: number
  endSeq?: number
}

let compactionCounter = 0

/**
 * Append one complete-or-faulted compaction transaction, in the engine's own
 * order and shapes: start → summary → checkpoint replacement → end.
 * @param session - the session the engine would write to.
 * @param script - the fault switch for this transaction.
 * @returns the recorded seqs.
 */
export function appendCompaction(session: Session, script: CompactionScript = {}): CompactionRecord {
  const compactionId = script.compactionId ?? `cp-${++compactionCounter}`
  const turn = script.turn ?? null
  const startEvent = session.append('compaction/start', { compactionId, turn })
  const nodes = [...session.surface.nodes]
  const shadowedSeqs = script.shadowedSeqs ?? [...nodes]
  const start = shadowedSeqs[0] ?? nodes[0] ?? 0
  const end = shadowedSeqs[shadowedSeqs.length - 1] ?? start
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'summary of the shadowed range' }],
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount: 12,
    provider: 'mock',
    model: 'mock',
  })
  if (script.checkpoint !== false && nodes.length > 0) {
    const first = nodes[0]!
    const last = nodes[nodes.length - 1]!
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: '[summary of the compacted range]' }],
        source: { kind: 'user' },
      }),
      {
        surfaceOp: { op: 'replace', startSeq: first, endSeq: last },
        // The engine cites start, summary, and every shadowed node
        // (`commitCompactionBody`); the summary citation is what proves the
        // checkpoint commit to the detect half.
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...nodes],
      },
    )
  }
  const record: CompactionRecord = { compactionId, startSeq: startEvent.seq, summarySeq: summaryEvent.seq }
  if (script.omitEnd !== true) {
    const endEvent = session.append('compaction/end', script.failEnd === true
      ? { compactionId, turn, error: 'summarizer failed' }
      : { compactionId, turn })
    record.endSeq = endEvent.seq
  }
  return record
}

/** The text of every derived user message, in surface order. */
export function derivedUserTexts(session: Session): string[] {
  return session.deriveMessages().flatMap((message) =>
    message.role !== 'user' ? [] : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])))
}

/**
 * Run one `agent/pre-step` waterfall the way the loop does: the plugin's
 * `{ prepend: true }` drain wraps every other listener, exactly as in a live
 * step.
 * @param rig - the live rig.
 * @param options.turn - the turn the proposed step belongs to (default 1).
 * @param options.step - the step number (default 1).
 * @param options.decision - what the inner continuation returns.
 * @returns the waterfall's decision.
 */
export async function runPreStep(
  rig: Rig,
  options: { turn?: number; step?: number; decision?: PreStepDecision } = {},
): Promise<PreStepDecision> {
  const decision = options.decision ?? { kind: 'enter', messages: [] }
  return await rig.ctx.waterfall(
    'agent/pre-step',
    {
      agent: rig.agent,
      messages: [],
      turn: options.turn ?? 1,
      step: options.step ?? 1,
      signal: new AbortController().signal,
      modelSelection: { provider: 'mock', model: 'mock' },
    },
    async () => decision,
  )
}

/** Reset the scripted-compaction id counter (keeps ids readable per test). */
export function resetCompactionIds(): void {
  compactionCounter = 0
}
