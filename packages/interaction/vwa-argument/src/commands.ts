import { defaultContract } from './command-host.ts'
/**
 * The human-facing `/vwa` command (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §10.2, §17.3, §18).
 *
 * Closed grammar: `/vwa <init|status|import|sign|adjudicate|repair> …` —
 * the subcommand enum is closed; extra arguments are a usage error. The
 * command source is ALWAYS `user` (§10.2/D21): the command registry only
 * dispatches human UI lines (`CommandSourceMap` has a single `user`
 * variant), and the assistant tool surface (`argument.update` etc.) can
 * never reach this module — a tool input claiming "user agrees" therefore
 * cannot sign or adjudicate.
 *
 * - `/vwa init [projectId]` — without an id, create a project (default
 *   contract candidate displayed; no search/review triggered); with an id,
 *   switch the pointer to the existing project. The pointer
 *   `.dsh/vwa/current-project.json` is written atomically (temp + rename;
 *   workspace-scoped, last writer wins per §10.2).
 * - `/vwa status` — pointer value, HEAD revision, artifact/source counts,
 *   pending review runs.
 * - `/vwa import <relativeDirectory>` — re-verify all source snapshots and
 *   the bound artifact against ACTUAL bytes; on success rebind the pointer
 *   to the (already re-verified) project root view; old reviews stay as
 *   history (naturally stale via their dependency digests).
 * - `/vwa sign <artifactId> <receiptHash>` — verify receipt/artifact/graph/
 *   policy consistency (§18) and write a Signature record. If the machine
 *   checks did not pass, the signature only means "the user reviewed the
 *   version with known gaps" — the reply says so.
 * - `/vwa adjudicate <findingId> accept|reject <reason>` — non-empty reason
 *   required; semantic findings only (deterministic failures such as path,
 *   hash, or quote mismatches cannot be overridden). reject removes the
 *   finding from the active set (the policy recomputes grades); the model's
 *   original review record is NEVER rewritten.
 * - `/vwa repair <projectId>` — list STORE_CORRUPT recovery candidates and
 *   adopt the NEWEST self-verifying candidate after chain re-verification
 *   (§14.2; the closed grammar has no candidate token, so selection is
 *   newest-first — every candidate is listed in the reply).
 *
 * @module @dsh-cc/vwa-argument/commands
 */

import { freezeReviewSettings, type FrozenReviewSettings } from './review-config.ts'
import { suggestedClaimsBatchSize } from './feasibility.ts'
import { receiptHashOf, type ReceiptV2 } from '@dsh-cc/vwa-evidence'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { helpable } from '@dsh-cc/command-usage'
import { sha256Hex, stableJson } from './schema.ts'
import { ProjectStore } from './store.ts'
import { verifySnapshot } from './sources.ts'
import {
  appendSignature,
  readPendingRuns,
  VwaArgumentService,
  type Signature,
} from './report.ts'
import type { Hash, Id } from './types.ts'

/** The closed subcommand enum (§10.2). */
export const VWA_SUBCOMMANDS = ['init', 'status', 'import', 'sign', 'adjudicate', 'repair'] as const
export type VwaSubcommand = (typeof VWA_SUBCOMMANDS)[number]

/** The current-project pointer shape (§10.2). */
export interface CurrentProjectPointer {
  schemaVersion: 1
  projectId: Id
  workspaceIdentity: Hash
}

/** Workspace root for the executing agent (the /vwa command deps face). */
export interface VwaCommandDeps {
  workspaceRoot(agent: unknown): string | undefined
  reviewSettings?(): FrozenReviewSettings
  defaultMode?(): 'draft' | 'reviewed'
  readReceipt?(agent: unknown, hash: string): ReceiptV2 | undefined
  delivery?(root: string, agent: unknown): VwaArgumentService
}

/** Parse error or a parsed subcommand invocation (closed grammar). */
export type ParsedVwaArgs = { ok: true; sub: VwaSubcommand; rest: string[] } | { ok: false; usage: string }

export const VWA_USAGE = [
  'Usage: /vwa <init|status|import|sign|adjudicate|repair> …',
  '  /vwa init [projectId]              create a project, or switch to an existing one',
  '  /vwa status                        current project, revision, pending review runs',
  '  /vwa import <relativeDirectory>    re-verify sources + artifact and rebind the pointer',
  '  /vwa sign <artifactId> <receiptHash>',
  '  /vwa adjudicate [projectId] <findingId> accept|reject [prevailingRunId] <reason>',
  '  /vwa repair <projectId>            list and adopt a STORE_CORRUPT recovery candidate',
].join('\n')

export function parseVwaArgs(rawInput: string): ParsedVwaArgs {
  const parts = rawInput
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
  if (parts.length === 0) return { ok: false, usage: VWA_USAGE }
  const [sub = '', ...rest] = parts
  if (!(VWA_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return { ok: false, usage: `unknown /vwa subcommand "${sub}".\n${VWA_USAGE}` }
  }
  const limits: Record<VwaSubcommand, number> = {
    init: 1,
    status: 0,
    import: 1,
    sign: 2,
    repair: 1,
    // adjudicate: [projectId] findingId decision [prevailingRunId] reason.
    adjudicate: 5,
  }
  const limit = limits[sub as VwaSubcommand]
  let used = rest
  if (sub === 'adjudicate') {
    const segments = [...rest]
    // §4.4: an optional leading projectId replaces the pointer fallback.
    const projectId = segments[0]?.startsWith('prj_') ? segments.shift() : undefined
    const findingId = segments.shift() ?? ''
    const decision = segments.shift() ?? ''
    const prevailingRunId = segments[0]?.startsWith('run_') ? segments.shift() : undefined
    // The reason is the REST OF THE LINE (one argument slot, §10.2): keep
    // its interior spaces instead of token-splitting it.
    used = [
      ...(projectId === undefined ? [] : [projectId]),
      findingId,
      decision,
      ...(prevailingRunId === undefined ? [] : [prevailingRunId]),
      segments.join(' '),
    ]
  }
  if (used.length > limit) {
    return { ok: false, usage: `too many arguments for /vwa ${sub} (expected at most ${limit}).\n${VWA_USAGE}` }
  }
  const minima: Record<VwaSubcommand, number> = { init: 0, status: 0, import: 1, sign: 2, repair: 1, adjudicate: 3 }
  if (used.length < minima[sub as VwaSubcommand]) {
    return { ok: false, usage: `missing arguments for /vwa ${sub}.\n${VWA_USAGE}` }
  }
  return { ok: true, sub: sub as VwaSubcommand, rest: used }
}

// ---- pointer helpers (§10.2) ----

/** Read the current-project pointer; fail-soft to undefined. */
export function readPointer(root: string): CurrentProjectPointer | undefined {
  const path = join(root, '.dsh', 'vwa', 'current-project.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CurrentProjectPointer
    if (parsed.schemaVersion !== 1 || typeof parsed.projectId !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Atomic pointer write (temp + rename; workspace-scoped, last writer wins). */
export function writePointer(root: string, projectId: Id, workspaceIdentity: Hash): void {
  const dir = join(root, '.dsh', 'vwa')
  mkdirSync(dir, { recursive: true })
  const pointer: CurrentProjectPointer = { schemaVersion: 1, projectId, workspaceIdentity }
  const tmp = join(mkdtempSync(join(dir, '.pointer-')), 'current-project.json')
  writeFileSync(tmp, stableJson(pointer), 'utf8')
  renameSync(tmp, join(dir, 'current-project.json'))
}

/** Find one finding by id across all completed review records. */
export { conflictingRunIds, findFinding, vwaAdjudicate } from './adjudicate.ts'
import { vwaAdjudicate } from './adjudicate.ts'

/** Execute the parsed /vwa subcommand. All output is user-facing text. */
export async function executeVwa(
  deps: VwaCommandDeps,
  agent: unknown,
  parsed: { sub: VwaSubcommand; rest: string[] },
): Promise<CommandResult> {
  const root = deps.workspaceRoot(agent)
  if (root === undefined) return { kind: 'error', text: '/vwa requires a workspace; none is bound to this session.' }
  try {
    switch (parsed.sub) {
      case 'init':
        return vwaInit(root, parsed.rest[0], deps.reviewSettings?.(), deps.defaultMode?.())
      case 'status':
        return vwaStatus(root)
      case 'import':
        return vwaImport(root, parsed.rest[0] ?? '')
      case 'repair':
        return vwaRepair(root, parsed.rest[0] ?? '')
      case 'sign': {
        const pointer = readPointer(root)
        if (pointer === undefined)
          return { kind: 'error', text: '/vwa sign requires a current project (/vwa init first).' }
        return vwaSign(
          root,
          pointer.projectId,
          parsed.rest[0] ?? '',
          parsed.rest[1] ?? '',
          deps.readReceipt?.(agent, parsed.rest[1] ?? ''),
          deps.delivery?.(root, agent),
        )
      }
      case 'adjudicate': {
        const segments = [...parsed.rest]
        // §4.4: batch runs set setPointer:false, so the explicit projectId
        // wins; the pointer remains the fallback when it is omitted.
        const explicitProject = segments[0]?.startsWith('prj_') === true
        const projectId = explicitProject ? segments.shift()! : readPointer(root)?.projectId
        if (projectId === undefined)
          return { kind: 'error', text: '/vwa adjudicate requires a current project (/vwa init first).' }
        const [findingId = '', decision = ''] = segments
        const tail = segments.slice(2)
        const prevailingRunId = tail[0]?.startsWith('run_') ? tail.shift() : undefined
        if (decision !== 'accept' && decision !== 'reject') {
          return {
            kind: 'error',
            text: 'usage: /vwa adjudicate [projectId] <findingId> accept|reject [prevailingRunId] <reason>',
          }
        }
        return vwaAdjudicate(root, projectId, findingId, decision, tail.join(' '), prevailingRunId)
      }
    }
  } catch (error: unknown) {
    return {
      kind: 'error',
      text: `/vwa ${parsed.sub} failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { kind: 'error', text: 'unreachable' }
}

function vwaInit(
  root: string,
  projectId: string | undefined,
  reviewSettings?: FrozenReviewSettings,
  mode: 'draft' | 'reviewed' = 'draft',
): CommandResult {
  if (projectId !== undefined) {
    const head = new ProjectStore(root, projectId).readHead()
    if (!head.ok)
      return { kind: 'error', text: `project "${projectId}" does not exist or is unreadable: ${head.message}` }
    writePointer(root, projectId, head.data.snapshot.workspaceIdentity)
    return { kind: 'success', text: `Current VWA project is now "${projectId}" (revision ${head.data.head.revision}).` }
  }
  const newId = `prj_${randomUUID()}`
  const contract = { ...defaultContract('(set the project question with argument.update: contract)'), mode }
  // Feature C §C.2.4: capacity guidance from the FROZEN budget (informational
  // only; never a suggestion to change an existing project's budget).
  const frozen = reviewSettings ?? freezeReviewSettings()
  const maxCallsFittingBudget = Math.floor(frozen.budget.maxOutputTokensPerRun / frozen.budget.maxOutputTokensPerCall)
  const result = new ProjectStore(root, newId).init(contract, reviewSettings)
  if (!result.ok) return { kind: 'error', text: `project creation failed: ${result.message}` }
  writePointer(root, newId, result.data.workspaceIdentity)
  return {
    kind: 'success',
    text: [
      `Created VWA project ${newId} (revision 1) and bound the current-project pointer.`,
      'Contract candidate (default; refine with argument.update):',
      stableJson(contract),
      'Initialization triggered no search or review (§10.2).',
      `Budget capacity (frozen at init): ${maxCallsFittingBudget} full calls fit the output budget ` +
        `(${frozen.budget.maxOutputTokensPerRun}/${frozen.budget.maxOutputTokensPerCall}); ` +
        `with 50% retry headroom ≈ ${Math.floor(maxCallsFittingBudget / 1.5)} review calls per run.`,
      `Suggested claims batch size: ${suggestedClaimsBatchSize(frozen.budget)} — set review-claims-batch-size BEFORE creating projects ` +
        'with larger graphs. After init, revise capacity with the argument.update op set-review-settings — ' +
        'registered sources, evidence, claims and completed review records are preserved.',
    ].join('\n'),
  }
}

function vwaStatus(root: string): CommandResult {
  const pointer = readPointer(root)
  if (pointer === undefined) {
    return {
      kind: 'success',
      text: 'No current VWA project pointer (`.dsh/vwa/current-project.json` is missing or corrupt); lane-1 evaluation only.',
    }
  }
  const head = new ProjectStore(root, pointer.projectId).readHead()
  if (!head.ok) {
    return {
      kind: 'error',
      text: `current project "${pointer.projectId}" is not readable (STORE_CORRUPT candidates available via /vwa repair): ${head.message}`,
    }
  }
  const snapshot = head.data.snapshot
  const pending = readPendingRuns(root, pointer.projectId)
  return {
    kind: 'success',
    text: [
      `Pointer: projectId=${pointer.projectId}`,
      `Revision ${head.data.head.revision}, graphHash ${head.data.head.graphHash.slice(0, 12)}…`,
      `Sources: ${snapshot.sources.length}, claims: ${snapshot.claims.length}, artifacts: ${snapshot.artifacts.length}`,
      `Pending review runs: ${pending.length === 0 ? 'none' : pending.join(', ')}`,
      `Contract mode: ${snapshot.contract.mode}`,
    ].join('\n'),
  }
}

function vwaImport(root: string, relativeDirectory: string): CommandResult {
  const pointer = readPointer(root)
  if (pointer === undefined) return { kind: 'error', text: 'no current project; run /vwa init first.' }
  const directory = isAbsolute(relativeDirectory) ? relativeDirectory : join(root, relativeDirectory)
  const rel = relative(root, directory)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { kind: 'error', text: `import directory must be inside the workspace: ${relativeDirectory}` }
  }
  const store = new ProjectStore(root, pointer.projectId)
  const head = store.readHead()
  if (!head.ok) return { kind: 'error', text: `cannot read HEAD: ${head.message}` }
  const failures: string[] = []
  for (const source of head.data.snapshot.sources) {
    const verified = verifySnapshot(store, source)
    if (!verified.ok) failures.push(`source ${source.id}: ${verified.message}`)
  }
  for (const artifact of head.data.snapshot.artifacts) {
    const path = join(root, artifact.path)
    if (!existsSync(path)) {
      failures.push(`artifact ${artifact.id}: ${artifact.path} is missing`)
      continue
    }
    const hash = sha256Hex(readFileSync(path, 'utf8'))
    if (hash !== artifact.contentHash)
      failures.push(`artifact ${artifact.id}: bytes changed after binding (re-bind required)`)
  }
  if (failures.length > 0) {
    return {
      kind: 'error',
      text: `import REJECTED — verification failures (the pointer is unchanged):\n${failures.map((line) => `  - ${line}`).join('\n')}`,
    }
  }
  writePointer(root, pointer.projectId, head.data.snapshot.workspaceIdentity)
  return {
    kind: 'success',
    text: [
      `Import verified: ${head.data.snapshot.sources.length} source snapshot(s) and ${head.data.snapshot.artifacts.length} artifact(s) re-verified against actual bytes.`,
      'The current-project pointer is rebound; old reviews are kept as history and are stale for the current digest.',
    ].join('\n'),
  }
}

/** The /vwa sign transaction (§18). */
export async function vwaSign(
  root: string,
  projectId: string,
  artifactId: string,
  receiptHash: string,
  receipt?: ReceiptV2,
  service?: VwaArgumentService,
): Promise<CommandResult> {
  if (!/^[0-9a-f]{64}$/.test(receiptHash)) {
    return { kind: 'error', text: 'receiptHash must be a 64-hex SHA-256 digest.' }
  }
  if (
    !receipt ||
    receiptHashOf(receipt) !== receiptHash ||
    receipt.projectId !== projectId ||
    receipt.artifactId !== artifactId
  )
    return { kind: 'error', text: 'No existing receipt with this hash is available in the calling session.' }
  let check: Awaited<ReturnType<VwaArgumentService['checkForDelivery']>>['check']
  try {
    check = (await (service ?? new VwaArgumentService({ root })).checkForDelivery(projectId, artifactId)).check
  } catch (error: unknown) {
    return {
      kind: 'error',
      text: `consistency check failed for ${artifactId}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (
    receipt.artifactHash !== check.artifactHash ||
    receipt.graphHash !== check.graphHash ||
    receipt.policyHash !== check.policyHash ||
    receipt.reviewerConfigHash !== check.reviewerConfigHash
  )
    return { kind: 'error', text: 'Receipt inputs are no longer current; generate a new receipt before signing.' }
  try {
    if (sha256Hex(readFileSync(join(root, receipt.report.path), 'utf8')) !== receipt.report.hash)
      return { kind: 'error', text: 'The receipt report is missing or changed.' }
  } catch {
    return { kind: 'error', text: 'The receipt report is missing or changed.' }
  }
  if (check.findings.some((f) => f.code === 'EVID-01'))
    return { kind: 'error', text: 'Source integrity failed; the receipt cannot be signed.' }
  const signature: Signature = {
    signatureId: `sig_${randomUUID()}`,
    artifactId,
    artifactHash: check.artifactHash,
    graphHash: check.graphHash,
    receiptHash,
    policyHash: check.policyHash,
    signer: 'user',
    ts: new Date().toISOString(),
  }
  appendSignature(root, projectId, signature)
  const knownGaps = check.eligibleForReviewed
    ? ''
    : ' NOTE: the machine checks have NOT passed — this signature only means "the user reviewed the version with known gaps"; it changes no checks, grades, or overall.'
  return {
    kind: 'success',
    text: `Signed ${artifactId} (receipt ${receiptHash.slice(0, 12)}…, artifact ${check.artifactHash.slice(0, 12)}…). Signature ${signature.signatureId}.${knownGaps}`,
  }
}

function vwaRepair(root: string, projectId: string): CommandResult {
  const store = new ProjectStore(root, projectId)
  const candidates = store.recoveryCandidates()
  if (candidates.length === 0) {
    const head = store.readHead()
    if (head.ok)
      return {
        kind: 'success',
        text: `project "${projectId}" HEAD is healthy (revision ${head.data.head.revision}); no repair needed.`,
      }
    return { kind: 'error', text: `no self-verifying recovery candidates for "${projectId}": ${head.message}` }
  }
  const newest = candidates[0]
  const list = candidates
    .map((candidate) => `  - revision ${candidate.revision} (${candidate.revisionPath})`)
    .join('\n')
  if (newest === undefined) {
    return { kind: 'error', text: `no self-verifying recovery candidates for "${projectId}".` }
  }
  const repaired = store.repair(newest.revisionPath)
  if (!repaired.ok) {
    return {
      kind: 'error',
      text: `candidates (newest first):\n${list}\n\nadopting ${newest.revisionPath} FAILED: ${repaired.message}`,
    }
  }
  return {
    kind: 'success',
    text: `Candidates (newest first):\n${list}\n\nAdopted ${newest.revisionPath} — HEAD is now revision ${repaired.data.revision} after chain re-verification (§14.2).`,
  }
}

/**
 * Register the `/vwa` command on every composed command adapter. The
 * registry only dispatches human UI lines (source is always `user`, §10.2),
 * and the handler closes the grammar before any side effect.
 */
export function registerVwaCommand(
  ctx: { commands: { register(definition: unknown): unknown } },
  deps: VwaCommandDeps,
): void {
  ctx.commands.register(
    helpable({
      name: 'vwa',
      description: 'VWA lane-2 project commands (init/status/import/sign/adjudicate/repair)',
      handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
        const parsed = parseVwaArgs(invocation.rawInput)
        if (!parsed.ok) return { kind: 'error', text: parsed.usage }
        return executeVwa(deps, invocation.agent, parsed)
      },
    }),
  )
}
