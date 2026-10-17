import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { registerArgumentTools, type ToolDefinition } from '../src/tools.ts'
import { CaptureRegistry } from '../src/sources.ts'
import { initWorkspace } from './helpers.ts'
import { BUDGET, fakeAdapter } from './review-helpers.ts'

describe('review request reservation', () => {
  it('rejects invalid public identifiers and non-integer revisions as structured failures',async()=>{
    const f=fixture()
    expect(await f.call({...f.args,projectId:'prj_../../escape'})).toMatchObject({ok:false,code:'SCHEMA_INVALID'})
    expect(await f.call({...f.args,requestId:'../escape'})).toMatchObject({ok:false,code:'SCHEMA_INVALID'})
    expect(await f.call({...f.args,expectedRevision:1.5})).toMatchObject({ok:false,code:'SCHEMA_INVALID'})
  })
  function fixture() {
    const f = initWorkspace(),
      tools = new Map<string, ToolDefinition>()
    let starts = 0
    registerArgumentTools(
      { tools: { register: (t) => tools.set(t.name, t) } },
      {
        workspaceRoot: () => f.root,
        captures: new CaptureRegistry(),
        artifactTexts: new Map(),
        snapshotTexts: new Map(),
        maxEntities: 10000,
        review: {
          adapter: fakeAdapter([() => ({ raw: '{}' })]),
          budget: BUDGET,
          tasks: {
            start: () => {
              starts++
              return true
            },
            cancel() {},
            get: () => 'running',
            emitProgress() {},
          },
        },
      },
    )
    const args = { projectId: f.projectId, expectedRevision: 1, requestId: randomUUID(), input: { stage: 'claims' } }
    const call = (value: unknown) =>
      tools.get('argument.review')!.execute(value, { signal: new AbortController().signal }) as Promise<any>
    return { ...f, args, call, starts: () => starts }
  }
  it('an immediate duplicate before the background callback starts spends no second job', async () => {
    const f = fixture()
    const first = await f.call(f.args),
      second = await f.call(f.args)
    expect(first.ok).toBe(true)
    expect(second.data.runId).toBe(first.data.runId)
    expect(f.starts()).toBe(1)
  })
  it('the same request ID with a different payload is an idempotency conflict', async () => {
    const f = fixture()
    await f.call(f.args)
    expect(await f.call({ ...f.args, input: { stage: 'sources' } })).toMatchObject({
      ok: false,
      code: 'IDEMPOTENCY_CONFLICT',
    })
    expect(f.starts()).toBe(1)
  })
})
