/**
 * CC compaction engine: the upstream `BasicCompactionEngine` with one
 * extension — a per-agent `/compact [instructions]` preservation hint the
 * `summarize()` hook folds into the summarizer input as an extra user
 * message. Everything else (selection, retention, durability) stays the
 * proven upstream replay.
 * @module @dsh-cc/compaction-basic-cc
 */

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomeFn as resolveDshHomePath } from '@dsh-cc/sidecar-io'
import { applyCompactHint, takeCompactHint } from './hint.ts'
import { applyTusSummaries } from './tus.ts'

export { applyCompactHint, setCompactHint, takeCompactHint } from './hint.ts'
export { applyTusSummaries, TUS_CONSUMER_PROBE } from './tus.ts'

/**
 * Resolve a dsh-home path for this plugin, degrading to `undefined` on any
 * absence. The property-access seam is shared with `@dsh-cc/sidecar-io`
 * (which guards cordis's throwing property read); this wrapper adds the two
 * protections the shared helper does not cover, because the resolver here is
 * OPTIONAL (`ctx: Context | undefined`) and is actually INVOKED — an invocation
 * that throws must not escape into the summarize path.
 */
function dshHomeFn(ctx: Context | undefined): string | undefined {
  if (ctx === undefined) return undefined
  const resolve = resolveDshHomePath(ctx)
  if (resolve === undefined) return undefined
  try {
    return resolve()
  } catch {
    return undefined
  }
}

export class CcBasicCompactionEngine extends BasicCompactionEngine {
  /**
   * Summarize with the agent's parked /compact hint, if any. The hint is
   * consumed here (take = read + clear); a later compaction of the same
   * agent starts hint-free. Empty/absent hints pass the input through
   * unchanged, so the auxiliary call stays byte-identical to upstream.
   *
   * Types derive from the inherited protected hook itself (indexed access
   * resolves within this subclass) instead of deep-importing the base
   * package's internals.
   */
  override async summarize(
    ...args: Parameters<BasicCompactionEngine['summarize']>
  ): ReturnType<BasicCompactionEngine['summarize']> {
    const [input, agent, signal] = args
    const hint = takeCompactHint(agent)
    const next = hint === undefined ? input : applyCompactHint(input, hint)
    // Consumer B (§5.4): substitute TUS digests for qualifying tool results.
    // Never throws; absent rows → the input unchanged (byte-identical call).
    const upgraded = await applyTusSummaries(
      next,
      dshHomeFn((this as unknown as { ctx?: Context }).ctx),
      agent === undefined ? '' : String((agent as { session?: { header?: { id?: unknown } } }).session?.header?.id ?? ''),
    )
    return super.summarize(upgraded, agent, signal)
  }
}

export default CcBasicCompactionEngine
