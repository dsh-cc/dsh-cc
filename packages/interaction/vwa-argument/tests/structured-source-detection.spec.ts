import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isStructuredData } from '../src/review-input.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex } from '../src/schema.ts'
import { BUDGET, fakeAdapter, makeClaim, makeSnapshot, makeSource } from './review-helpers.ts'

const cases = [
  ['blank records', '\n  \nname,note\n\nAlice,ok'],
  ['quoted comma', 'name,note\nAlice,"hello, world"\nBob,ok\n'],
  ['quoted newline', 'name,note\n"Alice\nSmith",hello\nBob,ok\n'],
  ['escaped quotes', 'name,note\nAlice,"She said ""hello, world""."\nBob,ok\n'],
  ['CRLF records', 'name,note\r\nAlice,"hello,\r\nworld"\r\nBob,ok\r\n'],
  ['quoted TSV tab', 'name\tnote\nAlice\t"hello\tworld"\nBob\tok\n'],
  ['tab inside CSV field', 'name,note\nAlice,"hello\tworld"\nBob,ok\n'],
  ['TSV empty first field', '\tvalue\nx\ty\n'],
  ['TSV empty first field after blank records', '\n  \r\n\tvalue\r\nx\ty\r\n'],
  ['TSV empty first record fields', '\t\nx\ty\n'],
] as const

describe('quoted structured sources', () => {
  it.each(cases)('recognizes %s', (_, text) => {
    expect(isStructuredData(text)).toBe(true)
  })

  it.each([
    'name,note\nAlice,"unfinished',
    'name,note\nAlice,"closed"extra',
    'A sentence, with a comma.\nAnother sentence.',
    'Only one record, here',
  ])('does not classify malformed or inconsistent records as CSV: %s', (text) => {
    expect(isStructuredData(text)).toBe(false)
  })

  it.each(cases)('refuses oversized %s before model dispatch', async (_, text) => {
    const fullText = text + text.repeat(10_000)
    const source = { ...makeSource(), snapshotHash: sha256Hex(fullText) }
    const claim = makeClaim()
    claim.scope.corpus = [source.id]
    const snapshot = makeSnapshot({ sources: [source], claims: [claim] })
    const adapter = fakeAdapter([() => ({ raw: JSON.stringify({
      stage: 'sources', rubricVersion: 'humanities-v1', findings: [],
      targets: [{ targetId: source.id, checks: ['SOURCE-01', 'SOURCE-02'].map((ruleId) => ({
        ruleId, result: 'pass', rationale: 'r', evidenceIds: [],
      })) }],
    }) })])
    const outcome = await executeReviewRun({
      deps: {
        root: mkdtempSync(join(tmpdir(), 'vwa-quoted-source-')),
        adapter, budget: BUDGET, contractHash: 'c'.repeat(64), readSnapshot: () => fullText,
      },
      runId: `run_${randomUUID()}`, requestId: `req-${randomUUID()}`,
      stages: ['sources'], targetClaimIds: [claim.id], snapshot, signal: new AbortController().signal,
    })
    expect(outcome.status).toBe('incomplete')
    expect(outcome.records).toHaveLength(1)
    expect(outcome.records[0]).toMatchObject({ status: 'error', errorCode: 'CONTEXT_TOO_LARGE' })
    expect(outcome.records[0]!.errorDetail?.message).toContain('lineage.parentSourceIds')
    expect(outcome.records[0]!.errorDetail?.message).toContain(source.id)
    expect(adapter.state.dispatches).toBe(0)
    expect(outcome.calls).toBe(0)
  })
})
