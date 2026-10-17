import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProjectStore } from '../src/store.ts'
import { GraphContext, applyMutation } from '../src/graph.ts'
import { vwaSign } from '../src/commands.ts'
import { sha256Hex } from '../src/schema.ts'
import { makeWorkspace, CONTRACT } from './helpers.ts'
import { BUDGET } from './review-helpers.ts'

describe('project policy is frozen and signatures require an existing receipt', () => {
  it('initialization freezes configured review limits and contract edits preserve them', () => {
    const f = makeWorkspace(),
      policy = { budget: { ...BUDGET, maxCallsPerRun: 7 }, maxArtifactChars: 5000, maxContextChars: 2000 }
    expect((f.store.init as Function)(CONTRACT, policy).ok).toBe(true)
    const head = f.store.readHead()
    if (!head.ok) throw new Error(head.message)
    expect((head.data.snapshot.contract as any).reviewSettings).toEqual(policy)
    const graph = new GraphContext(head.data.snapshot, 10000)
    applyMutation(graph, { op: 'set-contract', contract: { ...CONTRACT, question: 'A revised question' } })
    expect((graph.snapshot.contract as any).reviewSettings).toEqual(policy)
  })
  it('sign cannot bless an arbitrary 64-hex string as a receipt', async () => {
    const f = makeWorkspace()
    f.store.init(CONTRACT)
    const text = 'A draft.',
      artifactId = `art_${randomUUID()}`
    writeFileSync(join(f.root, 'a.md'), text)
    f.store.withTransaction({
      expectedRevision: 1,
      requestId: randomUUID(),
      payloadHash: 'bind',
      applyFn(s) {
        s.artifacts.push({
          id: artifactId,
          entityVersion: 1,
          createdAt: '',
          updatedAt: '',
          path: 'a.md',
          contentHash: sha256Hex(text),
          occurrences: [],
          outline: [],
        })
        return { result: {} }
      },
    })
    expect((await vwaSign(f.root, f.projectId, artifactId, 'a'.repeat(64))).kind).toBe('error')
  })
})
