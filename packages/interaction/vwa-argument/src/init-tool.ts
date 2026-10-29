/**
 * Feature 1 (design docs/plans/2026-10-28-vwa-batch-autonomous-review.md
 * §2): `argument.init`, the agent-callable project creation tool.
 *
 * Durably idempotent create (§2.4): a reservation file
 * `.dsh/vwa/inits/<requestId>.json` is exclusive-created (single
 * write + fsync) BEFORE `ProjectStore.init`; every retry — crash between
 * reservation and init, or a concurrent caller that lost the `wx` race —
 * adopts the reserved projectId and continues the init under the project
 * write lock (issue #312: two adopters must not write diverging
 * workspaceIdentity values). Nothing ever rewrites the reservation.
 *
 * @module @dsh-cc/vwa-argument/init-tool
 */

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { defaultContract } from './command-host.ts'
import { writePointer } from './commands.ts'
import { acquireLock, releaseLock } from './lock.ts'
import { freezeReviewSettings, type FrozenReviewSettings } from './review-config.ts'
import { applyReviewSettingsPatch, type PatchReviewSettings } from './review-settings-revision.ts'
import { isUuidV4, sha256Hex, stableJson } from './schema.ts'
import { RESULT_SCHEMA, toText } from './tool-input.ts'
import { defineTool, type ToolDefinition } from '@dsh-cc/tools'
import { ProjectStore, VwaFail, fail, type Fail, type Result } from './store.ts'
import { withSchemaEnvelope, type ToolDeps } from './tools.ts'

/** The §2.4 reservation body. */
export interface InitReservation {
  schemaVersion: 1
  requestId: string
  payloadHash: string
  projectId: string
  ts: string
}

/** Validated `argument.init` body (§2.2). */
interface InitInput {
  mode: 'draft' | 'reviewed'
  setPointer: boolean
  reviewSettings: PatchReviewSettings
}

const INPUT_KEYS = new Set(['mode', 'reviewSettings', 'setPointer'])
const PATCH_KEYS = new Set(['budget', 'claimsBatchSize', 'maxArtifactChars', 'disagreementPolicy', 'projectBudget'])
const PROJECT_BUDGET_KEYS = new Set(['maxCalls', 'maxInputTokens', 'maxOutputTokens'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Drop explicitly-undefined patch keys (spread target must stay lossless). */
function pickDefined(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
}

/**
 * §2.2 commitment semantics: freeze the COMPLETE baseline first, then apply
 * the patch on the frozen object (never translate the patch into flat
 * settings keys — the new keys would be dropped by `freezeReviewSettings`).
 */
export function mergeFrozenReviewSettings(
  base: FrozenReviewSettings,
  patch: PatchReviewSettings,
): FrozenReviewSettings {
  // Initialization and later revisions use the same closed schema and ranges.
  return applyReviewSettingsPatch(base, pickDefined(patch as Record<string, unknown>)).settings
}

/** Parse/validate the closed `input` key set; SCHEMA_INVALID on anything else. */
function parseInput(raw: unknown): InitInput | Fail {
  if (!isPlainObject(raw)) return fail('SCHEMA_INVALID', 'input must be an object')
  for (const key of Object.keys(raw)) {
    if (!INPUT_KEYS.has(key)) return fail('SCHEMA_INVALID', `unknown argument.init input field: ${key}`)
  }
  const mode = raw.mode ?? 'draft'
  if (mode !== 'draft' && mode !== 'reviewed')
    return fail('SCHEMA_INVALID', `input.mode must be 'draft' or 'reviewed', got ${String(mode)}`)
  const setPointer = raw.setPointer ?? true
  if (typeof setPointer !== 'boolean') return fail('SCHEMA_INVALID', 'input.setPointer must be a boolean when present')
  const reviewSettings = raw.reviewSettings ?? {}
  if (!isPlainObject(reviewSettings))
    return fail('SCHEMA_INVALID', 'input.reviewSettings must be a PatchReviewSettings object')
  for (const key of Object.keys(reviewSettings)) {
    if (!PATCH_KEYS.has(key))
      return fail('SCHEMA_INVALID', `unknown reviewSettings field: ${key}; allowed: budget, claimsBatchSize, maxArtifactChars, disagreementPolicy, projectBudget`)
  }
  const projectBudget = reviewSettings.projectBudget
  if (projectBudget !== undefined) {
    if (!isPlainObject(projectBudget))
      return fail('SCHEMA_INVALID', 'reviewSettings.projectBudget must be an object')
    for (const key of Object.keys(projectBudget)) {
      if (!PROJECT_BUDGET_KEYS.has(key))
        return fail('SCHEMA_INVALID', `unknown ProjectBudget field: ${key}`)
      const value = projectBudget[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1))
        return fail('SCHEMA_INVALID', `reviewSettings.projectBudget.${key} must be a positive integer`)
    }
  }
  const budget = reviewSettings.budget
  if (budget !== undefined && !isPlainObject(budget))
    return fail('SCHEMA_INVALID', 'reviewSettings.budget must be an object of ReviewBudget fields')
  const disagreementPolicy = reviewSettings.disagreementPolicy
  if (disagreementPolicy !== undefined && disagreementPolicy !== 'blocking' && disagreementPolicy !== 'deferred')
    return fail('SCHEMA_INVALID', "reviewSettings.disagreementPolicy must be 'blocking' or 'deferred'")
  return {
    mode,
    setPointer,
    reviewSettings: reviewSettings as PatchReviewSettings,
  }
}

function reservationsDir(root: string): string {
  return join(root, '.dsh', 'vwa', 'inits')
}

function reservationPath(root: string, requestId: string): string {
  return join(reservationsDir(root), `${requestId}.json`)
}

/** Read one reservation; `undefined` when absent, STORE_IO_FAILED when unparseable (§2.4). */
function readReservation(root: string, requestId: string): InitReservation | Fail | undefined {
  let text: string
  try {
    text = readFileSync(reservationPath(root, requestId), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as InitReservation
    if (
      !isPlainObject(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.requestId !== requestId ||
      typeof parsed.payloadHash !== 'string' ||
      typeof parsed.projectId !== 'string'
    ) {
      throw new Error('malformed reservation')
    }
    return parsed
  } catch {
    return fail(
      'STORE_IO_FAILED',
      `init reservation ${requestId} is unparseable (crash remnant); delete `.concat(
        reservationPath(root, requestId),
        ' to recover, then retry with a fresh requestId',
      ),
      false,
    )
  }
}

/**
 * Reserve-before-create (§2.4): exclusive-create via `wx`, full JSON in one
 * writeSync + fsync. A lost race reads the winner's reservation and adopts
 * it; a payload mismatch is IDEMPOTENCY_CONFLICT.
 */
function reserve(
  root: string,
  requestId: string,
  payloadHash: string,
): Result<{ reservation: InitReservation; created: boolean }> {
  mkdirSync(reservationsDir(root), { recursive: true })
  const path = reservationPath(root, requestId)
  const fresh: InitReservation = {
    schemaVersion: 1,
    requestId,
    payloadHash,
    projectId: `prj_${randomUUID()}`,
    ts: new Date().toISOString(),
  }
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      return fail('STORE_IO_FAILED', `reservation create failed: ${String(error)}`, true)
    const existing = readReservation(root, requestId)
    if (existing === undefined) return fail('STORE_IO_FAILED', 'reservation vanished after an EEXIST race', true)
    if ('ok' in existing) return existing
    if (existing.payloadHash !== payloadHash)
      return fail('IDEMPOTENCY_CONFLICT', `requestId ${requestId} was used with a different payload`)
    return { ok: true, projectId: existing.projectId, revision: 1, data: { reservation: existing, created: false } }
  }
  try {
    // The file is tiny: one write is effectively atomic (never fragment, §2.4).
    writeSync(fd, stableJson(fresh))
    fsyncSync(fd)
  } catch (error: unknown) {
    // A reservation write failure fails the whole init (no best-effort).
    return fail('STORE_IO_FAILED', `reservation write failed: ${String(error)}`, true)
  } finally {
    closeSync(fd)
  }
  return { ok: true, projectId: fresh.projectId, revision: 1, data: { reservation: fresh, created: true } }
}

/**
 * §2.3 recovery: the project already exists (original creator alive/
 * finished). Read HEAD + workspace.json; projectId match → success,
 * mismatch → STORE_CORRUPT.
 */
function recover(root: string, projectId: string): Result<{ workspaceIdentity: string }> {
  const store = new ProjectStore(root, projectId)
  const head = store.readHead()
  if (!head.ok) return head
  if (head.data.head.projectId !== projectId)
    return fail('STORE_CORRUPT', `project ${projectId} HEAD belongs to a different project`)
  let workspace: Record<string, unknown>
  try {
    workspace = JSON.parse(readFileSync(join(store.dir, 'workspace.json'), 'utf8'))
  } catch {
    return fail('STORE_CORRUPT', `project ${projectId} workspace.json is missing or unreadable`)
  }
  const workspaceIdentity = workspace?.workspaceIdentity
  if (!isPlainObject(workspace) || workspace.schemaVersion !== 1 || workspace.projectId !== projectId ||
      head.data.snapshot.projectId !== projectId || typeof workspaceIdentity !== 'string' || workspaceIdentity === '' ||
      workspaceIdentity !== head.data.snapshot.workspaceIdentity)
    return fail('STORE_CORRUPT', `project ${projectId} workspace.json does not match the committed project identity`)
  return { ok: true, projectId, revision: 1, data: { workspaceIdentity } }
}

/** Create (or recover) the reserved project under the project write lock (§2.3 step 4). */
export function initReservedProject(
  root: string,
  reservation: InitReservation,
  input: InitInput,
  reviewSettings: FrozenReviewSettings,
): Result<{ workspaceIdentity: string }> {
  const projectId = reservation.projectId
  const store = new ProjectStore(root, projectId)
  // The HEAD-exists check alone is not a create transaction (issue #312):
  // the lock serializes creator and adopters so workspaceIdentity never diverges.
  const lockFailure = acquireLock(store.dir)
  if (lockFailure !== undefined) return lockFailure
  try {
    if (existsSync(join(store.dir, 'HEAD.json'))) return recover(root, projectId)
    const contract = { ...defaultContract('(set the project question with argument.update: contract)'), mode: input.mode }
    const created = store.init(contract, reviewSettings)
    if (created.ok) return created
    // Concurrent creator finished between the check and init: recovery path.
    if (created.code === 'SCHEMA_INVALID' && created.message.includes('already exists'))
      return recover(root, projectId)
    return created
  } finally {
    releaseLock(store.dir)
  }
}

/** The `argument.init` tool (§2.1/§2.2). */
export function argumentInitTool(deps: ToolDeps): ToolDefinition {
  return withSchemaEnvelope(
    defineTool({
      name: 'argument.init',
      description:
        'Create a new VWA lane-2 project (the agent-callable equivalent of /vwa init). Idempotent by ' +
        'requestId: a replay — including any crash window — returns the same projectId and never creates ' +
        'a second project. Pass setPointer:false in batch loops to avoid rewriting the interactive pointer.',
      parameters: {
        requestId: {
          type: 'string',
          required: true,
          description: 'UUID v4 idempotency key',
        },
        input: {
          type: 'object',
          additionalProperties: false,
          required: true,
          description: 'body: {mode?: draft|reviewed, reviewSettings?: PatchReviewSettings, setPointer?: boolean}',
          properties: {
            mode: { type: 'string', description: "Project mode: 'draft' (default) or 'reviewed'" },
            reviewSettings: { type: 'json', description: 'Patch frozen onto the complete settings baseline' },
            setPointer: { type: 'boolean', description: 'Write .dsh/vwa/current-project.json (default true)' },
          },
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
      async execute(raw, exec) {
        const args = raw as { requestId?: unknown; input?: unknown }
        if (typeof args?.requestId !== 'string' || !isUuidV4(args.requestId))
          return fail('SCHEMA_INVALID', 'requestId must be a UUID v4 string')
        const input = parseInput(args.input)
        if ('ok' in input) return input
        const root = deps.workspaceRoot(exec.agent)
        if (root === undefined) return fail('STORE_IO_FAILED', 'no workspace root is bound to this session', false)
        const payloadHash = sha256Hex(stableJson(args.input))
        // A completed request replays the committed identity, regardless of
        // changes to runtime defaults since the original successful call.
        const existing = readReservation(root, args.requestId)
        if (existing !== undefined) {
          if ('ok' in existing) return existing
          if (existing.payloadHash !== payloadHash)
            return fail('IDEMPOTENCY_CONFLICT', `requestId ${args.requestId} was used with a different payload`)
          if (existsSync(join(root, '.dsh', 'vwa', existing.projectId, 'HEAD.json')))
            return recover(root, existing.projectId)
        }
        let reviewSettings: FrozenReviewSettings
        try {
          reviewSettings = mergeFrozenReviewSettings(deps.reviewSettings?.() ?? freezeReviewSettings(), input.reviewSettings)
        } catch (error) {
          if (error instanceof VwaFail) return error.fail
          throw error
        }
        // Invalid fresh settings must leave no reservation, project or pointer.
        const reserved = reserve(root, args.requestId, payloadHash)
        if (!reserved.ok) return reserved
        const created = initReservedProject(root, reserved.data.reservation, input, reviewSettings)
        if (!created.ok) return created
        // First result wins: only the caller that created the reservation
        // writes the pointer; replays never rewrite it (§2.2/§2.3).
        if (reserved.data.created && input.setPointer)
          writePointer(root, reserved.data.reservation.projectId, created.data.workspaceIdentity)
        return {
          ok: true,
          projectId: reserved.data.reservation.projectId,
          revision: 1,
          data: { workspaceIdentity: created.data.workspaceIdentity },
        }
      },
    }),
  )
}
