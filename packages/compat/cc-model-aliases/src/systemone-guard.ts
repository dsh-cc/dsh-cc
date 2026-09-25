/**
 * System One chat-path guard.
 *
 * System One models (the `gauge` lane) answer typed-decision questions over
 * the native `/v1/systemone` protocol; they are not generative chat models.
 * The resolver keeps that fact on the resolved route (`protocol:
 * 'systemone'`), and the `cc-model-routes` service installs one `llm/stream`
 * listener — the single layer every chat request (agent loops, spawned
 * children, and hand-built one-shots alike) passes through — that rejects a
 * System One model with {@link SystemOneChatModelError}. Legitimate System One
 * consumers (the permission-rules classifier and PI probe) speak the protocol
 * over their own client and never reach `llm/stream`, so they are unaffected.
 *
 * @module @dsh-cc/model-aliases/systemone-guard
 */

import type { AliasTarget, ModelProtocol, ResolvedRoute } from './types.ts'

/** The protocol marker value carried by System One alias targets and routes. */
export const SYSTEMONE_PROTOCOL: ModelProtocol = 'systemone'

/**
 * Model-id family prefix that identifies a System One model even without an
 * explicit `protocol` field (same heuristic as the permission-rules route
 * policy's arming check).
 */
const SYSTEMONE_MODEL_FAMILY_PREFIX = 'llmbox_systemone/'

/** Stable machine-readable code carried by {@link SystemOneChatModelError}. */
export const SYSTEMONE_CHAT_MODEL_ERROR_CODE = 'SYSTEMONE_NOT_CHAT_MODEL'

/** True when a bare model id belongs to the System One family. */
export function isSystemOneModelId(model: string | undefined): boolean {
  return model !== undefined && model.includes(SYSTEMONE_MODEL_FAMILY_PREFIX)
}

/**
 * True when one merged alias target is a System One target: an object form
 * carrying `protocol: 'systemone'`, or any form whose model id is in the
 * System One family.
 */
export function isSystemOneTarget(target: AliasTarget | undefined): boolean {
  if (target === undefined || target === null) return false
  if (typeof target === 'string') return isSystemOneModelId(target)
  return target.protocol === SYSTEMONE_PROTOCOL || isSystemOneModelId(target.model)
}

/** True when a resolved route carries the System One protocol marker. */
export function isSystemOneRoute(route: ResolvedRoute | undefined): boolean {
  return route?.protocol === SYSTEMONE_PROTOCOL
}

/** Details reported by {@link SystemOneChatModelError}. */
export interface SystemOneChatModelDetails {
  /** The model id the chat call asked for. */
  readonly model: string
  /** The provider the chat call asked for, when known. */
  readonly provider?: string | undefined
  /** The configured alias that declares this model System One, when one matched. */
  readonly alias?: string | undefined
}

/**
 * Thrown when a System One model reaches the chat path. The message names the
 * model, explains why it is rejected, and points at the supported entry point.
 */
export class SystemOneChatModelError extends Error {
  readonly code = SYSTEMONE_CHAT_MODEL_ERROR_CODE
  readonly model: string
  readonly provider: string | undefined
  readonly alias: string | undefined

  constructor(details: SystemOneChatModelDetails) {
    const where = details.provider === undefined || details.provider.length === 0
      ? `"${details.model}"`
      : `"${details.provider}/${details.model}"`
    const via = details.alias === undefined ? '' : ` (model alias "${details.alias}")`
    super(
      `System One model ${where}${via} cannot be used as a chat model: System One models only answer `
      + 'typed-decision questions over the System One protocol and cannot generate chat completions. '
      + 'Pick a chat model or alias (e.g. "haiku" or "sketch") for this Task/agent/hook/side query; '
      + 'System One models are consumed only by the permission-rules classifier and prompt-injection probe '
      + '(permission-rules `classifier.backend: "auto"` / `probe.backend: "auto"`, or `route: "gauge"`).',
    )
    this.name = 'SystemOneChatModelError'
    this.model = details.model
    this.provider = details.provider
    this.alias = details.alias
  }
}

/**
 * Find the System One declaration matching one chat request, if any: the
 * model id is in the System One family, or a merged alias target declared
 * System One names the same model (and the same provider when the target pins
 * one). Returns `undefined` for an ordinary chat model.
 * @param aliases - the effective merged alias map.
 * @param provider - the request's provider.
 * @param model - the request's model id.
 */
export function findSystemOneTarget(
  aliases: ReadonlyMap<string, AliasTarget>,
  provider: string | undefined,
  model: string | undefined,
): { alias?: string } | undefined {
  if (model === undefined || model.length === 0) return undefined
  const familyHit: { alias?: string } | undefined = isSystemOneModelId(model) ? {} : undefined
  for (const [alias, target] of aliases) {
    if (target === null || !isSystemOneTarget(target)) continue
    const targetModel = typeof target === 'string' ? target : target.model
    const targetProvider = typeof target === 'string' ? undefined : target.provider
    if (targetModel !== model) continue
    if (targetProvider !== undefined && provider !== undefined && targetProvider !== provider) continue
    return { alias }
  }
  return familyHit
}

/**
 * Chat-path assertion: throw {@link SystemOneChatModelError} when the request
 * targets a System One model. No-op for ordinary chat models.
 * @param aliases - the effective merged alias map.
 * @param request - the chat request's provider/model.
 */
export function assertChatModel(
  aliases: ReadonlyMap<string, AliasTarget>,
  request: { readonly provider?: string | undefined; readonly model?: string | undefined },
): void {
  const hit = findSystemOneTarget(aliases, request.provider, request.model)
  if (hit === undefined) return
  throw new SystemOneChatModelError({ model: request.model ?? '', provider: request.provider, alias: hit.alias })
}
