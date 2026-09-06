/**
 * CC compaction engine: the upstream `BasicCompactionEngine` with one
 * extension — a per-agent `/compact [instructions]` preservation hint the
 * `summarize()` hook folds into the summarizer input as an extra user
 * message. Everything else (selection, retention, durability) stays the
 * proven upstream replay.
 * @module @dsh-cc/compaction-basic-cc
 */

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { applyCompactHint, takeCompactHint } from './hint.ts'

export { applyCompactHint, setCompactHint, takeCompactHint } from './hint.ts'

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
    return super.summarize(next, agent, signal)
  }
}

export default CcBasicCompactionEngine
