/**
 * Shared live rig for the listener-level legs: a REAL cordis context, the real
 * governor listener registered through its public entry point, and synthetic
 * producers registered on the same `agent/pre-step` chain, dispatched through
 * the real waterfall.
 *
 * Not a spec file — the vitest `include` globs collect `*.spec.ts` only.
 *
 * The dispatch shape mirrors the harness (`packages/core/agent/src/dispatch.ts`):
 * the agent carrier is the event's `this` value, the payload rides as the first
 * listener argument, and the innermost `next` returns the claimed batch.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  registerGovernorListener,
  type GovernedMessage,
  type GovernorRow,
  type InputBudgetSettings,
  type PreStepDecisionLike,
  type PreStepPayloadLike,
} from '../src/index.ts'
import { settingsOf } from './rig.ts'

/** The waterfall dispatch signature (`agentCarrier, name, payload, next`). */
export type LiveDispatch = (
  thisArg: object,
  name: string,
  payload: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>

/** Temp roots created by the rig, removed by {@link cleanupRigs}. */
const roots: string[] = []

/** Remove every temp root this rig created (spec `afterEach`). */
export function cleanupRigs(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** A synthetic listener: delegate-first is the caller's choice. */
export type ProducerFn = (
  payload: PreStepPayloadLike,
  next: () => Promise<PreStepDecisionLike<GovernedMessage>>,
) => Promise<PreStepDecisionLike<GovernedMessage>>

/** One live rig: the context, the settings the hot read returns, and the rows. */
export interface LiveRig {
  ctx: Context
  home: string
  /** Rows the listener emitted, in invocation order. */
  rows: GovernorRow[]
  /** The settings an in-memory read returns; mutate to flip mode/budgets. */
  settings: InputBudgetSettings
  /** Release handle of the governor registration. */
  release: () => void
  /** Register a PLAIN (non-prepend) pre-step producer on the same context. */
  producer(fn: ProducerFn): void
  /** Register a PREPENDED pre-step producer (later registration = outermost). */
  prepended(fn: ProducerFn): void
  /** Dispatch one gate invocation through the real waterfall. */
  run(
    messages: GovernedMessage[],
    options?: {
      readonly agent?: object
      readonly turn?: number
      readonly step?: number
      /** Make the innermost decision carry the optional harness field. */
      readonly startsRequestSeries?: true
    },
  ): Promise<PreStepDecisionLike<GovernedMessage>>
}

/** A fake agent face carrying one durable session id. */
export function agentOf(sessionId: string): object {
  return { session: { id: sessionId, header: { id: sessionId } } }
}

/** Seed the rig's settings from the enforce-mode test defaults. */
export function enforceSettings(overrides: Partial<InputBudgetSettings> = {}): InputBudgetSettings {
  return { enabled: true, ...settingsOf(overrides) }
}

/** Seed the rig's settings as observe mode (the ship default). */
export function observeSettings(overrides: Partial<InputBudgetSettings> = {}): InputBudgetSettings {
  return enforceSettings({ mode: 'observe', ...overrides })
}

/** How the rig resolves its settings. */
export type SettingsSource =
  /** An in-memory object the test mutates. */
  | { readonly settings: InputBudgetSettings }
  /** A `cc-input-budget` section written to `<home>/settings.json`. */
  | { readonly section: Record<string, unknown> }
  /** No settings file at all (the real reader's fail-soft path). */
  | { readonly fileless: true }

/** Rig wiring variants. */
export interface LiveRigOptions {
  /**
   * `'ledger'` keeps the SHIPPED row sink — the real input-ledger append under
   * this rig's temp home — so `rows` stays empty and the test reads the JSONL.
   */
  readonly sink?: 'collect' | 'ledger'
}

/**
 * Build one live rig.
 * @param source - how the listener resolves settings per invocation.
 * @param options - `sink: 'ledger'` keeps the SHIPPED row sink (the input-ledger
 *   append under this rig's temp home) instead of capturing rows in memory.
 */
export function liveRig(
  source: SettingsSource = { settings: enforceSettings() },
  options: LiveRigOptions = {},
): LiveRig {
  const home = mkdtempSync(join(tmpdir(), 'dsh-input-budget-'))
  roots.push(home)
  const ctx = new Context()
  // The boot-provided resolver; a file source reads <home>/settings.json.
  ctx.dshHomePath = (...segments: string[]) => join(home, ...segments)
  if ('section' in source) {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-input-budget': source.section }), 'utf8')
  }
  const settings = 'settings' in source ? source.settings : observeSettings()
  const rows: GovernorRow[] = []
  const rig: LiveRig = {
    ctx,
    home,
    rows,
    settings,
    release: () => {},
    producer(fn) {
      register(ctx, 'agent/pre-step', fn as never, undefined)
    },
    prepended(fn) {
      register(ctx, 'agent/pre-step', fn as never, { prepend: true })
    },
    async run(messages, options = {}) {
      const agent = options.agent ?? agentOf('live-session')
      const payload: PreStepPayloadLike = {
        agent,
        messages,
        turn: options.turn ?? 1,
        step: options.step ?? 1,
        signal: new AbortController().signal,
        modelSelection: {},
      }
      const next = (): Promise<PreStepDecisionLike<GovernedMessage>> =>
        Promise.resolve({
          kind: 'enter' as const,
          messages,
          ...(options.startsRequestSeries === true ? { startsRequestSeries: true as const } : {}),
        })
      const dispatch = ctx.waterfall as unknown as LiveDispatch
      return await dispatch(agent, 'agent/pre-step', payload, next) as PreStepDecisionLike<GovernedMessage>
    },
  }
  // The `settings` source keeps the real hot read: only the file-based sources
  // let the shipped reader run. The closure reads `rig.settings` on every
  // invocation, so a test flips mode/budgets between steps exactly like a hot
  // settings edit does.
  // Row collection is an override; `sink: 'ledger'` leaves the shipped
  // input-ledger emission in place so the append path itself is exercised.
  const collect = options.sink !== 'ledger'
  const overrides = collect
    ? { emit: (row: GovernorRow): void => { rows.push(row) }, gen: 'rig-gen' }
    : { gen: 'rig-gen' }
  rig.release = 'settings' in source
    ? registerGovernorListener(ctx, { readSettings: () => rig.settings, ...overrides })
    : registerGovernorListener(ctx, overrides)
  return rig
}

/** Register one listener through the untyped event surface (harness augmentation is out of scope). */
function register(
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
