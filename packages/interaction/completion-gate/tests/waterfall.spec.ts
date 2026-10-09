/**
 * Waterfall safety (plan docs/plans/2026-10-09-runtime-verified-completion.md
 * §5.2): a forced EACCES on the ledger directory ⇒ the post-execute listener
 * does not throw and the decision passes through unchanged.
 *
 * @module
 */

import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPostExecuteHandler, type GateDeps } from '../src/wiring.ts'
import { LineageRegistry } from '../src/lineage.ts'
import type { Receipt } from '../src/events.ts'

function execWithSession(appendImpl: (type: string, data: unknown) => void) {
  return {
    callId: 'call_1',
    name: 'bash',
    arguments: { command: 'pnpm test' },
    agent: {
      session: {
        id: 'tui-e2e',
        header: { id: 'tui-e2e' },
        snapshotEvents: () => [],
        append: appendImpl,
      },
    },
  } as unknown as Parameters<ReturnType<typeof createPostExecuteHandler>>[0]
}

describe('waterfall safety (§5.2)', () => {
  it('EACCES on the ledger dir ⇒ no throw, decision passes through unchanged', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cg-eaccess-'))
    const receipts = join(base, 'receipts')
    mkdirSync(receipts)
    const sentinel = { decision: 'allow' as const }
    const deps: GateDeps = {
      readEnabled: () => true,
      receiptsDir: () => receipts,
      lineage: new LineageRegistry(),
      debug: () => {},
    }
    const handler = createPostExecuteHandler(deps)
    try {
      // Lock the receipts dir so the appendFile open fails with EACCES.
      chmodSync(receipts, 0o000)
      const decision = await handler(
        execWithSession(() => {}),
        { isError: false, content: [{ type: 'text', text: 'ok' }] } as never,
        async () => sentinel as never,
      )
      // Decision passed through untouched.
      expect(decision).toBe(sentinel)
      // Let the detached append reject and surface into the debug sink.
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      chmodSync(receipts, 0o755)
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('a throwing session.append does not throw into the waterfall', async () => {
    const sentinel = { decision: 'deny' as const }
    const handler = createPostExecuteHandler({
      readEnabled: () => false,
      receiptsDir: () => undefined,
      lineage: new LineageRegistry(),
      debug: () => {},
    })
    const decision = await handler(
      execWithSession(() => { throw new Error('append exploded') }),
      { isError: false, content: [] } as never,
      async () => sentinel as never,
    )
    expect(decision).toBe(sentinel)
  })
})
