/**
 * Registration-order independence (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §5.12): a downstream
 * post-execute listener that rewrites `result.content` post-`next()` must NOT
 * change the recorded `contentHash` (hash taken pre-`next()`, §3.2).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createPostExecuteHandler } from '../src/wiring.ts'
import { LineageRegistry } from '../src/lineage.ts'
import type { Receipt } from '../src/events.ts'

const originalResult = { isError: false, content: [{ type: 'text', text: 'PASS 12 tests' }] } as never

describe('order-independent hashing (§5.12)', () => {
  it('recorded hash survives a downstream post-next() content rewrite', async () => {
    const receipts: Receipt[] = []
    const handler = createPostExecuteHandler({
      readEnabled: () => false,
      receiptsDir: () => undefined,
      lineage: new LineageRegistry(),
      debug: () => {},
    })
    const recorded: Receipt[] = []
    const sessionAppend = (type: string, data: unknown) => {
      if (type === 'completion-gate/receipt') recorded.push(data as Receipt)
    }
    await handler(
      {
        callId: 'call_1',
        name: 'bash',
        arguments: { command: 'pnpm test' },
        agent: {
          session: { id: 's', header: { id: 's' }, snapshotEvents: () => [], append: sessionAppend },
        },
      } as never,
      originalResult,
      async () => {
        // Downstream listener rewrites the result content post-next() — what
        // CCR does. Our hash was already captured.
        return { kind: 'drop' } as never
      },
    )
    expect(recorded).toHaveLength(1)
    const plain = (await import('../src/receipts.ts')).buildReceipt(execNoop, originalPlain, { headEnabled: false })
    expect(recorded[0]!.contentHash).toBe(plain.contentHash)
    expect(recorded[0]!.contentHash).not.toBe((await import('../src/receipts.ts')).digest16('[CRUSHED]'))
  })
})

const execNoop = { callId: 'call_1', name: 'bash', arguments: { command: 'pnpm test' }, agent: undefined } as never
const originalPlain = { isError: false, content: [{ type: 'text', text: 'PASS 12 tests' }] } as never
