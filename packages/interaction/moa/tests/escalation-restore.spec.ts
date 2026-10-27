import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { restoreEscalationFloor } from '../src/escalation-restore.ts'
import { EscalationBookkeeping } from '../src/state.ts'

const source = (fromTier: number, toTier: number) => ({ kind: 'moa-escalation' as const, originSeq: 0, fromTier, toTier })
const opening = source(1, 2)

describe('durable escalation restore', () => {
  it('rebuilds a fresh session from a persisted JSONL chain, preserving its retry budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moa-restore-'))
    try {
      const session = Session.create(SessionId('restore-original'))
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original request' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      for (const [from, to] of [[0, 1], [1, 2]]) {
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'retry' }], source: source(from!, to!) }), { surfaceOp: 'append' })
      }
      const path = join(dir, 'session.jsonl')
      writeFileSync(path, session.snapshotEvents().map(e => JSON.stringify(e)).join('\n') + '\n')
      const restored = Session.create(SessionId('restore-fresh'), readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
      const bookkeeping = new EscalationBookkeeping(), warnings: string[] = []
      expect(restoreEscalationFloor(bookkeeping, { session: restored }, opening, m => warnings.push(m))).toBe(2)
      expect(bookkeeping.stateFor(0)).toEqual({ tierFloor: 2, retriesUsed: 2 })
      expect(warnings).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('warns and refuses malformed matching records rather than silently losing retries', () => {
    const bookkeeping = new EscalationBookkeeping(), warnings: string[] = []
    const agent = { session: { snapshotEvents: () => [{ type: 'user/message', data: { source: { ...source(0, 1), fromTier: 'bad' } } }] } }
    expect(restoreEscalationFloor(bookkeeping, agent, opening, m => warnings.push(m))).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(bookkeeping.stateFor(0)).toBeUndefined()
  })

  it('warns on an unreadable log instead of restoring an understated retry count', () => {
    const warnings: string[] = [], bookkeeping = new EscalationBookkeeping()
    expect(restoreEscalationFloor(bookkeeping, { session: { snapshotEvents() { throw new Error('log unreadable') } } }, opening, m => warnings.push(m))).toBeUndefined()
    expect(warnings[0]).toContain('log unreadable')
    expect(bookkeeping.stateFor(0)).toBeUndefined()
  })

  it('rejects inconsistent or repeated transitions atomically', () => {
    for (const records of [[source(1, 2), source(0, 1)], [source(0, 1), source(0, 1)]]) {
      const bookkeeping = new EscalationBookkeeping()
      expect(() => bookkeeping.restoreFromEscalations(0, records)).toThrow(/chain/)
      expect(bookkeeping.stateFor(0)).toBeUndefined()
    }
  })
})
