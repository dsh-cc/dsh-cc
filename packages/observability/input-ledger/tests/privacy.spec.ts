/**
 * Privacy fixture (design §Privacy boundary): synthetic messages carrying
 * credential-shaped strings produce serialized rows in which those strings
 * provably never appear.
 *
 * The builder below stands in for the request observer's projection — counts,
 * UTF-8 byte sizes and a local truncated hash only. The guarantee under test
 * is structural: the row types have no field that could carry text, so the
 * only way a credential could reach the file is through a new field, which the
 * allow-list assertion below would catch.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AssembleRow, RequestMessageStats, RequestRow } from '../src/index.ts'
import {
  appendLedgerRow,
  clampLabel,
  LEDGER_SCHEMA_VERSION,
  MAX_LABEL_CHARS,
  sessionLedgerPath,
} from '../src/index.ts'

const API_KEY = 'sk-proj-9f8a7b6c5d4e3f2a1b0c'
const BEARER_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXNpZ25hdHVyZQ=='
const CREDENTIALS = [API_KEY, BEARER_TOKEN, 'c2VjcmV0LXNpZ25hdHVyZQ']

interface SyntheticMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly sourceKind: string
}

const MESSAGES: readonly SyntheticMessage[] = [
  { role: 'system', content: `You are a harness. Use this key: ${API_KEY}`, sourceKind: 'system-prompt' },
  { role: 'user', content: `deploy with ${API_KEY} please`, sourceKind: 'user' },
  { role: 'assistant', content: `calling the API with ${BEARER_TOKEN}`, sourceKind: 'assistant' },
  { role: 'tool', content: `{"authorization":"${BEARER_TOKEN}"}`, sourceKind: 'tool-result' },
  { role: 'user', content: 'plain text without credentials', sourceKind: `kind-${'x'.repeat(120)}` },
]

/** Counts and byte sizes only — never the content itself. */
function summarize(messages: readonly SyntheticMessage[]): RequestMessageStats {
  const bySourceKind: Record<string, { count: number; bytes: number }> = {}
  const toolResults = { count: 0, bytes: 0 }
  let bytesTotal = 0
  let assistantBytes = 0
  for (const message of messages) {
    const bytes = Buffer.byteLength(message.content, 'utf8')
    bytesTotal += bytes
    const kind = clampLabel(message.sourceKind)
    const bucket = bySourceKind[kind] ?? { count: 0, bytes: 0 }
    bucket.count += 1
    bucket.bytes += bytes
    bySourceKind[kind] = bucket
    if (message.role === 'assistant') assistantBytes += bytes
    if (message.sourceKind === 'tool-result') {
      toolResults.count += 1
      toolResults.bytes += bytes
    }
  }
  return { count: messages.length, bytesTotal, nonTextBlocks: 0, bySourceKind, toolResults, assistantBytes }
}

function hash8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

function buildRequestRow(messages: readonly SyntheticMessage[]): RequestRow {
  const systemText = messages
    .filter(message => message.role === 'system' || message.sourceKind === 'system-prompt')
    .map(message => message.content)
    .join('')
  return {
    v: 1,
    ts: 1_763_000_000_000,
    sessionId: 'session-privacy',
    gen: 'gen-privacy',
    type: 'request',
    seqPerGen: 1,
    provider: 'deepseek',
    model: 'deepseek-chat',
    mainLoop: true,
    systemBytes: Buffer.byteLength(systemText, 'utf8'),
    systemHash8: hash8(systemText),
    toolsCount: 2,
    toolsBytes: 2048,
    messages: summarize(messages),
  }
}

function buildAssembleRow(messages: readonly SyntheticMessage[]): AssembleRow {
  const systemText = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('')
  return {
    v: 1,
    ts: 1_763_000_000_000,
    sessionId: 'session-privacy',
    gen: 'gen-privacy',
    type: 'assemble',
    isSubagent: false,
    sections: [{ name: 'core/identity', bytes: Buffer.byteLength(systemText, 'utf8'), hash8: hash8(systemText) }],
    totalBytes: Buffer.byteLength(systemText, 'utf8'),
    renderedFromCache: false,
  }
}

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('privacy boundary', () => {
  it('emits rows in which credential-shaped strings provably never appear', async () => {
    dir = await mkdtemp(join(tmpdir(), 'input-ledger-privacy-'))
    const request = buildRequestRow(MESSAGES)
    const assemble = buildAssembleRow(MESSAGES)

    for (const secret of CREDENTIALS) {
      expect(JSON.stringify(request)).not.toContain(secret)
      expect(JSON.stringify(assemble)).not.toContain(secret)
    }

    const file = sessionLedgerPath(dir, 'project-key', 'session-privacy')
    await appendLedgerRow(file, request)
    await appendLedgerRow(file, assemble)

    const raw = await readFile(file, 'utf8')
    for (const secret of CREDENTIALS) expect(raw).not.toContain(secret)
    expect(raw).not.toMatch(/sk-[A-Za-z0-9-]{8,}/)
    expect(raw).not.toMatch(/Bearer\s+\S+/)
    expect(raw).not.toMatch(/authorization/i)
  })

  it('still records the metrics the observers owe downstream docs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'input-ledger-privacy-'))
    const request = buildRequestRow(MESSAGES)
    const file = sessionLedgerPath(dir, 'project-key', 'session-privacy')
    await appendLedgerRow(file, request)

    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw.trim()) as RequestRow
    const expectedBytes = MESSAGES.reduce(
      (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
      0,
    )
    expect(parsed.v).toBe(LEDGER_SCHEMA_VERSION)
    expect(parsed.messages.count).toBe(MESSAGES.length)
    expect(parsed.messages.bytesTotal).toBe(expectedBytes)
    expect(parsed.systemBytes).toBeGreaterThan(0)
    expect(parsed.systemHash8).toMatch(/^[0-9a-f]{8}$/)
    expect(parsed.messages.toolResults.count).toBe(1)
    expect(parsed.messages.assistantBytes).toBeGreaterThan(0)
  })

  it('caps section names and source-kind strings at 64 chars', async () => {
    dir = await mkdtemp(join(tmpdir(), 'input-ledger-privacy-'))
    const file = sessionLedgerPath(dir, 'project-key', 'session-privacy')
    await appendLedgerRow(file, buildRequestRow(MESSAGES))
    const parsed = JSON.parse((await readFile(file, 'utf8')).trim()) as RequestRow
    const kinds = Object.keys(parsed.messages.bySourceKind)
    expect(kinds).toContain(`kind-${'x'.repeat(MAX_LABEL_CHARS - 'kind-'.length)}`)
    for (const kind of kinds) expect(kind.length).toBeLessThanOrEqual(MAX_LABEL_CHARS)
  })

  it('carries a fixed, text-free top-level field set on every row type', async () => {
    dir = await mkdtemp(join(tmpdir(), 'input-ledger-privacy-'))
    const request = buildRequestRow(MESSAGES)
    const assemble = buildAssembleRow(MESSAGES)
    expect(Object.keys(request).sort()).toEqual([
      'gen',
      'mainLoop',
      'messages',
      'model',
      'provider',
      'seqPerGen',
      'sessionId',
      'systemBytes',
      'systemHash8',
      'toolsBytes',
      'toolsCount',
      'ts',
      'type',
      'v',
    ])
    expect(Object.keys(assemble).sort()).toEqual([
      'gen',
      'isSubagent',
      'renderedFromCache',
      'sections',
      'sessionId',
      'totalBytes',
      'ts',
      'type',
      'v',
    ])
  })
})
