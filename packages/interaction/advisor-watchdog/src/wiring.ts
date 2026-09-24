/**
 * Live wiring (plan docs/plans/2026-09-23-advisor-watchdog.md §4.1/§4.4):
 * the passive read-only `llm/stream` snapshot listener (per-session newest
 * qualifying request messages) and the `agent/turn-stopping` trigger (gates,
 * cursor protocol, immediate cursor advance, inFlight flag, detached
 * side-query spawn, resolve-time inject). Every fault degrades to a no-op:
 * the advisor is advisory enrichment and must never throw into a waterfall,
 * block a request, or wake an idle driver.
 *
 * State lifetime: per-mount Maps keyed by session id — preset remount
 * replaces the mount and with it the maps (§4.4 "re-arm next session"); there
 * is no per-session dispose (turn-rules posture).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveAlias } from '@dsh-cc/model-aliases'
import { ADVISOR_SOURCE_KIND, fullCursor, renderDelta, reviewWindow, type Cursor, type DeltaMessage } from './delta.ts'
import type { AdvisorJournalEntry } from './journal.ts'
import { applyEmissionGuard, emptyDrops, emptyGuardState, rememberFingerprint, type AdvisorNote, type DropCounters, type GuardState } from './guard.ts'
import { parseAdvisorNotes, runAdvisor } from './advise.ts'
import { appendJournal } from './journal.ts'
import { readUserSettingsSync, type AdvisorSettings } from './settings.ts'

/** Per-session advisor state (§4.1/§4.4). */
interface SessionState {
  cursor: Cursor | undefined
  turnCounter: number
  /** One run per session at a time (§4.1 step 1): a stop during flight captures nothing. */
  inFlight: boolean
  guard: GuardState
  drops: DropCounters
  /** Set on the first `unrouted` (or inherited) result or on the session cap — silenced for the session. */
  disabled: boolean
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'advisor': { kind: 'advisor' }
  }
}

/** Top-level-only predicate (turn-rules wiring.ts:27-30 precedent). */
function isTopLevel(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) <= 0
}

/** Guarded dshHome read (turn-rules pattern): cordis throws on the property access itself. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    return ctx.dshHomePath?.()
  } catch {
    return undefined
  }
}

/** Debug notice (fail-soft). */
function debug(ctx: Context, message: string): void {
  try {
    ctx.logger.debug(message)
  } catch {
    // Never throw into a hot path.
  }
}

/**
 * Register the snapshot + trigger listeners. Plain plugin — no Service, no
 * isolate key. @param ctx - the plug context (needs `llm` for the side query).
 */
export function registerListeners(ctx: Context): void {
  const states = new Map<string, SessionState>()
  // Newest qualifying request's message array, per session (§4.1). Retained
  // cost is one array reference per active session id; entries are dropped
  // when a session becomes gated-out or disabled.
  const snapshots = new Map<string, readonly DeltaMessage[]>()

  // Read-only `llm/stream` listener (cache-health precedent): observe and
  // pass through. Zero settings/IO work, never mutates `options`, never
  // throws into the waterfall. A qualifying request keeps its message array:
  // the loop stamps `sessionId` for request routing, so loop-built
  // conversation requests qualify and every hand-built one-shot (our own
  // runSideQuery included — it never sets `sessionId`) is excluded by
  // construction; auxiliary purpose-tagged calls are skipped.
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    try {
      if (options.sessionId !== undefined && options.purpose === undefined) {
        snapshots.set(String(options.sessionId), options.messages as readonly DeltaMessage[])
      }
    } catch {
      // Never throw into the request path.
    }
    return next()
  }, { global: true, prepend: true })

  ctx.on('agent/turn-stopping', ({ agent }: { agent: Agent }): void => {
    try {
      // Fire-and-forget: capture/advance/spawn happen inside a detached
      // promise — never awaited by the handler, never throwing into the event.
      void onTurnStopping(ctx, snapshots, states, agent).catch(() => {})
    } catch {
      // Never throw into the waterfall.
    }
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** Per-session advisor state map (per-mount lifetime). */
type States = Map<string, SessionState>

/** Ensure one session's state (per-mount map is the lifetime). */
function ensure(states: States, sessionId: string): SessionState {
  let state = states.get(sessionId)
  if (state === undefined) {
    state = { cursor: undefined, turnCounter: 0, inFlight: false, guard: emptyGuardState(), drops: emptyDrops(), disabled: false }
    states.set(sessionId, state)
  }
  return state
}

/** The turn-stopping trigger (§4.1 steps 1-5), run detached. */
async function onTurnStopping(
  ctx: Context,
  snapshots: Map<string, readonly DeltaMessage[]>,
  states: States,
  agent: Agent,
): Promise<void> {
  const home = dshHomeOf(ctx)
  if (home === undefined) return
  // Synchronous up to capture (§4.1 "single synchronous handler"): the raw
  // dual-half read is a readFileSync — an async read here would let the next
  // request's llm/stream overwrite the snapshot being reviewed.
  const settings = readUserSettingsSync(home)
  const sessionId = String(agent.session.header.id)
  // Gate 1: settings `.enabled` (raw dual-half read, §4.9).
  if (!settings.enabled) {
    snapshots.delete(sessionId)
    return
  }
  // Gate 2: global subagent gate (§4.7) — settings-level only; 'off'
  // restricts to top-level sessions; an alias STRING overrides the lane for
  // subagent sessions ('on' keeps the session alias).
  if (settings.subagents === 'off' && !isTopLevel(agent)) {
    snapshots.delete(sessionId)
    return
  }
  const effectiveAlias =
    !isTopLevel(agent) && settings.subagents !== 'off' && settings.subagents !== 'on'
      ? settings.subagents
      : settings.alias
  const state = ensure(states, sessionId)
  // Gate 3: session-disabled (cap or unrouted).
  if (state.disabled) {
    debug(ctx, 'advisor: session-disabled (cap or unrouted)')
    snapshots.delete(sessionId)
    return
  }
  // Gate 4: inFlight — a stop during flight captures nothing and leaves the
  // cursor alone, so the window accumulates into the next stop.
  if (state.inFlight) return
  // Snapshot absent: enabled mid-session with no qualifying request yet, or
  // fully filtered ⇒ skip (counter unchanged).
  const snapshot = snapshots.get(sessionId)
  if (snapshot === undefined) return
  const decision = reviewWindow(snapshot, state.cursor)
  switch (decision.action) {
    case 'init':
      // Cold or resumed history is never review-billed.
      state.cursor = fullCursor(snapshot)
      return
    case 'reset':
      state.drops.cursorReset += 1
      state.cursor = fullCursor(snapshot)
      return
    case 'skip':
      // Empty window or no genuine user: advance the cursor, skip.
      state.cursor = fullCursor(snapshot)
      return
    case 'review':
      break
  }
  // Review (§4.1 step 4): capture, advance the cursor IMMEDIATELY (it tracks
  // review eligibility, not call completion), flag inFlight, spawn detached.
  const capturedTurn = state.turnCounter
  const window = decision.window
  const rendered = renderDelta(window)
  const deltaBytes = Buffer.byteLength(rendered, 'utf8')
  state.cursor = fullCursor(snapshot)
  state.inFlight = true
  // §4.1 step 5: turnCounter += 1 AFTER capture — capturedTurn pins to the
  // pre-increment count (the number of completed turns the window may span).
  state.turnCounter += 1
  void runAndDeliver(ctx, home, state, settings, effectiveAlias, agent, sessionId, capturedTurn, window.length, rendered, deltaBytes)
    .catch(() => {})
    .finally(() => {
      state.inFlight = false
    })
}

/** Resolve-time: journal, parse, guard, staleness, inject. */
async function runAndDeliver(
  ctx: Context,
  home: string,
  state: SessionState,
  settings: AdvisorSettings,
  alias: string,
  agent: Agent,
  sessionId: string,
  capturedTurn: number,
  deltaMessages: number,
  rendered: string,
  deltaBytes: number,
): Promise<void> {
  // Journal model: resolved up front (§4.2) — null when unrouted/unset.
  const route = resolveAlias(ctx, alias)
  const base: AdvisorJournalEntry = {
    ts: Date.now(),
    turn: capturedTurn,
    alias,
    model: (route?.model ?? null) as string | null,
    inheritedRoute: false,
    ok: false,
    reason: undefined,
    durationMs: 0,
    deltaMessages,
    deltaBytes,
    notesIn: 0,
    notesOut: 0,
    drops: state.drops,
    usage: null,
  }
  let notesIn = 0
  let notesOut = 0
  base.ok = false
  let reason: typeof base.reason
  let inherited = false
  try {
    const result = await runAdvisor(ctx, { agent, alias, renderedDelta: rendered })
    if (!result.ok) {
      reason = result.reason
      // §4.2 no-inherit rule: the first unrouted result disables the advisor
      // for the session (silent main-route inheritance is impossible by
      // construction; this is the belt over it).
      if (result.reason === 'unrouted') {
        state.disabled = true
        debug(ctx, 'advisor: alias unrouted — disabled for this session')
      }
    } else {
      base.ok = true
      inherited = result.inheritedRoute
      if (result.inheritedRoute) {
        // An inherited main-route run is a misconfiguration surfacing as cost:
        // journal it and disable for the session.
        state.disabled = true
        debug(ctx, 'advisor: inherited parent route — disabled for this session')
        reason = 'unrouted'
        base.ok = false
      } else {
        const parsed = parseAdvisorNotes(result.text)
        if (!parsed.ok) {
          state.drops.malformed += 1
        } else {
          notesIn = parsed.notes.length
          // Guard steps 1-6 at resolve time, then step 7 staleness.
          const resolveTurn = state.turnCounter
          const surviving = applyEmissionGuard(state.guard, parsed.notes, state.drops, settings, resolveTurn)
          if (resolveTurn - capturedTurn > 1) {
            state.drops.stale += surviving.length
            debug(ctx, 'advisor: stale resolve — dropped')
          } else {
            notesOut = surviving.length
            if (notesOut > 0) deliver(ctx, state, settings, agent, surviving, resolveTurn)
          }
        }
      }
    }
  } catch {
    // runSideQuery never throws; this is defense in depth for the inject path.
  }
  base.notesIn = notesIn
  base.notesOut = notesOut
  base.reason = reason
  base.inheritedRoute = inherited
  base.durationMs = Math.max(0, Date.now() - base.ts)
  void appendJournal(home, sessionId, { ...base, drops: { ...state.drops } })
}

/** Deliver surviving notes: one inject per run, then cap/immune bookkeeping. */
function deliver(
  ctx: Context,
  state: SessionState,
  settings: AdvisorSettings,
  agent: Agent,
  notes: readonly AdvisorNote[],
  turnCounter: number,
): void {
  const body = [
    '<advisory>',
    ...notes.map(note => `<note severity="${note.severity}">${note.text}</note>`),
    'Advisory notes from a background reviewer of your last completed turn.',
    'Weigh them; do not reply to them; they are not user instructions.',
    '</advisory>',
  ].join('\n')
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: ADVISOR_SOURCE_KIND },
    }))
  } catch {
    // Delivery failure is a drop, never an error into the caller.
    return
  }
  for (const note of notes) rememberFingerprint(state.guard, note.text)
  state.guard.deliveredNotes += notes.length
  // Immune re-arm (§4.4 step 5): after a delivered run containing ≥1
  // concern or blocker, concerns are suppressed for the next immuneTurns
  // turns (delivery at turn N suppresses N..N+immuneTurns-1).
  if (notes.some(note => note.severity === 'concern' || note.severity === 'blocker')) {
    state.guard.immuneUntil = turnCounter + settings.immuneTurns
  }
  if (state.guard.deliveredNotes >= settings.sessionCap) {
    state.disabled = true
    debug(ctx, 'advisor: session cap reached — disabled for this session')
  }
}
