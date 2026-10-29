/**
 * Task-scoped authorization (design §3.2/§3.3/§3.8 of the VWA batch
 * autonomous-review plan).
 *
 * A `TaskGrant` is the single relaxed authorization a whole batch runs under.
 * Every trust-bearing field is HOST-derived (root, branch, goalId, expires,
 * ts); only the capability face (rules/tools/writePaths/sandboxEscalation/
 * modeCeiling/contentScope) comes from the descriptor file, and the user
 * approves the complete post-derivation view before the grant exists.
 *
 * Grants are SESSION-SCOPED only (§3.8): grant + revoke are session events, a
 * resumed session folds its own log and keeps the grant, and a NEW session
 * resuming the same batch needs a fresh `/permissions grant` — there is no
 * cross-session persistence, on purpose.
 *
 * @module @dsh-cc/permission-rules/task-grant
 */

import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { parseRule } from './parser.ts'
import type { PermissionRule, PermissionRuleSource } from './types.ts'

/** The session event type carrying one task grant (payload = the grant). */
export const TASK_GRANT_EVENT = 'permission/task-grant'

// Same registration pattern as `permission/session-allow` (session-allowlist.ts).
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(TASK_GRANT_EVENT)

/** Grant rules are parsed into the highest-priority source: they are user-authored. */
export const TASK_GRANT_RULE_SOURCE: PermissionRuleSource = 'session'

/** The workspace-relative VWA state root that writePaths may never cover (§3.2). */
export const VWA_STATE_ROOT = '.dsh/vwa'

/** The only VWA state subtree writable under a grant (batch scratch space). */
export const VWA_BATCH_ROOT = '.dsh/vwa/batches'

/** How a grant ends (§3.2). */
export type GrantExpiry = { kind: 'session-end' } | { kind: 'goal-complete'; goalId: string } | { kind: 'manual' }

/** One task-scoped authorization. */
export interface TaskGrant {
  /** `grant_` + uuid. */
  readonly grantId: string
  /** Host-derived workspace realpath the grant is scoped to. */
  readonly root: string
  /** Host-derived `git rev-parse --abbrev-ref HEAD` at grant time. */
  readonly branch: string | null
  /** Host-derived active goal id, when a goal is active. */
  readonly goalId: string | null
  readonly expires: GrantExpiry
  /** Capability face: bare-prefix bash rule strings (`Bash(git add)`). */
  readonly rules: readonly string[]
  /** Capability face: exact tool names or `prefix.*` forms. */
  readonly tools: readonly string[]
  /** Capability face: root-relative write path prefixes. */
  readonly writePaths: readonly string[]
  readonly sandboxEscalation: boolean
  readonly modeCeiling: SandboxMode
  readonly contentScope: 'tracked-md-only' | 'any'
  /** Provenance: only the user-typed slash command can create a grant. */
  readonly createdBy: 'user'
  /** ISO timestamp (host clock). */
  readonly ts: string
}

/** The descriptor file's only allowed keys — the capability face (§3.3). */
export interface TaskGrantDescriptor {
  readonly rules: readonly string[]
  readonly tools: readonly string[]
  readonly writePaths: readonly string[]
  readonly sandboxEscalation: boolean
  readonly modeCeiling?: SandboxMode
  readonly contentScope?: 'tracked-md-only' | 'any'
}

/** A grant payload in the log, plus the revoke marker (§3.2: cleared carries a grantId). */
export interface TaskGrantEventData {
  /** The grant, on a create record. */
  readonly grant?: TaskGrant
  /** The revoked grant, on a clear record — NEVER a wipe-all. */
  readonly cleared?: string
  /** Why a clear happened (`manual` | `content-scope-violation` | `goal-complete`). */
  readonly reason?: string
  /** Wall-clock time of the record. */
  readonly timestamp: number
}

/** Diagnostic raised by the grant validator; the command renders it verbatim. */
export class GrantValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantValidationError'
  }
}

/** Whether a root-relative path is the VWA state root or under it. */
function underVwaState(path: string): boolean {
  return path === VWA_STATE_ROOT || path.startsWith(`${VWA_STATE_ROOT}/`)
}

/** Whether a root-relative path is the exempt batch subtree (or the VWA root itself). */
function underVwaBatches(path: string): boolean {
  return path === VWA_BATCH_ROOT || path.startsWith(`${VWA_BATCH_ROOT}/`)
}

/** Normalize one root-relative write path to its canonical POSIX form. */
function normalizeWritePath(raw: string): string {
  if (raw.trim() === '') throw new GrantValidationError('writePaths: empty entry')
  if (isAbsolute(raw)) throw new GrantValidationError(`writePaths: "${raw}" must be root-relative`)
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new GrantValidationError(`writePaths: "${raw}" escapes the workspace root`)
    segments.push(segment)
  }
  if (segments.length === 0) throw new GrantValidationError(`writePaths: "${raw}" names the workspace root`)
  return segments.join('/')
}

/** Tokenize a bash rule's content by whitespace (rule content is a command prefix). */
function ruleTokens(content: string): string[] {
  return content.trim().split(/\s+/)
}

/**
 * Reject the bash rule shapes §3.4 pins out of grant rules: whole-tool bash
 * rules, wildcards, `X:*` colon-prefix forms, and git invocations that place
 * `-c`/`--config-env` before the subcommand (a config override can change what
 * the admitted command does).
 */
function validateBashRule(rule: string): PermissionRule {
  const parsed = parseRule(rule, 'allow', TASK_GRANT_RULE_SOURCE)
  if (parsed.content === undefined || parsed.matcher === undefined) {
    throw new GrantValidationError(`rules: "${rule}" is a whole-tool rule; grant rules must carry a command prefix`)
  }
  if (parsed.matcher.kind !== 'prefix') {
    throw new GrantValidationError(`rules: "${rule}" uses a wildcard; grant rules are literal prefixes only`)
  }
  if (parsed.content.endsWith(':*')) {
    throw new GrantValidationError(`rules: "${rule}" uses the ":*" colon-prefix form; write the plain prefix instead`)
  }
  const tokens = ruleTokens(parsed.content)
  if (tokens[0] === 'git') {
    for (const token of tokens.slice(1)) {
      if (!token.startsWith('-')) break
      if (token === '-c' || token === '--config-env' || token.startsWith('--config-env=')) {
        throw new GrantValidationError(`rules: "${rule}" overrides git config before the subcommand`)
      }
    }
  }
  return parsed
}

/** Whether a tool entry is an exact name or a `prefix.*` form (§3.2). */
function validateToolEntry(entry: string): void {
  if (entry.trim() === '') throw new GrantValidationError('tools: empty entry')
  if (entry.includes('*') && !/^[A-Za-z0-9_.-]+\.\*$/.test(entry)) {
    throw new GrantValidationError(`tools: "${entry}" must be an exact tool name or "prefix.*"`)
  }
  if (!/^[A-Za-z0-9_.*-]+$/.test(entry)) throw new GrantValidationError(`tools: "${entry}" is not a tool name`)
}

/** Whether the rule set names a git subcommand prefix (`Bash(git commit)` / `Bash(git push)`). */
function namesGitSubcommand(rules: readonly string[], subcommand: string): boolean {
  return rules.some(raw => {
    const parsed = parseRule(raw, 'allow', TASK_GRANT_RULE_SOURCE)
    if (parsed.matcher?.kind !== 'prefix') return false
    const tokens = ruleTokens(parsed.content ?? '')
    return tokens[0] === 'git' && tokens[1] === subcommand
  })
}

/**
 * Validate a descriptor's capability face and derive the conditional defaults
 * (§3.2/§3.6): writePaths may never cover `.dsh/vwa/**` except
 * `.dsh/vwa/batches/**`; `modeCeiling` defaults to `workspace-write`;
 * `contentScope` defaults to `tracked-md-only` when escalation is on AND the
 * rules contain git commit/push (otherwise `any`, which needs no opt-in).
 * @param descriptor - the parsed descriptor file contents.
 * @returns the validated capability face.
 * @throws {GrantValidationError} on any rejected shape.
 */
export function validateDescriptor(descriptor: TaskGrantDescriptor): {
  rules: readonly string[]
  tools: readonly string[]
  writePaths: readonly string[]
  sandboxEscalation: boolean
  modeCeiling: SandboxMode
  contentScope: 'tracked-md-only' | 'any'
} {
  if (!Array.isArray(descriptor.rules) || !Array.isArray(descriptor.tools) || !Array.isArray(descriptor.writePaths)) {
    throw new GrantValidationError('descriptor: rules, tools and writePaths must be arrays')
  }
  if (typeof descriptor.sandboxEscalation !== 'boolean') {
    throw new GrantValidationError('descriptor: sandboxEscalation must be a boolean')
  }
  for (const rule of descriptor.rules) validateBashRule(rule)
  descriptor.tools.forEach(validateToolEntry)
  const writePaths = descriptor.writePaths.map(normalizeWritePath)
  for (const path of writePaths) {
    if (underVwaState(path) && !underVwaBatches(path)) {
      throw new GrantValidationError(
        `writePaths: "${path}" is authoritative VWA state; only ${VWA_BATCH_ROOT}/** is writable under a grant`,
      )
    }
  }
  const modeCeiling = descriptor.modeCeiling ?? 'workspace-write'
  if (modeCeiling !== 'workspace-write' && modeCeiling !== 'danger-full-access') {
    throw new GrantValidationError(`descriptor: unknown modeCeiling "${modeCeiling}"`)
  }
  const gitWrites = namesGitSubcommand(descriptor.rules, 'commit') || namesGitSubcommand(descriptor.rules, 'push')
  const conditionalDefault: 'tracked-md-only' | 'any' =
    descriptor.sandboxEscalation && gitWrites ? 'tracked-md-only' : 'any'
  const contentScope = descriptor.contentScope ?? conditionalDefault
  if (contentScope !== 'tracked-md-only' && contentScope !== 'any') {
    throw new GrantValidationError(`descriptor: unknown contentScope "${contentScope}"`)
  }
  return {
    rules: [...descriptor.rules],
    tools: [...descriptor.tools],
    writePaths,
    sandboxEscalation: descriptor.sandboxEscalation,
    modeCeiling,
    contentScope,
  }
}

/** Whether a descriptor explicitly opts into `any` where the default is tracked-md-only. */
export function isAnyOptIn(descriptor: TaskGrantDescriptor): boolean {
  return descriptor.contentScope === 'any'
    && descriptor.sandboxEscalation
    && (namesGitSubcommand(descriptor.rules, 'commit') || namesGitSubcommand(descriptor.rules, 'push'))
}

/** The parsed `allowed` keys of a descriptor file (unknown keys are rejected). */
const DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  'rules', 'tools', 'writePaths', 'sandboxEscalation', 'modeCeiling', 'contentScope',
])

/**
 * Read the capability face out of raw parsed JSON, rejecting host-owned or
 * unknown keys (the descriptor may only declare what the user approves).
 * @param raw - the JSON value read from the descriptor file.
 * @returns the capability face (unvalidated shapes go through {@link validateDescriptor}).
 */
export function descriptorFromJson(raw: unknown): TaskGrantDescriptor {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GrantValidationError('descriptor: must be a JSON object')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!DESCRIPTOR_KEYS.has(key)) {
      throw new GrantValidationError(`descriptor: "${key}" is host-derived and may not be declared`)
    }
  }
  const rules = record.rules
  const tools = record.tools
  const writePaths = record.writePaths
  if (!Array.isArray(rules) || rules.some(entry => typeof entry !== 'string')) {
    throw new GrantValidationError('descriptor: rules must be an array of strings')
  }
  if (!Array.isArray(tools) || tools.some(entry => typeof entry !== 'string')) {
    throw new GrantValidationError('descriptor: tools must be an array of strings')
  }
  if (!Array.isArray(writePaths) || writePaths.some(entry => typeof entry !== 'string')) {
    throw new GrantValidationError('descriptor: writePaths must be an array of strings')
  }
  return {
    rules: rules as string[],
    tools: tools as string[],
    writePaths: writePaths as string[],
    sandboxEscalation: record.sandboxEscalation as boolean,
    ...record.modeCeiling === undefined ? {} : { modeCeiling: record.modeCeiling as SandboxMode },
    ...record.contentScope === undefined
      ? {}
      : { contentScope: record.contentScope as 'tracked-md-only' | 'any' },
  }
}

/** Build a grant from a validated face plus the host-derived fields. */
export function buildTaskGrant(input: {
  root: string
  branch: string | null
  goalId: string | null
  face: ReturnType<typeof validateDescriptor>
  now?: Date
}): TaskGrant {
  const now = input.now ?? new Date()
  return {
    grantId: `grant_${randomUUID()}`,
    root: input.root,
    branch: input.branch,
    goalId: input.goalId,
    expires: input.goalId === null ? { kind: 'session-end' } : { kind: 'goal-complete', goalId: input.goalId },
    rules: [...input.face.rules],
    tools: [...input.face.tools],
    writePaths: [...input.face.writePaths],
    sandboxEscalation: input.face.sandboxEscalation,
    modeCeiling: input.face.modeCeiling,
    contentScope: input.face.contentScope,
    createdBy: 'user',
    ts: now.toISOString(),
  }
}

/**
 * Append one grant record. A clear record carries the revoked `grantId` — a
 * grant revoke never wipes the other grants of the session (§3.2).
 * @param session - the session log to extend.
 * @param data - the create or clear record.
 */
export function appendTaskGrantEvent(session: Session, data: TaskGrantEventData): void {
  type AppendFace = { append(type: string, data: TaskGrantEventData): unknown }
  ;(session as unknown as AppendFace).append(TASK_GRANT_EVENT, data)
}

/** Wire face of one log event that may or may not be a `permission/task-grant`. */
interface TaskGrantWire {
  readonly type: string
  readonly data: TaskGrantEventData
}

/**
 * Fold a session log into its live grants, in grant order. A clear record
 * drops exactly the named grant; unknown grantIds are ignored (idempotent
 * replay of a revoke).
 * @param events - session events in log order.
 * @returns the live grants.
 */
export function foldTaskGrants(events: readonly SessionEvent[]): TaskGrant[] {
  const live = new Map<string, TaskGrant>()
  for (const event of events) {
    const wire = event as unknown as TaskGrantWire
    if (wire.type !== TASK_GRANT_EVENT) continue
    if (typeof wire.data?.cleared === 'string') {
      live.delete(wire.data.cleared)
      continue
    }
    const grant = wire.data?.grant
    if (grant !== undefined && typeof grant.grantId === 'string' && grant.createdBy === 'user') {
      live.set(grant.grantId, grant)
    }
  }
  return [...live.values()]
}

/**
 * The in-memory grant store: grants keyed by session id, lazily seeded from
 * the session's own log on first use (the `sessionAllowMatches`
 * seed-on-first-use pattern — `foldTaskGrants` is not a generic event fold).
 * Session-scoped only: a different session id sees nothing (§3.8).
 */
export class TaskGrantStore {
  private readonly bySession = new Map<string, TaskGrant[]>()
  private readonly seeded = new Set<string>()

  /** Seed one session from its log, once. */
  private ensure(sessionId: string, events: () => readonly SessionEvent[]): TaskGrant[] {
    if (!this.seeded.has(sessionId)) {
      this.seeded.add(sessionId)
      const folded = foldTaskGrants(events())
      if (folded.length > 0) this.bySession.set(sessionId, folded)
    }
    return this.bySession.get(sessionId) ?? []
  }

  /** The live grants of one session (seeding from `events` on first use). */
  of(sessionId: string, events: () => readonly SessionEvent[]): readonly TaskGrant[] {
    return this.ensure(sessionId, events)
  }

  /** The live grant with this id, when it belongs to the session. */
  byId(sessionId: string, events: () => readonly SessionEvent[], grantId: string): TaskGrant | undefined {
    return this.ensure(sessionId, events).find(grant => grant.grantId === grantId)
  }

  /** Record a freshly created grant (the caller appends the session event). */
  add(sessionId: string, events: () => readonly SessionEvent[], grant: TaskGrant): void {
    const grants = this.ensure(sessionId, events).filter(existing => existing.grantId !== grant.grantId)
    this.bySession.set(sessionId, [...grants, grant])
  }

  /** Drop one grant (the caller appends the clear session event). */
  remove(sessionId: string, events: () => readonly SessionEvent[], grantId: string): boolean {
    const grants = this.ensure(sessionId, events)
    const next = grants.filter(grant => grant.grantId !== grantId)
    if (next.length === grants.length) return false
    if (next.length === 0) this.bySession.delete(sessionId)
    else this.bySession.set(sessionId, next)
    return true
  }

  /** Whether the session holds any live grant. */
  anyActive(sessionId: string): boolean {
    return (this.bySession.get(sessionId) ?? []).length > 0
  }

  /** Drop every grant of one session (session disposed/reset, §3.5 rule ②). */
  drop(sessionId: string): void {
    this.bySession.delete(sessionId)
    this.seeded.delete(sessionId)
  }
}

/**
 * Whether a grant has expired because its linked goal is no longer the
 * session's active goal (§3.2 `goal-complete`). This deployment composes no
 * goal service (so `goalId` is always null and the check is vacuous); when a
 * goal service IS reachable the same check runs at every match/consume point.
 * @param grant - the grant to test.
 * @param activeGoalId - the session's active goal id, or null.
 * @returns true when the grant's goal has completed.
 */
export function grantGoalExpired(grant: TaskGrant, activeGoalId: string | null): boolean {
  return grant.expires.kind === 'goal-complete' && grant.expires.goalId !== activeGoalId
}

/**
 * Resolve a path through the filesystem. A nonexistent target is still resolved
 * through its DEEPEST EXISTING ANCESTOR, then the remaining basenames are
 * appended — so a symlinked parent (`docs/link -> .dsh/vwa`) is always
 * resolved. Purely lexical `resolve()` is never enough: it would let a
 * symlinked directory smuggle a write into authoritative VWA state (B1).
 */
export function normalizePath(path: string): string {
  const absolute = resolve(path)
  const remainder: string[] = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync(current)
      return remainder.length === 0 ? real : join(real, ...remainder.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      remainder.push(basename(current))
      current = parent
    }
  }
}

/** Whether `target` is `base` or under it (separator-aware prefix). */
export function isPathWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/** The absolute realpath-normalized form of one root-relative write path. */
export function writePathBase(root: string, writePath: string): string {
  return normalizePath(join(root, writePath))
}
