/**
 * The auto-mode permission classifier's llm stream adapter.
 *
 * Extracted from the plugin `index` to stay under the file-size budget. The
 * adapter is the seam between the classifier's plain-text one-shot call and
 * the harness `llm` service; it resolves the lane's reasoning effort per
 * resolved route (catalog-validated route-explicit effort, else the first
 * declared — lowest — level) and memoizes the result per route key so
 * steady-state classification never re-hits `resolveModelInfo`.
 *
 * @module @dsh-cc/permission-rules/classifier-lane
 */

import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** The one-shot text completion face the classifier stage calls. */
export type ClassifierStream = (options: {
  provider: string
  model: string
  system: string
  prompt: string
  maxTokens: number
  reasoningEffort?: string
  signal?: AbortSignal
}) => Promise<string>

/** The harness `llm` service face this module needs (no dsh-llm import of the service). */
export type ClassifierLlm = {
  resolveModelInfo(provider: string, model: string): Promise<{
    reasoning?: { efforts: readonly { id: string }[] }
  }>
  stream(options: {
    provider: string
    model: string
    system: string
    messages: ReturnType<typeof createUserMessage>[]
    maxTokens: number
    reasoningEffort?: ReasoningEffortId
    signal?: AbortSignal
  }): AsyncIterable<StreamChunk>
}

/**
 * Build the classifier's stream adapter over a mounted llm service.
 * @param llm - the llm service from the `ctx.inject(['llm'])` scope.
 * @param warn - process-warning sink (plugin logger); the lane never throws.
 * @returns the stream adapter with per-route-key memoized effort resolution.
 */
export function createClassifierStreamAdapter(llm: ClassifierLlm, warn: (message: string) => void): ClassifierStream {
  // Memo of the validated effort per resolved route key
  // (`provider\0model\0effort`), negative results included, so steady-state
  // classification does not re-hit resolveModelInfo per decision.
  const memo = new Map<string, string | undefined>()
  return async (opts) => {
    const key = `${opts.provider}\u0000${opts.model}\u0000${opts.reasoningEffort ?? ''}`
    let effort = memo.get(key)
    if (effort === undefined && !memo.has(key)) {
      try {
        const info = await llm.resolveModelInfo(opts.provider, opts.model)
        const efforts = info.reasoning?.efforts
        if (efforts !== undefined && efforts.length > 0) {
          if (opts.reasoningEffort !== undefined) {
            if (efforts.some(candidate => candidate.id === opts.reasoningEffort)) {
              effort = opts.reasoningEffort
            } else {
              // Never throw, never drop silently: one warn line, field omitted.
              warn(`permission-rules: classifier effort "${opts.reasoningEffort}" is not supported by ${opts.provider}/${opts.model}; omitting reasoningEffort`)
            }
          } else {
            // No explicit effort: take the FIRST declared level. Adapter
            // display order is escalation order (harness llm catalog), so
            // efforts[0] is the lowest/cheapest lane — exactly what a
            // classifier wants.
            effort = efforts[0]!.id
          }
        }
      } catch (error) {
        warn(`permission-rules: route info for classifier ${opts.provider}/${opts.model} failed (${String(error)}); omitting reasoningEffort`)
      }
      memo.set(key, effort)
    }
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: opts.provider,
      model: opts.model,
      system: opts.system,
      messages: [createUserMessage({
        content: [{ type: 'text', text: opts.prompt }],
        source: { kind: 'plugin', plugin: 'permission-rules' },
      })],
      maxTokens: opts.maxTokens,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    })) {
      assembler.push(chunk)
    }
    return assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .trim()
  }
}
