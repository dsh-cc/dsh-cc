/**
 * Module augmentations for the retry-attendant feature (design doc
 * docs/plans/2026-10-09-verify-before-retry.md §3.2): our own message-source
 * kind for the injected guidance entries, and a log-only session event for
 * dogfood telemetry. Type-only module.
 *
 * @module
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** Message-source kind for the retry-attendant producer (own named kind). */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'retry-attendant': { readonly kind: 'retry-attendant' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only dogfood telemetry for the retry-attendant (§6 falsification metrics). */
    'retry-attendant/event': {
      kind: 'guidance' | 'escalation'
      /** The failure class that fired (see data/classes.json). */
      class: string
      /** The tool call name the outcome belonged to. */
      tool: string
      /** 16-hex effect digest of the call (see digest.ts). */
      digest: string
      ts: number
    }
  }
}
