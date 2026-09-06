/**
 * Configuration resolution and placeholder vocabulary for microcompaction.
 * @module @dsh-cc/compaction-micro/config
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig, MicrocompactConfig } from './types.ts'

/**
 * Fixed marker that opens every microcompact placeholder. Its presence in a
 * `tool/result` content's first text block is how a later pass recognizes an
 * already-collapsed result, so the decision is idempotent and the prompt stays
 * byte-identical across passes.
 */
export const MICROCOMPACT_MARKER = '[... earlier tool result compacted ...]'

/**
 * Textual lead-in for a re-embedded spill locator. When the original result
 * cited a spilled artifact (e.g. "Full grep result stored at: <locator>."), the
 * placeholder keeps that sentence so the model can still retrieve the full
 * result from disk.
 */
export const SPILL_LOCATOR_LEAD = 'Full result still available at: '

/**
 * Best-effort matcher for a rendered spill-locator sentence in tool-result
 * text. Tool renderers phrase saved artifacts as "…stored at: <locator>."; we
 * capture the locator token(s) up to the first sentence end so the placeholder
 * can reproduce the retrieval hint verbatim.
 */
const SPILL_LOCATOR_PATTERN = /stored at:\s*([^.\n]+)[.\n]/

/** Low-friction defaults for a coding-agent session. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  retainResults: 10,
  auto: false,
  placeholderChars: 256,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'retainResults',
  'auto',
  'placeholderChars',
])

/**
 * Whether a content list already carries a microcompact placeholder as its
 * first text block. Used for freeze/idempotence: an already-collapsed result is
 * never re-decided, so consecutive passes emit byte-identical prompts.
 * @param blocks - tool-result content to inspect.
 * @returns true when the first text block starts with {@link MICROCOMPACT_MARKER}.
 */
export function isMicrocompactPlaceholder(blocks: readonly { type: string; text?: string }[]): boolean {
  for (const block of blocks) {
    if (block.type !== 'text') continue
    return block.text === undefined ? false : block.text.startsWith(MICROCOMPACT_MARKER)
  }
  return false
}

/**
 * Extract a spill locator sentence from tool-result text, when present. The
 * placeholder re-embeds the first such locator so the full-result retrieval
 * handle survives compaction (model-visible ⟺ logged: the locator line is
 * carried verbatim into the replacement event, so it is reconstructable from
 * the log).
 * @param text - the original tool-result text.
 * @returns the captured locator sentence, or `undefined` when none is found.
 */
export function reuseSpillLocator(text: string): string | undefined {
  const match = SPILL_LOCATOR_PATTERN.exec(text)
  if (match === null) return undefined
  const locator = match[1]?.trim()
  if (locator === undefined || locator.length === 0) return undefined
  return `${SPILL_LOCATOR_LEAD}${locator}.`
}

/**
 * Resolve and validate microcompact configuration.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: MicrocompactConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `MicrocompactConfig: unknown key "${key}" `
        + '(allowed: retainResults, auto, placeholderChars)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    retainResults: config.retainResults ?? DEFAULTS.retainResults,
    auto: config.auto ?? DEFAULTS.auto,
    placeholderChars: config.placeholderChars ?? DEFAULTS.placeholderChars,
  }
  assertPositiveInteger('retainResults', resolved.retainResults)
  assertPositiveInteger('placeholderChars', resolved.placeholderChars)
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`MicrocompactConfig: ${name} (${value}) must be a positive integer`)
  }
}
