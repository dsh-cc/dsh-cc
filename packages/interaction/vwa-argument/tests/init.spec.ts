/**
 * Feature 1 (§2) `argument.init` specs: durable idempotency windows
 * (pre/post reservation, post-init recovery, concurrent `wx` conflict),
 * payload mismatch, pointer semantics, and the issue-#312 workspaceIdentity
 * divergence guard.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerArgumentTools, type ToolDefinition, type ToolDeps } from '../src/tools.ts'
import { CaptureRegistry } from '../src/sources.ts'
import { ProjectStore } from '../src/store.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import { DEFAULT_VWA_ARGUMENT_SETTINGS } from '../src/settings.ts'
import { uuid } from './helpers.ts'

function mount(overrides: Partial<ToolDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vwa-init-'))
  const captured: ToolDefinition[] = []
  const deps: ToolDeps = {
    workspaceRoot: () => root,
    captures: new CaptureRegistry(),
    artifactTexts: new Map(),
    snapshotTexts: new Map(),
    maxEntities: 10_000,
    ...overrides,
  }
  registerArgumentTools({ tools: { register: (definition) => captured.push(definition) } }, deps)
  const tool = captured.find((definition) => definition.name === 'argument.init')
  if (tool === undefined) throw new Error('argument.init is not registered')
  const call = async (args: Record<string, unknown>) =>
    (await tool.execute(args, { signal: new AbortController().signal })) as Record<string, unknown>
  return { root, call }
}

const reservationPath = (root: string, requestId: string) => join(root, '.dsh', 'vwa', 'inits', `${requestId}.json`)
const pointerPath = (root: string) => join(root, '.dsh', 'vwa', 'current-project.json')
const projectIds = (root: string) =>
  readdirSync(join(root, '.dsh', 'vwa')).filter((entry) => entry.startsWith('prj_'))

/** Pre-write a reservation as if another caller had already won the `wx` race. */
function seedReservation(root: string, requestId: string, input: unknown) {
  const path = reservationPath(root, requestId)
  mkdirSync(join(root, '.dsh', 'vwa', 'inits'), { recursive: true })
  const reservation = {
    schemaVersion: 1,
    requestId,
    payloadHash: sha256Hex(stableJson(input)),
    projectId: `prj_${uuid()}`,
    ts: new Date().toISOString(),
  }
  writeFileSync(path, stableJson(reservation), 'utf8')
  return { path, reservation }
}

describe('argument.init happy path (§2.2/§2.3)', () => {
  it('creates the project, the /vwa-init disk layout, the reservation and the pointer', async () => {
    const { root, call } = mount()
    const requestId = uuid()
    const input = { mode: 'reviewed' }
    const result = await call({ requestId, input })
    expect(result.ok).toBe(true)
    expect(result.revision).toBe(1)
    expect(result.projectId).toMatch(/^prj_/)
    expect(result.data).toMatchObject({ workspaceIdentity: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const projectId = result.projectId as string
    for (const entry of ['HEAD.json', 'workspace.json', 'revisions', 'operations', 'locks']) {
      expect(existsSync(join(root, '.dsh', 'vwa', projectId, entry))).toBe(true)
    }
    expect(existsSync(join(root, 'docs', 'vwa-sources', projectId))).toBe(true)
    const reservation = JSON.parse(readFileSync(reservationPath(root, requestId), 'utf8')) as Record<string, unknown>
    expect(reservation).toMatchObject({
      schemaVersion: 1,
      requestId,
      payloadHash: sha256Hex(stableJson(input)),
      projectId,
    })
    const pointer = JSON.parse(readFileSync(pointerPath(root), 'utf8')) as Record<string, unknown>
    expect(pointer).toMatchObject({ projectId, workspaceIdentity: (result.data as { workspaceIdentity: string }).workspaceIdentity })
    const head = new ProjectStore(root, projectId).readHead()
    expect(head.ok).toBe(true)
    if (head.ok) expect(head.data.snapshot.contract.mode).toBe('reviewed')
  })

  it('applies reviewSettings onto the frozen baseline without flattening the patch', async () => {
    const { root, call } = mount({
      reviewSettings: () => freezeReviewSettings({ ...DEFAULT_VWA_ARGUMENT_SETTINGS, 'review-max-calls-per-run': 7 }),
    })
    const result = await call({
      requestId: uuid(),
      input: { reviewSettings: { budget: { maxOutputTokensPerCall: 1234 }, claimsBatchSize: 2 } },
    })
    expect(result.ok).toBe(true)
    const head = new ProjectStore(root, result.projectId as string).readHead()
    expect(head.ok).toBe(true)
    if (!head.ok) return
    const frozen = head.data.snapshot.contract.reviewSettings!
    expect(frozen.budget.maxOutputTokensPerCall).toBe(1234)
    expect(frozen.budget.maxCallsPerRun).toBe(7)
    expect(frozen.budget.maxOutputTokensPerRun).toBe(freezeReviewSettings().budget.maxOutputTokensPerRun)
    expect(frozen.claimsBatchSize).toBe(2)
  })
})

describe('argument.init idempotency (§2.4)', () => {
  it('replays the same requestId without creating a second project or rewriting the pointer', async () => {
    const { root, call } = mount()
    const requestId = uuid()
    const input = {}
    const first = await call({ requestId, input })
    expect(first.ok).toBe(true)
    // First result wins: a later writer must not be overwritten by a replay.
    writeFileSync(pointerPath(root), stableJson({ schemaVersion: 1, projectId: 'prj_sentinel', workspaceIdentity: 'x' }))
    const second = await call({ requestId, input })
    expect(second).toMatchObject({ ok: true, projectId: first.projectId, revision: 1, data: first.data })
    expect(projectIds(root)).toHaveLength(1)
    expect(JSON.parse(readFileSync(pointerPath(root), 'utf8'))).toMatchObject({ projectId: 'prj_sentinel' })
    const head = new ProjectStore(root, first.projectId as string).readHead()
    expect(head.ok && head.data.head.revision).toBe(1)
  })

  it('adopts the reservation after a crash between reservation and init', async () => {
    const { root, call } = mount()
    const requestId = uuid()
    const input = {}
    const seeded = seedReservation(root, requestId, input)
    const result = await call({ requestId, input })
    expect(result).toMatchObject({ ok: true, projectId: seeded.reservation.projectId, revision: 1 })
    expect(existsSync(join(root, '.dsh', 'vwa', seeded.reservation.projectId, 'HEAD.json'))).toBe(true)
  })

  it('refuses a payload mismatch with IDEMPOTENCY_CONFLICT and creates no project', async () => {
    const { root, call } = mount()
    const requestId = uuid()
    expect((await call({ requestId, input: {} })).ok).toBe(true)
    const conflicted = await call({ requestId, input: { mode: 'reviewed' } })
    expect(conflicted).toMatchObject({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })
    expect(projectIds(root)).toHaveLength(1)
  })

  it('adopts on a concurrent wx conflict (the loser reads the winner reservation)', async () => {
    const { root, call } = mount()
    const requestId = uuid()
    const input = {}
    const seeded = seedReservation(root, requestId, input)
    const adopted = await call({ requestId, input })
    expect(adopted).toMatchObject({ ok: true, projectId: seeded.reservation.projectId })
    const fresh = await call({ requestId: uuid(), input: {} })
    expect(fresh.ok).toBe(true)
    expect(fresh.projectId).not.toBe(seeded.reservation.projectId)
    expect(projectIds(root)).toHaveLength(2)
  })

  it('leaves the reservation untouched after a successful create', async () => {
    const { root, call } = mount()
    const requestId = uuid()
    await call({ requestId, input: {} })
    const before = readFileSync(reservationPath(root, requestId), 'utf8')
    await call({ requestId, input: {} })
    expect(readFileSync(reservationPath(root, requestId), 'utf8')).toBe(before)
  })

  it('reports STORE_IO_FAILED with a delete-to-recover message for an unparseable reservation', async () => {
    const { root, call } = mount()
    const requestId = uuid()
    mkdirSync(join(root, '.dsh', 'vwa', 'inits'), { recursive: true })
    writeFileSync(reservationPath(root, requestId), '{"schemaVersion":1,"requ', 'utf8')
    const result = await call({ requestId, input: {} })
    expect(result).toMatchObject({ ok: false, code: 'STORE_IO_FAILED' })
    expect(result.message).toContain('delete')
    expect(projectIds(root)).toHaveLength(0)
  })
})

describe('argument.init pointer and lock semantics (§2.2/§2.3)', () => {
  it('does not write the pointer with setPointer:false', async () => {
    const { root, call } = mount()
    expect((await call({ requestId: uuid(), input: { setPointer: false } })).ok).toBe(true)
    expect(existsSync(pointerPath(root))).toBe(false)
  })

  it('two adopters of one reservation never write diverging workspaceIdentity (issue #312)', async () => {
    const { root, call } = mount()
    const requestId = uuid()
    const input = {}
    const seeded = seedReservation(root, requestId, input)
    const first = await call({ requestId, input })
    const second = await call({ requestId, input })
    expect(first.ok && second.ok).toBe(true)
    expect(second.projectId).toBe(seeded.reservation.projectId)
    expect(second.data).toEqual(first.data)
    expect(projectIds(root)).toHaveLength(1)
    const head = new ProjectStore(root, seeded.reservation.projectId).readHead()
    expect(head.ok).toBe(true)
    if (head.ok) expect(head.data.snapshot.workspaceIdentity).toBe((first.data as { workspaceIdentity: string }).workspaceIdentity)
  })

  it('rejects an unknown input key and a non-UUID requestId', async () => {
    const { call } = mount()
    expect(await call({ requestId: uuid(), input: { extra: true } })).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' })
    expect(await call({ requestId: 'not-a-uuid', input: {} })).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' })
    expect(await call({ requestId: uuid(), input: { mode: 'bogus' } })).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' })
  })
})

describe('argument.init validates the complete frozen settings before creating state', () => {
  it.each([
    { budget: { concurrency: 0 } },
    { budget: { concurrency: 5 } },
    { budget: { maxCallsPerRun: -1 } },
    { budget: { maxCallsPerRun: '10' } },
    { budget: { maxOutputTokensPerCall: 255 } },
    { budget: { typo: 1 } },
    { claimsBatchSize: 'oops' },
    { claimsBatchSize: 0 },
    { claimsBatchSize: 5 },
    { maxArtifactChars: 999 },
    { projectBudget: { maxCalls: 1_000_001 } },
  ])('rejects malformed reviewSettings %j without reserving or modifying a project', async (reviewSettings) => {
    const { root, call } = mount()
    const first = await call({ requestId: uuid(), input: {} })
    const pointer = readFileSync(pointerPath(root), 'utf8')
    const requestId = uuid()
    expect(await call({ requestId, input: { reviewSettings } })).toMatchObject({
      ok: false, code: 'SCHEMA_INVALID', retryable: false,
    })
    expect(existsSync(reservationPath(root, requestId))).toBe(false)
    expect(projectIds(root)).toEqual([first.projectId])
    expect(readFileSync(pointerPath(root), 'utf8')).toBe(pointer)
  })

  it('merges the project budget baseline key by key as well as the call budget', async () => {
    const { root, call } = mount({
      reviewSettings: () => ({ ...freezeReviewSettings(), projectBudget: { maxCalls: 10 } }),
    })
    const result = await call({
      requestId: uuid(), input: { reviewSettings: { projectBudget: { maxOutputTokens: 5000 } } },
    })
    expect(result.ok).toBe(true)
    const head = new ProjectStore(root, result.projectId as string).readHead()
    expect(head.ok && head.data.snapshot.contract.reviewSettings?.projectBudget).toEqual({
      maxCalls: 10, maxOutputTokens: 5000,
    })
  })

  it('replays a completed init without consulting changed runtime defaults', async () => {
    let reads = 0
    const { call } = mount({ reviewSettings: () => {
      if (++reads > 1) throw new Error('the previous runtime defaults are no longer available')
      return freezeReviewSettings()
    } })
    const args = { requestId: uuid(), input: {} }
    const first = await call(args)
    expect(first.ok).toBe(true)
    expect(await call(args)).toEqual(first)
    expect(reads).toBe(1)
  })

  it.each(['projectId', 'workspaceIdentity'] as const)('rejects inconsistent recovery metadata: %s', async (field) => {
    const { root, call } = mount()
    const args = { requestId: uuid(), input: {} }
    const first = await call(args)
    const path = join(root, '.dsh', 'vwa', first.projectId as string, 'workspace.json')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    metadata[field] = field === 'projectId' ? `prj_${uuid()}` : 'f'.repeat(64)
    writeFileSync(path, stableJson(metadata))
    expect(await call(args)).toMatchObject({ ok: false, code: 'STORE_CORRUPT' })
  })
})
