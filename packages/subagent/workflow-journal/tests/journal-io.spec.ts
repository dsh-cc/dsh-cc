/**
 * Journal IO tests (resume-journal design §3.3): canonicalJson/fnv golden
 * vectors, the writer's in-order prefix flush, the terminal-gap close rule,
 * the byte cap, tmp+rename atomicity, and the boot TTL sweep.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, fnv1a32hex, hashSubagentRequest, JournalWriter, sweepExpiredSessionDirs } from '../src/journal-io.ts'
import type { JournalLine } from '@dsh-cc/tool-workflow'

function scratch(): string {
  const root = join(process.cwd(), '.scratch')
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, 'journal-io-'))
}

describe('canonicalJson', () => {
  it('sorts nested object keys and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, 1, { z: 'y', a: 2 }] }, e: -1.5 }))
      .toBe('{"a":{"c":[3,1,{"a":2,"z":"y"}]},"b":1,"e":-1.5}')
  })

  it('drops undefined keys at every depth', () => {
    expect(canonicalJson({ a: undefined, b: { c: undefined, d: null } })).toBe('{"b":{"d":null}}')
  })

  it('uses JSON.stringify number semantics (floats and non-finites)', () => {
    expect(canonicalJson({ a: NaN, b: Infinity, c: -0.5, d: 1e21 })).toBe('{"a":null,"b":null,"c":-0.5,"d":1e+21}')
  })

  it('throws on non-JSON values', () => {
    expect(() => canonicalJson(() => 1)).toThrow()
    expect(() => canonicalJson(Symbol('x'))).toThrow()
    expect(() => canonicalJson(10n)).toThrow()
    expect(() => canonicalJson(new Date(0))).toThrow()
    expect(() => canonicalJson(undefined)).toThrow()
  })
})

describe('fnv1a32hex golden vectors', () => {
  it('pins exact hashes', () => {
    // Computed once against the reference implementation and re-verified here.
    expect(fnv1a32hex('{"agentOptions":null,"outputSchema":null,"prompt":[{"text":"read the repo","type":"text"}]}')).toBe('e7c044e9')
    expect(fnv1a32hex('{"a":{"c":[3,1,{"a":2,"z":"y"}]},"b":1,"e":-1.5}')).toBe('3513cc80')
    expect(fnv1a32hex('')).toBe('811c9dc5')
  })

  it('hashSubagentRequest normalizes absent optional fields to null', () => {
    const prompt = [{ type: 'text', text: 'read the repo' }]
    expect(hashSubagentRequest({ prompt }))
      .toBe(hashSubagentRequest({ prompt, outputSchema: undefined, agentOptions: undefined }))
    expect(hashSubagentRequest({ prompt })).toBe('e7c044e9')
    // Any change to the triple changes the hash (false-hit guard).
    expect(hashSubagentRequest({ prompt, outputSchema: { type: 'object' } })).not.toBe('e7c044e9')
    expect(hashSubagentRequest({ prompt, agentOptions: { model: 'm2' } })).not.toBe(hashSubagentRequest({ prompt, agentOptions: { model: 'm1' } }))
  })
})

function line(seq: number, hash = `h${seq}`): JournalLine {
  return { seq, hash, status: 'completed', result: { output: [{ type: 'text', text: `out-${seq}` }], stopReason: 'completed' } }
}

async function writtenText(writer: JournalWriter): Promise<string> {
  await writer.drain()
  return readFileSync(writer.journalPath, 'utf8')
}

describe('JournalWriter', () => {
  it('flushes in order under out-of-order record calls', async () => {
    const dir = scratch()
    const writer = new JournalWriter(join(dir, 'a.jsonl'), { maxBytes: 1 << 20, warn: () => {} })
    writer.record(3, line(3))
    writer.record(1, line(1))
    expect(existsSync(writer.journalPath)).toBe(false)
    writer.record(2, line(2))
    expect(await writtenText(writer)).toBe([1, 2, 3].map(i => `${JSON.stringify({ ...line(i) })}\n`).join(''))
  })

  it('close() flushes the contiguous prefix and discards beyond a permanent gap; drain resolves', async () => {
    const dir = scratch()
    const writer = new JournalWriter(join(dir, 'b.jsonl'), { maxBytes: 1 << 20, warn: () => {} })
    writer.record(1, line(1))
    writer.record(2, line(2))
    writer.record(4, line(4)) // permanent gap at 3 (never settled)
    writer.record(5, line(5))
    writer.close()
    writer.record(6, line(6)) // no-op after close
    await writer.drain() // close's final flush is chained before this
    const text = readFileSync(writer.journalPath, 'utf8')
    expect(text).toContain('"seq":1')
    expect(text).toContain('"seq":2')
    expect(text).not.toContain('"seq":4')
    expect(text).not.toContain('"seq":6')
    await expect(writer.drain()).resolves.toBeUndefined()
  })

  it('stops recording at the byte-cap boundary and warns once', async () => {
    const dir = scratch()
    const warnings: string[] = []
    // The cap admits exactly the first line (serialized + newline framing).
    const firstLine = JSON.stringify({ ...line(1) }).length + 1
    const writer = new JournalWriter(join(dir, 'c.jsonl'), { maxBytes: firstLine, warn: message => warnings.push(message) })
    writer.record(1, line(1))
    writer.record(2, line(2))
    await writer.drain()
    const text = readFileSync(writer.journalPath, 'utf8')
    expect(text).toContain('"seq":1')
    expect(text).not.toContain('"seq":2')
    expect(warnings).toHaveLength(1)
    writer.close()
  })

  it('drops further appends after a write failure, warns once, and drain still resolves', async () => {
    const dir = scratch()
    const warnings: string[] = []
    // The parent of the journal path is a FILE, so mkdir/rename cannot succeed.
    const file = join(dir, 'e.jsonl')
    writeFileSync(file, '')
    const writer = new JournalWriter(join(file, 'e2.jsonl'), { maxBytes: 1 << 20, warn: message => warnings.push(message) })
    writer.record(1, line(1))
    await expect(writer.drain()).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
    writer.record(2, line(2))
    await expect(writer.drain()).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1) // still once
    expect(writer.usable).toBe(false)
  })

  it('leaves no .tmp residue after drain', async () => {
    const dir = scratch()
    const writer = new JournalWriter(join(dir, 'f.jsonl'), { maxBytes: 1 << 20, warn: () => {} })
    writer.record(1, line(1))
    await writer.drain()
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
    writer.close()
  })

  it('keeps earlier content when appending (whole-file rewrite preserves the prefix)', async () => {
    const dir = scratch()
    const writer = new JournalWriter(join(dir, 'g.jsonl'), { maxBytes: 1 << 20, warn: () => {} })
    writer.record(1, line(1))
    await writer.drain()
    writer.record(2, line(2))
    await writer.drain()
    const text = readFileSync(writer.journalPath, 'utf8')
    expect(text).toContain('"seq":1')
    expect(text).toContain('"seq":2')
    writer.close()
  })
})

describe('sweepExpiredSessionDirs', () => {
  it('keeps a fresh dir at ttl-1 and removes one at ttl (fake mtimes)', () => {
    const root = scratch()
    const fresh = join(root, 'sess-fresh')
    const expired = join(root, 'sess-old')
    const file = join(root, 'loose.txt')
    mkdirSync(fresh)
    mkdirSync(expired)
    writeFileSync(file, 'not a session dir')
    const now = 1_000_000_000_000
    utimesSync(fresh, new Date(now), new Date(now - 999))
    utimesSync(expired, new Date(now), new Date(now - 1000))
    const { removed } = sweepExpiredSessionDirs(root, 1000, now)
    expect(removed.map(path => path.split('/').pop())).toEqual(['sess-old'])
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(expired)).toBe(false)
    expect(existsSync(file)).toBe(true) // only directories are swept
  })

  it('is silent when the root is missing', () => {
    const root = join(scratch(), 'absent')
    expect(sweepExpiredSessionDirs(root, 1000)).toEqual({ removed: [] })
    expect(sweepExpiredSessionDirs(root, 1000)).toEqual({ removed: [] })
  })
})
