/**
 * CC host-plane first-prompt session-title provider: mirrors the stock
 * `session-title-first-prompt-llm` plugin but stamps the auxiliary route from
 * the CC model-alias cheap lane — `resolveAlias(ctx, 'haiku')` — before the
 * shared `generateSessionTitleWithLlm` call. An explicit `provider`+`model`
 * config pair still wins; with neither configured the request's logged main
 * route is inherited.
 * @module @dsh-cc/session-title-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import {
  generateSessionTitleWithLlm,
  resolveSessionTitleLlmConfig,
  SessionTitleLlmConfigFields,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'
import { resolveAlias, toOneShotRoute } from '@dsh-cc/model-aliases'

export const name = 'cc-session-title-provider'
export const inject = ['sessionTitle', 'llm', 'sessions']

/** Required LLM policy; this plugin adds no defaults. */
export type Config = SessionTitleLlmConfig
/** Loader schema shared with the harness title providers. */
/* jscpd:ignore-start -- Loader requires each plugin to export its own statically walkable schema; the field validators remain shared. */
export const Config: z<Config> = z.object({
  targetWords: SessionTitleLlmConfigFields.targetWords,
  targetCjkCharacters: SessionTitleLlmConfigFields.targetCjkCharacters,
  maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
  provider: SessionTitleLlmConfigFields.provider,
  model: SessionTitleLlmConfigFields.model,
})
/* jscpd:ignore-end */

/**
 * Stamp the auxiliary route: explicit `provider`+`model` config wins; otherwise
 * the configured `haiku` alias (a string-form, model-only alias inherits the
 * missing provider from the logged main-request route); otherwise the main
 * request route (empty stamp).
 */
function stampRoute(ctx: Context, config: Config, parent?: { provider?: string; model?: string }): SessionTitleLlmConfig {
  if (config.provider !== undefined && config.model !== undefined) return config
  const filled = toOneShotRoute(resolveAlias(ctx, 'haiku'), parent)
  if (filled !== undefined) return { ...config, provider: filled.provider, model: filled.model }
  return config
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
      return generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig(stampRoute(ctx, config, request.route)),
        request,
        [first],
        titleProvider,
      )
    },
  })
}
