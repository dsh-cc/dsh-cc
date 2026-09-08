import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CollectClock } from '../src/collect.ts'

/** The deterministic injected clock used across collection specs. */
export const CLOCK: CollectClock = {
  now: () => new Date('2026-09-03T00:00:00.000Z'),
  ms: () => 0,
}

/** Build a minimal fake `CommandInvocation` over a fake session. */
export function fakeInvocation(options: {
  sessionId?: string
  cwd?: string
  events?: SessionEvent[]
} = {}): CommandInvocation {
  const events = options.events ?? []
  return {
    agent: {
      session: {
        id: options.sessionId ?? 'sess-doctor',
        header: { cwd: options.cwd ?? '/repo' },
        // Upstream >=0.1.3 reads events via snapshotEvents(); events stays for
        // any code path still iterating the log directly.
        events,
        snapshotEvents() { return events },
      },
    },
    rawInput: '',
  } as unknown as CommandInvocation
}

/** Mount a getter that throws, to exercise the per-group try/catch. */
export function mountThrowing(ctx: Context, name: string, error: Error): void {
  const original = ctx.get.bind(ctx)
  Object.defineProperty(ctx, 'get', {
    configurable: true,
    value: (key: string) => {
      if (key === name) throw error
      return original(key)
    },
  })
}
