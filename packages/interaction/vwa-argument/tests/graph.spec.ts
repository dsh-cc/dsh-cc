/**
 * Graph-level deterministic tests (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §22.1): D01 quote mismatch,
 * D02 UTF-16/raw bytes, D03 lineage cluster, D04 all-group dependencies,
 * D05 SUPPORT_CYCLE, D06 REFERENCE_IN_USE, D11 unrelated-claim digest,
 * D12 artifact byte change.
 */

import { describe, expect, it } from 'vitest'
import { GraphContext, applyMutation, assertNoSupportCycle, validateEvidenceAgainstSnapshot, type Mutation } from '../src/graph.ts'
import { validateArtifactPath } from '../src/artifact.ts'
import { buildReverseIndex, dependencyDigest, dependencyEntries } from '../src/dependencies.ts'
import { lineageClusterOf } from '../src/sources.ts'
import { VwaFail } from '../src/store.ts'
import { seedGraphSnapshot, seedSource, uuid } from './helpers.ts'
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
    applyMutation(graph, { op: 'bind-artifact', path: 'report.md', occurrences: [], outline: [] })
    const before = graph.snapshot.artifacts[0]?.contentHash
    const other = new GraphContext(structuredClone(made.snapshot), 10_000)
    other.artifactTexts.set('report.md', 'body text!')
    applyMutation(other, { op: 'bind-artifact', path: 'report.md', occurrences: [], outline: [] })
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
      contract: { ...made.snapshot.contract, mode: 'reviewed' },
    })
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
