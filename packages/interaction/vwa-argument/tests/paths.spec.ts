/**
 * Slice 2 of design docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md
 * (§8.1 paths, §3.4 canonical-root safety): the v2 state tree holds source
 * snapshots and reports, `Source.snapshotPath` is stored data that reads honor
 * verbatim, and the D22 output-tree classification compares canonical roots.
 * @module tests/paths
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectStore } from '../src/store.ts'
import { CaptureRegistry, rawSha256, readSourceBytes, registerSourceApply, verifySnapshot } from '../src/sources.ts'
import {
  LEGACY_SOURCES_ROOT,
  canonicalStateRoot,
  isRuntimeOutputPath,
  parseSourceSnapshotPath,
  projectSourcesDir,
  resolveRecordedPath,
  reviewReportPath,
  sourceSnapshotPath,
  stateRoot,
} from '../src/paths.ts'
import type { Source } from '../src/types.ts'
import { VwaArgumentService } from '../src/report.ts'
import { initWorkspace, makeWorkspace, seedSource, uuid } from './helpers.ts'

const BODY = 'Fetched article body — verbatim.\n'

const METADATA = {
  title: 'A source',
  creators: [],
  publication: 'unknown',
  originalLocator: 'https://example.test/a',
  edition: 'unknown',
  language: 'en',
  origin: 'external' as const,
  material: 'primary' as const,
}

/** Register one source through the real apply function (the tool's body, §10.3). */
function registerSource(store: ProjectStore, path: string, bytes: string) {
  const captures = new CaptureRegistry()
  captures.record({ tool: 'read', path, bytes: Buffer.from(bytes, 'utf8'), at: '2026-11-15T00:00:00.000Z' })
  const head = store.readHead()
  if (!head.ok) throw new Error(head.message)
  const applied = store.withTransaction({
    expectedRevision: head.data.head.revision,
    requestId: `reg-${uuid()}`,
    payloadHash: uuid(),
    applyFn: registerSourceApply(store, captures, { path, metadata: METADATA, excerpts: [] }),
  })
  if (!applied.ok) throw new Error(applied.message)
  return applied.data
}

describe('§8.1 — registration persists the v2 snapshotPath', () => {
  it('records .dsh/vwa/<projectId>/sources/<sourceId>.md and stages the bytes there', () => {
    const made = initWorkspace()
    const sourcePath = join(made.root, 'fetched.txt')
    writeFileSync(sourcePath, BODY, 'utf8')
    const outcome = registerSource(made.store, sourcePath, BODY)

    expect(outcome.snapshotPath).toBe(sourceSnapshotPath(made.projectId, outcome.sourceId))
    expect(outcome.snapshotPath).toMatch(
      new RegExp(`^\\.dsh/vwa/${made.projectId}/sources/${outcome.sourceId}\\.md$`),
    )
    expect(parseSourceSnapshotPath(outcome.snapshotPath)).toEqual({
      projectId: made.projectId,
      sourceId: outcome.sourceId,
    })

    // Bytes land in the new tree, inside the same commit transaction.
    const absolute = join(projectSourcesDir(made.root, made.projectId), `${outcome.sourceId}.md`)
    expect(existsSync(absolute)).toBe(true)
    expect(readFileSync(absolute, 'utf8')).toBe(BODY)
    expect(readFileSync(join(made.root, outcome.snapshotPath), 'utf8')).toBe(BODY)

    // The record carries the same value, and the legacy tree is never written.
    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const recorded = head.data.snapshot.sources.find((candidate: Source) => candidate.id === outcome.sourceId)
    expect(recorded?.snapshotPath).toBe(outcome.snapshotPath)
    expect(existsSync(join(made.root, LEGACY_SOURCES_ROOT))).toBe(false)
  })

  it('a legacy v1 record still reads its docs/vwa-sources snapshot verbatim', () => {
    const made = initWorkspace()
    const sourceId = `src_${uuid()}`
    const legacyPath = `${LEGACY_SOURCES_ROOT}/${made.projectId}/${sourceId}.md`
    mkdirSync(join(made.root, LEGACY_SOURCES_ROOT, made.projectId), { recursive: true })
    writeFileSync(join(made.root, legacyPath), BODY, 'utf8')

    // snapshotPath is stored data: readers resolve the recorded value (§8.1).
    const source = {
      snapshotPath: legacyPath,
      snapshotHash: rawSha256(Buffer.from(BODY, 'utf8')),
    }
    expect(resolveRecordedPath(made.root, legacyPath)).toBe(join(made.root, legacyPath))
    expect(parseSourceSnapshotPath(legacyPath)).toBeUndefined()
    const verdict = verifySnapshot(made.store, source)
    expect(verdict.ok).toBe(true)
  })
})

/**
 * §5.2 (slice 5) — registration captures the workspace-relative POSIX path of
 * the registered file; `gr:` citability is decided later by the corpus
 * whitelist, so the path is recorded for EVERY registrable source and the
 * sources that predate the field stay `corpusPath`-less (not gr-citable).
 */
describe('§5.2 — registration records corpusPath for gr: citability', () => {
  it('persists the workspace-relative POSIX path of the registered file', () => {
    const made = initWorkspace()
    const sourcePath = join(made.root, 'docs', 'corpus', 'letters.md')
    mkdirSync(dirname(sourcePath), { recursive: true })
    writeFileSync(sourcePath, BODY, 'utf8')
    const outcome = registerSource(made.store, sourcePath, BODY)

    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const recorded = head.data.snapshot.sources.find((candidate: Source) => candidate.id === outcome.sourceId)
    expect(recorded?.corpusPath).toBe('docs/corpus/letters.md')
    expect(outcome.snapshotPath).not.toBe(recorded?.corpusPath)
  })

  it('records corpusPath for non-corpus files too (the whitelist decides citability, not registration)', () => {
    const made = initWorkspace()
    const sourcePath = join(made.root, 'src', 'index.ts')
    mkdirSync(dirname(sourcePath), { recursive: true })
    writeFileSync(sourcePath, BODY, 'utf8')
    const outcome = registerSource(made.store, sourcePath, BODY)

    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const recorded = head.data.snapshot.sources.find((candidate: Source) => candidate.id === outcome.sourceId)
    expect(recorded?.corpusPath).toBe('src/index.ts')
  })

  it('the service exposes the registry for gr: checks and omits an absent corpusPath', () => {
    const made = initWorkspace()
    const sourcePath = join(made.root, 'docs', 'corpus', 'letters.md')
    mkdirSync(dirname(sourcePath), { recursive: true })
    writeFileSync(sourcePath, BODY, 'utf8')
    const outcome = registerSource(made.store, sourcePath, BODY)
    const legacy = seedSource(made.store, BODY).id

    const registry = new VwaArgumentService({ root: made.root }).listProjectSources(made.projectId)
    expect(registry.find((entry) => entry.sourceId === outcome.sourceId)).toEqual({
      sourceId: outcome.sourceId,
      corpusPath: 'docs/corpus/letters.md',
      snapshotPath: outcome.snapshotPath,
      snapshotHash: outcome.snapshotHash,
    })
    const legacyEntry = registry.find((entry) => entry.sourceId === legacy)
    expect(legacyEntry).toBeDefined()
    expect(Object.hasOwn(legacyEntry as object, 'corpusPath')).toBe(false)
    expect(new VwaArgumentService({ root: made.root }).listProjectSources('prj_missing')).toEqual([])
  })
})

describe('§8.1 — reports move to .dsh/vwa/<projectId>/reports', () => {
  it('builds the workspace-relative report path the report tool publishes to', () => {
    const made = makeWorkspace()
    expect(reviewReportPath(made.projectId, 'art_1', 'markdown')).toBe(
      `.dsh/vwa/${made.projectId}/reports/art_1.review.md`,
    )
    expect(reviewReportPath(made.projectId, 'art_1', 'json')).toBe(
      `.dsh/vwa/${made.projectId}/reports/art_1.review.json`,
    )
    expect(parseSourceSnapshotPath(`.dsh/vwa/${made.projectId}/reports/art_1.review.md`)).toBeUndefined()
  })
})

describe('§3.4 — the D22 classification compares canonical roots', () => {
  it('rejects a source reached through a symlinked .dsh/vwa', () => {
    const made = makeWorkspace()
    const state = join(made.root, 'docs', 'state')
    mkdirSync(join(state, made.projectId, 'reports'), { recursive: true })
    writeFileSync(join(state, made.projectId, 'reports', 'a.md'), 'report bytes\n', 'utf8')
    mkdirSync(join(made.root, '.dsh'), { recursive: true })
    symlinkSync(state, join(made.root, '.dsh', 'vwa'), 'dir')

    const candidate = join(state, made.projectId, 'reports', 'a.md')
    expect(canonicalStateRoot(made.root)).toBe(realpathSync(state))
    expect(isRuntimeOutputPath(made.root, realpathSync(candidate))).toBe(true)
    expect(() => readSourceBytes(made.root, candidate)).toThrow(/runtime output tree|D22/)
  })

  it('falls back to the lexical root when .dsh/vwa does not exist yet', () => {
    const made = makeWorkspace()
    expect(existsSync(stateRoot(made.root))).toBe(false)
    expect(canonicalStateRoot(made.root)).toBe(stateRoot(made.root))
    const sourcePath = join(made.root, 'notes.md')
    writeFileSync(sourcePath, 'ordinary workspace bytes\n', 'utf8')
    expect(readSourceBytes(made.root, sourcePath).text).toBe('ordinary workspace bytes\n')
  })

  it('rejects a lexical .dsh/vwa source and the legacy output trees', () => {
    const made = makeWorkspace()
    for (const relative of [
      `.dsh/vwa/${made.projectId}/sources/x.md`,
      `${LEGACY_SOURCES_ROOT}/${made.projectId}/x.md`,
      'docs/vwa-reports/x.md',
    ]) {
      const absolute = join(made.root, ...relative.split('/'))
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, 'x\n', 'utf8')
      expect(() => readSourceBytes(made.root, absolute)).toThrow(/runtime output tree|D22/)
    }
  })
})
