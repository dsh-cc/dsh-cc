/**
 * Pipeline pins (§4.5 composition over §4.1-§4.3): extract -> verify ->
 * gates -> coverage/overall -> receipt row; writeReceipt convenience.
 * Pure modules only — no cordis mounting in this slice.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256Hex, writeReceipt, type ReceiptRow } from '../src/receipt.ts'
import { DEFAULT_VWA_EVIDENCE_SETTINGS, SETTINGS_NAMESPACE, SettingsSchema } from '../src/settings.ts'
import { evaluateArtifact } from '../src/pipeline.ts'
import type { Executor } from '../src/gates.ts'

const passExec: Executor = async () => ({ code: 0, stdout: '', stderr: '' })

async function workspaceWith(aMd: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'vwa-pipeline-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'a.md'), aMd)
  await writeFile(join(root, 'docs', 'b.md'), '# Beta\nsource\n')
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('evaluateArtifact', () => {
  it('pass: legal in-bounds marker covering the detected claim', async () => {
    const { root, cleanup } = await workspaceWith('ships 42 files 〔src:ws:docs/b.md#L1-L2〕 per run.')
    const { row, coverage, overall } = await evaluateArtifact({
      sessionId: 'sess-1',
      artifactPath: 'docs/a.md',
      text: 'ships 42 files 〔src:ws:docs/b.md#L1-L2〕 per run.',
      workspaceRoot: root,
      exec: passExec,
      gates: { skip: ['exec'] },
    })
    expect(overall).toBe('pass')
    expect(coverage).toBe(1)
    expect(row.v).toBe(1)
    expect(row.artifactHash).toBe(sha256Hex('ships 42 files 〔src:ws:docs/b.md#L1-L2〕 per run.'))
    expect(row.overall).toBe('pass')
    expect(row.claims[0]?.status).toBe('marked-ok')
    expect(row.claims[0]?.sourceId).toBe('ws:docs/b.md')
    expect(row.numbers[0]?.ref).toBe('42 files')
    expect(row.numbers[0]?.paramsHash).toContain('v1-placeholder')
    expect(row.gates.map(g => g.gate)).toEqual(['link', 'style', 'exec'])
    expect(row.nudge).toEqual({ round: 0 })
    await cleanup()
  })

  it('fails on an out-of-bounds claim (§8: any single one fails the whole artifact)', async () => {
    const { root, cleanup } = await workspaceWith('')
    const { row, overall } = await evaluateArtifact({
      sessionId: 's',
      artifactPath: 'docs/a.md',
      text: 'ships 42 files 〔src:ws:../x.md#L1-L2〕 here.',
      workspaceRoot: root,
      exec: passExec,
      gates: { skip: ['exec'] },
    })
    expect(overall).toBe('fail')
    expect(row.claims[0]?.status).toBe('out-of-bounds')
    await cleanup()
  })

  it('fails when a gate fails, even with verified claims', async () => {
    // The on-disk artifact must match `text`: the gates read back from disk.
    const { root, cleanup } = await workspaceWith('[broken](ghost.md) and 3 files 〔src:ws:docs/b.md#L1-L2〕.')
    const { overall } = await evaluateArtifact({
      sessionId: 's',
      artifactPath: 'docs/a.md',
      text: '[broken](ghost.md) and 3 files 〔src:ws:docs/b.md#L1-L2〕.',
      workspaceRoot: root,
      exec: passExec,
      gates: { skip: ['exec'] },
    })
    expect(overall).toBe('fail')
    await cleanup()
  })

  it('abstained when no claims are detected and no gate fails', async () => {
    const { root, cleanup } = await workspaceWith('')
    const { row, coverage, overall } = await evaluateArtifact({
      sessionId: 's',
      artifactPath: 'docs/a.md',
      text: 'plain prose, nothing verifiable here.',
      workspaceRoot: root,
      exec: passExec,
      gates: { skip: ['exec'] },
    })
    expect(overall).toBe('abstained')
    expect(coverage).toBeNull()
    expect(row.claims).toEqual([])
    await cleanup()
  })

  it('unmarked claims are detected but not covered (coverage 0)', async () => {
    const { root, cleanup } = await workspaceWith('')
    const { coverage, overall } = await evaluateArtifact({
      sessionId: 's',
      artifactPath: 'docs/a.md',
      text: 'ships 42 files, unmarked.',
      workspaceRoot: root,
      exec: passExec,
      gates: { skip: ['exec'] },
    })
    expect(overall).toBe('pass')
    expect(coverage).toBe(0)
    await cleanup()
  })

  it('writeReceipt appends the canonical row and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vwa-pipeline-'))
    const ledger = join(dir, 'l.jsonl')
    const row: ReceiptRow = {
      v: 1,
      ts: 1,
      sessionId: 's',
      artifactId: 'a',
      artifactPath: 'a',
      artifactHash: 'h',
      claims: [],
      numbers: [],
      gates: [],
      provenance: { inputs: [], parentHash: '' },
      overall: 'abstained',
      nudge: { round: 0 },
    }
    const result = await writeReceipt(ledger, row)
    expect(result.ok).toBe(true)
    const text = await readFile(ledger, 'utf8')
    expect(text.trimEnd().endsWith('}')).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('settings shape (§4.4 schema-first)', () => {
  it('namespace, defaults, and absence-preserving schema are exported', () => {
    expect(SETTINGS_NAMESPACE).toBe('vwa-evidence')
    expect(DEFAULT_VWA_EVIDENCE_SETTINGS).toEqual({
      enabled: true,
      'nudge-budget': 4,
      'gate-timeout-ms': 30_000,
      'coverage-threshold': 0.9,
    })
    // Resolves a real section to defaults-preserving values.
    const resolved = SettingsSchema({ enabled: true }) as Record<string, unknown>
    expect(resolved).toBeDefined()
  })
})
