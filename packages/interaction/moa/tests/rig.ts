/**
 * Shared test rig for the moa routing specs: a manual MoaCore (settings/
 * arming/bookkeeping), a fake `ccModelRoutes` resolver, a canned System One
 * `fetchImpl` (the judge lane never goes through the llm adapter registry —
 * design §3.6), and a fake agent face for listener-level tests.
 * @module
 */

import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedRoute } from '@dsh-cc/model-aliases'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore, type MoaSettings } from '../src/index.ts'
import { createOpeningCapture } from '../src/capture.ts'
import { createRequestRouter, type ArmingValidation, type RequestPayload, type RouterDeps } from '../src/router.ts'
import { textOf } from '../src/router.ts'

/** Boot-default pair the rig's fake request header reports. */
export const BOOT_PAIR = { provider: 'mock', model: 'mock' }

/** The four-tier fake resolver: every alias resolves to a distinct model. */
export const routes = (): {
  resolve: (alias: string | undefined) => ResolvedRoute | undefined
} => ({
  resolve: (alias) => (alias === undefined ? { ...BOOT_PAIR } : { provider: 'mock', model: `tier-${alias}` }),
})

/** Probabilities with `draft` the argmax. */
export const DRAFT_PROBABILITIES = { sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 }

export interface Rig {
  core: MoaCore
  capture: ReturnType<typeof createOpeningCapture>
  router: ReturnType<typeof createRequestRouter>
  /** One entry per System One call: the parsed request state. */
  classifyStates: string[]
  /** One entry per System One call: the wire `model` field (gateway contract). */
  classifyModels: string[]
  fetchError: Error | undefined
  /** Texts of every injected notice row, in order. */
  injected: { text: string; source: unknown }[]
  warnings: string[]
  ledger: string
  /** Seed the capture for a turn (drive the pre-step listener directly). */
  seedCapture: (turn: number, messages: UserMessage[]) => Promise<void>
  /** Build an agent/request payload for the rig's fake agent. */
  payload: (turn: number, step: number, headerPair?: { provider: string; model: string }) => RequestPayload
  next: () => Promise<LlmCallConfig>
  setHeaderPair: (pair: { provider: string; model: string }) => void
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
}

export function makeRig(options: RigOptions = {}): Rig {
  const settings: MoaSettings = { ...DEFAULT_MOA_SETTINGS, enabled: options.enabled ?? true }
  const core: MoaCore = {
    readSettings: () => settings,
    arming: new ArmingMachine(() => settings.enabled),
    bookkeeping: new EscalationBookkeeping(),
  }
  core.arming.arm()
  const capture = createOpeningCapture()
  const classifyStates: string[] = []
  const classifyModels: string[] = []
  const injected: { text: string; source: unknown }[] = []
  const warnings: string[] = []
  let fetchError = options.failFetch
  let headerPair = { ...BOOT_PAIR }
  let ledger = options.ledger ?? ''
  let resolveEfforts: NonNullable<RouterDeps['resolveEfforts']> | undefined

  const fetchImpl: typeof fetch = async (_url, init) => {
    if (fetchError !== undefined) throw fetchError
    const body = JSON.parse(String(init?.body)) as { state: string; model?: string }
    classifyStates.push(body.state)
    classifyModels.push(body.model ?? '<missing>')
    return new Response(
      JSON.stringify({
        model: 'llmbox_systemone/bjev',
        answers: { route: { type: 'choice', choice: 'draft', probabilities: options.probabilities ?? DRAFT_PROBABILITIES } },
        usage: { input_tokens: options.inputTokens ?? 100, output_tokens: 5 },
      }),
      { status: 200 },
    )
  }

  const deps: RouterDeps = {
    getCapturedOpening: capture.getCapturedOpening,
    routes: () => routes() as never,
    resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
    fetchImpl,
    ledgerPath: () => (ledger === '' ? undefined : ledger),
    logger: { warn: (message) => warnings.push(message) },
    ...(resolveEfforts === undefined ? {} : { resolveEfforts }),
  }
  // Late-bound seam: setResolveEfforts swaps the resolver after construction.
  Object.defineProperty(deps, 'resolveEfforts', {
    get: () => resolveEfforts,
    configurable: true,
  })
  const router = createRequestRouter(core, { validation: options.validation ?? { ok: true }, deps })

  const fakeAgent = {
    session: { requestHeader: () => ({ config: { ...headerPair } }) },
    inject: (message: UserMessage) => {
      injected.push({ text: textOf(message), source: message.source })
    },
  }

  return {
    core,
    capture,
    router,
    classifyStates,
    classifyModels,
    get fetchError() {
      return fetchError
    },
    set fetchError(error: Error | undefined) {
      fetchError = error
    },
    injected,
    warnings,
    get ledger() {
      return ledger
    },
    set ledger(path: string) {
      ledger = path
    },
    seedCapture: async (turn, messages) => {
      await capture.listener({ messages, turn } as never, async () => ({}))
    },
    payload: (turn, step, pair) => ({
      agent: fakeAgent as never,
      turn,
      step,
      signal: new AbortController().signal,
      ...((pair === undefined ? {} : { headerPairOverride: pair }) as never),
    }),
    next: async () =>
      ({ provider: 'mock', model: 'mock', messages: [], reasoningEffort: 'max' }) as unknown as LlmCallConfig,
    setHeaderPair: (pair) => {
      headerPair = pair
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
