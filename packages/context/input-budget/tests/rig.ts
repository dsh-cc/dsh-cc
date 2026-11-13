/**
 * Shared test rig for the governor core: message builders, a settings builder
 * and small decoders. Not a spec file — the vitest `include` globs collect
 * `*.spec.ts` only.
 */

import {
  DEFAULT_INPUT_BUDGET_SETTINGS,
  messageBytes,
  type GovernedMessage,
  type GovernorSettings,
} from '../src/index.ts'

/**
 * One message carrying exactly `bytes` UTF-8 bytes of text content, tagged with
 * `kind` as its source kind. ASCII filler, so bytes === text length.
 */
export function messageOf(kind: string, bytes: number): GovernedMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(bytes) }],
    source: { kind },
  }
}

/** The governor knobs, every field explicit so a test never depends on default drift. */
export function settingsOf(overrides: Partial<GovernorSettings> = {}): GovernorSettings {
  return {
    mode: 'enforce',
    'enter-budget-bytes': 24_576,
    'advisory-budget-bytes': 8192,
    'memory-budget-bytes': 16_384,
    'defer-ttl-steps': 3,
    ...overrides,
  }
}

/** The ship-default settings (observe mode), for the wiring-level assertions. */
export function defaultSettings(): GovernorSettings {
  return {
    mode: DEFAULT_INPUT_BUDGET_SETTINGS.mode,
    'enter-budget-bytes': DEFAULT_INPUT_BUDGET_SETTINGS['enter-budget-bytes'],
    'advisory-budget-bytes': DEFAULT_INPUT_BUDGET_SETTINGS['advisory-budget-bytes'],
    'memory-budget-bytes': DEFAULT_INPUT_BUDGET_SETTINGS['memory-budget-bytes'],
    'defer-ttl-steps': DEFAULT_INPUT_BUDGET_SETTINGS['defer-ttl-steps'],
  }
}

/** Byte sizes of a batch, in order — the identity handle for order assertions. */
export function sizesOf(messages: readonly GovernedMessage[]): number[] {
  return messages.map((message) => messageBytes(message))
}

/** Source kinds of a batch, in order. */
export function kindsOf(messages: readonly GovernedMessage[]): string[] {
  return messages.map((message) => message.source?.kind ?? '')
}

/** Actions of a trimmed-row list, in the order the algorithm recorded them. */
export function actionsOf(row: { trimmed: { action: string }[] }): string[] {
  return row.trimmed.map((trim) => trim.action)
}
