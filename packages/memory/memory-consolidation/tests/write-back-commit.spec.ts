/**
 * Write-back pipeline for the memory forks (design §3.4): the settled report's
 * single `MEMORY.md` write goes through `commitMemoryWrites` with the
 * `pointerAdditions` / `mergeIndexContent` / `carveEntrypointRoom` builder, so
 * a pointer added by a concurrent writer after the job's baseline capture is
 * preserved rather than erased. A batch with no index write keeps the plain
 * `writeMemoryFiles` path.
 *
 * The `memory-consolidation` (dream) label keeps that protocol byte-for-byte;
 * the `extract-memories` label ignores the fork's index write and upserts one
 * pointer per batch topic host-side (design
 * docs/plans/2026-11-12-extraction-index-coverage-fix.md §A).
 */
import { describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from '@dsh-cc/memory'
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
 * a test can script a foreign writer landing at a precise commit-protocol step;
 * `writes` records every completed write in order (the "was this content ever
 * written?" assertion surface).
 */
function makeFs(seed: Record<string, string> = {}) {
  const backing = new Map(Object.entries(seed))
  const afterWrite: Array<(key: string, content: string) => void> = []
  const writes: Array<[string, string]> = []
  const fs = {
    backing,
    afterWrite,
    writes,
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
      writes.push([key, content])
      for (const hook of afterWrite) hook(key, content)
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
  opts: { onStart?: () => void; label?: string; warnSink?: string[] } = {},
): Promise<{ status: string; detail?: string }> {
  const ctx = new Context()
  const warnSpy = vi.spyOn(ctx.logger, 'warn')
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
  const job = await startMemoryJob(
    ctx,
    fakeAgent(),
    DIR,
    'fork',
    opts.label ?? 'memory-consolidation',
    'prompt',
    baselineIndex,
  )
  const outcome = await job.done
  opts.warnSink?.push(...warnSpy.mock.calls.map(call => call.map(String).join(' ')))
  return outcome
}

/** A memdir topic file body: frontmatter (name/description/type) plus a body. */
function topicFile(name: string, description: string): string {
  return ['---', `name: ${name}`, `description: ${description}`, 'type: project', '---', '', 'Body.', ''].join('\n')
}

/** `count` baseline pointer lines in the save path's line format. */
function pointers(count: number, prefix = 'topic'): string {
  return `${Array.from({ length: count }, (_, i) => `- [${prefix}-${i}](${prefix}-${i}.md) — d${i}`).join('\n')}\n`
}

/**
 * An index of `lines` pointer lines whose trimmed size is EXACTLY `bytes` UTF-8
 * bytes (the last line carries the padding), so the per-upsert byte gate can be
 * pinned without magic lengths.
 */
function sizedIndex(bytes: number, firstLine = '- [batch](batch.md) — old', lines = 5): string {
  const body = [firstLine, ...Array.from({ length: lines - 1 }, (_, i) => `- [pad-${i}](pad-${i}.md) — pad`)].join('\n')
  const missing = bytes - Buffer.byteLength(body, 'utf8')
  return `${body}${'x'.repeat(missing)}\n`
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

describe('memory-job extraction write-back (2026-11-12 design §A)', () => {
  it('incident reproduction: keeps every baseline pointer byte-identical, appends the new one, and never executes the fork index write', async () => {
    // The 2026-11-12 incident shape: the fork reported one topic plus a
    // MEMORY.md holding only its own pointer; the host committed it verbatim and
    // 30 baseline pointers vanished.
    const baseline = pointers(8)
    const fs = makeFs({ [INDEX]: baseline })
    const outcome = await runJob(fs, [
      { path: 'incident.md', content: topicFile('incident', 'one new fact') },
      { path: 'MEMORY.md', content: '- [incident](incident.md) — one new fact\n' },
    ], baseline, { label: 'extract-memories' })

    expect(outcome).toEqual({ status: 'completed' })
    const expected = `${baseline}- [incident](incident.md) — one new fact\n`
    expect(fs.backing.get(INDEX)).toBe(expected)
    // Every baseline line survives verbatim, in order.
    expect(fs.backing.get(INDEX)!.startsWith(baseline)).toBe(true)
    // The only MEMORY.md write that ever reached the fs is the host-generated
    // upsert result — the fork's own content was never written.
    expect(fs.writes.filter(([key]) => key === INDEX).map(([, content]) => content)).toEqual([expected])
    expect(fs.backing.get(`${DIR}/incident.md`)).toBe(topicFile('incident', 'one new fact'))
  })

  it('drops an over-cap fork index before validation and still commits the topic', async () => {
    const baseline = '- [a](a.md) — A\n'
    const fs = makeFs({ [INDEX]: baseline })
    const overCap = Array.from({ length: 210 }, (_, i) => `- [x-${i}](x-${i}.md) — d`).join('\n')
    const outcome = await runJob(fs, [
      { path: 'fresh.md', content: topicFile('fresh', 'a fresh fact') },
      { path: 'MEMORY.md', content: overCap },
    ], baseline, { label: 'extract-memories' })

    // A batch whose index write would fail validateMemoryWrites still succeeds.
    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(`${DIR}/fresh.md`)).toBe(topicFile('fresh', 'a fresh fact'))
    expect(fs.backing.get(INDEX)).toBe(`${baseline}- [fresh](fresh.md) — a fresh fact\n`)
  })

  it('skips an append that would exceed the entrypoint caps and commits the topic only', async () => {
    const baseline = pointers(MAX_ENTRYPOINT_LINES)
    const fs = makeFs({ [INDEX]: baseline })
    const warnings: string[] = []
    const outcome = await runJob(fs, [{ path: 'late.md', content: topicFile('late', 'late fact') }], baseline, {
      label: 'extract-memories',
      warnSink: warnings,
    })

    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(INDEX)).toBe(baseline)
    expect(fs.backing.get(`${DIR}/late.md`)).toBe(topicFile('late', 'late fact'))
    expect(warnings.join('\n')).toContain('cap')
  })

  it('freezes a pre-existing over-cap index without failing the job', async () => {
    const baseline = pointers(MAX_ENTRYPOINT_LINES + 10)
    const fs = makeFs({ [INDEX]: baseline })
    const warnings: string[] = []
    const outcome = await runJob(fs, [{ path: 'extra.md', content: topicFile('extra', 'extra fact') }], baseline, {
      label: 'extract-memories',
      warnSink: warnings,
    })

    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(INDEX)).toBe(baseline)
    expect(fs.backing.get(`${DIR}/extra.md`)).toBe(topicFile('extra', 'extra fact'))
    expect(warnings.join('\n')).toContain('cap')
  })

  it('preserves a pointer a concurrent save added after the job started', async () => {
    const baseline = '- [topic-a](topic-a.md) — A\n'
    const fs = makeFs({ [INDEX]: baseline })
    const outcome = await runJob(fs, [
      { path: 'topic-b.md', content: topicFile('topic-b', 'B') },
      { path: 'MEMORY.md', content: '- [topic-b](topic-b.md) — B\n' },
    ], baseline, {
      label: 'extract-memories',
      onStart: () => fs.backing.set(INDEX, `${baseline}- [saved](saved.md) — S\n`),
    })

    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(INDEX)).toBe(`${baseline}- [saved](saved.md) — S\n- [topic-b](topic-b.md) — B\n`)
  })

  it('completes with zero writes when the report carried only an index write', async () => {
    const fs = makeFs({ [INDEX]: '- [a](a.md) — A\n' })
    const outcome = await runJob(fs, [{ path: 'MEMORY.md', content: '- [a](a.md) — A\n- [b](b.md) — B\n' }], '', {
      label: 'extract-memories',
    })

    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(INDEX)).toBe('- [a](a.md) — A\n')
    expect(fs.writes).toEqual([])
  })

  it('commits frontmatter-less topics with no pointer and one warn per batch', async () => {
    const baseline = '- [a](a.md) — A\n'
    const fs = makeFs({ [INDEX]: baseline })
    const warnings: string[] = []
    const outcome = await runJob(fs, [
      { path: 'raw.md', content: 'no frontmatter here\n' },
      { path: 'raw-two.md', content: 'nor here\n' },
    ], baseline, { label: 'extract-memories', warnSink: warnings })

    expect(outcome).toEqual({ status: 'completed' })
    expect(fs.backing.get(`${DIR}/raw.md`)).toBe('no frontmatter here\n')
    expect(fs.backing.get(`${DIR}/raw-two.md`)).toBe('nor here\n')
    expect(fs.backing.get(INDEX)).toBe(baseline)
    const degraded = warnings.filter(warning => warning.includes('grep only'))
    expect(degraded).toHaveLength(1)
    expect(degraded[0]).toContain('raw.md')
    expect(degraded[0]).toContain('raw-two.md')
  })

  it('applies cap skips in batch order: a too-wide append is skipped, a later fitting one lands', async () => {
    // One line of headroom under the line cap and ~200 bytes under the byte
    // cap: the first append's (clamped, 200-char) description cannot fit, the
    // second one's short description does.
    const baseline = sizedIndex(MAX_ENTRYPOINT_BYTES - 200)
    expect(baseline.trim().split('\n')).toHaveLength(5)
    const headroom = MAX_ENTRYPOINT_BYTES - Buffer.byteLength(baseline.trim(), 'utf8')
    expect(headroom).toBe(200)
    const fs = makeFs({ [INDEX]: baseline })
    const warnings: string[] = []
    const outcome = await runJob(fs, [
      { path: 'wide.md', content: topicFile('wide', 'w'.repeat(400)) },
      { path: 'narrow.md', content: topicFile('narrow', 'short') },
    ], baseline, { label: 'extract-memories', warnSink: warnings })

    expect(outcome).toEqual({ status: 'completed' })
    const written = fs.backing.get(INDEX)!
    expect(written).not.toContain('wide.md')
    expect(written).toBe(`${baseline.trimEnd()}\n- [narrow](narrow.md) — short\n`)
    expect(warnings.join('\n')).toContain('cap')
    expect(fs.backing.get(`${DIR}/wide.md`)).toBe(topicFile('wide', 'w'.repeat(400)))
    expect(fs.backing.get(`${DIR}/narrow.md`)).toBe(topicFile('narrow', 'short'))
  })
})

describe('memory-job label validation (2026-11-12 design §B)', () => {
  it('rejects an unknown label before dispatching anything', async () => {
    const ctx = new Context()
    let dispatched = 0
    const subagents = {
      async startActivation() {
        dispatched += 1
        return {
          dispose: () => Promise.resolve(),
          result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }),
        }
      },
    }
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, makeFs() as unknown as FileSystem as never)

    await expect(startMemoryJob(ctx, fakeAgent(), DIR, 'fork', 'dream', 'prompt', ''))
      .rejects.toThrow('unknown memory job label "dream"')
    expect(dispatched).toBe(0)
  })

  it('dispatches both known labels', async () => {
    for (const label of ['extract-memories', 'memory-consolidation']) {
      const fs = makeFs()
      const outcome = await runJob(fs, [{ path: 'topic-a.md', content: topicFile('topic-a', 'A') }], '', { label })
      expect(outcome).toEqual({ status: 'completed' })
      expect(fs.backing.get(`${DIR}/topic-a.md`)).toBe(topicFile('topic-a', 'A'))
    }
  })
})
