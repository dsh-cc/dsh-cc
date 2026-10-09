/**
 * Receipt writer field matrix (plan docs/plans/2026-10-09-runtime-verified-
 * completion.md §5.1): success + failure rows contain all fields; a
 * HarnessError-derived failure exposes `errorCode`; a plain `Error` (no
 * `info`) leaves it null; `head` is gated on tool=bash + enabled.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { buildReceipt, stableJson, digest16 } from '../src/receipts.ts'

function fakeExec(overrides: Record<string, unknown> = {}): Parameters<typeof buildReceipt>[0] {
  return {
    callId: 'call_1',
    name: 'bash',
    arguments: { command: 'pnpm test', all: undefined },
    agent: {
      session: {
        id: 'tui-abc',
        header: { id: 'tui-abc', parentSession: undefined },
        snapshotEvents: () => [],
        append: () => {},
      },
    },
    ...overrides,
  } as unknown as Parameters<typeof buildReceipt>[0]
}

function okResult(content: { type: string; text?: string }[] = [{ type: 'text', text: 'all green' }]) {
  return { isError: false, content } as unknown as Parameters<typeof buildReceipt>[1]
}

function failResult(error: unknown) {
  return { isError: true, error, content: [{ type: 'text', text: 'boom' }] } as unknown as Parameters<typeof buildReceipt>[1]
}

describe('receipt field matrix (§5.1)', () => {
  it('success bash row with enabled head capture carries every field', () => {
    const receipt = buildReceipt(fakeExec(), okResult(), { headEnabled: true })
    expect(receipt.v).toBe(1)
    expect(receipt.ts).toBeTypeOf('number')
    expect(receipt.sessionId).toBe('tui-abc')
    expect(receipt.callId).toBe('call_1')
    expect(receipt.tool).toBe('bash')
    expect(receipt.argsDigest).toMatch(/^[0-9a-f]{16}$/)
    expect(receipt.outcome).toBe('ok')
    expect(receipt.errorCode).toBeNull()
    expect(receipt.contentHash).toMatch(/^[0-9a-f]{16}$/)
    expect(receipt.textBytes).toBe(Buffer.byteLength('all green', 'utf8'))
    expect(receipt.head).toBe('pnpm test')
  })

  it('failure with HarnessError-derived info exposes errorCode', () => {
    const receipt = buildReceipt(fakeExec({ name: 'edit' }), failResult({ info: { name: 'HarnessError', code: 'FS_AMBIGUOUS_EDIT' } }), { headEnabled: true })
    expect(receipt.outcome).toBe('error')
    expect(receipt.errorCode).toBe('FS_AMBIGUOUS_EDIT')
    expect(receipt.head).toBeUndefined() // non-bash rows carry no head
  })

  it('failure with a plain Error (no info) leaves errorCode null', () => {
    const receipt = buildReceipt(fakeExec(), failResult(new Error('boom')), { headEnabled: false })
    expect(receipt.errorCode).toBeNull()
    expect(receipt.outcome).toBe('error')
  })

  it('head is gated on enabled even for bash rows', () => {
    const receipt = buildReceipt(fakeExec(), okResult(), { headEnabled: false })
    expect(receipt.head).toBeUndefined()
    // hashed fields still present (receipts-always-on)
    expect(receipt.contentHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('no session reachable ⇒ sessionId null', () => {
    const receipt = buildReceipt(fakeExec({ agent: undefined }), okResult(), { headEnabled: true })
    expect(receipt.sessionId).toBeNull()
  })

  it('stableJson is sorted-key no-whitespace and digest is 16 hex chars', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}')
    expect(digest16('x')).toMatch(/^[0-9a-f]{16}$/)
  })
})
