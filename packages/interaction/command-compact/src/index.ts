/**
 * Human-facing `/compact` command with optional preservation instructions.
 * `/compact` runs the same idle-session manual compaction as upstream;
 * `/compact <instructions>` additionally parks the free-text hint on the
 * invoking agent so the CC compaction engine's summarizer preserves what the
 * user asked for. The hint is cleared in a finally block, so a failed or
 * no-op compaction never leaves a stale hint parked for a later turn.
 * @module @dsh-cc/command-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { setCompactHint, takeCompactHint } from '@dsh-cc/compaction-basic'

export const name = 'command-compact'
export const inject = ['commands', 'compaction']

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`)
}
/* v8 ignore stop */

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
      }
    case 'cancelled':
      return { kind: 'error', text: 'Compaction cancelled.' }
    case 'changed':
      return {
        kind: 'error',
        text: 'The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.',
      }
    case 'summary':
      return {
        kind: 'error',
        text: 'Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.',
      }
    case 'commit':
      return {
        kind: 'error',
        text: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
      }
    case 'persistence':
      return {
        kind: 'error',
        text: 'Compaction finished, but the session could not be saved.',
      }
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default: return assertNever(error.code)
  }
}

/** Execute one manual compaction request with an optional preservation hint. */
async function executeCompact(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const hint = invocation.rawInput.trim()
  try {
    if (hint.length > 0) setCompactHint(invocation.agent, hint)
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  } finally {
    // The engine consumes the hint inside summarize(); clear any remainder
    // (no-op compaction, failure) so a stale hint can never ride a later turn.
    takeCompactHint(invocation.agent)
  }
}

/**
 * Register `/compact` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeCompact(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'compact',
      description: 'Compact older conversation history',
      input: { hint: '[instructions]' },
      handler,
    })
  }, 'command-compact lifecycle')
}
