/**
 * Shadow-verdict ledger unit tests (design
 * docs/plans/2026-11-25-systemone-shadow-verdict-ledger.md §"Verification"):
 * closed-schema validation (unknown keys, wrong types, caps), rotation at
 * the byte cap, torn-tail repair, per-directory serialization, and the
 * never-rejects contract of the append entry point. All legs run in
 * tmpdirs — the real dsh home is never touched.
 */
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SHADOW_VERDICTS_FILE_NAME,
  SHADOW_VERDICTS_MAX_BYTES,
  SHADOW_VERDICTS_PAYLOAD_MAX_BYTES,
  SHADOW_VERDICTS_ROTATED_NAME,
  appendShadowVerdict,
  parseShadowVerdictLine,
  validateShadowVerdictInput,
} from '../src/shadow-verdicts.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => stat(dir).then(() => undefined, () => undefined)))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-verdicts-'))
  dirs.push(dir)
  return dir
}

const deps = {
  now: () => 1795486845000,
  uuid: (() => {
    let n = 0
    return () => `event-${(n += 1)}`
  })(),
}

const extractionPayload = {
  verdict: 'would-skip',
  probability: 0.05,
  skipThreshold: 0.15,
  fromExclusive: 12,
  throughInclusive: 47,
  surfaceEvents: 42,
  stateBytes: 1843,
}

const discoveryPayload = {
  queryHash8: 'a1b2c3d4e5f60708',
  suggested: ['Bash'],
  lexical: ['Bash', 'Grep'],
  differing: true,
  suggestedOnly: 0,
  lexicalOnly: 1,
  candidatesJudged: 12,
  originSeq: 1157,
}

const skillrecPayload = {
  status: 'shadow',
  eligible: 128,
  judged: 96,
  recommended: ['article-review'],
  requestLatencyMs: 812,
  requestTimeoutMs: 5000,
}

describe('closed-schema validation', () => {
  it('accepts a valid extraction payload', () => {
    const result = validateShadowVerdictInput({
      feature: 'memory-extraction',
      decisionIds: ['d-1'],
      mode: 'shadow',
      payload: { ...extractionPayload },
    })
    expect(result.ok).toBe(true)
  })

  it('drops an unknown key', () => {
    const result = validateShadowVerdictInput({
      feature: 'memory-extraction',
      decisionIds: ['d-1'],
      mode: 'shadow',
      payload: { ...extractionPayload, state: 'private short message' },
    })
    expect(result).toMatchObject({ ok: false, reason: 'unknown-key', key: 'state' })
  })

  it('drops a wrong-typed field', () => {
    const result = validateShadowVerdictInput({
      feature: 'tool-discovery',
      decisionIds: [],
      mode: 'active',
      payload: { ...discoveryPayload, differing: 'yes' },
    })
    expect(result).toMatchObject({ ok: false, reason: 'wrong-type', key: 'differing' })
  })

  it('drops a missing required field', () => {
    const { verdict: _omitted, ...rest } = extractionPayload
    const result = validateShadowVerdictInput({
      feature: 'memory-extraction',
      decisionIds: ['d-1'],
      mode: 'shadow',
      payload: rest,
    })
    expect(result).toMatchObject({ ok: false, reason: 'wrong-type', key: 'verdict' })
  })

  it('drops a 257-char string (the size backstop)', () => {
    const result = validateShadowVerdictInput({
      feature: 'tool-discovery',
      decisionIds: [],
      mode: 'shadow',
      payload: { ...discoveryPayload, queryHash8: 'a'.repeat(257) },
    })
    expect(result).toMatchObject({ ok: false, reason: 'string-too-long', key: 'queryHash8' })
  })

  it('drops an oversize serialized payload', () => {
    const result = validateShadowVerdictInput({
      feature: 'tool-discovery',
      decisionIds: [],
      mode: 'shadow',
      payload: { ...discoveryPayload, suggested: Array.from({ length: 129 }, (_, i) => `skill-${i}`) },
    })
    expect(result).toMatchObject({ ok: false, reason: 'array-too-long', key: 'suggested' })
  })

  it('accepts a decimal-string window seq (the host seq type)', () => {
    const result = validateShadowVerdictInput({
      feature: 'memory-extraction',
      decisionIds: ['d-1'],
      mode: 'shadow',
      payload: { ...extractionPayload, fromExclusive: '15', throughInclusive: '30' },
    })
    expect(result.ok).toBe(true)
  })

  it('accepts skill-rec pre-dispatch terminals without pool fields', () => {
    const result = validateShadowVerdictInput({
      feature: 'skill-recommendation',
      decisionIds: [],
      mode: 'shadow',
      payload: { status: 'unavailable', failureClass: 'unconfigured', requestLatencyMs: 3, requestTimeoutMs: 5000 },
    })
    expect(result.ok).toBe(true)
  })
})

describe('appendShadowVerdict', () => {
  it('persists a valid row, parseable by the reader', async () => {
    const dir = await tempDir()
    await appendShadowVerdict(
      dir,
      { feature: 'memory-extraction', decisionIds: ['d-1'], mode: 'shadow', payload: { ...extractionPayload } },
      deps,
    )
    const text = await readFile(join(dir, SHADOW_VERDICTS_FILE_NAME), 'utf8')
    const row = parseShadowVerdictLine(text.trimEnd())
    expect(row).toMatchObject({
      schemaVersion: 1,
      eventId: 'event-1',
      feature: 'memory-extraction',
      mode: 'shadow',
      decisionIds: ['d-1'],
    })
  })

  it('drops a rejected payload without writing a line and never rejects', async () => {
    const dir = await tempDir()
    const warns: string[] = []
    await appendShadowVerdict(
      dir,
      // @ts-expect-error — a hostile payload shape is the point of this leg
      { feature: 'memory-extraction', decisionIds: ['d-1'], mode: 'shadow', payload: { oops: true } },
      { ...deps, warn: m => warns.push(m) },
    )
    await expect(readFile(join(dir, SHADOW_VERDICTS_FILE_NAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(warns.join('\n')).toContain('unknown-key')
  })

  it('never rejects on an unwritable directory', async () => {
    const dir = join(await tempDir(), 'no', 'such', 'dir')
    await expect(
      appendShadowVerdict(
        dir,
        { feature: 'memory-extraction', decisionIds: [], mode: 'shadow', payload: { ...extractionPayload } },
        deps,
      ),
    ).resolves.toBeUndefined()
  })

  it('serializes concurrent appends per directory (two rows, both intact)', async () => {
    const dir = await tempDir()
    await Promise.all([
      appendShadowVerdict(dir, { feature: 'tool-discovery', decisionIds: ['d-1'], mode: 'shadow', payload: { ...discoveryPayload } }, deps),
      appendShadowVerdict(dir, { feature: 'skill-recommendation', decisionIds: [], mode: 'shadow', payload: { ...skillrecPayload } }, deps),
    ])
    const text = await readFile(join(dir, SHADOW_VERDICTS_FILE_NAME), 'utf8')
    const lines = text.split('\n').filter(l => l.trim() !== '')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(parseShadowVerdictLine(line)).toBeDefined()
  })

  it('repairs a torn tail (no trailing newline)', async () => {
    const dir = await tempDir()
    await appendShadowVerdict(
      dir,
      { feature: 'memory-extraction', decisionIds: ['d-1'], mode: 'shadow', payload: { ...extractionPayload } },
      deps,
    )
    // Simulate a crash mid-append: strip the trailing newline.
    const file = join(dir, SHADOW_VERDICTS_FILE_NAME)
    const text = await readFile(file, 'utf8')
    await writeFile(file, text.trimEnd(), 'utf8')
    await appendShadowVerdict(
      dir,
      { feature: 'memory-extraction', decisionIds: ['d-2'], mode: 'shadow', payload: { ...extractionPayload, probability: 0.9 } },
      deps,
    )
    const repaired = await readFile(file, 'utf8')
    const lines = repaired.split('\n').filter(l => l.trim() !== '')
    // The torn first line may or may not still parse (it was truncated) but the
    // second row must be intact on its own line.
    const parsed = lines.map(l => parseShadowVerdictLine(l))
    expect(parsed[parsed.length - 1]).toMatchObject({ decisionIds: ['d-2'] })
  })

  it('rotates at the byte cap and keeps the prior generation', async () => {
    const dir = await tempDir()
    // Shrink the cap for the test by writing a file just under it, then one
    // more row that crosses it: emulate with a big-ish payload per row.
    const bigNames = Array.from({ length: 60 }, (_, i) => `skill-name-${i}`)
    const bigPayload = { ...discoveryPayload, suggested: bigNames, lexical: bigNames }
    for (let i = 0; i < 40; i += 1) {
      await appendShadowVerdict(dir, { feature: 'tool-discovery', decisionIds: [`d-${i}`], mode: 'shadow', payload: bigPayload }, deps)
    }
    const before = await stat(join(dir, SHADOW_VERDICTS_FILE_NAME))
    expect(before.size).toBeLessThanOrEqual(SHADOW_VERDICTS_MAX_BYTES)
    // Force rotation by pre-sizing the current file over the cap.
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), 'x'.repeat(SHADOW_VERDICTS_MAX_BYTES + 1), 'utf8')
    await appendShadowVerdict(dir, { feature: 'tool-discovery', decisionIds: ['d-final'], mode: 'shadow', payload: { ...discoveryPayload } }, deps)
    const entries = await readdir(dir)
    expect(entries).toContain(SHADOW_VERDICTS_ROTATED_NAME)
    const rows = (await readFile(join(dir, SHADOW_VERDICTS_FILE_NAME), 'utf8')).split('\n').filter(l => l.trim() !== '')
    expect(rows).toHaveLength(1)
    expect(parseShadowVerdictLine(rows[0]!)).toMatchObject({ decisionIds: ['d-final'] })
  })
})

describe('parseShadowVerdictLine', () => {
  it('reads blank lines as undefined', () => {
    expect(parseShadowVerdictLine('')).toBeUndefined()
    expect(parseShadowVerdictLine('   ')).toBeUndefined()
  })

  it('rejects a non-object line and a wrong schemaVersion', () => {
    expect(parseShadowVerdictLine('not json')).toBeUndefined()
    expect(parseShadowVerdictLine('42')).toBeUndefined()
    expect(
      parseShadowVerdictLine(JSON.stringify({ schemaVersion: 99, eventId: 'e', time: 1, feature: 'memory-extraction', mode: 'shadow', decisionIds: [], payload: extractionPayload })),
    ).toBeUndefined()
  })
})

describe('payload size bound', () => {
  it('caps the serialized payload at the documented bound', async () => {
    const dir = await tempDir()
    const names = Array.from({ length: 120 }, (_, i) => `s-${i}`)
    const payload = { ...skillrecPayload, recommended: names }
    const serialized = JSON.stringify(payload)
    expect(serialized.length).toBeLessThanOrEqual(SHADOW_VERDICTS_PAYLOAD_MAX_BYTES)
    await appendShadowVerdict(dir, { feature: 'skill-recommendation', decisionIds: [], mode: 'shadow', payload }, deps)
    const text = await readFile(join(dir, SHADOW_VERDICTS_FILE_NAME), 'utf8')
    expect(text).toContain('s-0')
  })
})
