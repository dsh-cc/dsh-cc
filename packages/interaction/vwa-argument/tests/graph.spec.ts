/**
 * Graph-level deterministic tests (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §22.1): D01 quote mismatch,
 * D02 UTF-16/raw bytes, D03 lineage cluster, D04 all-group dependencies,
 * D05 SUPPORT_CYCLE, D06 REFERENCE_IN_USE, D11 unrelated-claim digest,
 * D12 artifact byte change.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GraphContext, applyMutation, assertNoSupportCycle, validateEvidenceAgainstSnapshot, type Mutation } from '../src/graph.ts'
import { validateArtifactPath } from '../src/artifact.ts'
import { buildReverseIndex, dependencyDigest, dependencyEntries } from '../src/dependencies.ts'
import { lineageClusterOf } from '../src/sources.ts'
import { ProjectStore, VwaFail, type StagedFile } from '../src/store.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { stripMarkers } from '../src/render.ts'
import { seedGraphSnapshot, seedSource, initWorkspace, uuid } from './helpers.ts'
import type { Argument, Claim, Evidence } from '../src/types.ts'

const TEXT = 'Paragraph one.\n\nParagraph two with 前后文 and an emoji 🙂 here.\n'

function failOf(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof VwaFail) return { code: error.fail.code, message: error.fail.message }
    throw error
  }
  throw new Error('expected a VwaFail')
}

function claimOf(snapshot: import('../src/types.ts').ProjectSnapshot, id: string): Claim {
  return snapshot.claims.find((claim) => claim.id === id) as Claim
}

/** Register one evidence excerpt for `source` via a transaction. */
function addEvidence(ctx: { store: import('../src/store.ts').ProjectStore; source: import('../src/types.ts').Source }, start: number, end: number): Evidence {
  const quote = TEXT.slice(start, end)
  let evidence!: Evidence
  const head = ctx.store.readHead()
  if (!head.ok) throw new Error(head.message)
  const result = ctx.store.withTransaction<Evidence>({
    expectedRevision: head.data.head.revision,
    requestId: uuid(),
    payloadHash: uuid(),
    applyFn: (snapshot) => {
      evidence = {
        id: `ev_${uuid()}`, entityVersion: 1,
        createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
        sourceId: ctx.source.id, sourceSnapshotHash: ctx.source.snapshotHash,
        span: { start, end }, quote, contextSpan: { start, end },
        originalLocation: 'loc', transformation: 'none', transformationNote: '',
      }
      snapshot.evidence.push(evidence)
      return { result: evidence }
    },
  })
  if (!result.ok) throw new Error(result.message)
  return evidence
}

function addClaim(ctx: { store: import('../src/store.ts').ProjectStore }, text: string): Claim {
  const head = ctx.store.readHead()
  if (!head.ok) throw new Error(head.message)
  let claim!: Claim
  const result = ctx.store.withTransaction<Claim>({
    expectedRevision: head.data.head.revision,
    requestId: uuid(),
    payloadHash: uuid(),
    applyFn: (snapshot) => {
      claim = {
        id: `cl_${uuid()}`, entityVersion: 1,
        createdAt: 't', updatedAt: 't',
        text, kind: 'fact',
        scope: { subject: 's', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
        importance: 'supporting', stance: 'asserted', evaluationCriteria: [],
      }
      snapshot.claims.push(claim)
      return { result: claim }
    },
  })
  if (!result.ok) throw new Error(result.message)
  return claim
}

describe('D01 quote mismatch', () => {
  it('rejects a quote that differs from the snapshot slice (mechanical, before any review)', () => {
    const made = seedGraphSnapshot()
    const start = TEXT.indexOf('Paragraph two')
    try {
      validateEvidenceAgainstSnapshot(
        { span: { start, end: start + 5 }, quote: 'Wrong text', contextSpan: { start, end: start + 5 } },
        TEXT,
      )
      throw new Error('expected rejection')
    } catch (error: unknown) {
      const failure = failOf(() => { throw error })
      expect(failure.code).toBe('SCHEMA_INVALID')
      expect(failure.message).toContain('quote does not match')
    }
    // The correct slice passes.
    validateEvidenceAgainstSnapshot(
      { span: { start, end: start + 5 }, quote: TEXT.slice(start, start + 5), contextSpan: { start, end: start + 5 } },
      TEXT,
    )
  })
})

describe('D02 UTF-16 spans and raw-byte hashes', () => {
  it('emoji/CJK count as UTF-16 code units and hashes keep raw bytes unnormalized', () => {
    const made = seedGraphSnapshot()
    const emojiStart = TEXT.indexOf('🙂')
    expect(TEXT.indexOf('🙂')).toBeGreaterThan(0)
    // 🙂 is 2 UTF-16 code units; the span arithmetic stays byte-slice-free.
    const evidence = addEvidence(made, emojiStart, emojiStart + 2 + 6)
    expect(evidence.quote.startsWith('🙂')).toBe(true)
    expect(evidence.quote.endsWith('here.')).toBe(true)
    // CRLF text hashes over raw bytes: no normalization drift.
    const crlf = 'line one\r\nline two\r\n'
    const source = seedSource(made.store, crlf)
    expect(source.snapshotHash).not.toBe(seedSource(made.store, 'line one\nline two\n').snapshotHash)
  })
})

describe('D03 lineage clusters', () => {
  it('three sources derived from one parent form a single undirected cluster', () => {
    const made = seedGraphSnapshot()
    const parent = made.source
    const snapshot = made.store.readHead()
    if (!snapshot.ok) throw new Error(snapshot.message)
    const derivedA = { ...parent, id: `src_${uuid()}` }
    const derivedB = { ...parent, id: `src_${uuid()}` }
    const sources = [
      parent,
      { ...derivedA, lineage: { relation: 'derived' as const, parentSourceIds: [parent.id], note: '' } },
      { ...derivedB, lineage: { relation: 'derived' as const, parentSourceIds: [parent.id], note: '' } },
    ]
    const cluster = lineageClusterOf(parent.id, sources)
    expect(cluster.size).toBe(3)
    expect(lineageClusterOf(derivedA.id, sources)).toEqual(cluster)
  })
})

describe('D04 all-group dependency closure', () => {
  it('a claim’s dependency closure carries both joint evidence fragments of its all-group', () => {
    const made = seedGraphSnapshot()
    const first = addEvidence(made, 0, 13)
    const second = addEvidence(made, TEXT.indexOf('Paragraph two'), TEXT.indexOf('Paragraph two') + 20)
    const target = addClaim(made, 'target claim')
    const claimId = target.id
    const groupId = `grp_${uuid()}`
    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    made.store.withTransaction({
      expectedRevision: head.data.head.revision, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => {
        snapshot.groups.push({
          id: groupId, entityVersion: 1, createdAt: 't', updatedAt: 't',
          targetClaimId: claimId, evidenceIds: [first.id, second.id],
          mode: 'all', rationale: 'joint reading',
        } as never)
        return { result: null }
      },
    })
    const after = made.store.readHead()
    if (!after.ok) throw new Error(after.message)
    const index = buildReverseIndex(after.data.snapshot)
    const closure = dependencyEntries(index, [claimId]).map((entry) => entry.id).sort()
    expect(closure).toContain(first.id)
    expect(closure).toContain(second.id)
  })
})

describe('D05 SUPPORT_CYCLE', () => {
  it('rejects A→B→A and commits nothing', () => {
    const made = seedGraphSnapshot()
    const a = addClaim(made, 'claim A')
    const b = addClaim(made, 'claim B')
    const headBefore = made.store.readHead()
    if (!headBefore.ok) throw new Error(headBefore.message)
    const mutation: Mutation = {
      op: 'upsert',
      creates: [
        {
          clientKey: 'arg1', type: 'argument',
          body: {
            premiseClaimIds: [b.id], evidenceGroupIds: [],
            conclusionClaimId: a.id, scheme: 'causal',
            warrant: 'w', assumptions: [], limitations: [],
          },
        },
        {
          clientKey: 'arg2', type: 'argument',
          body: {
            premiseClaimIds: [a.id], evidenceGroupIds: [],
            conclusionClaimId: b.id, scheme: 'causal',
            warrant: 'w', assumptions: [], limitations: [],
          },
        },
      ],
      updates: [], deletes: [],
    }
    const graph = new GraphContext(structuredClone(headBefore.data.snapshot), 10_000)
    const failure = failOf(() => applyMutation(graph, mutation))
    if (failure.code !== 'SUPPORT_CYCLE') console.log('D05 failure:', JSON.stringify(failure))
    expect(failure.code).toBe('SUPPORT_CYCLE')
    // No partial commit: HEAD untouched.
    const headAfter = made.store.readHead()
    if (headAfter.ok) expect(headAfter.data.head.revision).toBe(headBefore.data.head.revision)
  })
})

describe('D06 REFERENCE_IN_USE', () => {
  it('deleting a referenced claim fails and HEAD is unchanged', () => {
    const made = seedGraphSnapshot()
    const a = addClaim(made, 'claim A')
    const b = addClaim(made, 'claim B')
    const headBefore = made.store.readHead()
    if (!headBefore.ok) throw new Error(headBefore.message)
    made.store.withTransaction({
      expectedRevision: headBefore.data.head.revision, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => {
        snapshot.arguments.push({
          id: `arg_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't',
          premiseClaimIds: [b.id], evidenceGroupIds: [], conclusionClaimId: a.id,
          scheme: 'causal', warrant: 'w', assumptions: [], limitations: [],
        } as never)
        return { result: null }
      },
    })
    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const graph = new GraphContext(structuredClone(head.data.snapshot), 10_000)
    const failure = failOf(() => applyMutation(graph, { op: 'upsert', creates: [], updates: [], deletes: [b.id] }))
    expect(failure.code).toBe('REFERENCE_IN_USE')
    expect(made.store.readHead().ok).toBe(true)
    const after = made.store.readHead()
    if (after.ok) expect(after.data.head.revision).toBe(head.data.head.revision)
  })
})

describe('D11 unrelated-claim updates keep digests stable', () => {
  it('updating an unrelated claim leaves another target’s dependencyDigest unchanged', () => {
    const made = seedGraphSnapshot()
    const relevant = addClaim(made, 'relevant claim')
    const unrelated = addClaim(made, 'unrelated claim')
    const before = made.store.readHead()
    if (!before.ok) throw new Error(before.message)
    const indexBefore = buildReverseIndex(before.data.snapshot)
    const digestBefore = dependencyDigest(indexBefore, [relevant.id])
    // Bump the unrelated claim's text via argument.update-style full replacement.
    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    made.store.withTransaction({
      expectedRevision: head.data.head.revision, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => {
        const target = claimOf(snapshot, unrelated.id)
        target.text = 'unrelated claim, revised'
        target.entityVersion += 1
        return { result: null }
      },
    })
    const after = made.store.readHead()
    if (!after.ok) throw new Error(after.message)
    const digestAfter = dependencyDigest(buildReverseIndex(after.data.snapshot), [relevant.id])
    expect(digestAfter).toBe(digestBefore)
    // …while the unrelated target's digest moves.
    expect(dependencyDigest(buildReverseIndex(after.data.snapshot), [unrelated.id]))
      .not.toBe(dependencyDigest(indexBefore, [unrelated.id]))
  })
})

describe('D12 artifact byte change', () => {
  it('a one-character artifact change yields a different contentHash', () => {
    const made = seedGraphSnapshot()
    const graph = new GraphContext(structuredClone(made.snapshot), 10_000)
    graph.artifactTexts.set('report.md', 'body text')
    applyMutation(graph, { op: 'bind-artifact', mode: 'inline', path: 'report.md', occurrences: [], outline: [] })
    const before = graph.snapshot.artifacts[0]?.contentHash
    const other = new GraphContext(structuredClone(made.snapshot), 10_000)
    other.artifactTexts.set('report.md', 'body text!')
    applyMutation(other, { op: 'bind-artifact', mode: 'inline', path: 'report.md', occurrences: [], outline: [] })
    expect(other.snapshot.artifacts[0]?.contentHash).not.toBe(before)
  })

  it('restricted artifact paths are refused', () => {
    for (const path of ['docs/vwa-sources/p/x.md', '.dsh/vwa/p/HEAD.md', '../outside.md', 'notes.txt']) {
      expect(() => validateArtifactPath(path)).toThrow(VwaFail)
    }
    expect(() => validateArtifactPath('docs/report.md')).not.toThrow()
  })
})

describe('contract mutation (§10.5 set-contract)', () => {
  it('flags contractChanged for §15 invalidation', () => {
    const made = seedGraphSnapshot()
    const graph = new GraphContext(structuredClone(made.snapshot), 10_000)
    const outcome = applyMutation(graph, {
      op: 'set-contract',
      // F3.3: a set-contract payload must not carry reviewSettings — the frozen
      // settings are preserved when absent (revising them is the new op's job).
      contract: { ...made.snapshot.contract, mode: 'reviewed', reviewSettings: undefined },
    } as never)
    expect(outcome.contractChanged).toBe(true)
    expect(graph.snapshot.contract.mode).toBe('reviewed')
  })
})

/** Full VwaFail (code, message, details) or throw. */
function failDetailOf(run: () => unknown): { code: string; message: string; details?: unknown } {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof VwaFail) return { code: error.fail.code, message: error.fail.message, details: error.fail.details }
    throw error
  }
  throw new Error('expected a VwaFail')
}

/** Current committed snapshot — `seedGraphSnapshot().snapshot` goes stale after transactions. */
function liveSnapshot(made: { store: import('../src/store.ts').ProjectStore }): import('../src/types.ts').ProjectSnapshot {
  const head = made.store.readHead()
  if (!head.ok) throw new Error(head.message)
  return head.data.snapshot
}

describe('Feature D §D.1 op validation', () => {
  const graphOf = (): GraphContext => new GraphContext(seedGraphSnapshot().snapshot, 10_000)

  it('missing op → SCHEMA_INVALID naming got and expected ops', () => {
    const failure = failDetailOf(() => applyMutation(graphOf(), {} as unknown as Mutation))
    expect(failure.code).toBe('SCHEMA_INVALID')
    expect(failure.message).toContain('undefined')
    expect(failure.message).toContain('set-contract')
  })

  it('unknown op → SCHEMA_INVALID', () => {
    const failure = failDetailOf(() => applyMutation(graphOf(), { op: 'destroy' } as unknown as Mutation))
    expect(failure.code).toBe('SCHEMA_INVALID')
    expect(failure.message).toContain('unknown op')
    expect(failure.message).toContain('bind-artifact')
  })

  it('upsert missing creates/updates/deletes → SCHEMA_INVALID', () => {
    const failure = failDetailOf(() => applyMutation(graphOf(), { op: 'upsert' } as unknown as Mutation))
    expect(failure.code).toBe('SCHEMA_INVALID')
    expect(failure.message).toContain('creates, updates, and deletes')
  })

  it('valid ops still work', () => {
    const graph = new GraphContext(seedGraphSnapshot().snapshot, 10_000)
    const outcome = applyMutation(graph, {
      op: 'upsert',
      creates: [{
        clientKey: 'c1', type: 'claim',
        body: {
          text: 'ok claim', kind: 'fact', importance: 'supporting', stance: 'asserted',
          scope: { subject: 's', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
          evaluationCriteria: [],
        },
      }],
      updates: [],
      deletes: [],
    })
    expect(outcome.changedIds).toHaveLength(1)
  })
})

describe('Feature D §D.4.1 reference diagnostics', () => {
  it('REFERENCE_IN_USE names referencer ids and carries details.references', () => {
    const made = seedGraphSnapshot()
    const a = addClaim(made, 'claim A')
    const b = addClaim(made, 'claim B')
    const graph = new GraphContext(structuredClone(liveSnapshot(made)), 10_000)
    applyMutation(graph, {
      op: 'upsert',
      creates: [{
        clientKey: 'arg1', type: 'argument',
        body: { premiseClaimIds: [b.id], evidenceGroupIds: [], conclusionClaimId: a.id, scheme: 'causal', warrant: 'w', assumptions: [], limitations: [] },
      }],
      updates: [],
      deletes: [],
    })
    const failure = failDetailOf(() => applyMutation(graph, { op: 'upsert', creates: [], updates: [], deletes: [b.id] }))
    expect(failure.code).toBe('REFERENCE_IN_USE')
    expect(failure.message).toContain(`${b.id} is still referenced by:`)
    expect(failure.message).toMatch(/argument arg_\S+ \(premiseClaimIds\)/)
    const details = failure.details as { references: { kind: string; id: string; role: string }[] }
    expect(details.references).toContainEqual({ kind: 'argument', id: expect.stringMatching(/^arg_/), role: 'premiseClaimIds' })
  })

  it('claim.scope.corpus references are detected with kind claim', () => {
    const made = seedGraphSnapshot()
    const a = addClaim(made, 'claim A')
    const b = addClaim(made, 'claim B')
    const graph = new GraphContext(structuredClone(liveSnapshot(made)), 10_000)
    graph.snapshot.claims.find((claim) => claim.id === b.id)!.scope.corpus.push(a.id)
    const failure = failDetailOf(() => applyMutation(graph, { op: 'upsert', creates: [], updates: [], deletes: [a.id] }))
    expect(failure.code).toBe('REFERENCE_IN_USE')
    expect(failure.message).toContain('(scope.corpus)')
    const details = failure.details as { references: { kind: string; id: string; role: string }[] }
    expect(details.references).toContainEqual({ kind: 'claim', id: b.id, role: 'scope.corpus' })
  })
})

describe('Feature D §D.4.2 cascade delete', () => {
  function buildReferencedClaim(): { made: ReturnType<typeof seedGraphSnapshot>; a: Claim; b: Claim; graph: GraphContext } {
    const made = seedGraphSnapshot()
    const a = addClaim(made, 'claim A')
    const b = addClaim(made, 'claim B')
    const graph = new GraphContext(structuredClone(liveSnapshot(made)), 10_000)
    applyMutation(graph, {
      op: 'upsert',
      creates: [{
        clientKey: 'arg1', type: 'argument',
        body: { premiseClaimIds: [b.id], evidenceGroupIds: [], conclusionClaimId: a.id, scheme: 'causal', warrant: 'w', assumptions: [], limitations: [] },
      }],
      updates: [],
      deletes: [],
    })
    return { made, a, b, graph }
  }

  it('without cascade, deleting a referenced claim is still REFERENCE_IN_USE', () => {
    const { b, graph } = buildReferencedClaim()
    const failure = failDetailOf(() => applyMutation(graph, { op: 'upsert', creates: [], updates: [], deletes: [b.id] }))
    expect(failure.code).toBe('REFERENCE_IN_USE')
    expect(graph.snapshot.claims.some((claim) => claim.id === b.id)).toBe(true)
  })

  it('cascade removes referencing entities recursively; cascadeDeleted is leaf-first', () => {
    const { a, b, graph } = buildReferencedClaim()
    const outcome = applyMutation(graph, { op: 'upsert', creates: [], updates: [], deletes: [b.id], cascade: true })
    expect(graph.snapshot.claims.some((claim) => claim.id === b.id)).toBe(false)
    expect(graph.snapshot.claims.some((claim) => claim.id === a.id)).toBe(true)
    expect(graph.snapshot.arguments).toHaveLength(0)
    const argumentId = outcome.changedIds.find((id) => id.startsWith('arg_'))!
    expect(outcome.cascadeDeleted).toEqual([argumentId])
    // postValidate ran once on the final state — the snapshot is consistent.
    expect(graph.snapshot.claims.map((claim) => claim.id)).toContain(a.id)
  })

  it('deletes repeated cascade roots and shared referencers exactly once', () => {
    const { a, b, graph } = buildReferencedClaim()
    const argumentId = graph.snapshot.arguments[0]!.id
    const outcome = applyMutation(graph, {
      op: 'upsert', creates: [], updates: [], deletes: [a.id, b.id, a.id, b.id], cascade: true,
    })
    expect(graph.snapshot.claims).toHaveLength(0)
    expect(graph.snapshot.arguments).toHaveLength(0)
    expect(outcome.changedIds).toHaveLength(3)
    expect(new Set(outcome.changedIds)).toEqual(new Set([a.id, b.id, argumentId]))
    expect(outcome.cascadeDeleted).toEqual([argumentId])
  })

  it('cascadeDeleted is leaves-first when referencers reference each other (not reversed BFS)', () => {
    // Reviewer scenario: root R; A and B both reference R; A also references B.
    // A is the leaf (nothing references A), so A must precede B — reversed BFS
    // would order [B, A].
    const made = seedGraphSnapshot()
    const graph = new GraphContext(structuredClone(liveSnapshot(made)), 10_000)
    const snapshot = graph.snapshot
    const root = structuredClone(snapshot.sources[0]!)
    root.id = 'src_root'
    snapshot.sources.push(root)
    const b = structuredClone(snapshot.sources[0]!)
    b.id = 'src_b'
    b.lineage.parentSourceIds = [root.id]
    snapshot.sources.push(b)
    const a = structuredClone(snapshot.sources[0]!)
    a.id = 'src_a'
    a.lineage.parentSourceIds = [root.id, b.id]
    snapshot.sources.push(a)
    const outcome = applyMutation(graph, { op: 'upsert', creates: [], updates: [], deletes: [root.id], cascade: true })
    expect(outcome.cascadeDeleted).toEqual(['src_a', 'src_b'])
  })

  it('closure handles cross-kind cycles (source lineage ↔ evidence authenticity basis)', () => {
    const made = seedGraphSnapshot()
    const graph = new GraphContext(structuredClone(made.snapshot), 10_000)
    const snapshot = graph.snapshot
    const src1 = snapshot.sources[0]!
    const src2 = structuredClone(src1)
    src2.id = `src_${'cycle-test'}`
    src2.lineage.parentSourceIds = [src1.id]
    snapshot.sources.push(src2)
    const evidence = structuredClone(snapshot.evidence[0] ?? {
      id: `ev_${'cycle'}`, entityVersion: 1, createdAt: 't', updatedAt: 't',
      sourceId: src2.id, sourceSnapshotHash: 'h', span: { start: 0, end: 1 }, quote: 'q',
      contextSpan: { start: 0, end: 1 }, originalLocation: 'loc', transformation: 'none',
      transformationNote: '',
    } as Evidence)
    evidence.sourceId = src2.id
    if (!snapshot.evidence.some((candidate) => candidate.id === evidence.id)) snapshot.evidence.push(evidence)
    src2.authenticityBasisEvidenceIds = [evidence.id]
    const outcome = applyMutation(graph, { op: 'upsert', creates: [], updates: [], deletes: [src1.id], cascade: true })
    expect(snapshot.sources.some((source) => source.id === src1.id || source.id === src2.id)).toBe(false)
    expect(snapshot.evidence.some((candidate) => candidate.id === evidence.id)).toBe(false)
    // Leaf-first: the evidence and the child source precede the root.
    expect(outcome.cascadeDeleted).toEqual([evidence.id, src2.id])
  })
})

it('reports ordinary deleted claims in changedIds and affectedClaimIds', () => {
  const made = seedGraphSnapshot()
  const claim = addClaim(made, 'Unreferenced claim')
  const graph = new GraphContext(structuredClone(liveSnapshot(made)), 10_000)
  const outcome = applyMutation(graph, { op: 'upsert', creates: [], updates: [], deletes: [claim.id] })
  expect(graph.snapshot.claims.some((c) => c.id === claim.id)).toBe(false)
  expect(outcome.changedIds).toEqual([claim.id])
  expect(outcome.affectedClaimIds).toEqual([claim.id])
  expect(outcome.cascadeDeleted).toBeUndefined()
})

// ---- render pipeline: explicit bind modes (§4.1–§4.3, §13) ----

describe('bind-artifact draft mode (render pipeline §4)', () => {
  /** `.dsh/vwa/<projectId>/drafts/<name>` — workspace-relative POSIX draft path. */
  const draftRelOf = (made: { projectId: string }, name: string): string =>
    `.dsh/vwa/${made.projectId}/drafts/${name}`
  /** Create the drafts dir and write one draft file; deliverable parents are callers' job. */
  function writeDraft(made: { root: string; projectId: string }, text: string | Buffer, name = 'main.md'): void {
    const dir = join(made.root, '.dsh', 'vwa', made.projectId, 'drafts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  /** Run one store transaction applying every mutation through the real bind pipeline. */
  function bindTx(
    made: { root: string; store: ProjectStore },
    mutations: Mutation[],
    requestId = uuid(),
  ): { result: import('../src/store.ts').Result<unknown>; staged: StagedFile[] } {
    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const staged: StagedFile[] = []
    const result = made.store.withTransaction<unknown>({
      expectedRevision: head.data.head.revision,
      requestId,
      payloadHash: uuid(),
      applyFn: (snapshot) => {
        const graph = new GraphContext(snapshot, 10_000)
        let outcome: unknown
        for (const mutation of mutations) {
          outcome = applyMutation(graph, mutation, { root: made.root, requestId, staged })
        }
        return { result: outcome, files: staged }
      },
    })
    return { result, staged }
  }
  /** The seeded talk-track: one core claim whose text sits in the draft. */
  function draftFixture(): {
    made: ReturnType<typeof initWorkspace>
    claimId: string
    draftPath: string
    deliverable: string
    draftText: string
    occurrence: { claimId: string; span: { start: number; end: number }; exactText: string }
    rendered: string
  } {
    const made = initWorkspace()
    const claim = addClaim(made, 'The shift began in 1789')
    mkdirSync(join(made.root, 'docs'), { recursive: true })
    const draftPath = draftRelOf(made, 'main.md')
    const body = 'The shift began in 1789'
    const draftText = `# Report\n\n${body}〔src:ws:docs/archive.md#L1-L3〕 and spread〔claim:${claim.id}〕.\n`
    writeDraft(made, draftText)
    const rendered = stripMarkers(draftText).text
    return {
      made,
      claimId: claim.id,
      draftPath,
      deliverable: join(made.root, 'docs', 'article.md'),
      draftText,
      occurrence: {
        claimId: claim.id,
        span: { start: draftText.indexOf(body), end: draftText.indexOf(body) + body.length },
        exactText: body,
      },
      rendered,
    }
  }
  const bindDraftMutation = (
    f: ReturnType<typeof draftFixture>,
    extras: Partial<Extract<Mutation, { op: 'bind-artifact' }>> = {},
  ): Mutation => ({
    op: 'bind-artifact', mode: 'draft', path: 'docs/article.md',
    occurrences: [f.occurrence], outline: [], draftPath: f.draftPath, ...extras,
  })

  it('mode is required (§4.1)', () => {
    const f = draftFixture()
    const { result } = bindTx(f.made, [
      { op: 'bind-artifact', path: 'docs/article.md', occurrences: [], outline: [] } as unknown as Mutation,
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('SCHEMA_INVALID')
    expect(result.message).toContain('bind-artifact requires mode')
  })

  it('renders the draft inside the bind transaction: hashes, draft coords, disk bytes, intent cleared (§4.2)', () => {
    const f = draftFixture()
    const requestId = uuid()
    const { result } = bindTx(f.made, [bindDraftMutation(f)], requestId)
    expect(result.ok).toBe(true)
    // Deliverable = the marker-free render, on disk only after adoption.
    expect(readFileSync(f.deliverable, 'utf8')).toBe(f.rendered)
    expect(readFileSync(f.deliverable, 'utf8')).not.toContain('〔')
    const head = f.made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const artifact = head.data.snapshot.artifacts[0]!
    expect(artifact.contentHash).toBe(sha256Hex(f.rendered))
    expect(artifact.draft).toEqual({ path: f.draftPath, draftHash: sha256Hex(f.draftText) })
    // Occurrences keep DRAFT coordinates verbatim — no remap is persisted (§4.4).
    expect(artifact.occurrences).toEqual([f.occurrence])
    // HEAD adoption cleared the render intent (§7.1 reads as inert after success).
    expect(existsSync(join(f.made.root, '.dsh', 'vwa', f.made.projectId, 'renders', `${requestId}.json`))).toBe(false)
  })

  it('re-bind re-renders without overwrite (the gate owns its previous render, §4.7)', () => {
    const f = draftFixture()
    const first = bindTx(f.made, [bindDraftMutation(f)])
    expect(first.result.ok).toBe(true)
    const nextText = `# Report\n\nThe shift began in 1790〔claim:${f.claimId}〕.\n`
    writeDraft(f.made, nextText)
    const second = bindTx(f.made, [bindDraftMutation(f, { occurrences: [] })])
    expect(second.result.ok).toBe(true)
    expect(readFileSync(f.deliverable, 'utf8')).toBe(stripMarkers(nextText).text)
    const head = f.made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    expect(head.data.snapshot.artifacts[0]!.contentHash).toBe(sha256Hex(stripMarkers(nextText).text))
    expect(head.data.snapshot.artifacts[0]!.entityVersion).toBe(2)
  })

  it('validates draftPath shape, project segment and containment (§4.2 step 2)', () => {
    const f = draftFixture()
    const cases: { draftPath: string; code: string; part?: string }[] = [
      { draftPath: 'docs/note.md', code: 'PATH_OUT_OF_BOUNDS' },
      { draftPath: `.dsh/vwa/prj_${uuid()}/drafts/main.md`, code: 'PATH_OUT_OF_BOUNDS' },
      { draftPath: `${draftRelOf(f.made, 'main')}`, code: 'PATH_OUT_OF_BOUNDS' },
      { draftPath: draftRelOf(f.made, 'nested/main.md'), code: 'PATH_OUT_OF_BOUNDS' },
      { draftPath: draftRelOf(f.made, 'missing.md'), code: 'NOT_FOUND', part: 'draft text unavailable' },
    ]
    writeDraft(f.made, 'placeholder\n')
    for (const { draftPath, code, part } of cases) {
      const { result } = bindTx(f.made, [bindDraftMutation(f, { draftPath })])
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.code, `draftPath ${draftPath}`).toBe(code)
      if (part !== undefined) expect(result.message).toContain(part)
    }
  })

  it('a symlinked draft escaping the drafts tree is rejected (§4.2 step 2)', () => {
    const f = draftFixture()
    const outside = mkdtempSync(join(tmpdir(), 'vwa-out-'))
    writeFileSync(join(outside, 'evil.md'), 'outside the workspace\n')
    symlinkSync(join(outside, 'evil.md'), join(f.made.root, '.dsh', 'vwa', f.made.projectId, 'drafts', 'evil.md'))
    const { result } = bindTx(f.made, [bindDraftMutation(f, { draftPath: draftRelOf(f.made, 'evil.md') })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('PATH_OUT_OF_BOUNDS')
  })

  it('rejects a non-lossless draft encoding', () => {
    const f = draftFixture()
    writeDraft(f.made, Buffer.from([0x66, 0x80, 0x67]), 'bad.md')
    const { result } = bindTx(f.made, [bindDraftMutation(f, { draftPath: draftRelOf(f.made, 'bad.md') })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('INVALID_ENCODING')
  })

  it('rejects a draft already bound to another artifact (§3.1, verbatim message)', () => {
    const f = draftFixture()
    expect(bindTx(f.made, [bindDraftMutation(f)]).result.ok).toBe(true)
    const { result } = bindTx(f.made, [bindDraftMutation(f, { path: 'docs/other.md' })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('SCHEMA_INVALID')
    expect(result.message).toBe('draft already bound to another artifact')
  })

  it('validates occurrences against the DRAFT text and rejects marker overlap (§4.2 steps 3–5)', () => {
    const f = draftFixture()
    const markerStart = f.draftText.indexOf('〔src:')
    const cases: { span: { start: number; end: number }; exactText: string; code: string; part?: string }[] = [
      { span: { start: 0, end: f.draftText.length + 1 }, exactText: 'x', code: 'SCHEMA_INVALID', part: 'occurrence span invalid' },
      { span: { start: f.occurrence.span.start, end: f.occurrence.span.end }, exactText: 'wrong text', code: 'SCHEMA_INVALID', part: 'occurrence exactText does not match the artifact slice' },
      // Overlapping the marker (start strictly inside → invalid by affinity).
      { span: { start: f.occurrence.span.end, end: f.occurrence.span.end + 10 }, exactText: f.draftText.slice(f.occurrence.span.end, f.occurrence.span.end + 10), code: 'SCHEMA_INVALID', part: 'occurrence overlaps a stripped marker' },
    ]
    for (const { span, exactText, code, part } of cases) {
      const { result } = bindTx(f.made, [bindDraftMutation(f, { occurrences: [{ claimId: f.claimId, span, exactText }] })])
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.code).toBe(code)
      expect(result.message, part).toContain(part ?? '')
    }
    // Endpoint affinity: a span ending exactly at a marker's start is valid.
    const adjacent = bindTx(f.made, [bindDraftMutation(f, {
      occurrences: [{ claimId: f.claimId, span: { start: 10, end: markerStart }, exactText: f.draftText.slice(10, markerStart) }],
    })])
    expect(adjacent.result.ok).toBe(true)
    // An unknown claim stays a plain reference error.
    const unknown = bindTx(f.made, [bindDraftMutation(f, { occurrences: [{ claimId: 'cl_nope', span: f.occurrence.span, exactText: f.occurrence.exactText }] })])
    expect(unknown.result.ok).toBe(false)
    if (unknown.result.ok) throw new Error('expected failure')
    expect(unknown.result.code).toBe('REFERENCE_INVALID')
  })

  it('inline on a draft-backed artifact is rejected verbatim; conversion goes through draft only (§4.1/§4.7)', () => {
    const f = draftFixture()
    expect(bindTx(f.made, [bindDraftMutation(f)]).result.ok).toBe(true)
    const { result } = bindTx(f.made, [{
      op: 'bind-artifact', mode: 'inline', path: 'docs/article.md', occurrences: [], outline: [],
    }])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('SCHEMA_INVALID')
    expect(result.message).toBe('artifact is draft-backed; bind with mode:"draft"')
  })

  it('legacy inline first bind converts on explicit draft bind (§4.1 conversion row)', () => {
    const f = draftFixture()
    const text = 'The shift began in 1789 and spread.\n'
    const inlineTx = bindTx(f.made, [{
      op: 'bind-artifact', mode: 'inline', path: 'docs/article.md', occurrences: [], outline: [],
    }])
    // Inline needs the deliverable text: seed the transaction's text map.
    const head0 = f.made.store.readHead()
    if (!head0.ok) throw new Error(head0.message)
    const seeded = f.made.store.withTransaction<unknown>({
      expectedRevision: head0.data.head.revision, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => {
        const graph = new GraphContext(snapshot, 10_000)
        graph.artifactTexts.set('docs/article.md', text)
        applyMutation(graph, { op: 'bind-artifact', mode: 'inline', path: 'docs/article.md', occurrences: [], outline: [] })
        return { result: null }
      },
    })
    expect(inlineTx.result.ok).toBe(false) // no text is provided without the map
    expect(seeded.ok).toBe(true)
    // write the inline deliverable to disk, then convert explicitly
    writeFileSync(join(f.made.root, 'docs', 'article.md'), text)
    const converted = bindTx(f.made, [bindDraftMutation(f)])
    expect(converted.result.ok).toBe(true)
    const head = f.made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    expect(head.data.snapshot.artifacts[0]!.draft).toBeDefined()
    expect(readFileSync(f.deliverable, 'utf8')).toBe(f.rendered)
  })

  it('overwrite gate: a foreign deliverable demands overwrite:true (§4.3, verbatim message)', () => {
    const f = draftFixture()
    writeFileSync(join(f.made.root, 'docs', 'article.md'), 'user authored content\n')
    const refused = bindTx(f.made, [bindDraftMutation(f)])
    expect(refused.result.ok).toBe(false)
    if (refused.result.ok) throw new Error('expected failure')
    expect(refused.result.code).toBe('SCHEMA_INVALID')
    expect(refused.result.message).toBe('deliverable exists and is not owned by this artifact; pass overwrite:true to take ownership')
    // …and the foreign file survived the refusal (TLA I6 NoLostUserFile).
    expect(readFileSync(join(f.made.root, 'docs', 'article.md'), 'utf8')).toBe('user authored content\n')
    const owned = bindTx(f.made, [bindDraftMutation(f, { overwrite: true })])
    expect(owned.result.ok).toBe(true)
    expect(readFileSync(join(f.made.root, 'docs', 'article.md'), 'utf8')).toBe(f.rendered)
  })

  it('overwrite gate owns a provisional render recorded by an unadopted intent (§4.3 + §7, TLA OverwriteForeign)', () => {
    const f = draftFixture()
    const provisional = 'provisionally rendered bytes from a crashed bind\n'
    writeFileSync(join(f.made.root, 'docs', 'article.md'), provisional)
    // Seed the intent record the crashed bind left behind; the draft moved on
    // since, so the CURRENT render differs from the bytes on disk.
    const rendersDir = join(f.made.root, '.dsh', 'vwa', f.made.projectId, 'renders')
    mkdirSync(rendersDir, { recursive: true })
    writeFileSync(join(rendersDir, `${uuid()}.json`), stableJson({
      requestId: uuid(), projectId: f.made.projectId, draftPath: f.draftPath,
      draftHash: sha256Hex('older draft bytes'),
      renderedHash: sha256Hex(provisional), target: 'docs/article.md', at: new Date().toISOString(),
    }))
    const { result } = bindTx(f.made, [bindDraftMutation(f)])
    expect(result.ok).toBe(true)
    // Negative control: an intent for a DIFFERENT target does not confer ownership.
    const other = draftFixture()
    writeFileSync(join(other.made.root, 'docs', 'article.md'), provisional)
    const otherRendersDir = join(other.made.root, '.dsh', 'vwa', other.made.projectId, 'renders')
    mkdirSync(otherRendersDir, { recursive: true })
    writeFileSync(join(otherRendersDir, `${uuid()}.json`), stableJson({
      requestId: uuid(), projectId: other.made.projectId, draftPath: other.draftPath,
      draftHash: sha256Hex('older draft bytes'),
      renderedHash: sha256Hex(provisional), target: 'docs/elsewhere.md', at: new Date().toISOString(),
    }))
    const blocked = bindTx(other.made, [bindDraftMutation(other)])
    expect(blocked.result.ok).toBe(false)
  })

  it('deliverable parent must exist and the canonical target must not be restricted (§4.2 step 7)', () => {
    const f = draftFixture()
    const missing = bindTx(f.made, [bindDraftMutation(f, { path: 'nowhere/article.md' })])
    expect(missing.result.ok).toBe(false)
    if (missing.result.ok) throw new Error('expected failure')
    expect(missing.result.code).toBe('PATH_OUT_OF_BOUNDS')
    const restricted = bindTx(f.made, [bindDraftMutation(f, { path: `.dsh/vwa/${f.made.projectId}/reports/out.md` })])
    expect(restricted.result.ok).toBe(false)
    if (restricted.result.ok) throw new Error('expected failure')
    expect(restricted.result.code).toBe('PATH_OUT_OF_BOUNDS')
    // Step 7 replaces the lexical check entirely: non-.md deliverables are fine.
    const txt = bindTx(f.made, [bindDraftMutation(f, { path: 'docs/article.txt' })])
    expect(txt.result.ok).toBe(true)
    expect(readFileSync(join(f.made.root, 'docs', 'article.txt'), 'utf8')).toBe(f.rendered)
  })

  it('the staged render intent carries full provenance before adoption (§7.1)', () => {
    const made = draftFixture()
    // Crash AT rename op #1: after the intent rename, before the deliverable.
    const crashing = new ProjectStore(made.made.root, made.made.projectId, { crashAfter: 1 })
    const head = crashing.readHead()
    if (!head.ok) throw new Error(head.message)
    const requestId = uuid()
    const staged: StagedFile[] = []
    expect(() => crashing.withTransaction<unknown>({
      expectedRevision: head.data.head.revision,
      requestId,
      payloadHash: uuid(),
      applyFn: (snapshot) => {
        const graph = new GraphContext(snapshot, 10_000)
        applyMutation(graph, bindDraftMutation(made), { root: made.made.root, requestId, staged })
        return { result: null, files: staged }
      },
    })).toThrow(/simulated crash/)
    const intentPath = join(made.made.root, '.dsh', 'vwa', made.made.projectId, 'renders', `${requestId}.json`)
    expect(existsSync(intentPath)).toBe(true)
    const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as Record<string, unknown>
    expect(intent.requestId).toBe(requestId)
    expect(intent.projectId).toBe(made.made.projectId)
    expect(intent.artifactId).toMatch(/^art_/)
    expect(intent.draftPath).toBe(made.draftPath)
    expect(intent.draftHash).toBe(sha256Hex(made.draftText))
    expect(intent.renderedHash).toBe(sha256Hex(made.rendered))
    expect(intent.target).toBe('docs/article.md')
    expect(typeof intent.at).toBe('string')
    // The intent was written BEFORE the deliverable bytes.
    expect(existsSync(made.deliverable)).toBe(false)
    const headAfter = made.made.store.readHead()
    if (!headAfter.ok) throw new Error(headAfter.message)
    expect(headAfter.data.head.revision).toBe(head.data.head.revision)
  })

  it('stale sibling temps of the deliverable are swept while staging (§4.6)', () => {
    const f = draftFixture()
    const staleTmp = join(f.made.root, 'docs', 'article.md.deadbeef.tmp')
    writeFileSync(staleTmp, 'orphaned temp\n')
    const old = Date.now() - 25 * 60 * 60 * 1000
    utimesSync(staleTmp, new Date(old), new Date(old))
    const freshTmp = join(f.made.root, 'docs', 'article.md.live.tmp')
    writeFileSync(freshTmp, 'recent temp\n')
    const { result } = bindTx(f.made, [bindDraftMutation(f)])
    expect(result.ok).toBe(true)
    expect(existsSync(staleTmp)).toBe(false)
    expect(existsSync(freshTmp)).toBe(true)
  })

  it('inline mode keeps v1 semantics: no draft field, no staged files, deliverable untouched (§4.7)', () => {
    const made = initWorkspace()
    const claim = addClaim(made, 'Unchanged legacy claim')
    const text = 'Unchanged legacy body.\n'
    const { result, staged } = bindTx(made, [{
      op: 'bind-artifact', mode: 'inline', path: 'docs/article.md', occurrences: [], outline: [],
    }])
    expect(result.ok).toBe(false) // inline still requires the text via the transaction seams
    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const seeded = made.store.withTransaction<unknown>({
      expectedRevision: head.data.head.revision, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => {
        const graph = new GraphContext(snapshot, 10_000)
        graph.artifactTexts.set('docs/article.md', text)
        const outcome = applyMutation(graph, {
          op: 'bind-artifact', mode: 'inline', path: 'docs/article.md',
          occurrences: [{ claimId: claim.id, span: { start: 0, end: 9 }, exactText: 'Unchanged' }], outline: [],
        }, { root: made.root, requestId: 'x', staged })
        return { result: outcome, files: staged }
      },
    })
    expect(seeded.ok).toBe(true)
    expect(staged).toEqual([])
    const after = made.store.readHead()
    if (!after.ok) throw new Error(after.message)
    expect(after.data.snapshot.artifacts[0]!.draft).toBeUndefined()
    expect(after.data.snapshot.artifacts[0]!.contentHash).toBe(sha256Hex(text))
    expect(existsSync(join(made.root, 'docs', 'article.md'))).toBe(false)
  })
})
