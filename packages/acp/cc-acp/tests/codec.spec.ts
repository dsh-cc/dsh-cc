// Vendored from @deepseek-ai/dsh-acp (packages/acp/acp/tests/codec.spec.ts)
// Source ref: c1b47e41fcd54d20a0f061df28683bfc29ee24e5 (deepseek-harness, MIT — see LICENSE-harness)
// Copied 2026-10-09. Structural fixes flow from upstream during harness
// migrations; CC-specific divergences must be recorded in DIVERGENCE.md.
import { describe, expect, it } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { turnEndToStopReason } from '../src/codec.ts'

describe('ACP codec', () => {
  it.each([
    [{ kind: 'completed' }, 'end_turn'],
    [{ kind: 'max-tokens' }, 'max_tokens'],
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'end_turn'],
    [{ kind: 'interrupted' }, 'cancelled'],
    [{ kind: 'blocked' }, 'end_turn'],
    [{ kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } }, 'end_turn'],
  ] satisfies Array<[TurnEndReason, string]>)('maps %o to %s', (reason, expected) => {
    expect(turnEndToStopReason(reason)).toBe(expected)
  })
})
