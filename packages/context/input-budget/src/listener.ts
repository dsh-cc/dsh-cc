/**
 * The `agent/pre-step` governor listener — plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md` §"Package & seam",
 * §"Defer queue" and §"Failure semantics".
 *
 * One waterfall listener, registered `{ prepend: true }`, delegate-first: it
 * awaits `next()` (so every inner listener produced its decision) and then
 * rewrites the returned decision with `{ ...decision, messages: newBatch }`.
 * The decision is always SPREAD, never reconstructed: harness
 * `PreStepDecision.enter` carries `startsRequestSeries`, and tomorrow's payload
 * may carry more — a rebuilt literal would silently drop them.
 *
 * Per-session state owned here (the reason this is wiring, not core): the
 * monotonic `gateSeq` invocation counter and the defer backlog. The turn-local
 * `step` resets per turn and is never used as a clock.
 *
 * Failure semantics: any exception — settings read, hook, governor — returns
 * the unmodified decision and records `{ error: true }`. Nothing is ever thrown
 * into the waterfall and no protected class is ever dropped.
 *
 * Backlog re-entry happens ONLY through this listener's return value: a
 * deferred message is re-admitted by prepending it to the decision batch, never
 * by `agent.inject`, so no new claimed batches form.
 *
 * Payload/decision faces are declared here as local structural subsets
 * (turn-rules `PreStepPayload` idiom, `packages/interaction/turn-rules/src/wiring.ts:71`)
 * rather than harness imports: the listener reads a session id and a message
 * list, and the merge-extensible harness types stay out of this package.
 *
 * @module @dsh-cc/input-budget/listener
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GovernorRow } from '@dsh-cc/input-ledger'
import type { DeferredEntry, GovernedMessage } from './core.ts'
import { runGovernorPipeline, type GovernorStageHook } from './pipeline.ts'
import { buildGovernorRow } from './row.ts'
import {
  DEFAULT_INPUT_BUDGET_SETTINGS,
  readUserSettingsSync,
  registerSettings,
  type InputBudgetMode,
  type InputBudgetSettings,
} from './settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** Structural face of the `agent/pre-step` payload (turn-rules idiom). */
export interface PreStepPayloadLike {
  readonly agent?: unknown
  readonly messages?: unknown
  readonly turn?: unknown
  readonly step?: unknown
  readonly signal?: unknown
  readonly modelSelection?: unknown
}

/** Structural face of an `enter` decision; every field survives the rewrite. */
export interface EnterDecisionLike<T> {
  readonly kind: 'enter'
  readonly messages: T[]
  readonly startsRequestSeries?: true
}

/** Structural face of `PreStepDecision`: exactly the two shapes the harness emits. */
export type PreStepDecisionLike<T> = { readonly kind: 'reject' } | EnterDecisionLike<T>

/** Per-session governor state: the monotonic clock and the defer backlog. */
export interface SessionGovernorState {
  /** The last `gateSeq` this session consumed (0 before the first gate call). */
  gateSeq: number
  /** The mode the stored backlog belongs to; a flip resets the backlog. */
  mode: InputBudgetMode
  /** The defer backlog carried into the next invocation (empty in observe mode). */
  backlog: DeferredEntry[]
}

/** Collaborators of the listener; the registration wires them to the runtime. */
export interface GovernorListenerDeps {
  /** Hot settings read — called once per gate invocation. */
  readSettings(): InputBudgetSettings
  /** Row sink seam (the input-ledger append, wired by the ledger slice). */
  emit(row: GovernorRow): void
  /** Process boot id stamped into every row. */
  gen: string
  /** Debug sink for swallowed failures (must not throw). */
  debug(message: string): void
  /** Pre-trim pipeline stages (doc 7 dedupe → caps); empty in this slice. */
  hooks?: readonly GovernorStageHook<GovernedMessage>[] | undefined
}

/** The listener plus the introspection a test needs. */
export interface GovernorListener {
  /** The waterfall listener itself. */
  handler(
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike<GovernedMessage>>,
  ): Promise<PreStepDecisionLike<GovernedMessage>>
  /** One session's live state, or undefined before its first gate call. */
  stateOf(sessionId: string): SessionGovernorState | undefined
  /** Drop one session's state (session disposal; never affects other sessions). */
  forget(session: unknown): void
}

/** Read one untyped value as an object face, or undefined. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Read one untyped value as a finite integer, or undefined. */
function intOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/** Read one untyped identifier as a non-empty string, or undefined. */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * Durable session id of an agent face: `session.header.id` first (the harness
 * shape every other dsh-cc listener reads), then the bare `session.id`.
 * @param agent - the payload's agent, of unknown shape.
 * @returns the session id, or undefined when the face carries none.
 */
export function sessionIdOf(agent: unknown): string | undefined {
  const session = objectOf(objectOf(agent)?.session)
  return idOf(objectOf(session?.header)?.id) ?? idOf(session?.id)
}

/** Best-effort one-line description of a caught failure. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the governor listener over one private per-session state map.
 *
 * The returned {@link GovernorListener.handler} is pure wiring around the pure
 * pipeline: read settings, resolve state, run the pipeline, persist the new
 * clock/backlog, emit the row, rewrite the decision.
 *
 * @param deps - settings reader, row sink, debug sink, boot id and stages.
 */
export function createGovernorListener(deps: GovernorListenerDeps): GovernorListener {
  const sessions = new Map<string, SessionGovernorState>()

  /** This session's state, created on demand — no state is shared across sessions. */
  const stateOfSession = (sessionId: string): SessionGovernorState => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { gateSeq: 0, mode: 'observe', backlog: [] }
      sessions.set(sessionId, state)
    }
    return state
  }

  /** Run one gate invocation and persist its outcome (throws only to the caller). */
  const governBatch = (
    payload: PreStepPayloadLike,
    decision: EnterDecisionLike<GovernedMessage>,
    settings: InputBudgetSettings,
    sessionId: string,
  ): PreStepDecisionLike<GovernedMessage> => {
    const state = stateOfSession(sessionId)
    // Flip boundary (plan §"Observe mode"): an observe → enforce flip starts with
    // an empty queue, and an enforce → observe flip clears it — no cross-mode
    // carryover in either direction.
    const flipped = state.mode !== settings.mode
    const result = runGovernorPipeline(
      {
        messages: decision.messages,
        settings,
        backlog: flipped ? [] : state.backlog,
        gateSeq: state.gateSeq,
      },
      deps.hooks ?? [],
    )
    // The mode, the clock and the backlog advance only with a completed
    // invocation, so a throwing invocation leaves the session where it was.
    state.mode = settings.mode
    state.gateSeq = result.gateSeq
    state.backlog = result.backlog
    try {
      deps.emit(buildGovernorRow({
        sessionId,
        gen: deps.gen,
        turn: intOf(payload?.turn),
        step: intOf(payload?.step),
        decision: result.decision,
      }))
    } catch (error: unknown) {
      // The sink is best-effort by contract (a missing ledger must never change
      // admission). It throws only after the state advanced, so it must not be
      // allowed to route this invocation into the failure path — that would
      // return the untrimmed batch while the backlog already holds its trims.
      deps.debug(`input-budget: row dropped: ${describe(error)}`)
    }
    // SPREAD the decision (never rebuild it): `startsRequestSeries` and any
    // future field survive, only the batch is replaced.
    return { ...decision, messages: result.messages }
  }

  return {
    async handler(payload, next) {
      // Delegate first, OUTSIDE the try: if the inner chain already threw, the
      // waterfall is failing and calling `next()` again would run every inner
      // listener a second time (progress-rebuild delivery.ts:151 rationale).
      const decision = await next()
      // Only an `enter` decision carries a batch. A `reject` is not a gate
      // invocation: it must not advance the clock, age the backlog or emit a row
      // for a batch that does not exist.
      if (decision?.kind !== 'enter') return decision
      let sessionId: string | undefined
      let mode: InputBudgetMode = 'observe'
      try {
        sessionId = sessionIdOf(payload?.agent)
        const settings = deps.readSettings()
        mode = settings.mode
        // Disabled is a full no-op — no row, no clock tick, no queue change.
        if (!settings.enabled) return decision
        // An unattributable batch has no session clock to age against: never
        // gate it blind, and never emit a row under a guessed session id.
        if (sessionId === undefined) return decision
        return governBatch(payload, decision, settings, sessionId)
      } catch (error: unknown) {
        deps.debug(`input-budget: degraded to passthrough: ${describe(error)}`)
        if (sessionId !== undefined) {
          try {
            deps.emit(buildGovernorRow({
              sessionId,
              gen: deps.gen,
              turn: intOf(payload?.turn),
              step: intOf(payload?.step),
              mode,
              error: true,
            }))
          } catch (emitError: unknown) {
            // The sink is best-effort; a failure there must not escape either.
            deps.debug(`input-budget: error row dropped: ${describe(emitError)}`)
          }
        }
        return decision
      }
    },
    stateOf(sessionId) {
      return sessions.get(sessionId)
    },
    forget(session) {
      const scope = objectOf(session)
      const sessionId = idOf(scope?.id) ?? idOf(objectOf(scope?.header)?.id)
      if (sessionId !== undefined) sessions.delete(sessionId)
    },
  }
}

/** Test/consumer seams of {@link registerGovernorListener}. */
export interface GovernorListenerOverrides {
  /** Replace the hot settings read (default: the raw user-layer file). */
  readSettings?: () => InputBudgetSettings
  /** Replace the row sink (default: drop — the ledger slice wires it). */
  emit?: (row: GovernorRow) => void
  /** Replace the process boot id stamped into rows. */
  gen?: string
  /** Pre-trim pipeline stages (doc 7); empty in this slice. */
  hooks?: readonly GovernorStageHook<GovernedMessage>[]
}

/** Guarded dsh-home read: cordis throws on the property access itself when absent. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    const resolve = ctx.dshHomePath
    return resolve === undefined ? undefined : resolve()
  } catch {
    return undefined
  }
}

/**
 * Register one listener on the event chain through the untyped surface
 * (input-ledger `mount.ts` idiom): the event name belongs to a harness
 * augmentation this package deliberately does not import.
 */
function listen(
  ctx: Context,
  event: string,
  listener: never,
  options: { prepend?: boolean } | undefined,
): () => unknown {
  const on = ctx.on as unknown as (
    name: string,
    handler: unknown,
    options?: { prepend?: boolean },
  ) => () => unknown
  return on.call(ctx, event, listener, options)
}

/**
 * Register the governor on a context — what the preset's `input-budget` row
 * mounts through {@linkcode apply}.
 *
 * The listener is prepended, so it runs outermost among the preset's
 * `agent/pre-step` rewriters and sees the final batch on the way back out.
 *
 * @param ctx - the preset (or any) context mounting the governor.
 * @param overrides - test seam; production callers pass nothing.
 * @returns the release handle that unregisters the listeners.
 */
export function registerGovernorListener(
  ctx: Context,
  overrides: GovernorListenerOverrides = {},
): () => void {
  const home = dshHomeOf(ctx)
  const debug = (message: string): void => {
    try {
      ctx.logger.debug(message)
    } catch {
      // Debug sink failures are swallowed by contract.
    }
  }
  try {
    registerSettings(ctx)
  } catch (error: unknown) {
    debug(`input-budget: settings namespace registration failed: ${describe(error)}`)
  }
  const listener = createGovernorListener({
    // Hot read per gate invocation: a settings edit applies on the next step.
    // No home (a bare test host) means the ship defaults, i.e. observe mode.
    readSettings: overrides.readSettings
      ?? (() => (home === undefined ? DEFAULT_INPUT_BUDGET_SETTINGS : readUserSettingsSync(home))),
    emit: overrides.emit ?? (() => {
      // Row sink seam: this slice builds the row, the ledger slice persists it.
    }),
    gen: overrides.gen ?? randomUUID(),
    debug,
    hooks: overrides.hooks,
  })
  const disposers: Array<() => unknown> = [
    // prepend: true — cordis unshifts prepended listeners, so this one runs
    // OUTERMOST and rewrites the decision after every inner listener returned.
    listen(ctx, 'agent/pre-step', listener.handler as never, { prepend: true }),
    listen(ctx, 'session/disposed', ((session: unknown): void => {
      listener.forget(session)
    }) as never, undefined),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error: unknown) {
        debug(`input-budget: listener disposal failed: ${describe(error)}`)
      }
    }
  }
}
