/**
 * Provider tests with a fake delegate provider and a minimal registry stub
 * (resume-journal design §3.4): all-hit replay, first-miss freezing, hash
 * misses, corruption fail-open, copy-forward, claim lifecycle, capability
 * mirroring, and disposal cleanup.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JournalLine, PendingWorkflowClaim } from '@dsh-cc/tool-workflow'
import type { ResolvedSubagentStartRequest, SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { CcWorkflowJournalProvider } from '../src/provider.ts'
import { hashSubagentRequest } from '../src/journal-io.ts'

function scratch(): string {
  const root = join(process.cwd(), '.scratch')
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, 'provider-'))
}

/** Minimal registry stub: the provider's exact consume surface. */
class FakeRegistry {
  claim: PendingWorkflowClaim | undefined
  readonly handles = new Map<WorkflowRunId, { drain(): Promise<void>; markCached(index: number): void }>()
  readonly cached = new Map<WorkflowRunId, number[]>()

  takePendingClaim(): PendingWorkflowClaim | undefined {
    const claim = this.claim
    this.claim = undefined
    return claim
  }

  bindJournal(runId: WorkflowRunId, handle: { drain(): Promise<void>; markCached(index: number): void }): () => void {
    this.handles.set(runId, handle)
    return () => this.handles.delete(runId)
  }

  markCached(runId: WorkflowRunId, arrivalIndex: number): void {
    const list = this.cached.get(runId) ?? []
    list.push(arrivalIndex)
    this.cached.set(runId, list)
  }
}

interface SpawnRecord { promptText: string; agentOptions?: unknown; outputSchema?: unknown }

/** Fake delegate 'spawn' provider: deterministic text per arrival, small delay. */
class FakeDelegate implements SubagentProvider {
  readonly name = 'spawn'
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = true
  readonly agentRouteDefaults = { provider: 'deepseek', model: 'mock-model' }
  readonly spawns: SpawnRecord[] = []

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const index = this.spawns.length
    this.spawns.push({
      promptText: promptText(request),
      ...(request.agentOptions !== undefined ? { agentOptions: request.agentOptions } : {}),
      ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
    })
    await new Promise(resolve => setTimeout(resolve, 1))
    const result: SubagentResult = {
      output: [{ type: 'text', text: `out-${index}` }],
      ...(request.outputSchema !== undefined ? { structured: { structuredFor: index } } : {}),
      stopReason: 'completed',
    }
    return {
      id: `spawn-${index}` as never,
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose: () => Promise.resolve(),
    }
  }
}

function promptText(request: ResolvedSubagentStartRequest): string {
  return (request.prompt as readonly { type: string; text?: string }[]).map(block => block.text ?? '').join('')
}

function requestOf(prompt: string, signal: AbortSignal, extra: { agentOptions?: unknown; outputSchema?: unknown } = {}): ResolvedSubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: prompt }],
    parent: {} as never,
    signal,
    ...(extra.agentOptions !== undefined ? { agentOptions: extra.agentOptions as never } : {}),
    ...(extra.outputSchema !== undefined ? { outputSchema: extra.outputSchema as never } : {}),
    descriptor: {} as never,
  }
}

interface Fixture {
  dir: string
  registry: FakeRegistry
  delegate: FakeDelegate
  provider: CcWorkflowJournalProvider
  warnings: string[]
  nextRun: number
}

function setup(maxJournalBytes = 1 << 20): Fixture {
  const dir = scratch()
  const registry = new FakeRegistry()
  const delegate = new FakeDelegate()
  const warnings: string[] = []
  const provider = new CcWorkflowJournalProvider(
    { getProvider: name => name === 'spawn' ? delegate : undefined },
    registry,
    { maxJournalBytes, warn: message => warnings.push(message) },
  )
  return { dir, registry, delegate, provider, warnings, nextRun: 1 }
}

/** Fire one run: fresh signal, fresh claim, starts awaited to settlement. */
async function runSpawns(
  fixture: Fixture,
  prompts: string[],
  options: { resumeOf?: string; journalText?: string; extra?: (index: number) => { agentOptions?: unknown; outputSchema?: unknown } } = {},
): Promise<{ runId: WorkflowRunId; runs: SubagentRun[] }> {
  const runId = `run-${fixture.nextRun++}` as WorkflowRunId
  const signal = new AbortController().signal
  fixture.registry.claim = {
    runId,
    journalPath: join(fixture.dir, 'sess', `${runId}.jsonl`),
    ...(options.resumeOf !== undefined ? { resumeOf: options.resumeOf as WorkflowRunId } : {}),
    ...(options.journalText !== undefined ? { journalText: options.journalText } : {}),
  }
  const runs: SubagentRun[] = []
  for (let i = 0; i < prompts.length; i++) {
    runs.push(await fixture.provider.start(requestOf(prompts[i]!, signal, options.extra?.(i))))
  }
  await Promise.all(runs.map(run => run.result))
  await fixture.registry.handles.get(runId)?.drain()
  return { runId, runs }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('CcWorkflowJournalProvider', () => {
  it('replays an all-hit resume with zero delegate spawns and fabricated results equal to stored projections', async () => {
    const fx = setup()
    const prompts = ['one', 'two', 'three']
    await runSpawns(fx, prompts)
    expect(fx.delegate.spawns).toHaveLength(3)
    const text = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    const second = await runSpawns(fx, prompts, { resumeOf: 'run-1', journalText: text })
    expect(fx.delegate.spawns).toHaveLength(3) // zero new spawns
    for (let i = 0; i < prompts.length; i++) {
      const result = await second.runs[i]!.result
      expect(result.stopReason).toBe('completed')
      expect(result.output).toEqual([{ type: 'text', text: `out-${i}` }])
    }
    expect(second.runs.every(run => run.localAgent === undefined)).toBe(true)
    await second.runs[0]!.dispose()
    await second.runs[0]!.dispose() // dispose is idempotent
  })

  it('freezes at the first miss and reruns exactly the suffix (captured prompts prove it)', async () => {
    const fx = setup()
    await runSpawns(fx, ['one', 'two', 'three'])
    const text = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    const before = fx.delegate.spawns.length
    await runSpawns(fx, ['one', 'EDITED', 'three'], { resumeOf: 'run-1', journalText: text })
    expect(fx.delegate.spawns.slice(before).map(record => record.promptText)).toEqual(['EDITED', 'three'])
  })

  it('treats a per-seq hash miss (model change) like a mid-script edit', async () => {
    const fx = setup()
    await runSpawns(fx, ['one', 'two'], { extra: () => ({ agentOptions: { model: 'm1' } }) })
    const text = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    const before = fx.delegate.spawns.length
    await runSpawns(fx, ['one', 'two'], {
      resumeOf: 'run-1',
      journalText: text,
      extra: index => index === 0 ? { agentOptions: { model: 'm1' } } : { agentOptions: { model: 'm2' } },
    })
    expect(fx.delegate.spawns.slice(before).map(record => record.promptText)).toEqual(['two'])
  })

  it('misses on a schema change too', async () => {
    const fx = setup()
    await runSpawns(fx, ['one'], { extra: () => ({ outputSchema: { type: 'object', properties: { a: { type: 'string' } } } }) })
    const text = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    const before = fx.delegate.spawns.length
    await runSpawns(fx, ['one'], { resumeOf: 'run-1', journalText: text, extra: () => ({ outputSchema: { type: 'object', properties: { b: { type: 'string' } } } }) })
    expect(fx.delegate.spawns.length - before).toBe(1)
  })

  it('fails open live on corrupt journal text (frozen from the start)', async () => {
    const fx = setup()
    await runSpawns(fx, ['one', 'two'])
    const before = fx.delegate.spawns.length
    await runSpawns(fx, ['one', 'two'], { resumeOf: 'run-1', journalText: '{"seq":1,"hash" nope\n' })
    expect(fx.delegate.spawns.slice(before).map(record => record.promptText)).toEqual(['one', 'two'])
    expect(fx.warnings.some(message => message.includes('corrupt'))).toBe(true)
  })

  it('fails open live when a resume claim carries no journal text', async () => {
    const fx = setup()
    await runSpawns(fx, ['one'])
    const before = fx.delegate.spawns.length
    await runSpawns(fx, ['one'], { resumeOf: 'run-1' })
    expect(fx.delegate.spawns.length - before).toBe(1)
  })

  it('drops a truncated last line and still replays the remaining prefix', async () => {
    const fx = setup()
    await runSpawns(fx, ['one', 'two', 'three'])
    const text = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    const lines = text.split('\n').filter(Boolean)
    const truncated = [...lines.slice(0, 2), '{"seq":3,"hash":"h3"'].join('\n')
    const before = fx.delegate.spawns.length
    await runSpawns(fx, ['one', 'two', 'three'], { resumeOf: 'run-1', journalText: truncated })
    expect(fx.delegate.spawns.slice(before).map(record => record.promptText)).toEqual(['three'])
  })

  it('freezes at a stored non-completed line before the first prompt change', async () => {
    const fx = setup()
    await runSpawns(fx, ['one', 'two'])
    const text = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    const failed: JournalLine[] = text.split('\n').filter(Boolean).map((lineText, i) => {
      const parsed = JSON.parse(lineText) as JournalLine
      return i === 0 ? { ...parsed, status: 'error' } : parsed
    })
    const before = fx.delegate.spawns.length
    await runSpawns(fx, ['one', 'two'], { resumeOf: 'run-1', journalText: failed.map(line => JSON.stringify(line)).join('\n') })
    // Even though prompt 2 matches, the frozen latch reruns it live.
    expect(fx.delegate.spawns.slice(before).map(record => record.promptText)).toEqual(['one', 'two'])
  })

  it('treats a malformed completed projection as corruption (frozen + live)', async () => {
    const fx = setup()
    const bad = JSON.stringify({
      seq: 1,
      hash: hashSubagentRequest({ prompt: [{ type: 'text', text: 'one' }] }),
      status: 'completed',
      result: { output: 'not-an-array', stopReason: 'completed' },
    })
    const before = fx.delegate.spawns.length
    await runSpawns(fx, ['one'], { resumeOf: 'run-x', journalText: `${bad}\n` })
    expect(fx.delegate.spawns.length - before).toBe(1)
  })

  it('fabricates fresh uuid4 ids: unique across hits and never reused across resumes', async () => {
    const fx = setup()
    const prompts = ['one', 'two']
    await runSpawns(fx, prompts)
    const text = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    const second = await runSpawns(fx, prompts, { resumeOf: 'run-1', journalText: text })
    const third = await runSpawns(fx, prompts, { resumeOf: 'run-1', journalText: text })
    const ids = [...second.runs, ...third.runs].map(run => run.id as string)
    expect(ids.every(id => UUID_RE.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('replays a resume of a resumed run via copy-forward (new journal carries the copied lines)', async () => {
    const fx = setup()
    const prompts = ['one', 'two', 'three']
    await runSpawns(fx, prompts)
    const text1 = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    await runSpawns(fx, prompts, { resumeOf: 'run-1', journalText: text1 })
    const text2 = readFileSync(join(fx.dir, 'sess', 'run-2.jsonl'), 'utf8')
    expect(text2).toBe(text1) // copy-forward re-appended identical content
    const before = fx.delegate.spawns.length
    await runSpawns(fx, prompts, { resumeOf: 'run-2', journalText: text2 })
    expect(fx.delegate.spawns.length).toBe(before) // full prefix still replays
  })

  it('attributes the normal run after a zero-agent run leaves its claim unclaimed (deposit overwrite)', async () => {
    const fx = setup()
    // A zero-agent run deposits a claim its provider never consumes; the next
    // deposit overwrites it and the next run's children attribute to it.
    fx.registry.claim = { runId: 'run-zero' as WorkflowRunId, journalPath: join(fx.dir, 'sess', 'run-zero.jsonl') }
    const next = await runSpawns(fx, ['one'])
    expect(next.runId).toBe('run-1')
    expect(fx.registry.handles.has('run-zero' as WorkflowRunId)).toBe(false)
    expect(fx.registry.handles.has('run-1' as WorkflowRunId)).toBe(true)
    expect(fx.delegate.spawns).toHaveLength(1)
  })

  it('marks replay hits cached and live rows not', async () => {
    const fx = setup()
    const prompts = ['one', 'two']
    const first = await runSpawns(fx, prompts)
    expect(fx.registry.cached.get(first.runId)).toBeUndefined()
    const text = readFileSync(join(fx.dir, 'sess', 'run-1.jsonl'), 'utf8')
    const second = await runSpawns(fx, prompts, { resumeOf: 'run-1', journalText: text })
    expect(fx.registry.cached.get(second.runId)).toEqual([1, 2])
  })

  it('throws loudly on an unknown signal with no pending claim', async () => {
    const fx = setup()
    await expect(fx.provider.start(requestOf('x', new AbortController().signal)))
      .rejects.toThrow('cc-workflow-journal: start on an unknown signal with no pending workflow-run claim')
  })

  it('mirrors the delegate capabilities through lazy getters and throws loudly while the delegate is missing', () => {
    const registry = new FakeRegistry()
    const delegate = new FakeDelegate()
    const missing = new CcWorkflowJournalProvider({ getProvider: () => undefined }, registry, { maxJournalBytes: 1 << 20, warn: () => {} })
    expect(() => missing.capabilities).toThrow('cc-workflow-journal: delegate provider "spawn" is not registered yet')
    const resolved = new CcWorkflowJournalProvider({ getProvider: name => name === 'spawn' ? delegate : undefined }, registry, { maxJournalBytes: 1 << 20, warn: () => {} })
    expect(resolved.capabilities).toBe(delegate.capabilities)
    expect(resolved.inheritsParentContext).toBe(true)
    expect(resolved.agentRouteDefaults).toEqual(delegate.agentRouteDefaults)
  })

  it('disposeAllJournals closes writers, drains, and removes the session directory', async () => {
    const fx = setup()
    await runSpawns(fx, ['one', 'two'])
    const sessionDir = join(fx.dir, 'sess')
    expect(existsSync(sessionDir)).toBe(true)
    await fx.provider.disposeAllJournals()
    expect(existsSync(sessionDir)).toBe(false)
    expect(fx.registry.handles.size).toBe(0)
  })
})
