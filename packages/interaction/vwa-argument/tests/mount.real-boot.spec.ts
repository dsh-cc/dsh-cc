/**
 * Real-mount integration (design §10.3/§10.6/§13, Appendix A): the plugin is
 * mounted through cordis exactly as a preset row would mount it — real
 * `@deepseek-ai/dsh-llm` runtime, real `@deepseek-ai/dsh-tools` registry
 * (so `tools/post-execute` fires), real `@deepseek-ai/dsh-jobs-local`
 * registry — and driven through `ctx.tools.execute` the way the agent loop
 * drives it. The ONLY fake is the model at the provider boundary: an
 * `LlmAdapter` registered for a test provider that answers the forced
 * `respond` tool call from the envelope it receives.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as VwaArgument from '../src/index.ts'
import { ProjectStore } from '../src/store.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { CONTRACT } from './helpers.ts'
import { resolveDeliveryProvider } from '@dsh-cc/vwa-evidence'

const PROVIDER = 'fake-provider'
const REVIEWER_MODEL = 'reviewer-model'

/** Provider-boundary fake: answers each review envelope with a schema-valid `respond` call. */
class EnvelopeReviewer extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  readonly quotes: string[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const user = options.messages.at(-1) as { content: { type: string; text?: string }[] }
    const envelope = JSON.parse(user.content.map((block) => block.text ?? '').join('')) as {
      stage: string
      requiredRules: { targetId: string; ruleId: string }[]
      targets: { id: string }[]
      context?: { evidenceId: string; quote: string }[]
    }
    for (const entry of envelope.context ?? []) this.quotes.push(entry.quote)
    const response = {
      stage: envelope.stage,
      rubricVersion: 'humanities-v1',
      findings: [],
      targets: envelope.targets.map((target) => ({
        targetId: target.id,
        checks: envelope.requiredRules.filter((rule) => rule.targetId === target.id)
          .map((rule) => ({ ruleId: rule.ruleId, result: 'pass', rationale: 'quoted text states it', evidenceIds: [] })),
        support: 'direct',
        adequacy: 'adequate',
        evidenceRelations: (envelope.context ?? []).map((entry) => ({ evidenceId: entry.evidenceId, support: 'direct', rationale: 'r' })),
      })),
    }
    const args = JSON.stringify(response)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'respond', argumentsDelta: args } as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'respond', arguments: args } } as StreamChunk
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } } as StreamChunk
    yield { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk
  }
}

interface Booted {
  ctx: Context
  reviewer: EnvelopeReviewer
  agentAt(root: string): unknown
  exec(name: string, args: unknown, agent: unknown): Promise<Record<string, unknown>>
  commandNames: string[]
}

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
})

function workspace(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'vwa-mount-')))
}

/** Boot the host services a preset mount sees, then plug the real vwa-argument entry. */
async function boot(settings: Record<string, unknown> = { 'semantic-enabled': true, 'review-alias': 'reviewer' }): Promise<Booted> {
  const dshHome = mkdtempSync(join(tmpdir(), 'vwa-mount-home-'))
  writeFileSync(join(dshHome, 'settings.json'), JSON.stringify({ 'vwa-argument': settings }), 'utf8')
  const ctx = new Context()
  ;(ctx as unknown as { dshHomePath: () => string }).dshHomePath = () => dshHome
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  const commandNames: string[] = []
  ctx.provide('commands', { register: (definition: { name: string }) => { commandNames.push(definition.name); return () => {} } })
  // The alias registry: `reviewer` routes to the test provider (no concrete id in src).
  ctx.provide('ccModelRoutes', {
    resolve: (alias: string | undefined) => (alias === 'reviewer' ? { provider: PROVIDER, model: REVIEWER_MODEL } : undefined),
  })
  await ctx.plugin(LlmRuntime)
  const reviewer = new EnvelopeReviewer()
  ctx.llm.registerAdapter([PROVIDER], reviewer)
  await ctx.plugin(ToolRuntime as never)
  await ctx.plugin(LocalJobRegistry as never, {})
  ;(ctx as unknown as { jobs: { attachController(name: string): () => void } }).jobs.attachController('test-controller')
  // Host fs tools with the harness names/argument keys (`read`/`write`, file_path).
  const tools = (ctx as unknown as { tools: { register(def: unknown): () => void } }).tools
  const text = (value: unknown) => [{ type: 'text', text: JSON.stringify(value) }]
  tools.register({
    name: 'read', description: 'read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
    output: { schema: { type: 'object' }, render: (_a: unknown, v: unknown) => text(v) },
    async execute(args: { file_path: string }) { return { content: readFileSync(args.file_path, 'utf8') } },
  })
  tools.register({
    name: 'write', description: 'write a file',
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } },
    output: { schema: { type: 'object' }, render: (_a: unknown, v: unknown) => text(v) },
    async execute(args: { file_path: string; content: string }) { writeFileSync(args.file_path, args.content, 'utf8'); return { ok: true } },
  })
  tools.register({
    name: 'web_fetch', description: 'fetch a url', parameters: { type: 'object', properties: { url: { type: 'string' } } },
    output: { schema: { type: 'object' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: (v as { body: string }).body }] },
    async execute() { return { body: FETCHED_BODY } },
  })
  const fiber = await ctx.plugin(VwaArgument as never)
  disposers.push(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  const agentAt = (root: string): unknown => {
    const id = `sess-${randomUUID()}`
    return {
      id,
      session: {
        id, header: { cwd: root }, snapshotEvents: () => [],
        requestHeader: () => ({ config: { provider: PROVIDER, model: 'parent-model' } }),
      },
    }
  }
  const exec = async (name: string, args: unknown, agent: unknown) => {
    const result = await (ctx as unknown as { tools: { execute(e: unknown): Promise<{ isError: boolean; value?: unknown; error?: { message: string } }> } })
      .tools.execute({ callId: `c-${randomUUID()}`, name, arguments: args, agent, signal: new AbortController().signal })
    if (result.isError) throw new Error(`${name} failed: ${result.error?.message}`)
    return result.value as Record<string, unknown>
  }
  return { ctx, reviewer, agentAt, exec, commandNames }
}

function initProject(root: string): string {
  const projectId = `prj_${randomUUID()}`
  const init = new ProjectStore(root, projectId).init(CONTRACT)
  if (!init.ok) throw new Error(init.message)
  return projectId
}

const METADATA = {
  title: 'Council minutes', creators: [], publication: 'unknown', originalLocator: 'archive://minutes/1',
  edition: 'unknown', language: 'en', origin: 'external', material: 'primary',
}
const FETCHED_BODY = 'Port closure order, archived copy.\n'
const SOURCE_TEXT = 'The council voted to close the port on 3 May.\n'

async function waitForRun(root: string, projectId: string, requestId: string): Promise<ReturnType<ReviewRunStore['readRecords']>> {
  const store = new ReviewRunStore(root, projectId)
  for (let i = 0; i < 200; i += 1) {
    const run = store.findRunByRequestId(requestId)
    if (run !== undefined && run.status !== 'running') return store.readRecords(run.runId)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('review run never settled')
}

describe('vwa-argument real mount (semantic-enabled)', () => {
  it('registers the lane-2 tools and the vwa-argument service on a real cordis mount', async () => {
    const { ctx, commandNames } = await boot()
    // The user-surface /vwa command reaches the real commands service too.
    expect(commandNames).toContain('vwa')
    const tools = (ctx as unknown as { tools: { get(name: string): unknown } }).tools
    for (const name of ['evidence.register', 'evidence.search_log', 'argument.update', 'argument.review']) {
      expect(tools.get(name), name).toBeDefined()
    }
    expect(ctx.get('vwa-argument')).toBeDefined()
  })

  it('argument.review runs a real background review through the alias-routed model', async () => {
    const { reviewer, agentAt, exec } = await boot()
    const root = workspace()
    const agent = agentAt(root)
    const projectId = initProject(root)
    const sourcePath = join(root, 'minutes.md')
    writeFileSync(sourcePath, SOURCE_TEXT, 'utf8')
    await exec('read', { file_path: sourcePath }, agent)
    const registered = await exec('evidence.register', {
      projectId, expectedRevision: 1, requestId: randomUUID(),
      input: {
        path: sourcePath, metadata: METADATA,
        excerpts: [{ clientKey: 'e1', span: { start: 0, end: 44 }, originalLocation: 'p.1', transformation: 'none', transformationNote: '' }],
      },
    }, agent)
    expect(registered.ok).toBe(true)
    const evidenceId = (registered.data as { evidenceIds: { evidenceId: string }[] }).evidenceIds[0]!.evidenceId
    const graph = await exec('argument.update', {
      projectId, expectedRevision: 2, requestId: randomUUID(),
      input: {
        op: 'upsert', updates: [], deletes: [],
        creates: [
          {
            clientKey: 'c', type: 'claim',
            body: {
              text: 'The council closed the port in May.', kind: 'fact',
              scope: { subject: 'port', corpus: [], time: 'May', geography: 'unspecified', exclusions: [] },
              importance: 'core', stance: 'asserted', evaluationCriteria: [],
            },
          },
          { clientKey: 'g', type: 'group', body: { targetClaimId: { $new: 'c' }, evidenceIds: [evidenceId], mode: 'all', rationale: 'the minutes record the vote' } },
        ],
      },
    }, agent)
    expect(graph.ok, JSON.stringify(graph)).toBe(true)
    const requestId = randomUUID()
    const started = await exec('argument.review', {
      projectId, expectedRevision: 3, requestId, input: { stage: 'support' },
    }, agent)
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, data: { completion: 'started' } })
    const records = await waitForRun(root, projectId, requestId)
    const completed = records.filter((record) => record.status === 'completed')
    expect(completed, JSON.stringify(records.map((r) => [r.status, r.errorCode]))).toHaveLength(1)
    expect(completed[0]?.response?.stage).toBe('support')
    // The model was reached through the alias route, at the provider boundary.
    expect(reviewer.calls).toHaveLength(1)
    expect(reviewer.calls[0]).toMatchObject({ provider: PROVIDER, model: REVIEWER_MODEL })
    // The envelope carried the real quoted bytes read back from the snapshot (§11.4).
    expect(reviewer.quotes).toEqual([SOURCE_TEXT.slice(0, 44)])
  })
})

describe('vwa-argument real mount: capture and artifact sources (§10.3/§10.5)', () => {
  async function registerSource(b: Booted, agent: unknown, projectId: string, path: string): Promise<string> {
    const registered = await b.exec('evidence.register', {
      projectId, expectedRevision: 1, requestId: randomUUID(),
      input: { path, metadata: METADATA, excerpts: [] },
    }, agent)
    expect(registered.ok, JSON.stringify(registered)).toBe(true)
    const sourceId = (registered.data as { sourceId: string }).sourceId
    const root = (agent as { session: { header: { cwd: string } } }).session.header.cwd
    const head = new ProjectStore(root, projectId).readHead()
    if (!head.ok) throw new Error(head.message)
    return head.data.snapshot.sources.find((source) => source.id === sourceId)!.acquisition.kind
  }

  it('a same-session read through the real tool pipeline makes the source a tool-event capture', async () => {
    const b = await boot()
    const root = workspace()
    const agent = b.agentAt(root)
    const projectId = initProject(root)
    const path = join(root, 'minutes.md')
    writeFileSync(path, SOURCE_TEXT, 'utf8')
    await b.exec('read', { file_path: path }, agent)
    expect(await registerSource(b, agent, projectId, path)).toBe('tool-event')
  })

  it('a file never read in the session stays unverified, and another session\'s read does not count', async () => {
    const b = await boot()
    const root = workspace()
    const agent = b.agentAt(root)
    const projectId = initProject(root)
    const path = join(root, 'minutes.md')
    writeFileSync(path, SOURCE_TEXT, 'utf8')
    await b.exec('read', { file_path: path }, b.agentAt(root))
    expect(await registerSource(b, agent, projectId, path)).toBe('unverified')
  })

  it('D23 on the real pipeline: model-authored bytes written then read back stay unverified', async () => {
    const b = await boot()
    const root = workspace()
    const agent = b.agentAt(root)
    const projectId = initProject(root)
    const path = join(root, 'fabricated.md')
    await b.exec('write', { file_path: path, content: 'A quotation nobody ever published.\n' }, agent)
    await b.exec('read', { file_path: path }, agent)
    expect(await registerSource(b, agent, projectId, path)).toBe('unverified')
  })

  it('web_fetch body written byte-identically to a file upgrades that file to tool-event', async () => {
    const b = await boot()
    const root = workspace()
    const agent = b.agentAt(root)
    const projectId = initProject(root)
    const path = join(root, 'order.md')
    await b.exec('web_fetch', { url: 'https://archive.example/order' }, agent)
    await b.exec('write', { file_path: path, content: FETCHED_BODY }, agent)
    expect(await registerSource(b, agent, projectId, path)).toBe('tool-event')
  })

  it('bind-artifact reads the artifact bytes the session wrote to the workspace', async () => {
    const b = await boot()
    const root = workspace()
    const agent = b.agentAt(root)
    const projectId = initProject(root)
    const made = await b.exec('argument.update', {
      projectId, expectedRevision: 1, requestId: randomUUID(),
      input: {
        op: 'upsert', updates: [], deletes: [],
        creates: [{
          clientKey: 'c', type: 'claim',
          body: {
            text: 'The port closed in May.', kind: 'fact',
            scope: { subject: 'port', corpus: [], time: 'May', geography: 'unspecified', exclusions: [] },
            importance: 'core', stance: 'asserted', evaluationCriteria: [],
          },
        }],
      },
    }, agent)
    expect(made.ok).toBe(true)
    const claimId = (made.data as { changedIds: string[] }).changedIds[0]
    mkdirSync(join(root, 'docs'), { recursive: true })
    await b.exec('write', { file_path: join(root, 'docs', 'report.md'), content: '# Report\n\nThe port closed in May.\n' }, agent)
    const bound = await b.exec('argument.update', {
      projectId, expectedRevision: 2, requestId: randomUUID(),
      input: {
        op: 'bind-artifact', path: 'docs/report.md', outline: [],
        occurrences: [{ claimId, span: { start: 10, end: 32 }, exactText: 'The port closed in May' }],
      },
    }, agent)
    expect(bound, JSON.stringify(bound)).toMatchObject({ ok: true })
  })
})

describe('vwa-argument real mount: the delivery service resolves the CALLER\'s workspace (Appendix A)', () => {
  async function boundProject(b: Booted, agent: unknown, root: string, body: string): Promise<{ projectId: string; artifactId: string }> {
    const projectId = initProject(root)
    const made = await b.exec('argument.update', {
      projectId, expectedRevision: 1, requestId: randomUUID(),
      input: {
        op: 'upsert', updates: [], deletes: [],
        creates: [{
          clientKey: 'c', type: 'claim',
          body: {
            text: body, kind: 'fact',
            scope: { subject: 's', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
            importance: 'core', stance: 'asserted', evaluationCriteria: [],
          },
        }],
      },
    }, agent)
    const claimId = (made.data as { changedIds: string[] }).changedIds[0]
    await b.exec('write', { file_path: join(root, 'report.md'), content: `${body}\n` }, agent)
    const bound = await b.exec('argument.update', {
      projectId, expectedRevision: 2, requestId: randomUUID(),
      input: { op: 'bind-artifact', path: 'report.md', outline: [], occurrences: [{ claimId, span: { start: 0, end: body.length }, exactText: body }] },
    }, agent)
    expect(bound.ok, JSON.stringify(bound)).toBe(true)
    const head = new ProjectStore(root, projectId).readHead()
    if (!head.ok) throw new Error(head.message)
    return { projectId, artifactId: head.data.snapshot.artifacts[0]!.id }
  }

  it('two sessions in two workspaces each see their own bound artifacts, independent of process.cwd()', async () => {
    const b = await boot()
    const rootA = workspace()
    const rootB = workspace()
    expect(process.cwd()).not.toBe(rootA)
    const a = await boundProject(b, b.agentAt(rootA), rootA, 'Workspace A claim.')
    const bProject = await boundProject(b, b.agentAt(rootB), rootB, 'Workspace B claim.')
    const providerA = resolveDeliveryProvider(b.ctx, rootA)
    const providerB = resolveDeliveryProvider(b.ctx, rootB)
    expect(providerA?.listBoundArtifacts(a.projectId)).toEqual([{ artifactId: a.artifactId, path: 'report.md' }])
    expect(providerB?.listBoundArtifacts(bProject.projectId)).toEqual([{ artifactId: bProject.artifactId, path: 'report.md' }])
    // A project id never leaks across workspaces.
    expect(providerA?.listBoundArtifacts(bProject.projectId)).toEqual([])
    const frozen = await providerA!.checkForDelivery(a.projectId, a.artifactId)
    expect(frozen.check.artifactHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
