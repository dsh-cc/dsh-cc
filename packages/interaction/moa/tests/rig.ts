/**
 * Shared test rig for the moa routing specs (harness-0.2.2 D3.2 form): a
 * manual MoaCore (settings/arming/bookkeeping), a fake `ccModelRoutes`
 * resolver, a canned System One `fetchImpl` (the judge lane never goes
 * through the llm adapter registry — design §3.6), and a fake agent face
 * with an AgentModel work-alike (`current()`/`select()` over an in-memory
 * recorded selection with the creation-options fallback).
 *
 * Specs drive the NEW seams: `admit(opening)` (the entry-point admission
 * seam), `claim(turn, messages)` (the inbox/claimed bind + floor restore),
 * plus the pre-step row delivery — no more assemble seam or `agent/request`
 * overlay listener.
 * @module
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { BoundDecisionRunner } from '@dsh-cc/systemone'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ResolvedRoute } from '@dsh-cc/model-aliases'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore, type MoaSettings } from '../src/index.ts'
import { DEFAULT_CONTEXT_ROUTING_SETTINGS } from '../src/context-settings.ts'
import { resetRuntimeCore, setRuntimeCore } from '../src/runtime-state.ts'
import { createRequestRouter, textOf, type ArmingValidation, type RouterDeps } from '../src/router.ts'

/** Boot-default pair the rig's creation options carry. */
export const BOOT_PAIR = { provider: 'mock', model: 'mock' }

/**
 * The fake `gauge` System One route the default judge alias resolves to. The
 * model carries a gateway-style prefix on purpose: the wire field must equal
 * it verbatim — never re-prefixed with the provider.
 */
export const GAUGE_ROUTE: ResolvedRoute = { provider: 'gw', model: 'gw/judge-model', protocol: 'systemone' }

/** The four-tier fake resolver: every alias resolves to a distinct model. */
export const routes = (): {
  resolve: (alias: string | undefined) => ResolvedRoute | undefined
} => ({
  resolve: (alias) =>
    alias === undefined ? { ...BOOT_PAIR } : alias === 'gauge' ? { ...GAUGE_ROUTE } : { provider: 'mock', model: `tier-${alias}` },
})

/** Probabilities with `draft` the argmax. */
export const DRAFT_PROBABILITIES = { sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 }

/**
 * The label a legal Choice envelope must carry: the strict System One
 * validator rejects a chosen option that trails the probability maximum, so a
 * fixture always derives `choice` from the distribution it serves.
 */
export function argmaxLabel(probabilities: Record<string, number>): string {
  let best = ''
  let bestProbability = -Infinity
  for (const [label, probability] of Object.entries(probabilities)) {
    if (probability > bestProbability) {
      bestProbability = probability
      best = label
    }
  }
  return best
}

/** An AgentModel work-alike for listener-level rigs. */
export interface FakeAgentModel {
  /** Every recorded durable select, in order. */
  selections: ModelSelection[]
  current(): ModelSelection | undefined
  select(selection: ModelSelection): void
}

/** The rig's fake agent (structural Agent face for the router seams). */
export interface FakeAgent {
  options: { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
  model: FakeAgentModel
  session: {
    header: Record<string, unknown>
    /** undefined = fresh session (no prior requests); a config = resumed. */
    requestHeader(): { config: Record<string, unknown> } | undefined
    snapshotEvents(): readonly unknown[]
    id: string
  }
  followups: UserMessage[]
  followup(message: UserMessage): void
}

export interface Rig {
  core: MoaCore
  router: ReturnType<typeof createRequestRouter>
  agent: FakeAgent
  /** One entry per System One call: the parsed request state. */
  classifyStates: string[]
  /** One entry per System One call: the wire `model` field (gateway contract). */
  classifyModels: string[]
  fetchError: Error | undefined
  warnings: string[]
  ledger: string
  /** The entry-point admission seam on the rig's agent (D3.2). */
  admit: (opening: UserMessage) => Promise<void>
  /** The claimed-listener drive (bind + floor restore + capture). */
  claim: (turn: number, messages: UserMessage[]) => Promise<void>
  /** Drive the pre-step row delivery; returns the decision messages. */
  deliverRows: (messages?: UserMessage[]) => Promise<UserMessage[]>
  /** Set the creation-options effort (the pre-route live effort). */
  setOptionsEffort: (effort: string | undefined) => void
  /** Mark the session RESUMED (a prior request header exists / not). */
  setResumed: (resumed: boolean, pair?: { provider: string; model: string }) => void
  setResolveEfforts: (resolve: NonNullable<RouterDeps['resolveEfforts']>) => void
  settings: MoaSettings
}

export interface RigOptions {
  enabled?: boolean
  probabilities?: Record<string, number>
  validation?: ArmingValidation
  ledger?: string
  /** First fetchImpl call fails with this error (P3b). */
  failFetch?: Error
  /** Returned usage.input_tokens (truncation sentinel tests). */
  inputTokens?: number
  /** Creation-options route; defaults to BOOT_PAIR. */
  bootPair?: { provider: string; model: string }
  /** Creation-options effort. */
  effort?: string
  /** S1-09 context routing: the per-use decision-runner binding. */
  contextDecisions?: ((agent: unknown) => BoundDecisionRunner | undefined) | undefined
}

export function makeRig(options: RigOptions = {}): Rig {
  // The capture map, claimed-turn, sticky-tier, pending-row, admission entry,
  // and tripwire slots are process-global runtime state — start clean.
  resetRuntimeCore()
  // The nested `context-routing` section is re-cloned per rig: the shallow
  // spread above would otherwise share ONE defaults object across the whole
  // spec process, leaking a mode/threshold change into unrelated rigs.
  const settings: MoaSettings = {
    ...DEFAULT_MOA_SETTINGS,
    enabled: options.enabled ?? true,
    contextRouting: { ...DEFAULT_CONTEXT_ROUTING_SETTINGS },
  }
  const core: MoaCore = {
    arming: new ArmingMachine(() => settings.enabled),
    bookkeeping: new EscalationBookkeeping(),
    warnedReasons: new Set<string>(),
  }
  core.arming.arm()
  // The router observes through the shared runtime-state singletons; point
  // them at THIS rig's machine/validation (apply() does this in production).
  setRuntimeCore({ arming: core.arming, validation: options.validation ?? { ok: true } })
  const classifyStates: string[] = []
  const classifyModels: string[] = []
  const warnings: string[] = []
  let fetchError = options.failFetch
  let ledger = options.ledger ?? ''
  let resolveEfforts: NonNullable<RouterDeps['resolveEfforts']> | undefined
  let resumed = false
  let resumedPair = options.bootPair ?? { ...BOOT_PAIR }

  const fetchImpl: typeof fetch = async (_url, init) => {
    if (fetchError !== undefined) throw fetchError
    const body = JSON.parse(String(init?.body)) as { state: string; model?: string }
    classifyStates.push(body.state)
    classifyModels.push(body.model ?? '<missing>')
    const probabilities = options.probabilities ?? DRAFT_PROBABILITIES
    return new Response(
      JSON.stringify({
        model: GAUGE_ROUTE.model,
        answers: { route: { type: 'choice', choice: argmaxLabel(probabilities), probabilities } },
        usage: { input_tokens: options.inputTokens ?? 100, output_tokens: 5 },
      }),
      { status: 200 },
    )
  }

  const deps: RouterDeps = {
    readSettings: () => settings,
    routes: () => routes() as never,
    resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
    fetchImpl,
    ledgerPath: () => (ledger === '' ? undefined : ledger),
    logger: { warn: (message) => warnings.push(message) },
    ...(options.contextDecisions === undefined ? {} : { contextDecisions: options.contextDecisions }),
  }
  // Late-bound seam: setResolveEfforts swaps the resolver after construction.
  Object.defineProperty(deps, 'resolveEfforts', {
    get: () => resolveEfforts,
    configurable: true,
  })
  const router = createRequestRouter(core, { validation: options.validation ?? { ok: true }, deps })

  const selections: ModelSelection[] = []
  const agent: FakeAgent = {
    options: {
      ...(options.bootPair ?? { ...BOOT_PAIR }),
      ...(options.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(options.effort) }),
    },
    model: {
      selections,
      current(): ModelSelection | undefined {
        const recorded = selections.at(-1)
        if (recorded !== undefined) return { ...recorded }
        const { provider, model, reasoningEffort } = agent.options
        return provider.length > 0 && model.length > 0
          ? { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
          : undefined
      },
      select(selection: ModelSelection): void {
        selections.push({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) })
      },
    },
    session: {
      header: {},
      requestHeader() {
        return resumed ? { config: { ...resumedPair } } : undefined
      },
      snapshotEvents: () => [],
      id: 'rig-agent',
    },
    followups: [],
    followup(message: UserMessage): void {
      this.followups.push(message)
    },
  }

  return {
    core,
    router,
    agent,
    classifyStates,
    classifyModels,
    get fetchError() {
      return fetchError
    },
    set fetchError(error: Error | undefined) {
      fetchError = error
    },
    warnings,
    get ledger() {
      return ledger
    },
    set ledger(path: string) {
      ledger = path
    },
    admit: (opening) => router.routeBeforeAdmission(agent as never, opening),
    claim: async (turn, messages) => {
      // The claimed emit is per-message; the router's noteClaimed owns
      // capture + bind + escalation-floor restore (D3.2). Await the bind's
      // ledger writes so specs can assert the sidecar synchronously after.
      const writes: (Promise<void> | void)[] = []
      for (const message of messages) writes.push(router.noteClaimed(agent as never, message, turn))
      await Promise.all(writes)
    },
    deliverRows: async (messages = []) => {
      const decision = await router.preStepListener({ agent } as never, async () => ({ kind: 'enter', messages }) as never)
      return (decision as { messages: UserMessage[] }).messages
    },
    setOptionsEffort: (effort) => {
      if (effort === undefined) delete agent.options.reasoningEffort
      else agent.options.reasoningEffort = ReasoningEffortId(effort)
    },
    setResumed: (next, pair) => {
      resumed = next
      if (pair !== undefined) resumedPair = pair
    },
    setResolveEfforts: (resolve) => {
      resolveEfforts = resolve
    },
    settings,
  }
}

/** A genuine user opening message with the given text. */
export function userOpening(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A leading queued notice (e.g. an agent/created inject) — kind is NOT user. */
export function noticeOpening(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'moa', form: 'notice', summary: text } as never,
  })
}

/** A typed moa-escalation followup message (§3.4 frozen provenance). */
export function escalationOpening(text: string, originSeq: number, fromTier: number, toTier: number): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'moa-escalation', originSeq, fromTier, toTier },
  })
}

export { textOf }
