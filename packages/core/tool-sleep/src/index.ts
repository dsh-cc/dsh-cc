/**
 * Model-facing `Sleep` tool that waits a specified duration with cooperative
 * cancellation. Aligns with Claude Code's SleepTool semantics: the input is a
 * `{ duration }` in seconds, the wait is interruptible (a new turn cancels it
 * like CC's `interruptBehavior: 'cancel'`), and the tool is concurrency-safe
 * so it may overlap sibling calls.
 * @module @dsh-cc/tool-sleep
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED } from '@dsh-cc/tools'
import type { ToolRunContext } from '@dsh-cc/tools'
import { presentSleepCall, presentSleepResult } from './render.ts'

export const name = 'tool-sleep'
export const inject = ['tools']

/** Runtime configuration for the Sleep tool. */
export interface Config {
  /**
   * Optional lower bound (seconds) that a `Sleep` call must wait for, used to
   * throttle busy-waiting; positive values clamp short durations up. Mirrors
   * CC's `minSleepDurationMs` in spirit.
   */
  minDurationSeconds?: number
  /**
   * Optional upper bound (seconds) that a `Sleep` call may wait for; a request
   * above it is clamped down. Mirrors CC's `maxSleepDurationMs` in spirit.
   */
  maxDurationSeconds?: number
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  minDurationSeconds: z.number(),
  maxDurationSeconds: z.number(),
})

/** Arguments accepted by the Sleep tool. */
export interface SleepToolArgs {
  /** How long to wait, in seconds. */
  duration: number
}

/** Structured, model-visible failure (maps to an isError tool result). */
class SleepError extends Error {}

/**
 * A `HarnessError` that surfaces as the canonical tool-aborted outcome
 * (`name: AbortError`, `code: TOOL_ABORTED`) — the same shape the harness
 * produces when cancellation supersedes a body and the shape CC uses when a
 * user interrupts the sleep turn (`interruptBehavior: 'cancel'`).
 * @param signal - the aborted tool-call signal whose `reason` is preserved.
 * @returns the abort error to throw.
 */
function abortError(signal: AbortSignal): Error {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED, { cause: signal.reason })
  error.name = 'AbortError'
  return error
}

/**
 * Wait for a wall-clock duration, resolving early (with an abort error) the
 * moment `signal` fires. Cooperative: the waiter never spins; it arms a timer
 * for `ms` and an `abort` listener, then settles on whichever fires first.
 * @param ms - the wait duration in milliseconds.
 * @param signal - the tool-call cancellation signal.
 * @returns a promise resolving after `ms`, or rejecting with the abort error on cancellation.
 */
function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    const fail = (): void => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', fail)
      resolve()
    }, ms)
    signal.addEventListener('abort', fail, { once: true })
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  const minMs = config.minDurationSeconds !== undefined ? config.minDurationSeconds * 1000 : 0
  const maxMs = config.maxDurationSeconds !== undefined ? config.maxDurationSeconds * 1000 : Number.POSITIVE_INFINITY

  ctx.tools.register(defineTool({
    name: 'Sleep',
    description:
      'Wait for a specified duration. Use this when the user tells you to sleep or rest, when you have '
      + 'nothing to do, or when you are waiting for something. The user can interrupt the sleep at any time. '
      + 'This tool is concurrency-safe: you can call it concurrently with other tools — it will not interfere '
      + 'with them. Prefer this over running a sleep command, because it does not hold a subprocess. '
      + 'Sleep for a short enough duration that you wake up and are ready when the thing you are waiting for '
      + 'is likely to be ready; each wake-up costs an API call.',
    parameters: {
      duration: {
        type: 'number',
        description: 'How long to wait, in seconds. Must be a finite, non-negative number.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          duration: { type: 'number', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: SleepToolArgs, value: { duration: number; message: string }) =>
        [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    presentCall: presentSleepCall,
    presentResult: presentSleepResult,
    async execute(args: SleepToolArgs, exec: ToolRunContext) {
      let seconds = args.duration
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new SleepError(
          `Sleep duration must be a finite, non-negative number of seconds (got ${JSON.stringify(args.duration)})`,
        )
      }
      const ms = seconds * 1000
      const clampedMs = Math.min(Math.max(ms, minMs), maxMs)
      seconds = clampedMs / 1000

      await waitFor(clampedMs, exec.signal)

      return {
        duration: seconds,
        message: `Slept for ${seconds} second${seconds === 1 ? '' : 's'}.`,
      }
    },
  }))
}

export { presentSleepCall, presentSleepResult } from './render.ts'
