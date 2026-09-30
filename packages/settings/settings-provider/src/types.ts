/**
 * Vendored client-safe type surface of the user-settings seam: the namespace
 * brand, the commit-origin union, and the seam's Cordis event declarations.
 *
 * Vendored verbatim (modulo trims noted below) from harness
 * `@deepseek-ai/dsh-settings` at pin `1ef9c1fa9a` (0.1.5-rc.1),
 * `packages/settings/settings/src/types.ts`. Trims: the Remote wire-view types
 * (`SettingsNamespaceView`, `SettingsDescribeValue`, `SettingsPathOpView`,
 * `SettingsSecretView`) are dropped — no dsh-cc consumer reads them — and the
 * `Branded` import from `@deepseek-ai/dsh-brand` is inlined as a local
 * compile-time-only brand to avoid a new dependency.
 *
 * @module @dsh-cc/settings-provider/types
 */

declare const BRAND: unique symbol

/** Nominal id of one registered settings namespace. */
export type SettingsNamespace = string & { readonly [BRAND]: 'SettingsNamespace' }

/** Origin of one committed settings change. */
export type SettingsUpdateSource = 'update' | 'provider'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed change to one registered namespace's resolved value. Emitted
     * after the provider persisted (for `update`) or published (`provider`)
     * the change; never emitted when the resolved value is deep-equal.
     * Listener failures are contained and logged — a sync throw and an async
     * rejection alike — except `INVARIANT`-coded failures, which rethrow
     * after every listener ran; that rethrow reaches the emitter only from
     * synchronous listeners, so invariant checks on this event must not be
     * async functions.
     * @param ns - the namespace whose resolved value changed.
     * @param next - the new resolved value.
     * @param prev - the previous resolved value.
     * @param source - whether the change entered through `update()` or the provider.
     * @mode emit
     */
    'settings/updated'(ns: SettingsNamespace, next: unknown, prev: unknown, source: SettingsUpdateSource): void

    /**
     * One registered namespace's RAW user section changed, whether or not the
     * resolved value did. `settings/updated` is the consumer-facing event and
     * stays deep-equal-gated; this one exists for configuration surfaces,
     * which must learn that a field went from inherited to overridden (same
     * resolved value, different meaning) and that their held revision is
     * stale. Listener containment matches `settings/updated`.
     * @param ns - the namespace whose stored section changed.
     * @param revision - the namespace's new revision.
     * @mode emit
     */
    'settings/document-updated'(ns: SettingsNamespace, revision: number): void
  }
}
