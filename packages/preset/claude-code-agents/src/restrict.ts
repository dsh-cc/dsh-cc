/**
 * Effective tool restriction from Claude Code's `tools` allow-list and
 * `disallowedTools` deny-list, and the `model: inherit` normalization.
 *
 * A Claude Code agent's `tools` narrows the visible global tool set while its
 * `disallowedTools` removes specific members — including members the `tools`
 * list names. In harness terms both compile to one scoped
 * {@link ToolRestriction} (`allow` from `tools`, `deny` from
 * `disallowedTools`) passed to a scoped `ctx.tools.restrict()`. Because
 * restrictions INTERSECT with every sibling and inherited restriction, a name
 * in both `allow` and `deny` is denied: the agent sees only tools its `allow`
 * admits that no `deny` removes.
 *
 * Claude Code tool names are translated to harness tool names at this
 * boundary via `translateToolNames`. The mapping is one-to-many (e.g. `Read`
 * → `read` + `read_image`, so denying `Read` denies both). Unknown names pass
 * through verbatim so `tools.restrict()` fails loudly at agent-load time with
 * its own clear error rather than silently dropping a typo.
 *
 * @module @dsh-cc/claude-code-agents/restrict
 */

import { translateToolNames } from '@dsh-cc/tools'
import type { ToolRestriction } from './types.ts'

/**
 * Combine a sorted unique tool allow/deny pair into one effective restriction.
 * `deny` wins over `allow` when a name appears in both (restrictions
 * intersect). Omission of both yields no restriction (`undefined`).
 * @param tools - the `tools`/`disallowedTools` normalize root this came from.
 *   Absent when neither key was declared.
 * @returns the effective restriction, or `undefined` when neither key existed.
 * @throws when `tools` or `disallowedTools` held an element that is not a string.
 */
export function resolveToolRestriction(
  tools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined,
): ToolRestriction | undefined {
  if (tools === undefined && disallowedTools === undefined) return undefined
  if (tools !== undefined) assertStringArray(tools, 'tools')
  if (disallowedTools !== undefined) assertStringArray(disallowedTools, 'disallowedTools')
  const allow = tools !== undefined ? translateToolNames(tools, 'strict') : undefined
  const deny = disallowedTools !== undefined ? translateToolNames(disallowedTools, 'strict') : undefined
  return {
    ...allow !== undefined ? { allow } : {},
    ...deny !== undefined ? { deny } : {},
  }
}

/**
 * Assert a tool name array is non-empty when present, so an agent that claims
 * a restriction actually names one — a materialized-empty config almost always
 * hides an authoring mistake, and an empty split-set equals no restriction.
 * @param names - the array to validate.
 * @param key - the frontmatter key the array came from, for the error.
 * @throws when the array holds a non-string element.
 */
function assertStringArray(names: readonly string[], key: string): void {
  for (const name of names) {
    if (typeof name !== 'string') {
      throw new Error(`${key} must name tools as strings, got ${String(name)}`)
    }
  }
}

/**
 * Normalize a `model` frontmatter value: trim it and lowercase the sentinel so
 * `Inherit`, `INHERIT`, and `inherit` all mean the same thing, exactly as
 * Claude Code does.
 * @param model - the raw `model` value, or `undefined`.
 * @returns the normalized model, or `undefined` when absent or blank.
 * @throws when `model` is present but not a string.
 */
export function normalizeModel(model: unknown): string | undefined {
  if (model === undefined) return undefined
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new Error('model must be a non-empty string')
  }
  const trimmed = model.trim()
  return trimmed.toLowerCase() === 'inherit' ? 'inherit' : trimmed
}
