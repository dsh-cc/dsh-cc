/**
 * `/permissions grant` support (design §3.3): read the descriptor file, derive
 * the host-owned fields, and build the grant the user approves. Creation is a
 * USER-typed slash command only — there is no agent-callable grant tool, so
 * `createdBy: 'user'` cannot be forged.
 *
 * @module @dsh-cc/permission-rules/task-grant-command
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gitLine } from './grant-content-scope.ts'
import {
  GrantValidationError,
  buildTaskGrant,
  descriptorFromJson,
  validateDescriptor,
  type TaskGrant,
} from './task-grant.ts'

/** The host facts a descriptor cannot declare, derived at grant time. */
export interface GrantHostFacts {
  /** Workspace realpath. */
  root: string
  /** Current branch, or null when git cannot answer. */
  branch: string | null
  /** Active goal id, when a goal is active. */
  goalId: string | null
}

/** Read the active branch through a DIRECT git spawn (never the shell service). */
export async function deriveBranch(root: string): Promise<string | null> {
  try {
    const branch = await gitLine(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return branch === '' ? null : branch
  } catch {
    return null
  }
}

/**
 * The active goal id, when a goal service is composed. This deployment's
 * packages compose none, so the structural read yields null — grant expiry then
 * falls back to `session-end` (host-derived, never descriptor-supplied).
 * @param ctx - the plugin context (structural `get` face).
 * @param session - the agent's session.
 * @returns the active goal id, or null.
 */
export function activeGoalIdOf(ctx: { get(name: string): unknown }, session: unknown): string | null {
  const goals = ctx.get('goals') as { activeGoalId?: (target: unknown) => unknown } | undefined
  const id = goals?.activeGoalId?.(session)
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Read and validate a descriptor file's capability face, plus a content
 * fingerprint of the exact bytes the user viewed (P1b: the `--confirm` step
 * binds to this hash, so a descriptor rewritten between view and confirm is
 * rejected instead of silently becoming a different grant).
 * @param path - the descriptor file.
 * @returns the validated face and the sha256 of the raw file text.
 */
export function loadDescriptorFingerprint(path: string): {
  face: ReturnType<typeof validateDescriptor>
  hash: string
} {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new GrantValidationError(`cannot read descriptor ${path}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new GrantValidationError(`descriptor ${path} is not valid JSON: ${String(error)}`)
  }
  return {
    face: validateDescriptor(descriptorFromJson(parsed)),
    hash: createHash('sha256').update(text).digest('hex'),
  }
}

/** Read and validate a descriptor file's capability face. */
export function loadDescriptor(path: string): ReturnType<typeof validateDescriptor> {
  return loadDescriptorFingerprint(path).face
}

/**
 * Derive the complete grant from a descriptor + host facts. The caller appends
 * the create event only after the user confirms the rendered view.
 * @param descriptorPath - the descriptor file the user named.
 * @param facts - host-derived root/branch/goalId.
 * @param now - host clock (tests).
 * @returns the grant to approve.
 * @throws {GrantValidationError} when the descriptor is rejected.
 */
export function deriveTaskGrant(descriptorPath: string, facts: GrantHostFacts, now?: Date): TaskGrant {
  const face = loadDescriptor(descriptorPath)
  return buildTaskGrant({ root: facts.root, branch: facts.branch, goalId: facts.goalId, face, ...now === undefined ? {} : { now } })
}
