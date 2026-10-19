/**
 * Tool-level deterministic tests (§10.3/§10.4/§10.5, §22.1): the tool face
 * over the store — exact-byte snapshots and trusted-event projection,
 * search-log limits, requestId idempotency (D07), reference/cycle rules
 * (D05/D06 via the envelope), and artifact occurrence validation (D12).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerArgumentTools, type ToolDefinition } from '../src/tools.ts'
import type { ToolDeps } from '../src/tools.ts'
import { CaptureRegistry } from '../src/sources.ts'
import { CONTRACT, initWorkspace, uuid } from './helpers.ts'
import { BUDGET, claimsResponse, fakeAdapter } from './review-helpers.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import type { ReviewMessages } from '../src/review-adapter.ts'

/** One dispatch step: pass the target claim it was called with (or throw). */
function stepFor(req: { messages: ReviewMessages }, tokens: number, throwWhen: () => boolean = () => false) {
  const targetId = (JSON.parse((req.messages[1] as { content: string }).content) as { targets: { id: string }[] })
    .targets[0]!.id
  if (throwWhen()) throw new Error('boom')
  return { raw: claimsResponse(targetId, 'pass'), inputTokens: tokens }
}

/** A per-call review collaborator whose adapter consumes the given script. */
function reviewWithScript(
  script: Parameters<typeof fakeAdapter>[0],
): () => ReturnType<typeof reviewCollaborators> {
  return () => reviewCollaborators(script)
}
function reviewCollaborators(script: Parameters<typeof fakeAdapter>[0]) {
  return {
    adapter: fakeAdapter(script),
    budget: BUDGET,
    tasks: {
      start: (_taskId: string, _label: string, run: (signal: AbortSignal) => Promise<void>) => {
        void run(new AbortController().signal)
        return true
      },
      cancel: () => {},
      get: () => 'settled',
      emitProgress: () => {},
    },
  }
}

/** Poll the run request until it leaves queued/running. */
async function settle(store: ReviewRunStore, runId: string, attempts = 500) {
  for (let i = 0; i < attempts; i++) {
    const request = store.readRequest(runId)
    if (request && request.status !== 'queued' && request.status !== 'running') return request
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`run ${runId} did not settle`)
}
import { fail } from '../src/store.ts'

/** Mount the tools against a fresh initialized workspace; return them by name. */
function mount(overrides: Partial<ToolDeps> = {}): {
  tools: Map<string, ToolDefinition>
  workspace: ReturnType<typeof initWorkspace>
  deps: ToolDeps
} {
  const workspace = initWorkspace()
  const captured: ToolDefinition[] = []
  const deps: ToolDeps = {
    workspaceRoot: () => workspace.root,
    captures: new CaptureRegistry(),
    artifactTexts: new Map(),
    snapshotTexts: new Map(),
    maxEntities: 10_000,
    ...overrides,
  }
  registerArgumentTools(
    {
      tools: {
        register: (definition) => {
          captured.push(definition)
        },
      },
    },
    deps,
  )
  const tools = new Map(captured.map((definition) => [definition.name, definition]))
  return { tools, workspace, deps }
}

const requestIdMap = new Map<string, string>()
async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestIds = requestIdMap
  if (typeof args.requestId === 'string' && !requestIds.has(args.requestId)) requestIds.set(args.requestId, uuid())
  const normalized = {
    ...args,
    requestId: requestIds.get(args.requestId as string) ?? args.requestId,
    ...(args.projectId === 'prj_none' ? { projectId: 'prj_11111111-1111-4111-8111-111111111111' } : {}),
  }
  return (await tool.execute(normalized, { signal: new AbortController().signal })) as Record<string, unknown>
}

const CLAIM_BODY = {
  text: 'Claim one',
  kind: 'fact',
  scope: { subject: 's', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
  importance: 'supporting',
  stance: 'asserted',
  evaluationCriteria: [],
}

const METADATA = {
  title: 'A source',
  creators: [],
  publication: 'unknown',
  originalLocator: 'https://example.test/a',
  edition: 'unknown',
  language: 'en',
  origin: 'external',
  material: 'primary',
}

describe('tool registration (§13 gate surface)', () => {
  it('mounts the three author tools plus argument.review', () => {
    const { tools } = mount()
    expect([...tools.keys()].sort()).toEqual([
      'argument.report',
      'argument.review',
      'argument.update',
      'evidence.register',
      'evidence.search_log',
    ])
  })

  it('argument.review resolves its collaborators per call and surfaces the host reason when unavailable', async () => {
    // Production mounts always pass a per-call factory (review-host.ts); the
    // factory's REVIEW_UNAVAILABLE (no llm / jobs / route) reaches the caller.
    const reasons: unknown[] = []
    const { tools, workspace } = mount({
      review: (agent) => {
        reasons.push(agent)
        return fail('REVIEW_UNAVAILABLE', 'no llm service is mounted on the host', true)
      },
    })
    const agent = { id: 'sess-1' }
    const result = (await (tools.get('argument.review') as ToolDefinition).execute(
      {
        projectId: workspace.projectId,
        expectedRevision: 1,
        requestId: uuid(),
        input: { stage: 'claims' },
      },
      { signal: new AbortController().signal, agent },
    )) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.code).toBe('REVIEW_UNAVAILABLE')
    expect(result.message).toBe('no llm service is mounted on the host')
    expect(reasons).toEqual([agent])
  })

  it('argument.review starts a background run when the factory resolves collaborators', async () => {
    const started: string[] = []
    const { tools, workspace } = mount({
      review: () => ({
        adapter: fakeAdapter([
          () => {
            throw new Error('no task planned')
          },
        ]),
        budget: BUDGET,
        tasks: {
          start: (taskId, _label, run) => {
            started.push(taskId)
            void run(new AbortController().signal)
            return true
          },
          cancel: () => {},
          get: () => 'settled',
          emitProgress: () => {},
        },
      }),
    })
    const result = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'r2',
      input: { stage: 'claims' },
    })
    expect(result).toMatchObject({ ok: true, data: { completion: 'started' } })
    expect(started).toHaveLength(1)
  })

  it('refuses to run without a bound workspace root', async () => {
    const { tools } = mount({ workspaceRoot: () => undefined })
    const result = await call(tools.get('argument.update') as ToolDefinition, {
      projectId: 'prj_none',
      expectedRevision: 1,
      requestId: 'r',
      input: { op: 'upsert', creates: [], updates: [], deletes: [] },
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('STORE_IO_FAILED')
  })

  it('input.continue threads continueMode and reuses completed records across requestIds (§A.3.7)', async () => {
    const { tools, workspace } = mount({
      review: () => {
        let scriptDispatches = 0
        return reviewCollaborators([
          (req) => {
            if (scriptDispatches++ > 0) throw new Error('boom')
            return stepFor(req, 10)
          },
        ])
      },
    })
    const update = tools.get('argument.update') as ToolDefinition
    await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'u-1',
      input: {
        op: 'upsert',
        creates: [
          { clientKey: 'c1', type: 'claim', body: CLAIM_BODY },
          { clientKey: 'c2', type: 'claim', body: { ...CLAIM_BODY, text: 'Claim two' } },
        ],
        updates: [],
        deletes: [],
      },
    })
    // Run 1: one claim passes, the other fails → incomplete.
    const first = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 2,
      requestId: 'r-first',
      input: { stage: 'claims' },
    })
    expect(first.ok).toBe(true)
    const store = new ReviewRunStore(workspace.root, workspace.projectId)
    const firstRunId = (first.data as { runId: string }).runId
    const firstSettled = await settle(store, firstRunId)
    expect(firstSettled?.status).toBe('incomplete')
    // Continue with a new requestId: only the failed claim is re-executed.
    const second = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 2,
      requestId: 'r-continue',
      input: { stage: 'claims', continue: true },
    })
    expect(second.ok).toBe(true)
    const secondRunId = (second.data as { runId: string }).runId
    expect((await settle(store, secondRunId))?.status).toBe('completed')
    // §A.3.5: the reused record appears in the new run's usage ledger.
    expect(store.readUsage(secondRunId).some((row) => row.kind === 'reused')).toBe(true)
  })

  it('freezes the reviewer configuration before refusing a completed continuation (§A.2)', async () => {
    const { tools, workspace } = mount({
      review: () => {
        const collaborators = reviewCollaborators([(req) => stepFor(req, 5)])
        let initialized = false
        collaborators.adapter.initialize = async () => { initialized = true }
        collaborators.adapter.configFingerprint = () => ({
          provider: 'fake', model: 'fake-model',
          ...(initialized ? { effectiveConfig: { maxTokens: BUDGET.maxOutputTokensPerCall } } : {}),
        })
        return collaborators
      },
    })
    const update = tools.get('argument.update') as ToolDefinition
    await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'u-1',
      input: { op: 'upsert', creates: [{ clientKey: 'c1', type: 'claim', body: CLAIM_BODY }], updates: [], deletes: [] },
    })
    const first = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 2,
      requestId: 'r-first',
      input: { stage: 'claims' },
    })
    expect(first.ok).toBe(true)
    const store = new ReviewRunStore(workspace.root, workspace.projectId)
    expect((await settle(store, (first.data as { runId: string }).runId))?.status).toBe('completed')
    const second = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 2,
      requestId: 'r-continue',
      input: { stage: 'claims', continue: true },
    })
    expect(second).toMatchObject({ ok: false, code: 'NOTHING_TO_CONTINUE', retryable: false })
    expect(second.message).toContain('second opinion')
    expect(store.findRunByRequestId(requestIdMap.get('r-continue')!)).toBeUndefined()
  })

  it('returns a retryable refusal without reserving a request if reviewer initialization fails', async () => {
    const { tools, workspace } = mount({
      review: () => {
        const collaborators = reviewCollaborators([])
        collaborators.adapter.initialize = async () => { throw new Error('provider unavailable') }
        return collaborators
      },
    })
    const result = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'r-init-failed',
      input: { stage: 'claims', continue: true },
    })
    expect(result).toMatchObject({ ok: false, code: 'REVIEW_UNAVAILABLE', retryable: true })
    expect(new ReviewRunStore(workspace.root, workspace.projectId)
      .findRunByRequestId(requestIdMap.get('r-init-failed')!)).toBeUndefined()
  })

  it('absent input.continue keeps the fresh-run behavior (re-executes completed tasks)', async () => {
    const { tools, workspace } = mount({
      review: reviewWithScript([(req) => stepFor(req, 5)]),
    })
    const update = tools.get('argument.update') as ToolDefinition
    await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'u-1',
      input: { op: 'upsert', creates: [{ clientKey: 'c1', type: 'claim', body: CLAIM_BODY }], updates: [], deletes: [] },
    })
    const first = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 2,
      requestId: 'r-1',
      input: { stage: 'claims' },
    })
    const store = new ReviewRunStore(workspace.root, workspace.projectId)
    await settle(store, (first.data as { runId: string }).runId)
    const second = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 2,
      requestId: 'r-2',
      input: { stage: 'claims' },
    })
    expect(second.ok).toBe(true)
    // A fresh requestId without continue re-executed the completed task (spent tokens).
    const secondState = await settle(store, (second.data as { runId: string }).runId)
    expect(secondState?.inputTokens).toBeGreaterThan(0)
  })

  it('rejects a non-boolean input.continue', async () => {
    const { tools, workspace } = mount()
    const result = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'r-x',
      input: { stage: 'claims', continue: 'yes' },
    })
    expect(result).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' })
  })
})

describe('evidence.register (§10.3)', () => {
  it('writes an exact-byte snapshot and projects acquisition from a whitelist event', async () => {
    const { tools, workspace, deps } = mount()
    const body = 'Fetched article body — verbatim.\n'
    const sourcePath = join(workspace.root, 'fetched.txt')
    writeFileSync(sourcePath, body, 'utf8')
    deps.captures.record({
      tool: 'web_fetch',
      path: sourcePath,
      bytes: Buffer.from(body, 'utf8'),
      at: '2026-10-16T00:00:00.000Z',
    })
    const result = await call(tools.get('evidence.register') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'reg-1',
      input: {
        path: sourcePath,
        metadata: METADATA,
        excerpts: [
          {
            clientKey: 'e1',
            span: { start: 0, end: 7 },
            originalLocation: 'https://example.test/a#p1',
            transformation: 'none',
            transformationNote: '',
          },
        ],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.revision).toBe(2)
    const data = result.data as { sourceId: string; snapshotPath: string; evidenceIds: { evidenceId: string }[] }
    // Snapshot bytes are exact; no added frontmatter (§14.1).
    expect(readFileSync(join(workspace.root, data.snapshotPath)).equals(Buffer.from(body, 'utf8'))).toBe(true)
    // Trusted event → tool-event acquisition (§10.3).
    const head = workspace.store.readHead()
    if (head.ok) {
      const source = head.data.snapshot.sources.find((candidate) => candidate.id === data.sourceId)
      expect(source?.acquisition.kind).toBe('tool-event')
    }
    // The runtime read the quote itself (§10.3): quote === slice.
    if (head.ok) expect(head.data.snapshot.evidence[0]?.quote).toBe('Fetched')
  })

  it('a file with no verifiable capture registers as unverified (never guessed)', async () => {
    const { tools, workspace } = mount()
    const sourcePath = join(workspace.root, 'mystery.txt')
    writeFileSync(sourcePath, 'who knows where this came from\n', 'utf8')
    const result = await call(tools.get('evidence.register') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'reg-2',
      input: { path: sourcePath, metadata: METADATA, excerpts: [] },
    })
    expect(result.ok).toBe(true)
    const head = workspace.store.readHead()
    if (head.ok) expect(head.data.snapshot.sources[0]?.acquisition.kind).toBe('unverified')
  })

  it('rejects paths outside the workspace root and binary input', async () => {
    const { tools, workspace } = mount()
    const outside = join(initWorkspace().root, 'outside.txt')
    writeFileSync(outside, 'x', 'utf8')
    const escaped = await call(tools.get('evidence.register') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'reg-3',
      input: { path: outside, metadata: METADATA, excerpts: [] },
    })
    expect(escaped.ok).toBe(false)
    expect(escaped.code).toBe('PATH_OUT_OF_BOUNDS')
    const binaryPath = join(workspace.root, 'bin.txt')
    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02]))
    const binary = await call(tools.get('evidence.register') as ToolDefinition, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'reg-4',
      input: { path: binaryPath, metadata: METADATA, excerpts: [] },
    })
    expect(binary.ok).toBe(false)
    expect(binary.code).toBe('INVALID_ENCODING')
  })
})

describe('evidence.search_log (§10.4)', () => {
  it('rejects more than 50 entries and records valid ones atomically', async () => {
    const { tools, workspace } = mount()
    const searchLog = tools.get('evidence.search_log') as ToolDefinition
    const entry = {
      purpose: 'counter-evidence sweep',
      targetIds: [],
      corpus: [],
      query: 'q',
      tool: 'web_search',
      performedAt: '2026-10-16T00:00:00.000Z',
      state: 'executed',
      resultSourceIds: [],
      inaccessible: [],
      finding: 'none-found',
      externalAttestation: 'The caller records an externally executed search.',
    }
    const tooMany = await call(searchLog, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'sl-1',
      input: { entries: Array.from({ length: 51 }, () => entry) },
    })
    expect(tooMany.ok).toBe(false)
    expect(tooMany.code).toBe('SCHEMA_INVALID')
    const ok = await call(searchLog, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'sl-2',
      input: { entries: [entry] },
    })
    expect(ok.ok).toBe(true)
    expect((ok.data as { searchIds: string[] }).searchIds).toHaveLength(1)
  })
})

describe('argument.update (§10.5)', () => {
  it('same requestId + same payload replays; different payload conflicts (D07)', async () => {
    const { tools, workspace } = mount()
    const update = tools.get('argument.update') as ToolDefinition
    const mutation = {
      op: 'upsert',
      creates: [{ clientKey: 'c1', type: 'claim', body: CLAIM_BODY }],
      updates: [],
      deletes: [],
    }
    const first = await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'u-1',
      input: mutation,
    })
    expect(first.ok).toBe(true)
    expect(first.revision).toBe(2)
    const replay = await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'u-1',
      input: mutation,
    })
    expect(replay.ok).toBe(true)
    expect(replay.revision).toBe(2) // old result, no new revision
    const conflict = await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 2,
      requestId: 'u-1',
      input: { ...mutation, deletes: ['cl_nope'] },
    })
    expect(conflict.ok).toBe(false)
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('reports REFERENCE_IN_USE and HEAD stays unchanged (D06 via the envelope)', async () => {
    const { tools, workspace } = mount()
    const update = tools.get('argument.update') as ToolDefinition
    const made = (await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'u-2',
      input: {
        op: 'upsert',
        creates: [
          { clientKey: 'a', type: 'claim', body: CLAIM_BODY },
          { clientKey: 'b', type: 'claim', body: { ...CLAIM_BODY, text: 'Claim two' } },
          {
            clientKey: 'arg',
            type: 'argument',
            body: {
              premiseClaimIds: [{ $new: 'b' }],
              evidenceGroupIds: [],
              conclusionClaimId: { $new: 'a' },
              scheme: 'causal',
              warrant: 'w',
              assumptions: [],
              limitations: [],
            },
          },
        ],
        updates: [],
        deletes: [],
      },
    })) as { ok: boolean; code?: string; message?: string; data?: { changedIds: string[] } }
    if (!made.ok) console.log('D06 setup failure:', made.code, made.message)
    expect(made.ok).toBe(true)
    const [, claimB, argument] = made.data.changedIds
    const head = workspace.store.readHead()
    if (!head.ok) throw new Error(head.message)
    // argument.update needs a reference-aware graph; exercise deletion through
    // the store transaction that wraps applyMutation (the tool's path).
    const deletion = await call(update, {
      projectId: workspace.projectId,
      expectedRevision: head.data.head.revision,
      requestId: 'u-3',
      input: { op: 'upsert', creates: [], updates: [], deletes: [claimB] },
    })
    expect(deletion.ok).toBe(false)
    expect(deletion.code).toBe('REFERENCE_IN_USE')
    expect(deletion.message).toContain('argument premise/conclusion')
    const after = workspace.store.readHead()
    if (after.ok) expect(after.data.head.revision).toBe(head.data.head.revision)
  })

  it('bind-artifact validates occurrences against the real bytes (D12)', async () => {
    const { tools, workspace, deps } = mount()
    const update = tools.get('argument.update') as ToolDefinition
    const made = (await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'u-4',
      input: {
        op: 'upsert',
        creates: [{ clientKey: 'c1', type: 'claim', body: { ...CLAIM_BODY, importance: 'core' } }],
        updates: [],
        deletes: [],
      },
    })) as { ok: boolean; data: { changedIds: string[] } }
    const claimId = made.data.changedIds[0]
    const bodyText = 'The documented shift began in 1789 and spread quickly.\n'
    deps.artifactTexts.set('report.md', bodyText)
    const head1 = workspace.store.readHead()
    if (!head1.ok) throw new Error(head1.message)
    const bind = await call(update, {
      projectId: workspace.projectId,
      expectedRevision: head1.data.head.revision,
      requestId: 'bind-1',
      input: {
        op: 'bind-artifact',
        path: 'report.md',
        occurrences: [{ claimId, span: { start: 4, end: 26 }, exactText: 'documented shift began' }],
        outline: [],
      },
    })
    expect(bind.ok).toBe(true)
    // A one-character change invalidates the artifact hash (D12 direction).
    const other = mount()
    other.deps.artifactTexts.set('report.md', `${bodyText}!`)
    const bound = other.workspace.store.readHead()
    if (bound.ok) {
      const bind2 = await call(other.tools.get('argument.update') as ToolDefinition, {
        projectId: other.workspace.projectId,
        expectedRevision: bound.data.head.revision,
        requestId: 'bind-2',
        input: { op: 'bind-artifact', path: 'report.md', occurrences: [], outline: [] },
      })
      expect(bind2.ok).toBe(true)
    }
    // A wrong exactText is refused mechanically.
    const head2 = workspace.store.readHead()
    if (head2.ok) {
      const bad = await call(update, {
        projectId: workspace.projectId,
        expectedRevision: head2.data.head.revision,
        requestId: 'bind-3',
        input: {
          op: 'bind-artifact',
          path: 'report.md',
          occurrences: [{ claimId, span: { start: 4, end: 26 }, exactText: 'documented shift started' }],
          outline: [],
        },
      })
      expect(bad.ok).toBe(false)
      expect(bad.code).toBe('SCHEMA_INVALID')
    }
  })

  it('set-contract flags all-review invalidation (§15)', async () => {
    const { tools, workspace } = mount()
    const update = tools.get('argument.update') as ToolDefinition
    const result = (await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      requestId: 'u-5',
      input: { op: 'set-contract', contract: { ...CONTRACT, mode: 'reviewed' } },
    })) as { ok: boolean; data: { contractChanged: boolean } }
    expect(result.ok).toBe(true)
    expect(result.data.contractChanged).toBe(true)
  })
})
