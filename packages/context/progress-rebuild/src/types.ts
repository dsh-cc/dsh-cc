/**
 * Module augmentations for the progress-rebuild producer.
 * @module @dsh-cc/progress-rebuild/types
 */

/** Message-source kind for the injected rebuild brief. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'progress-rebuild': { readonly kind: 'progress-rebuild' }
  }
}

// NOTE: no SessionEventMap augmentation on purpose. Appending a custom
// session-event type would poison the log on harness 0.2.0-rc.x persistence:
// the JSONL backend hard-rejects event types outside the upstream catalog
// that are not marked `ignorable`, and `Session.append` has no
// production-side ignorable channel — every compacted session would become
// un-resumable. Dogfood measurement goes to a sidecar file instead (§3.3
// step 4 of the design doc).

export {}
