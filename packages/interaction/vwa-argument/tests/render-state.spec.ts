/**
 * §7.2/§7.3 plus §13: the three crash series for draft-backed artifacts and
 * the legacy two-state — classified through VwaArgumentService.checkForDelivery
 * (the SAME code path report generation uses) and folded by the report tool
 * (STALE_RENDER carried through, never collapsed to INPUT_CHANGED).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GraphContext, applyMutation, type Mutation } from '../src/graph.ts'
import { ProjectStore, type Fail } from '../src/store.ts'
import { InputChangedError, VwaArgumentService } from '../src/report.ts'
import { reportTool } from '../src/report-tool.ts'
import { CaptureRegistry } from '../src/sources.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { stripMarkers } from '../src/render.ts'
import { readRenderIntents } from '../src/render-state.ts'
import { initWorkspace, uuid } from './helpers.ts'
import type { ToolDefinition } from '../src/tools.ts'

const D0 = '# Report\n\nThe shift began in 1789 and spread〔src:ws:docs/a.md#L1-L1〕.\n'
const D1 = '# Report\n\nThe shift began in 1790 and spread〔src:ws:docs/a.md#L1-L1〕.\n'
const R0 = stripMarkers(D0).text
const R1 = stripMarkers(D1).text
const FOREIGN = 'hand-edited foreign bytes\n'

function seedDraft(root: string, projectId: string, text: string): void {
  const drafts = join(root, '.dsh', 'vwa', projectId, 'drafts')
  mkdirSync(drafts, { recursive: true })
  writeFileSync(join(drafts, 'main.md'), text)
}

/**
 * Commit one draft bind (docs/article.md ← the current draft) and return the
 * project's HEAD revision afterwards. Shared base for every crash state.
 */
function bindDraft(root: string, projectId: string, store: ProjectStore): number {
  const head = store.readHead()
  if (!head.ok) throw new Error(head.message)
  const requestId = uuid()
  const staged: import('../src/store.ts').StagedFile[] = []
  const result = store.withTransaction<unknown>({
    expectedRevision: head.data.head.revision,
    requestId,
    payloadHash: uuid(),
    applyFn: (snapshot) => {
      const graph = new GraphContext(snapshot, 10_000)
      applyMutation(graph, {
        op: 'bind-artifact', mode: 'draft', path: 'docs/article.md',
        occurrences: [], outline: [], draftPath: `.dsh/vwa/${projectId}/drafts/main.md`,
      }, { root, requestId, staged })
      return { result: null, files: staged }
    },
  })
  if (!result.ok) throw new Error(`bind failed: ${result.message}`)
  const after = store.readHead()
  if (!after.ok) throw new Error(after.message)
  return after.data.head.revision
}

function seedIntent(root: string, projectId: string, intent: Record<string, unknown>): void {
  const renders = join(root, '.dsh', 'vwa', projectId, 'renders')
  mkdirSync(renders, { recursive: true })
  writeFileSync(join(renders, `${uuid()}.json`), stableJson({
    requestId: uuid(), projectId, draftPath: `.dsh/vwa/${projectId}/drafts/main.md`,
    ...intent,
  }))
}

function fixture(): { root: string; projectId: string; artifactId: string } {
  const made = initWorkspace()
  mkdirSync(join(made.root, 'docs'), { recursive: true })
  seedDraft(made.root, made.projectId, D0)
  bindDraft(made.root, made.projectId, made.store)
  const head = made.store.readHead()
  if (!head.ok) throw new Error(head.message)
  return { root: made.root, projectId: made.projectId, artifactId: head.data.snapshot.artifacts[0]!.id }
}

type Classified = 'current' | 'STALE_RENDER' | 'INPUT_CHANGED'

/** The §7.2 verdict of one disk state, surfaced through the service. */
async function verdict(root: string, projectId: string, artifactId: string): Promise<Classified> {
  const service = new VwaArgumentService({ root })
  try {
    await service.checkForDelivery(projectId, artifactId)
    return 'current'
  } catch (error: unknown) {
    if (error instanceof InputChangedError) return error.code
    throw error
  }
}

describe('§7.2 three-state crash classification (draft-backed artifacts)', () => {
  it('series 1: bytes == contentHash ⇒ current, even with a stray intent present', async () => {
    const { root, projectId, artifactId } = fixture()
    seedIntent(root, projectId, { draftHash: sha256Hex('x'), renderedHash: sha256Hex(FOREIGN), target: 'docs/article.md', at: new Date().toISOString() })
    expect(await verdict(root, projectId, artifactId)).toBe('current')
  })

  it('series 2a: a roll-forward crash (deliverable = render of the CURRENT draft) ⇒ STALE_RENDER', async () => {
    const { root, projectId, artifactId } = fixture()
    // bind adopted R0 for D0; a later bind staged R1 + intent, crashed pre-HEAD.
    seedDraft(root, projectId, D1)
    writeFileSync(join(root, 'docs', 'article.md'), R1)
    expect(await verdict(root, projectId, artifactId)).toBe('STALE_RENDER')
  })

  it('series 2b: the draft moved on after the crash — the unadopted intent rescues the state ⇒ STALE_RENDER', async () => {
    const { root, projectId, artifactId } = fixture()
    seedDraft(root, projectId, D1) // draft moved on; strip(D1) ≠ bytes below
    const staleBytes = 'bytes of an older unadopted render\n'
    writeFileSync(join(root, 'docs', 'article.md'), staleBytes)
    seedIntent(root, projectId, {
      draftHash: sha256Hex(D0),
      renderedHash: sha256Hex(staleBytes),
      target: 'docs/article.md',
      at: new Date().toISOString(),
    })
    expect(await verdict(root, projectId, artifactId)).toBe('STALE_RENDER')
  })

  it('series 3: foreign bytes, no matching render or intent ⇒ INPUT_CHANGED', async () => {
    const { root, projectId, artifactId } = fixture()
    seedDraft(root, projectId, D1)
    writeFileSync(join(root, 'docs', 'article.md'), FOREIGN)
    expect(await verdict(root, projectId, artifactId)).toBe('INPUT_CHANGED')
  })

  it('a tampered/malformed intent is inert (classification falls through to INPUT_CHANGED)', async () => {
    const { root, projectId, artifactId } = fixture()
    const renders = join(root, '.dsh', 'vwa', projectId, 'renders')
    mkdirSync(renders, { recursive: true })
    writeFileSync(join(renders, `${uuid()}.json`), '{ not json')
    writeFileSync(join(renders, `${uuid()}.json`), stableJson({ target: 'docs/article.md' })) // shape-tampered
    writeFileSync(join(root, 'docs', 'article.md'), FOREIGN)
    expect(readRenderIntents(root, projectId)).toEqual([])
    expect(await verdict(root, projectId, artifactId)).toBe('INPUT_CHANGED')
  })

  it('a deleted draft with current bytes is drift, not a stale render', async () => {
    const { root, projectId, artifactId } = fixture()
    const { rmSync } = await import('node:fs')
    rmSync(join(root, '.dsh', 'vwa', projectId, 'drafts', 'main.md'))
    const service = new VwaArgumentService({ root })
    await expect(service.checkForDelivery(projectId, artifactId)).rejects.toMatchObject({
      code: 'INPUT_CHANGED',
      message: expect.stringContaining('draft text for') as unknown as string,
    })
  })
})

describe('§7.2 legacy two-state (no draft field)', () => {
  async function legacyFixture(): Promise<{ root: string; projectId: string; artifactId: string; text: string }> {
    const made = initWorkspace()
    mkdirSync(join(made.root, 'docs'), { recursive: true })
    const text = 'The legacy inline body.\n'
    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const graphResult = made.store.withTransaction<unknown>({
      expectedRevision: head.data.head.revision, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => {
        const graph = new GraphContext(snapshot, 10_000)
        graph.artifactTexts.set('docs/article.md', text)
        applyMutation(graph, {
          op: 'bind-artifact', mode: 'inline', path: 'docs/article.md', occurrences: [], outline: [],
        })
        return { result: null }
      },
    })
    if (!graphResult.ok) throw new Error(graphResult.message)
    writeFileSync(join(made.root, 'docs', 'article.md'), text)
    const after = made.store.readHead()
    if (!after.ok) throw new Error(after.message)
    return { root: made.root, projectId: made.projectId, artifactId: after.data.snapshot.artifacts[0]!.id, text }
  }

  it('bytes changed ⇒ INPUT_CHANGED — there is no middle state for legacy inline', async () => {
    const { root, projectId, artifactId } = await legacyFixture()
    writeFileSync(join(root, 'docs', 'article.md'), FOREIGN)
    expect(await verdict(root, projectId, artifactId)).toBe('INPUT_CHANGED')
  })

  it('an intent record does not promote a legacy artifact into the stale class', async () => {
    const { root, projectId, artifactId } = await legacyFixture()
    writeFileSync(join(root, 'docs', 'article.md'), FOREIGN)
    seedIntent(root, projectId, { draftHash: sha256Hex('x'), renderedHash: sha256Hex(FOREIGN), target: 'docs/article.md', at: new Date().toISOString() })
    expect((await verdict(root, projectId, artifactId)) === 'STALE_RENDER').toBe(false)
  })
})

describe('report tool classification pass-through (§7.3)', () => {
  async function reportWith(f: { root: string; projectId: string; artifactId: string }): Promise<Record<string, unknown>> {
    const tool: ToolDefinition = reportTool({
      workspaceRoot: () => f.root,
      captures: new CaptureRegistry(),
      artifactTexts: new Map(),
      snapshotTexts: new Map(),
      maxEntities: 10_000,
    })
    return (await tool.execute(
      { projectId: f.projectId, artifactId: f.artifactId, format: 'markdown', write: false },
      { signal: new AbortController().signal },
    )) as unknown as Record<string, unknown>
  }

  it('STALE_RENDER is carried through, not collapsed into INPUT_CHANGED', async () => {
    const { root, projectId, artifactId } = fixture()
    seedDraft(root, projectId, D1)
    writeFileSync(join(root, 'docs', 'article.md'), R1)
    const result = await reportWith({ root, projectId, artifactId })
    expect(result.ok).toBe(false)
    expect((result as unknown as Fail).code).toBe('STALE_RENDER')
    expect((result as unknown as Fail).retryable).toBe(true)
  })
})
