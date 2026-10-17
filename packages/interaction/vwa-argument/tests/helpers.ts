/**
 * Shared test fixtures for the vwa-argument slice-2 specs: a tmpdir
 * workspace, a seeded project, and full author-entity factories (§5 bodies
 * minus system fields).
 * @module tests/helpers
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProjectStore, fail, type Fail } from '../src/store.ts'
import type { ProjectContract, ProjectSnapshot, Source } from '../src/types.ts'

export const PRJ_PREFIX = 'prj_'

export function newProjectId(): string {
  return `${PRJ_PREFIX}${randomUUID()}`
}

export function makeWorkspace(): { root: string; projectId: string; store: ProjectStore } {
  const root = mkdtempSync(join(tmpdir(), 'vwa-arg-'))
  const projectId = newProjectId()
  return { root, projectId, store: new ProjectStore(root, projectId) }
}

export const CONTRACT: ProjectContract = {
  question: 'What explains the documented shift?',
  language: 'en',
  domain: 'history',
  requiredQuestions: [{ id: 'q1', text: 'Is the causal account supported?' }],
  plannedCorpus: [],
  expectedCoreTopics: ['causal shift'],
  mode: 'draft',
}

export function initWorkspace(): { root: string; projectId: string; store: ProjectStore } {
  const made = makeWorkspace()
  const result = made.store.init(CONTRACT)
  if (!result.ok) throw new Error(`init failed: ${result.message}`)
  return made
}

export function expectFail<T>(result: { ok: true; data: T } | Fail, code: Fail['code'], messagePart?: string): Fail {
  if (result.ok) throw new Error(`expected failure ${code}, got ok: ${JSON.stringify(result.data)}`)
  if (result.code !== code) {
    throw new Error(`expected ${code}, got ${result.code}: ${result.message}`)
  }
  if (messagePart !== undefined && !result.message.includes(messagePart)) {
    throw new Error(`expected message containing "${messagePart}", got: ${result.message}`)
  }
  return result
}

export const uuid = randomUUID

/** Seed one registered source (with exact snapshot bytes) plus its snapshot text on disk. */
export function seedSource(store: ProjectStore, text: string): Source {
  const sourceId = `src_${randomUUID()}`
  const dir = store.snapshotDir
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sourceId}.md`), text, 'utf8')
  const { rawSha256 } = require0()
  const source: Source = {
    id: sourceId, entityVersion: 1, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
    snapshotPath: `docs/vwa-sources/x/${sourceId}.md`, snapshotHash: rawSha256(Buffer.from(text, 'utf8')),
    acquisition: { kind: 'unverified', capturedAt: '2026-10-16T00:00:00.000Z' },
    title: 'A source', creators: [], publication: 'unknown', originalLocator: 'loc', edition: 'unknown',
    language: 'en', origin: 'external', material: 'primary',
    lineage: { relation: 'unknown', parentSourceIds: [], note: 'n' },
    authenticity: 'unverified', authenticityBasisEvidenceIds: [],
  }
  const applied = store.withTransaction<void>({
    expectedRevision: store.readHead().ok ? (store.readHead() as { ok: true; data: { head: { revision: number } } }).data.head.revision : 1,
    requestId: `seed-${randomUUID()}`,
    payloadHash: randomUUID(),
    applyFn: (snapshot) => {
      snapshot.sources.push(source)
      return { result: undefined }
    },
  })
  if (!applied.ok) throw new Error(`seed failed: ${applied.message}`)
  return source
}

// Direct import (kept out of the ESM top level to mirror the store's one import site).
import { rawSha256 } from '../src/sources.ts'
function require0(): { rawSha256: typeof rawSha256 } {
  return { rawSha256 }
}

/** Build a snapshot by registering one source with one evidence excerpt (for graph tests). */
export function seedGraphSnapshot(): {
  root: string
  projectId: string
  store: ProjectStore
  snapshot: ProjectSnapshot
  source: Source
  text: string
} {
  const made = initWorkspace()
  const text = 'Paragraph one.\n\nParagraph two with 前后文 and an emoji 🙂 here.\n'
  const source = seedSource(made.store, text)
  const head = made.store.readHead()
  if (!head.ok) throw new Error(head.message)
  return { ...made, snapshot: head.data.snapshot, source, text }
}
