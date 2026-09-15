/**
 * First-class auxiliary-LLM primitive: a one-shot, non-streaming, fail-soft
 * side query over a cheap-lane alias route. Library package — no listeners,
 * no preset mount; consumers carry their own registrations.
 *
 * Semantics (design doc §4): never throws; tool-call blocks rejected by
 * default; `AbortSignal.timeout(timeoutMs)` composed with the caller's signal
 * via `AbortSignal.any` and both aborts map to `reason: 'timeout'`;
 * unfillable route → `'unrouted'` (with the `inherit` fallback running on the
 * parent route); empty assembled text → `'empty'`; any other failure →
 * `'error'`.
 *
 * @module @dsh-cc/side-query
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveAlias, toOneShotRoute } from '@dsh-cc/model-aliases'

/** Options for {@link runSideQuery}. */
export interface SideQueryOptions {
  /**
   * Calling agent; REQUIRED. Route/provider fill follows the web-fetch
   * precedent: a string-form alias needs the calling agent's requestHeader()
   * to complete the provider half of the one-shot route.
   */
  agent: Agent
  /** Model alias consulted through ccModelRoutes/resolveAlias. Default 'haiku'. */
  alias?: string
  /** System prompt for the one-shot. */
  system?: string
  /** User prompt content (fully assembled by the caller). */
  prompt: string
  /** Hard token budget. Default 512. */
  maxTokens?: number
  /** Wall-clock budget; aborts the stream. Default 8000. */
  timeoutMs?: number
  /**
   * Caller-owned abort signal (e.g. the host plugin's effect-scope disposal);
   * composed with the internal timeout. Never a tool-scoped exec.signal.
   */
  signal?: AbortSignal
  /**
   * Behavior when the alias resolves to nothing (unconfigured + no parent
   * route to inherit, or provider half cannot be completed). Default
   * 'inherit'; 'skip' returns `{ ok: false, reason: 'unrouted' }` without
   * touching the model.
   */
  onUnrouted?: 'inherit' | 'skip'
  /** Reject results whose stream emits tool-call blocks. Default true. */
  rejectToolCalls?: boolean
}

/** Result of {@link runSideQuery}; every failure shape collapses into `ok: false`. */
export type SideQueryResult =
  | { ok: true; text: string; inheritedRoute: boolean; durationMs: number }
  | { ok: false; reason: 'unrouted' | 'timeout' | 'error' | 'empty'; inheritedRoute?: boolean }

const DEFAULT_ALIAS = 'haiku'
const DEFAULT_MAX_TOKENS = 512
const DEFAULT_TIMEOUT_MS = 8000

/**
 * Run one non-streaming side query on the cheap lane (or the inherited parent
 * route). Never throws.
 * @param ctx - the host context (needs `llm` mounted; `ccModelRoutes` optional).
 * @param opts - the side query declaration.
 * @returns the assembled text, or a failure reason.
 */
export async function runSideQuery(ctx: Context, opts: SideQueryOptions): Promise<SideQueryResult> {
  const start = Date.now()
  try {
    const alias = opts.alias ?? DEFAULT_ALIAS
    const route = resolveAlias(ctx, alias)
    // The calling agent's logged request header fills the provider half for a
    // string-form (model-only) alias (web-fetch precedent).
    const parent = opts.agent?.session?.requestHeader?.()?.config as
      | { provider?: string; model?: string }
      | undefined
    const filled = toOneShotRoute(route, parent)
    let provider: string | undefined = filled?.provider
    let model: string | undefined = filled?.model
    // Builtin alias unconfigured → inherit the parent route (default), unless
    // the caller opts out or no parent route exists to inherit.
    const inherited = filled === undefined
    if (inherited) {
      if (opts.onUnrouted === 'skip' || parent?.provider === undefined || parent?.model === undefined) {
        return { ok: false, reason: 'unrouted' }
      }
      provider = parent.provider
      model = parent.model
    }
    provider = provider ?? ''
    model = model ?? ''

    if (opts.signal?.aborted) return { ok: false, reason: 'timeout' }
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = opts.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([timeoutSignal, opts.signal])

    const assembler = new BlockAssembler()
    const options = {
      provider,
      model,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(opts.system === undefined ? {} : { system: opts.system }),
      messages: [createUserMessage({
        content: [{ type: 'text', text: opts.prompt }],
        source: { kind: 'plugin', plugin: 'side-query' },
      })],
      signal,
    }
    const consume = (async () => {
      for await (const chunk of ctx.llm.stream(options) as AsyncIterable<StreamChunk>) {
        assembler.push(chunk)
      }
    })()
    // Dangling-stream safety: after a timeout win the dangling consume may
    // still reject; swallow its rejection (the abort path owns the result).
    void consume.catch(() => {})
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
    await Promise.race([consume, aborted])
    if (signal.aborted) return { ok: false, reason: 'timeout' }

    // The runtime normalizes an adapter throw into a terminal `finish` chunk
    // with kind 'error'; surface it instead of misreading it as 'empty'.
    if (assembler.finish?.kind === 'error') return { ok: false, reason: 'error' }
    // A side query that tries to act is a bug, not a capability (recall-selector
    // rogue-execution lesson); rejectToolCalls defaults true.
    if ((opts.rejectToolCalls ?? true)
      && (assembler.finish?.kind === 'tool-calls'
        || assembler.blocks().some(block => block.type === 'tool-call'))) {
      return { ok: false, reason: 'error' }
    }
    const text = assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join(' ')
      .trim()
    if (text.length === 0) return { ok: false, reason: 'empty' }
    return { ok: true, text, inheritedRoute: inherited, durationMs: Date.now() - start }
  } catch {
    return { ok: false, reason: 'error' }
  }
}
