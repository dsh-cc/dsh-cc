import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/store.ts'
import { initWorkspace, uuid } from './helpers.ts'

/**
 * D09 companion: a crash exactly at the HEAD rename (op 3) leaves the
 * complete new version committed. Complements the loop in store.spec.ts.
 */
describe('crash at the HEAD rename (D09 op 3)', () => {
  it('HEAD is the complete new version; read-back verifies the revision hash', () => {
    const made = initWorkspace()
    const crashing = new ProjectStore(made.root, made.projectId, { crashAfter: 3 })
    expect(() => crashing.withTransaction({
      expectedRevision: 1, requestId: uuid(), payloadHash: 'h',
      applyFn: (snapshot) => {
        snapshot.claims.push({ id: `cl_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't' } as never)
        return { result: 1 }
      },
    })).toThrow(/simulated crash/)
    const fresh = new ProjectStore(made.root, made.projectId)
    const head = fresh.readHead()
    expect(head.ok).toBe(true)
    if (head.ok) expect(head.data.head.revision).toBe(2)
  })
})
