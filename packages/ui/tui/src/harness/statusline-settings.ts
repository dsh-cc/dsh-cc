/**
 * Pure settings module for the custom status line: the `statusline` settings
 * namespace (the cascade aliases CC's camelCase `statusLine` key onto it), a
 * tolerant schema, and the activation/normalization predicate. No driver or
 * shell imports — this file is the seam-free half of the feature.
 * @module @dsh-cc/tui/harness/statusline-settings
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace carrying the status-line section (kebab-case). */
export const STATUSLINE_SETTINGS_NAMESPACE = settingsNamespace('statusline')

/** Raw (unresolved) settings section for the status line, CC-shaped and open. */
export type StatusLineSection = {
  type?: unknown
  command?: unknown
  padding?: unknown
  refreshInterval?: unknown
  hideVimModeIndicator?: unknown
  [key: string]: unknown
}

/**
 * Tolerant schema for the `statusline` section: every known key is optional,
 * unknown sibling keys pass through (schemastery objects are non-strict by
 * default), and a missing section resolves to `{}` — a shared CC settings
 * file never hard-fails the cascade over extra keys.
 */
export const STATUSLINE_SECTION_SCHEMA: z<StatusLineSection> = z.object({
  type: z.any(),
  command: z.any(),
  padding: z.any(),
  refreshInterval: z.any(),
  hideVimModeIndicator: z.any(),
})

/** Tolerant resolution of a raw section into the known shape (unknown keys kept). */
export function statusLineSectionSchema(raw: StatusLineSection | undefined): StatusLineSection {
  if (typeof raw !== 'object' || raw === null) return {}
  return STATUSLINE_SECTION_SCHEMA(raw)
}

/** Normalized, activated status-line configuration. */
export type StatusLineDescription =
  | { active: true; command: string; padding: number; refreshIntervalSec?: number; hideVimModeIndicator?: boolean }
  | { active: false }

/**
 * Apply the §3.1 activation predicate + clamps to a resolved section:
 * activates iff `type === 'command'` and `command` is a non-empty string;
 * `padding` defaults to 0 with negatives clamped to 0; `refreshInterval` is
 * SECONDS with values < 1 clamped to 1; `hideVimModeIndicator` is parsed but
 * behaviorally inert (no Vim mode in dsh-cc).
 */
export function describeStatusLine(section: StatusLineSection | undefined): StatusLineDescription {
  if (typeof section !== 'object' || section === null) return { active: false }
  const { type, command, padding, refreshInterval, hideVimModeIndicator } = section
  if (type !== 'command' || typeof command !== 'string' || command.trim().length === 0) {
    return { active: false }
  }
  const description: StatusLineDescription = {
    active: true,
    command,
    padding: typeof padding === 'number' && Number.isFinite(padding) && padding > 0 ? padding : 0,
  }
  if (typeof refreshInterval === 'number' && Number.isFinite(refreshInterval)) {
    description.refreshIntervalSec = refreshInterval < 1 ? 1 : refreshInterval
  }
  if (hideVimModeIndicator === true) description.hideVimModeIndicator = true
  return description
}
