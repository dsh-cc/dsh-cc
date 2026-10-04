/**
 * Unit tests for the resume-pin schema (§4.2 of the resume-pins plan):
 * round-trip through the canonical writer/parser, unknown-field tolerance,
 * and the `version` guard.
 *
 * @module tests/pin.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PinParseError, parsePin, writePin } from '../src/pin.ts'
import { PinStore } from '../src/store.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-resume-pins-'))
  roots.push(root)
  return root
}

function completePin(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: 1 as const,
    childId: '0b6f9c88-1111-4222-8333-444455556666',
    parentSessionId: 'parent-1',
    label: 'researcher',
    mode: 'continuable-background' as const,
    createdAt: '2026-09-04T00:00:00.000Z',
    definition: {
      kind: 'named' as const,
      agentType: 'researcher',
      source: 'project' as const,
      fingerprint: 'sha256:aaaa',
      personaHash: 'sha256:bbbb',
    },
    modelSelector: { raw: 'sonnet', via: 'alias' as const },
    effective: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: null,
      maxTokens: 12345,
      complete: true,
    },
    toolFilter: { allow: ['Read'], deny: ['Bash'] },
    maxTurns: 30,
    workspace: { cwd: '/w', gitDir: '/w/.git', gitCommonDir: '/w/.git', branch: 'main' },
    resume: { state: 'ok' as const },
    ...overrides,
  }
}

describe('pin round-trip', () => {
  it('serializes and parses a complete named pin without loss', () => {
    const pin = completePin()
    const text = writePin(pin as never)
    const parsed = parsePin(text)
    expect(parsed).toEqual(pin)
  })

  it('round-trips a plain-definition pin with optional fields absent', () => {
    const pin = {
      version: 1 as const,
      childId: 'aaaaaaaa-1111-4222-8333-444455556666',
      parentSessionId: 'parent-2',
      label: 'helper',
      mode: 'continuable-background' as const,
      createdAt: '2026-09-04T00:00:00.000Z',
      definition: { kind: 'plain' as const },
      modelSelector: { raw: 'inherit', via: 'inherit' as const },
      effective: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high', maxTokens: null, complete: true },
      toolFilter: { allow: [], deny: [] },
      workspace: { cwd: '/w', gitDir: '/w/.git', gitCommonDir: '/w/.git', branch: 'main' },
      resume: { state: 'ok' as const },
    }
    expect(parsePin(writePin(pin as never))).toEqual(pin)
  })
})

describe('tolerant reader', () => {
  it('ignores unknown top-level and nested fields', () => {
    const pin = completePin()
    const text = writePin(pin as never)
    const doctored = JSON.parse(text) as Record<string, unknown>
    doctored.futureField = 'whatever'
    ;(doctored.effective as Record<string, unknown>).newAdapterDefault = 99
    const parsed = parsePin(JSON.stringify(doctored))
    expect(parsed).toEqual(pin)
  })

  it('rejects an unsupported version with a typed error', () => {
    const doctored = { ...completePin(), version: 2 }
    expect(() => parsePin(JSON.stringify(doctored))).toThrow(PinParseError)
  })

  it('rejects malformed JSON with a typed error', () => {
    expect(() => parsePin('{not json')).toThrow(PinParseError)
  })

  it('rejects a pin missing required fields', () => {
    const { childId, ...rest } = completePin()
    expect(() => parsePin(JSON.stringify(rest))).toThrow(PinParseError)
  })

  it('rejects a pin whose definition kind is neither plain nor named', () => {
    const pin = completePin()
    const doctored = { ...pin, definition: { kind: 'weird' } }
    expect(() => parsePin(JSON.stringify(doctored))).toThrow(PinParseError)
  })

  it('rejects an effective block MISSING reasoningEffort/maxTokens — presence is contractual (M9)', () => {
    const pin = completePin()
    const noEffort = JSON.parse(writePin(pin as never)) as Record<string, unknown>
    delete (noEffort.effective as Record<string, unknown>).reasoningEffort
    expect(() => parsePin(JSON.stringify(noEffort))).toThrow(/reasoningEffort/)
    const noMax = JSON.parse(writePin(pin as never)) as Record<string, unknown>
    delete (noMax.effective as Record<string, unknown>).maxTokens
    expect(() => parsePin(JSON.stringify(noMax))).toThrow(/maxTokens/)
    // An explicit null is still the absence encoding, not an error.
    const explicitNull = { ...pin, effective: { ...pin.effective, maxTokens: null } }
    expect(parsePin(writePin(explicitNull as never)).effective.maxTokens).toBeNull()
  })
})

describe('R9 dispatch tier + autoReleaseMs pin fields', () => {
  it('round-trips both fields through parsePin/writePin', () => {
    const pin = completePin({ dispatchTier: 'foreground', autoReleaseMs: 0 })
    const parsed = parsePin(writePin(pin as never))
    expect(parsed.dispatchTier).toBe('foreground')
    expect(parsed.autoReleaseMs).toBe(0)
  })

  it('omits both fields on a legacy pin (absent, not null)', () => {
    const pin = completePin()
    const parsed = parsePin(writePin(pin as never))
    expect(parsed.dispatchTier).toBeUndefined()
    expect(parsed.autoReleaseMs).toBeUndefined()
  })

  it('rejects a malformed dispatchTier with a typed error', () => {
    const pin = completePin({ dispatchTier: 'sideways' })
    expect(() => parsePin(JSON.stringify(pin))).toThrow(PinParseError)
    expect(() => parsePin(JSON.stringify(pin))).toThrow(/dispatchTier/)
  })

  it('rejects a malformed autoReleaseMs (negative, fractional, non-number)', () => {
    for (const bad of [-1, 1.5, '60000', null]) {
      const pin = completePin({ autoReleaseMs: bad })
      expect(() => parsePin(JSON.stringify(pin))).toThrow(PinParseError)
    }
  })

  it('both fields survive a PinStore.update round-trip (closed field set)', () => {
    const store = new PinStore(tempRoot())
    const id = '0b6f9c88-1111-4222-8333-444455556666'
    store.write(parsePin(writePin(completePin({ dispatchTier: 'background', autoReleaseMs: 0 }) as never)))
    store.update(id, draft => {
      draft.dispatchTier = 'foreground'
      draft.lastNotice = 'n'
    })
    const after = store.read(id)
    expect(after).toMatchObject({ dispatchTier: 'foreground', autoReleaseMs: 0 })
  })
})

describe('PinStore', () => {
  it('returns undefined for an absent pin and a corrupt sentinel for an unparseable one', () => {
    const store = new PinStore(tempRoot())
    expect(store.read('0b6f9c88-1111-4222-8333-444455556666')).toBeUndefined()
    const corruptId = '11111111-2222-4333-8444-555566667777'
    writeFileSync(store.pathFor(corruptId), '{broken')
    expect(store.read(corruptId)).toMatchObject({ kind: 'corrupt' })
  })

  it('write fails when the pin already exists', () => {
    const store = new PinStore(tempRoot())
    const pin = completePin()
    store.write(pin as never)
    expect(() => store.write(pin as never)).toThrow()
  })

  it('update mutates the disk file and publishes to the cache synchronously', () => {
    const store = new PinStore(tempRoot())
    const pin = completePin()
    store.write(pin as never)
    store.update(pin.childId, draft => {
      draft.resume = { state: 'blocked', reason: 'PIN_UNREADABLE' }
    })
    expect(store.getCached(pin.childId)?.resume).toEqual({ state: 'blocked', reason: 'PIN_UNREADABLE' })
    expect(store.read(pin.childId)?.resume).toEqual({ state: 'blocked', reason: 'PIN_UNREADABLE' })
  })

  it('updates to different childIds lose nothing (independently delayed async writers)', async () => {
    // NOTE: PinStore reads/writes are synchronous, so this exercises interleaved
    // async scheduling of independent writers, not true intra-store concurrency.
    const store = new PinStore(tempRoot())
    const ids = ['0b6f9c88-1111-4222-8333-444455556666', '11111111-2222-4333-8444-555566667777', '22222222-3333-4444-8555-666677778888']
    for (let i = 0; i < ids.length; i++) {
      store.write(completePin({ childId: ids[i] }) as never)
    }
    await Promise.all(ids.map(async (id, i) => {
      await new Promise(resolve => setTimeout(resolve, i * 5))
      store.update(id, draft => { draft.label = `label-a-${i}` })
      store.update(id, draft => { draft.lastNotice = `notice-${i}` })
    }))
    for (let i = 0; i < ids.length; i++) {
      const pin = store.read(ids[i])
      expect(pin?.label).toBe(`label-a-${i}`)
      expect(pin?.lastNotice).toBe(`notice-${i}`)
    }
  })

  it('a failed disk read invalidates the cache entry — a file deleted or corrupted out-of-band is never served stale (H4)', () => {
    const store = new PinStore(tempRoot())
    const pin = completePin()
    store.write(pin as never)
    expect(store.getCached(pin.childId)).toBeDefined()
    // Corrupt the file out-of-band.
    writeFileSync(store.pathFor(pin.childId), '{broken')
    expect(store.read(pin.childId)).toMatchObject({ kind: 'corrupt' })
    expect(store.getCached(pin.childId)).toBeUndefined()
    // Restore, update (warms the cache), then delete the file out-of-band.
    store.write({ ...pin, childId: '99999999-1111-4222-8333-444455556666' } as never)
    store.update('99999999-1111-4222-8333-444455556666', draft => { draft.lastNotice = 'x' })
    rmSync(store.pathFor('99999999-1111-4222-8333-444455556666'))
    expect(store.read('99999999-1111-4222-8333-444455556666')).toBeUndefined()
    expect(store.getCached('99999999-1111-4222-8333-444455556666')).toBeUndefined()
  })

  it('remove tombstone-deletes the pin and its cache entry', () => {
    const store = new PinStore(tempRoot())
    const pin = completePin()
    store.write(pin as never)
    store.remove(pin.childId)
    expect(store.read(pin.childId)).toBeUndefined()
    expect(store.getCached(pin.childId)).toBeUndefined()
  })

  it('rejects childIds containing path separators or ..', () => {
    const store = new PinStore(tempRoot())
    expect(() => store.pathFor('../evil')).toThrow()
    expect(() => store.pathFor('a/b')).toThrow()
    expect(() => store.pathFor('..')).toThrow()
  })
})
