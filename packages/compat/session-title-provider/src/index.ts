/**
 * CC host-plane first-prompt session-title provider: mirrors the stock
 * `session-title-first-prompt-llm` plugin but stamps the auxiliary route from
 * the CC model-alias cheap lane — `resolveAlias(ctx, 'haiku')` — before the
 * shared `executeSessionTitleLlm` call. An explicit `provider`+`model` config
 * pair still wins; with neither configured the request's logged main route is
 * inherited. Title wording and parsing belong to this package; the shared
 * module owns only execution controls.
 * @module @dsh-cc/session-title-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
  type SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'
import {
  executeSessionTitleLlm,
  resolveSessionTitleLlmConfig,
  SessionTitleLlmConfigFields,
  type ResolvedSessionTitleLlmConfig,
  type SessionTitleLlmConfig,
  type SessionTitleLlmResponse,
} from '@deepseek-ai/dsh-session-title-llm'
import { resolveAlias, toOneShotRoute } from '@dsh-cc/model-aliases'
import { writeTitleSidecar } from '@dsh-cc/memory'

export const name = 'cc-session-title-provider'
export const inject = ['sessionTitle', 'llm', 'sessions']

/** Required execution controls plus this provider's title-length targets; no defaults. */
export interface Config extends SessionTitleLlmConfig {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
}

/** Loader schema for this provider's required execution controls and title-length targets. */
/* jscpd:ignore-start -- Loader requires each plugin to export its own statically walkable schema; the field validators remain shared. */
export const Config: z<Config> = z.object({
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
  provider: SessionTitleLlmConfigFields.provider,
  model: SessionTitleLlmConfigFields.model,
})
/* jscpd:ignore-end */

/** Validated immutable provider policy. */
interface ResolvedConfig extends ResolvedSessionTitleLlmConfig {
  readonly targetWords: number
  readonly targetCjkCharacters: number
}

/**
 * Stamp the auxiliary route: explicit `provider`+`model` config wins; otherwise
 * the configured `haiku` alias (a string-form, model-only alias inherits the
 * missing provider from the logged main-request route); otherwise the main
 * request route (empty stamp).
 */
function stampRoute(ctx: Context, config: Config, parent?: { provider?: string; model?: string }): Config {
  if (config.provider !== undefined && config.model !== undefined) return config
  const filled = toOneShotRoute(resolveAlias(ctx, 'haiku'), parent)
  if (filled !== undefined) return { ...config, provider: filled.provider, model: filled.model }
  return config
}

/** Validate one positive title-length target. */
function assertTarget(name: 'targetWords' | 'targetCjkCharacters', value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`cc-session-title-provider: ${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate the shared execution controls and this provider's title-length targets.
 * @param config - untrusted plugin configuration.
 * @returns immutable provider policy.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const { targetWords, targetCjkCharacters, ...execution } = config
  return {
    ...resolveSessionTitleLlmConfig(execution),
    targetWords: assertTarget('targetWords', targetWords),
    targetCjkCharacters: assertTarget('targetCjkCharacters', targetCjkCharacters),
  }
}

/** Select the route's least supported reasoning effort for a title call. */
const selectReasoningEffort = (model: Readonly<LlmResolvedModelInfo>): ReasoningEffortId | undefined =>
  model.reasoning?.efforts[0]?.id

/** Language-aware system instruction for a title derived from one message. */
function systemPrompt(config: ResolvedConfig): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
  ].join('\n')
}

/** Frame the selected messages as JSON so user text cannot break structural delimiters. */
function frameMessages(messages: readonly SessionTitleUserMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/** Asterisk emphasis wrapping a whole line, such as `**Title**`. */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u

/**
 * Take the title from model output: the first non-empty line, without
 * asterisk emphasis that wraps that whole line. Models that disregard the
 * one-line instruction put the title first and commentary after it. A line
 * that is entirely `*` emphasis loses the marker pair even when the model
 * meant it literally; the inner-marker check keeps emphasis inside a longer
 * line, and the system instruction forbids Markdown.
 */
function titleFromOutput(text: string): string {
  const line = text.split(/\r?\n/u).map(item => item.trim()).find(item => item.length > 0) ?? ''
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups
  const marker = groups?.['marker']
  const inner = groups?.['inner']
  return marker === undefined || inner === undefined || inner.includes(marker) ? line : inner
}

/** Reject terminal tool-call or max-token outcomes and derive one non-empty title from the text blocks. */
function titleFromResponse(response: SessionTitleLlmResponse): string {
  switch (response.finish.kind) {
    case 'stop':
      break
    case 'tool-calls':
      throw new Error('cc-session-title-provider: title output must contain text only')
    case 'max-tokens':
      throw new Error('cc-session-title-provider: title output reached maxOutputTokens')
  }
  if (response.blocks.some(block => block.type === 'tool-call')) {
    throw new Error('cc-session-title-provider: title output must contain text only')
  }
  const text = response.blocks
    .filter((block): block is Extract<(typeof response.blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  // The service applies `maxTitleBytes` afterwards; this only strips control
  // codes, collapses whitespace, and guarantees visible characters remain.
  const title = normalizeSessionTitle(titleFromOutput(text), Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('cc-session-title-provider: title model produced no text')
  return title
}

/**
 * Register the CC first-prompt model provider.
 * @param ctx - context exposing session-title, LLM, and session services.
 * @param config - required route, target, byte, token, and timeout policy.
 */
export function apply(ctx: Context, config: Config): void {
  const titleProvider = SessionTitleProviderId(name)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic: 'first-prompt',
    async generate(request) {
      const first = request.messages[0]
      if (first === undefined) throw new Error('first-prompt title provider requires one human message')
      const stamped = resolveConfig(stampRoute(ctx, config, request.route))
      const response = await executeSessionTitleLlm(ctx, stamped, request, titleProvider, {
        system: systemPrompt(stamped),
        input: frameMessages([first]),
        messageSeqs: [first.seq],
        selectReasoningEffort,
      })
      const result = {
        title: titleFromResponse(response),
        messageSeqs: [first.seq],
        model: response.model,
      }
      // Best-effort sidecar so the /resume listing skips the expensive cold
      // title read. `header.cwd` is optional in the harness Session type; an
      // absent one falls back to the host process cwd.
      writeTitleSidecar(request.session.header.cwd ?? process.cwd(), String(request.session.id), result.title)
      return result
    },
  })
}
