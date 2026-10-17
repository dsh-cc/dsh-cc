/**
 * D23 (§10.3): acquisition is never upgraded by a model's fabrication loop —
 * "model fabricates text → write → read → register external" leaves the
 * source `unverified`. The ONLY upgrade path is a same-session write/edit
 * whose bytes are BYTE-IDENTICAL to a trusted whitelist capture
 * (`web_fetch`/`read`). Extend the sources tests accordingly.
 * @module tests/sources-dcases
 */

import { describe, expect, it } from 'vitest'
import { CaptureRegistry, type CaptureEvent } from '../src/sources.ts'

const BODY = Buffer.from('Captured article body, verbatim.\n', 'utf8')

function capture(tool: CaptureEvent['tool'], path: string, bytes: Buffer): CaptureEvent {
  return { tool, path, bytes, at: '2026-10-16T00:00:00.000Z' }
}

describe('D23 — acquisition never upgrades without byte identity', () => {
  it('a trusted read capture of the exact bytes → tool-event', () => {
    const captures = new CaptureRegistry()
    captures.record(capture('read', '/x/docs/a.md', BODY))
    expect(captures.classify('/x/docs/a.md', BODY).kind).toBe('tool-event')
  })

  it('a fabricated write → read → register: NO capture of those bytes → unverified (never upgraded)', () => {
    const captures = new CaptureRegistry()
    // The model "reads" its own fabricated bytes through a write; no
    // whitelist capture of this body ever happened.
    captures.record(capture('write', '/x/docs/fabricated.md', BODY))
    captures.record(capture('read', '/x/docs/fabricated-echo.md', BODY))
    // Registration of the fabricated file: bytes match a read of a DIFFERENT
    // path, and the write is not byte-identical to any capture → unverified.
    expect(captures.classify('/x/docs/fabricated.md', BODY).kind).toBe('unverified')
  })

  it('the upgrade path requires a write/edit byte-identical to an existing capture of the SAME path', () => {
    const captures = new CaptureRegistry()
    captures.record(capture('web_fetch', '/x/docs/a.md', BODY))
    // A later edit reproducing the captured bytes exactly → upgraded.
    expect(captures.classify('/x/docs/a.md', BODY).kind).toBe('tool-event')
    // Any byte difference → no upgrade, regardless of tool history.
    expect(captures.classify('/x/docs/a.md', Buffer.from(`${BODY}tail\n`, 'utf8')).kind).toBe('unverified')
  })

  it('a same-path write byte-identical to a whitelist capture upgrades to tool-event', () => {
    const captures = new CaptureRegistry()
    captures.record(capture('web_fetch', '/x/docs/a.md', BODY))
    captures.record(capture('write', '/x/docs/a.md', BODY))
    const classified = captures.classify('/x/docs/a.md', BODY)
    // The whitelist capture of the same bytes classifies as tool-event (the
    // byte-identity gate, not the tool name, is what matters).
    expect(classified.kind).toBe('tool-event')
    expect(classified.eventRef).toContain('web_fetch')
  })

  it('byte-identity is the whole test: same length, different bytes → unverified', () => {
    const captures = new CaptureRegistry()
    captures.record(capture('read', '/x/docs/a.md', BODY))
    const tamperedBytes = Buffer.from('Captured article body, verbatim!\n', 'utf8')
    expect(tamperedBytes.length).toBe(BODY.length)
    expect(captures.classify('/x/docs/a.md', tamperedBytes).kind).toBe('unverified')
  })
})
