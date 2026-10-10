/**
 * Typed provenance for moa status rows (design §3.1/§3.5): a visible,
 * non-human-input `user/message` whose `MessageSourceMap` kind is `moa` with
 * `form: 'notice'` + `summary` — the same TUI-visible notice shape the
 * mcpReadyNotice / model-switch precedents use. The payload stays free-form;
 * `tier` (when present) names the applied tier index for diagnostics.
 *
 * The escalation followup keeps its own kind (`moa-escalation`, src/state.ts).
 *
 * @module
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'

/** Module augmentation for the moa status-row source. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    moa: { kind: 'moa'; form?: 'notice'; summary?: string; tier?: number }
  }
}

/** Build the notice source for a moa status row. */
export function moaNoticeSource(text: string, tier?: number): MessageSource {
  return tier === undefined
    ? { kind: 'moa', form: 'notice', summary: text }
    : { kind: 'moa', form: 'notice', summary: text, tier }
}
