/**
 * Stage-0 reasoning-fold probe: a READ-ONLY `llm/stream` listener that
 * byte-counts `reasoning-delta` vs `text-delta` chunks and captures the
 * terminal usage chunk into a per-session JSONL ledger under
 * `<dshHome>/reasoning-fold/<sessionId>.jsonl`. Measurement before any
 * behavior change (docs/plans/2026-09-10-reasoning-fold-deepseek.md): the
 * listener always passes every chunk through untouched (LEDGER-ONLY) —
 * probe failures are swallowed and never break the model call.
 *
 * Plain cordis plugin (publishes no Service — handoff-store/memory pattern),
 * so it needs no isolate realm of its own. No-ops when the settings provider
 * is absent or `cc-reasoning-fold.probe` is `false`, or when `dshHomePath`
 * is absent (ledger skipped, chunks still pass through).
 *
 * @module @dsh-cc/reasoning-fold
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendLedgerRow, observeChunk, type FoldRecord } from './ledger.ts'
import { registerProbeSetting } from './settings.ts'

export { appendLedgerRow, observeChunk, type FoldRecord, type LedgerRow } from './ledger.ts'
export { registerProbeSetting, SETTINGS_NAMESPACE, SettingsSchema } from './settings.ts'

/** dshHomePath seam, read defensively (a providerless host must not crash the plugin). */
type HomeFn = (...segments: string[]) => string

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

function dshHomeFn(ctx: Context): HomeFn | undefined {
  try {
    return ctx.dshHomePath
  } catch {
    return undefined
  }
}

/**
 * The read-only passthrough listener body. Detached from `apply` for direct
 * unit testing (incl. the abort path: the ledger row is appended in
 * `finally`, so an upstream throw mid-iteration still records).
 */
export async function* foldStream(
  record: FoldRecord,
  probeOn: boolean,
  observe: (record: FoldRecord, chunk: StreamChunk) => void,
  append: (record: FoldRecord) => Promise<void>,
  next: () => AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  try {
    for await (const chunk of await next()) {
      if (probeOn) {
        try {
          observe(record, chunk)
        } catch {
          // LEDGER-ONLY: probe failures must never break the model call.
        }
      }
      yield chunk
    }
  } finally {
    try {
      await append(record)
    } catch {
      // Best-effort: the row is observability, never the call's fate.
    }
  }
}

/**
 * Mount the probe. No-op (registers nothing) when the settings provider is
 * absent or `probe` is false.
 * @param ctx - the plug context.
 * @returns the listener disposer, or `undefined` when not registered.
 */
export function apply(ctx: Context): (() => void) | undefined {
  const readProbe = registerProbeSetting(ctx)
  if (readProbe === undefined || !readProbe()) return undefined
  const home = dshHomeFn(ctx)
  return ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    // Probe decision pinned at call start: a settings flip mid-call cannot
    // discard the in-flight record (it still appends its row).
    const probeOn = readProbe()
    const record: FoldRecord = {
      provider: options.provider,
      model: options.model,
      sessionId: String(options.sessionId ?? 'unknown'),
      purpose: options.purpose ?? null,
      reasoningBytes: 0,
      textBytes: 0,
    }
    return foldStream(
      record,
      probeOn,
      observeChunk,
      (r) => home === undefined ? Promise.resolve() : appendLedgerRow(home('reasoning-fold', `${r.sessionId}.jsonl`), r),
      next,
    )
  })
}

/** Cordis plugin id. */
export const name = 'cc-reasoning-fold'
