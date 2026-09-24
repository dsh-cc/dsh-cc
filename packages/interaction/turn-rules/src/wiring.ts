/**
 * Live wiring (plan docs/plans/2026-09-23-turn-rules.md §4.3): the three
 * listeners — `tools/post-execute` (fail-soft shell, additionalContexts
 * sideband), `agent/pre-step` + `agent.inject` (attributed prompt-channel
 * reminders), `agent/turn-stopping` (turn counter + ledger persistence).
 * Every fault degrades to a passthrough — a listener throw would turn the
 * user's tool result into an error (data loss).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, PostToolDecision } from '@dsh-cc/tools'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { discoverTurnRules, type TurnRule } from './discovery.ts'
import { emptyLedger, loadLedger, writeLedger, type TurnRulesLedger } from './ledger.ts'
import { buildPromptCandidate, buildToolUnit, shouldFire, TURN_RULES_SOURCE_KIND } from './matcher.ts'
import { createRegexCache, type RegexCache } from './regex-cache.ts'
import { readUserSettings } from './settings.ts'

/** Per-session total-injection cap (§6): debug notice, then silence. */
export const MAX_INJECTIONS = 32

/** Top-level-only predicate (recall.ts:294 precedent, §4.5). */
function isTopLevel(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) <= 0
}

/** Guarded dshHome read (edit-recovery-hint pattern): cordis throws on the property access itself. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    return ctx.dshHomePath?.()
  } catch {
    return undefined
  }
}

/** Mutable per-session state; the in-memory map is the authoritative double-fire gate (§4.6). */
interface SessionState {
  /** ruleKey → the turn counter value at which the rule last fired. */
  fired: Map<string, number>
  turnCounter: number
  /** Total reminders injected this session (the §6 cap). */
  injections: number
  /** Prompt-channel dedupe (§4.3 step 3). */
  lastPromptText: string
  hydrated: Promise<void> | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

// The injected-reminder source kind (MessageSourceMap is merge-extensible;
// memory's 'memory' kind precedent).
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'turn-rules': { kind: 'turn-rules' }
  }
}

/** The pre-step payload structural subset (recall.ts idiom). */
interface PreStepPayload {
  agent: Agent
  messages: ReadonlyArray<{ content: readonly { type: string; text?: string }[]; source?: { kind?: string } }>
  signal: AbortSignal
}

/**
 * Register the three listeners over the snapshotted rule corpus. The corpus is
 * discovered ONCE (kickoff at apply; awaited lazily on the first event).
 * @param ctx - the plug context.
 * @param rulesOverride - test seam: pre-resolved corpus replacing discovery.
 */
export function registerListeners(ctx: Context, rulesOverride?: Promise<TurnRule[]>): void {
  // Snapshot once at apply (§4.2): plugin install/enable changes take effect
  // on the next preset remount. Kick off eagerly, await lazily, fail soft.
  const rules = rulesOverride ?? discoverTurnRules().catch(() => [])
  const states = new Map<string, SessionState>()
  // The compiled-regex LRU is created on the first event with that event's
  // settings capacity (§4.5) and memoized per mount — a capacity flip applies
  // on the next preset remount.
  let memoCache: RegexCache | undefined
  const cacheFor = (capacity: number): RegexCache => (memoCache ??= createRegexCache(capacity))

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
    const downstream = await next()
    try {
      return await onPostExecute(ctx, rules, cacheFor, states, exec, result, downstream)
    } catch (error: unknown) {
      // Fail-soft invariant of the seam (CCR precedent): a throw here would
      // turn the user's tool result into an error result (data loss).
      ctx.logger.warn(`turn-rules: degraded to passthrough: ${String(error)}`)
      return downstream
    }
  })

  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    try {
      await onPreStep(ctx, rules, cacheFor, states, payload)
    } catch {
      // Advisory enrichment only; never fail the step.
    }
    return decision
  })

  ctx.on('agent/turn-stopping', ({ agent }: { agent: Agent }): void => {
    try {
      if (!isTopLevel(agent)) return
      const home = dshHomeOf(ctx)
      if (home === undefined) return
      const sessionId = String(agent.session.header.id)
      void bumpTurnCounter(home, states, sessionId)
    } catch {
      // Never throw into the waterfall.
    }
  })
}

/** Tool-result channel (§4.3): match the bounded unit, append reminders to the accept. */
async function onPostExecute(
  ctx: Context,
  rules: Promise<TurnRule[]>,
  cacheFor: (capacity: number) => RegexCache,
  states: Map<string, SessionState>,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  downstream: PostToolDecision,
): Promise<PostToolDecision> {
  // Guard battery (§4.3 step 2), in the documented order; any miss ⇒ passthrough.
  if (downstream.kind !== 'accept') return downstream
  // Value-accept guard: the runtime throws on content+value in one decision,
  // so never compose onto the value variant — passthrough untouched.
  if ((downstream as { value?: unknown }).value !== undefined) return downstream
  const home = dshHomeOf(ctx)
  if (home === undefined) return downstream
  const settings = await readUserSettings(home)
  if (!settings.enabled) return downstream
  const agent = exec.agent
  if (agent === undefined) {
    // No-op + counter; do NOT persist under 'unknown' (would poison `once`).
    countDebug(ctx, 'agent-undefined')
    return downstream
  }
  if (!isTopLevel(agent)) return downstream
  const sessionId = String(agent.session.header.id)
  // Hydrate BEFORE any gate/match read (§4.6): the ledger is the resume-proof
  // record, so a resumed session must see its persisted fired-set before
  // `once`/`after-gap` evaluation — otherwise a pre-restart fire re-fires.
  const state = await hydrate(home, states, sessionId)
  if (state.injections >= MAX_INJECTIONS) {
    countDebug(ctx, 'injection-cap')
    return downstream
  }
  const cache = cacheFor(settings.regexCacheSize)
  const unit = buildToolUnit(exec.arguments, downstream.content ?? result.content, settings.maxResultBytes)
  const corpus = await rules
  const firing: TurnRule[] = []
  for (const rule of corpus) {
    if (!rule.triggerOn.includes('tool-results')) continue
    const compiled = cache(rule.trigger)
    if (compiled === undefined || !compiled.test(unit)) continue
    if (!shouldFire(state.fired.get(rule.ruleKey), state.turnCounter, rule.repeat, rule.repeatGap)) continue
    firing.push(rule)
  }
  if (firing.length === 0) return downstream
  const allowance = MAX_INJECTIONS - state.injections
  const claimed = firing.slice(0, Math.max(0, allowance))
  if (claimed.length === 0) {
    countDebug(ctx, 'injection-cap')
    return downstream
  }
  const reminders: UserMessage[] = []
  for (const rule of claimed) {
    state.fired.set(rule.ruleKey, state.turnCounter)
    state.injections += 1
    reminders.push(reminderMessage(rule.body))
  }
  void writeLedger(home, sessionId, ledgerOf(state))
  return { ...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), ...reminders] }
}

/** Prompt channel (§4.3): candidate text → matches → agent.inject per fired rule. */
async function onPreStep(
  ctx: Context,
  rules: Promise<TurnRule[]>,
  cacheFor: (capacity: number) => RegexCache,
  states: Map<string, SessionState>,
  payload: PreStepPayload,
): Promise<void> {
  const { agent, messages } = payload
  if (!isTopLevel(agent)) return
  const home = dshHomeOf(ctx)
  if (home === undefined) return
  const settings = await readUserSettings(home)
  if (!settings.enabled) return
  const sessionId = String(agent.session.header.id)
  const state = await hydrate(home, states, sessionId)
  if (state.injections >= MAX_INJECTIONS) {
    countDebug(ctx, 'injection-cap')
    return
  }
  const candidate = buildPromptCandidate(messages, settings.maxResultBytes)
  // Per-step dedupe (§4.3 step 3): the same pending text re-presented on a
  // later step must not re-evaluate. Update only on non-empty candidates.
  if (candidate.length === 0) return
  if (state.lastPromptText === candidate) return
  state.lastPromptText = candidate
  const cache = cacheFor(settings.regexCacheSize)
  const corpus = await rules
  let firedAny = false
  for (const rule of corpus) {
    if (!rule.triggerOn.includes('user-prompts')) continue
    const compiled = cache(rule.trigger)
    if (compiled === undefined || !compiled.test(candidate)) continue
    if (!shouldFire(state.fired.get(rule.ruleKey), state.turnCounter, rule.repeat, rule.repeatGap)) continue
    if (state.injections >= MAX_INJECTIONS) {
      countDebug(ctx, 'injection-cap')
      break
    }
    state.fired.set(rule.ruleKey, state.turnCounter)
    state.injections += 1
    firedAny = true
    agent.inject(reminderMessage(rule.body))
  }
  if (firedAny) void writeLedger(home, sessionId, ledgerOf(state))
}

/** Turn-stopping (§4.6): bump the counter once per top-level turn stop, persist. */
async function bumpTurnCounter(
  home: string,
  states: Map<string, SessionState>,
  sessionId: string,
): Promise<void> {
  const state = await hydrate(home, states, sessionId)
  state.turnCounter += 1
  await writeLedger(home, sessionId, ledgerOf(state))
}

/** One advisory reminder UserMessage, attributed via the plugin's source kind. */
function reminderMessage(body: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: { kind: TURN_RULES_SOURCE_KIND },
  })
}

/** The durable view of one session's in-memory state. */
function ledgerOf(state: SessionState): TurnRulesLedger {
  const fired: Record<string, number> = {}
  for (const [key, at] of state.fired) fired[key] = at
  return { version: 1, turnCounter: state.turnCounter, fired }
}

/**
 * Lazily hydrate one session's state from the ledger on the session's first
 * event (§4.6): the in-memory map is authoritative afterwards; the ledger
 * rehydrates resume/compaction.
 */
async function hydrate(
  home: string,
  states: Map<string, SessionState>,
  sessionId: string,
): Promise<SessionState> {
  let state = states.get(sessionId)
  if (state === undefined) {
    state = { fired: new Map(), turnCounter: 0, injections: 0, lastPromptText: '', hydrated: undefined }
    states.set(sessionId, state)
  }
  if (state.hydrated === undefined) {
    state.hydrated = (async () => {
      const ledger = await loadLedger(home, sessionId) ?? emptyLedger()
      for (const [key, at] of Object.entries(ledger.fired)) {
        if (!state!.fired.has(key)) state!.fired.set(key, at)
      }
      if (state!.turnCounter === 0) state!.turnCounter = ledger.turnCounter
    })().catch(() => {
      // Rehydration failure keeps the in-memory view; never poison a listener.
    })
  }
  await state.hydrated
  return state
}

/** Debug counter + notice (fail-soft accounting; §2 "debug counter"). */
function countDebug(ctx: Context, reason: string): void {
  try {
    ctx.logger.debug(`turn-rules: passthrough (${reason})`)
  } catch {
    // Never throw into a hot path.
  }
}
