/**
 * Write-back pipeline for the memory forks (design §3.4): the settled report's
 * single `MEMORY.md` write goes through `commitMemoryWrites` with the
 * `pointerAdditions` / `mergeIndexContent` / `carveEntrypointRoom` builder, so
 * a pointer added by a concurrent writer after the job's baseline capture is
 * preserved rather than erased. A batch with no index write keeps the plain
 * `writeMemoryFiles` path.
 */
import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { startMemoryJob } from '../src/memory-job.ts'

const DIR = '/mem'
const INDEX = `${DIR}/MEMORY.md`

function fakeAgent(): Agent {
  return {
    options: {},
    session: { events: [], get seq() { return 0 }, snapshotEvents() { return [] }, header: { id: 'session:/mem', cwd: '/mem' } },
  } as unknown as Agent
}

/**
 * In-memory fs seam. `afterWrite` hooks observe each completed `writeText`, so
 * a test can script a foreign writer landing at a precise commit-protocol step.
 */
function makeFs(seed: Record<string, string> = {}) {
  const backing = new Map(Object.entries(seed))
  const afterWrite: Array<(key: string) => void> = []
  const fs = {
    backing,
    afterWrite,
    async resolve(path: string) { return { targetKey: path, displayPath: path } },
    async stat(target: unknown) {
      const content = backing.get(String((target as { targetKey: unknown }).targetKey))
      return content === undefined ? undefined : { version: 'v1', type: 'file', size: content.length }
    },
    async readText(target: unknown) {
      const key = String((target as { targetKey: unknown }).targetKey)
      const content = backing.get(key)
      if (content === undefined) throw new Error('not found')
      return content
    },
    async writeText(target: unknown, content: string) {
      const key = String((target as { targetKey: unknown }).targetKey)
      backing.set(key, content)
      for (const hook of afterWrite) hook(key)
      return {}
    },
    async listDir() { return [] },
  }
  return fs
}

/** Run one job with a resolvable fork report; `onStart` fires after dispatch. */
async function runJob(
  fs: ReturnType<typeof makeFs>,
  writes: unknown,
  baselineIndex: string,
  opts: { onStart?: () => void } = {},
): Promise<{ status: string; detail?: string }> {
  const ctx = new Context()
  const subagents = {
    async startActivation() {
      opts.onStart?.()
      return {
        childId: 'job-child',
        messageId: 'job-m',
        dispose: () => Promise.resolve(),
        result: Promise.resolve({ structured: { writes }, stopReason: 'completed' }),
      }
    },
  }
  ctx.provide('subagents' as never, subagents as never)
  ctx.provide('fs' as never, fs as unknown as FileSystem as never)
  const job = await startMemoryJob(ctx, fakeAgent(), DIR, 'fork', 'dream', 'prompt', baselineIndex)
  return job.done
}

describe('memory-job MEMORY.md write-back (design §3.4)', () => {
  it('preserves a pointer added to the durable index after the job started (prompt/baseline gap)', async () => {
    const baseline = '- [topic-a](topic-a.md): A\n'
    const fs = makeFs({ [INDEX]: baseline })
    const modelIndex = '- [topic-a](topic-a.md): A revised\n'
    const outcome = await runJob(fs, [{ path: 'MEMORY.md', content: modelIndex }], baseline, {
      // A concurrent save lands AFTER the job start: absent from the baseline
      // and from the model's rewrite.
      onStart: () => fs.backing.set(INDEX, `${baseline}- [topic-b](topic-b.md): B\n`),
    })

    expect(outcome).toEqual({ status: 'completed' })
    const written = fs.backing.get(INDEX)!
    expect(written).toContain('- [topic-a](topic-a.md): A revised')
    expect(written).toContain('- [topic-b](topic-b.md): B')
  })

  it('honors a model deletion: a baseline pointer dropped from the rewrite stays dropped', async () => {
    const baseline = '- [topic-a](topic-a.md): A\n- [topic-b](topic-b.md): B\n'
    const fs = makeFs({ [INDEX]: baseline })
    const modelIndex = '- [topic-a](topic-a.md): A\n'
    const outcome = await runJob(fs, [{ path: 'MEMORY.md', content: modelIndex }], baseline)

    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(INDEX)).toBe(modelIndex)
  })

  it('dream baseline residual: a pointer added after the baseline and dropped by the model is resurrected (accepted §3.2 residual)', async () => {
    const baseline = '- [topic-a](topic-a.md): A\n'
    const fs = makeFs({ [INDEX]: baseline })
    const modelIndex = '- [topic-a](topic-a.md): A\n'
    const outcome = await runJob(fs, [{ path: 'MEMORY.md', content: modelIndex }], baseline, {
      // The dream fork read the directory AFTER this landed (so the model saw
      // it) and chose to drop it: the merge cannot tell the difference and
      // resurrects the visible pointer line — the documented residual.
      onStart: () => fs.backing.set(INDEX, `${baseline}- [late](late.md): late\n`),
    })

    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(INDEX)).toContain('- [late](late.md): late')
  })

  it('keeps a concurrent addition when the model index is over its caps (carveEntrypointRoom, §3.5)', async () => {
    const baseline = '- [topic-0](topic-0.md): d0\n'
    const fs = makeFs({ [INDEX]: baseline })
    const modelIndex = Array.from({ length: 210 }, (_, i) => `- [topic-${i}](topic-${i}.md): d${i}`).join('\n')
    const outcome = await runJob(fs, [{ path: 'MEMORY.md', content: modelIndex }], baseline, {
      onStart: () => fs.backing.set(INDEX, `${baseline}- [extra](extra.md): concurrent\n`),
    })

    expect(outcome).toEqual({ status: 'completed' })
    const written = fs.backing.get(INDEX)!
    // The protected addition survives and the document is back under the caps.
    expect(written).toContain('- [extra](extra.md): concurrent')
    expect(written.trim().split('\n').length).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(written.trim(), 'utf8')).toBeLessThanOrEqual(25_000)
  })

  it('maps commit exhaustion to a failed outcome with the conflict detail', async () => {
    const fs = makeFs({ [INDEX]: '- [topic-a](topic-a.md): A\n' })
    // Every index write is immediately clobbered by a foreign writer, so the
    // read-back never matches and all bounded attempts are spent.
    fs.afterWrite.push((key) => { if (key === INDEX) fs.backing.set(INDEX, '- [foreign](foreign.md): won\n') })
    const outcome = await runJob(fs, [{ path: 'MEMORY.md', content: '- [topic-a](topic-a.md): A\n' }], '')

    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('index commit conflict')
    expect(outcome.detail).toContain('12 attempts')
    // Our writes were superseded: the durable index is the last foreign write.
    expect(fs.backing.get(INDEX)).toBe('- [foreign](foreign.md): won\n')
  })

  it('a batch with no MEMORY.md write keeps the plain write path', async () => {
    const fs = makeFs()
    const outcome = await runJob(fs, [{ path: 'topic-a.md', content: 'body\n' }], '')

    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(`${DIR}/topic-a.md`)).toBe('body\n')
    expect(fs.backing.get(INDEX)).toBeUndefined()
  })

  it('rejects two MEMORY.md writes in one batch with the validation error', async () => {
    const fs = makeFs()
    const outcome = await runJob(fs, [
      { path: 'MEMORY.md', content: '# one\n' },
      { path: 'MEMORY.md', content: '# two\n' },
    ], '')

    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('duplicate memory filename "MEMORY.md"')
    expect(fs.backing.get(INDEX)).toBeUndefined()
  })
})
