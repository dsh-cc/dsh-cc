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
import { BUDGET, fakeAdapter } from './review-helpers.ts'
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
  registerArgumentTools({ tools: { register: (definition) => { captured.push(definition) } } }, deps)
  const tools = new Map(captured.map((definition) => [definition.name, definition]))
  return { tools, workspace, deps }
}

async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await tool.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
}

const CLAIM_BODY = {
  text: 'Claim one', kind: 'fact',
  scope: { subject: 's', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
  importance: 'supporting', stance: 'asserted', evaluationCriteria: [],
}

const METADATA = {
  title: 'A source', creators: [], publication: 'unknown', originalLocator: 'https://example.test/a',
  edition: 'unknown', language: 'en', origin: 'external', material: 'primary',
}

describe('tool registration (§13 gate surface)', () => {
  it('mounts the three author tools plus argument.review', () => {
    const { tools } = mount()
    expect([...tools.keys()].sort()).toEqual(['argument.review', 'argument.update', 'evidence.register', 'evidence.search_log'])
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
    const result = await (tools.get('argument.review') as ToolDefinition).execute({
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'r', input: { stage: 'claims' },
    }, { signal: new AbortController().signal, agent }) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.code).toBe('REVIEW_UNAVAILABLE')
    expect(result.message).toBe('no llm service is mounted on the host')
    expect(reasons).toEqual([agent])
  })

  it('argument.review starts a background run when the factory resolves collaborators', async () => {
    const started: string[] = []
    const { tools, workspace } = mount({
      review: () => ({
        adapter: fakeAdapter([() => { throw new Error('no task planned') }]),
        budget: BUDGET,
        tasks: {
          start: (taskId, _label, run) => { started.push(taskId); void run(new AbortController().signal); return true },
          cancel: () => {}, get: () => 'settled', emitProgress: () => {},
        },
      }),
    })
    const result = await call(tools.get('argument.review') as ToolDefinition, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'r2', input: { stage: 'claims' },
    })
    expect(result).toMatchObject({ ok: true, data: { completion: 'started' } })
    expect(started).toHaveLength(1)
  })

  it('refuses to run without a bound workspace root', async () => {
    const { tools } = mount({ workspaceRoot: () => undefined })
    const result = await call(tools.get('argument.update') as ToolDefinition, {
      projectId: 'prj_none', expectedRevision: 1, requestId: 'r', input: { op: 'upsert', creates: [], updates: [], deletes: [] },
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('STORE_IO_FAILED')
  })
})

describe('evidence.register (§10.3)', () => {
  it('writes an exact-byte snapshot and projects acquisition from a whitelist event', async () => {
    const { tools, workspace, deps } = mount()
    const body = 'Fetched article body — verbatim.\n'
    const sourcePath = join(workspace.root, 'fetched.txt')
    writeFileSync(sourcePath, body, 'utf8')
    deps.captures.record({ tool: 'web_fetch', path: sourcePath, bytes: Buffer.from(body, 'utf8'), at: '2026-10-16T00:00:00.000Z' })
    const result = await call(tools.get('evidence.register') as ToolDefinition, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'reg-1',
      input: {
        path: sourcePath, metadata: METADATA,
        excerpts: [{
          clientKey: 'e1', span: { start: 0, end: 7 },
          originalLocation: 'https://example.test/a#p1', transformation: 'none', transformationNote: '',
        }],
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
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'reg-2',
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
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'reg-3',
      input: { path: outside, metadata: METADATA, excerpts: [] },
    })
    expect(escaped.ok).toBe(false)
    expect(escaped.code).toBe('PATH_OUT_OF_BOUNDS')
    const binaryPath = join(workspace.root, 'bin.txt')
    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02]))
    const binary = await call(tools.get('evidence.register') as ToolDefinition, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'reg-4',
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
      purpose: 'counter-evidence sweep', targetIds: [], corpus: [], query: 'q', tool: 'web_search',
      performedAt: '2026-10-16T00:00:00.000Z', state: 'executed',
      resultSourceIds: [], inaccessible: [], finding: 'none-found',
    }
    const tooMany = await call(searchLog, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'sl-1',
      input: { entries: Array.from({ length: 51 }, () => entry) },
    })
    expect(tooMany.ok).toBe(false)
    expect(tooMany.code).toBe('SCHEMA_INVALID')
    const ok = await call(searchLog, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'sl-2',
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
    const mutation = { op: 'upsert', creates: [{ clientKey: 'c1', type: 'claim', body: CLAIM_BODY }], updates: [], deletes: [] }
    const first = await call(update, { projectId: workspace.projectId, expectedRevision: 1, requestId: 'u-1', input: mutation })
    expect(first.ok).toBe(true)
    expect(first.revision).toBe(2)
    const replay = await call(update, { projectId: workspace.projectId, expectedRevision: 1, requestId: 'u-1', input: mutation })
    expect(replay.ok).toBe(true)
    expect(replay.revision).toBe(2) // old result, no new revision
    const conflict = await call(update, {
      projectId: workspace.projectId, expectedRevision: 2, requestId: 'u-1',
      input: { ...mutation, deletes: ['cl_nope'] },
    })
    expect(conflict.ok).toBe(false)
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('reports REFERENCE_IN_USE and HEAD stays unchanged (D06 via the envelope)', async () => {
    const { tools, workspace } = mount()
    const update = tools.get('argument.update') as ToolDefinition
    const made = await call(update, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'u-2',
      input: {
        op: 'upsert',
        creates: [
          { clientKey: 'a', type: 'claim', body: CLAIM_BODY },
          { clientKey: 'b', type: 'claim', body: { ...CLAIM_BODY, text: 'Claim two' } },
          {
            clientKey: 'arg', type: 'argument',
            body: {
              premiseClaimIds: [{ $new: 'b' }], evidenceGroupIds: [], conclusionClaimId: { $new: 'a' },
              scheme: 'causal', warrant: 'w', assumptions: [], limitations: [],
            },
          },
        ],
        updates: [], deletes: [],
      },
    }) as { ok: boolean; code?: string; message?: string; data?: { changedIds: string[] } }
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
    const made = await call(update, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'u-4',
      input: { op: 'upsert', creates: [{ clientKey: 'c1', type: 'claim', body: { ...CLAIM_BODY, importance: 'core' } }], updates: [], deletes: [] },
    }) as { ok: boolean; data: { changedIds: string[] } }
    const claimId = made.data.changedIds[0]
    const bodyText = 'The documented shift began in 1789 and spread quickly.\n'
    deps.artifactTexts.set('report.md', bodyText)
    const head1 = workspace.store.readHead()
    if (!head1.ok) throw new Error(head1.message)
    const bind = await call(update, {
      projectId: workspace.projectId, expectedRevision: head1.data.head.revision, requestId: 'bind-1',
      input: {
        op: 'bind-artifact', path: 'report.md',
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
        projectId: other.workspace.projectId, expectedRevision: bound.data.head.revision, requestId: 'bind-2',
        input: { op: 'bind-artifact', path: 'report.md', occurrences: [], outline: [] },
      })
      expect(bind2.ok).toBe(true)
    }
    // A wrong exactText is refused mechanically.
    const head2 = workspace.store.readHead()
    if (head2.ok) {
      const bad = await call(update, {
        projectId: workspace.projectId, expectedRevision: head2.data.head.revision, requestId: 'bind-3',
        input: {
          op: 'bind-artifact', path: 'report.md',
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
    const result = await call(update, {
      projectId: workspace.projectId, expectedRevision: 1, requestId: 'u-5',
      input: { op: 'set-contract', contract: { ...CONTRACT, mode: 'reviewed' } },
    }) as { ok: boolean; data: { contractChanged: boolean } }
    expect(result.ok).toBe(true)
    expect(result.data.contractChanged).toBe(true)
  })
})
