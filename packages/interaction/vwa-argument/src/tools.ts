import { COMMON_PARAMS, RESULT_SCHEMA, guard, toText, type ToolArgs } from './tool-input.ts'
/**
 * Author-facing tools (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §10.3/§10.4/§10.5): `evidence.register`, `evidence.search_log`,
 * `argument.update`.
 *
 * Registration gate (§13): tools are mounted ONLY when
 * `vwa-argument.semantic-enabled` is true in the raw settings file. Tool
 * input = the §10 body minus system fields; `requestId` idempotency
 * (§10.1/D07) is enforced by the store's operation records.
 *
 * Tools are plain ToolDefinition-compatible objects (raw JSON-Schema
 * parameters + `output.schema/render`), the contract `ctx.tools.register`
 * enforces; the defineTool DSL adds nothing this slice needs.
 *
 * @module @dsh-cc/vwa-argument/tools
 */

import { reportTool } from './report-tool.ts'
import type { VwaArgumentService } from './report.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readUserSettingsSync } from './settings.ts'
import { sha256Hex, stableJson, authorDefValidator, ajvErrors } from './schema.ts'
import { VwaFail, fail, ProjectStore, type Fail, type Result } from './store.ts'
import { applyMutation, GraphContext, type Mutation } from './graph.ts'
import { CaptureRegistry, registerSourceApply } from './sources.ts'
import type { Id, ProjectSnapshot, SearchLog } from './types.ts'
import type { ReviewStage } from './review-plan.ts'
import { createHostTaskService, type ReviewBudget, type ReviewTaskService } from './review-tasks.ts'
import { executeReviewRun } from './review-runner.ts'
import { ReviewRunStore } from './review-run-store.ts'
import type { ReviewModelAdapter } from './review-adapter.ts'

/** The minimal registration face of the harness tool runtime (no hard dep). */
export interface ToolRegistrar {
  register(definition: ToolDefinition): unknown
}

/** ToolDefinition-compatible shape this slice registers. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): { type: 'text'; text: string }[]
  }
  execute(args: unknown, exec: ExecContext): Promise<unknown>
}

/** Collaborators injected per mount; tests substitute fakes. */
export interface ToolDeps {
  /** Workspace root for the executing agent (session cwd; undefined → refuse). */
  workspaceRoot(agent: unknown): string | undefined
  /** Capture registry for trusted-event projection (§10.3): fixed, or per calling session. */
  captures: CaptureRegistry | ((agent: unknown) => CaptureRegistry)
  /**
   * Artifact bytes by workspace-relative path when `artifactTexts` has no
   * entry (production: the caller's workspace file, capture-wiring.ts).
   */
  readArtifact?(root: string, path: string): string | undefined
  /** Bound-artifact text by path (bind-artifact reads it, §10.5). */
  artifactTexts: Map<string, string>
  /** Source snapshot texts by sourceId (quote validation, §5.1). */
  snapshotTexts: Map<string, string>
  maxEntities: number
  report?(root: string, agent: unknown): VwaArgumentService
  /**
   * Review collaborators (§10.6/Appendix A). Absent → `argument.review` is
   * disabled with REVIEW_UNAVAILABLE (never a synchronous long call).
   */
  review?: ReviewCollaborators | ((agent: unknown) => ReviewCollaborators | Fail)
}

/** The review collaborator bundle (Appendix A); production builds it per call (review-host.ts). */
export interface ReviewCollaborators {
  adapter: ReviewModelAdapter
  budget: ReviewBudget
  tasks?: ReviewTaskService
  /** Snapshot text by source id; defaults to the project's on-disk exact-byte snapshot. */
  readSnapshot?(sourceId: Id): string | undefined
  maxArtifactChars?: number
  maxContextChars?: number
  emitProgress?(event: { runId: Id; stage: string; message: string }): void
}

/** The §10.6 stage union: the audit stage dispatches extract+align (§12). */
const REVIEW_STAGES = new Set(['sources', 'support', 'claims', 'arguments'])
const ALL_ORDER: ReviewStage[] = ['sources', 'support', 'claims', 'arguments', 'audit']

/** Tool execution context: identity signal plus optional agent for cwd resolution. */
interface ExecContext {
  signal: AbortSignal
  agent?: unknown
}

/** Run one store transaction, translating VwaFail into the uniform envelope (§10.1). */
function runTool(
  deps: ToolDeps,
  args: ToolArgs,
  exec: ExecContext,
  payloadHashSeed: Record<string, unknown>,
  apply: (
    snapshot: ProjectSnapshot,
    graph: GraphContext,
  ) => { result: unknown; files?: { path: string; bytes: Buffer }[] },
): Result<unknown> {
  const root = deps.workspaceRoot(exec.agent)
  if (root === undefined) {
    return fail('STORE_IO_FAILED', 'no workspace root is bound to this session', false)
  }
  const store = new ProjectStore(root, args.projectId)
  const payloadHash = sha256Hex(stableJson(payloadHashSeed))
  return store.withTransaction<unknown>({
    expectedRevision: args.expectedRevision,
    requestId: args.requestId,
    payloadHash,
    applyFn: (snapshot) => {
      const reader = deps.readArtifact === undefined ? undefined : (path: string) => deps.readArtifact?.(root, path)
      const graph = new GraphContext(snapshot, deps.maxEntities, deps.snapshotTexts, reader)
      for (const [path, text] of deps.artifactTexts) graph.artifactTexts.set(path, text)
      return apply(snapshot, graph)
    },
  })
}

/** Mount the three lane-2 tools (caller gates on semantic-enabled, §13). */
export function registerArgumentTools(
  registrar: { tools: { register(definition: ToolDefinition): unknown } },
  deps: ToolDeps,
): void {
  registrar.tools.register(reportTool(deps))
  const common = () => ({
    projectId: COMMON_PARAMS.projectId,
    expectedRevision: COMMON_PARAMS.expectedRevision,
    requestId: COMMON_PARAMS.requestId,
  })
  // Tool values must be lossless JSON: normalize away undefined members.
  const finish = (result: Result<unknown>): unknown => JSON.parse(JSON.stringify(result)) as unknown

  registrar.tools.register({
    name: 'evidence.register',
    description:
      'Register a source snapshot and optional evidence excerpts for a VWA lane-2 project. ' +
      'The snapshot is an exact byte copy of the cited file; quotes are read by the runtime ' +
      'from the given UTF-16 spans and are never passed by the model.',
    parameters: {
      ...common(),
      input: { type: 'object', required: true, description: 'body: {path, metadata, excerpts}' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
    async execute(raw, exec) {
      const args = guard(raw)
      if ('ok' in args) return args
      return finish(
        runTool(deps, args, exec as ExecContext, { op: 'register', input: args.input }, (snapshot) => {
          const applied = registerSourceApply(
            new ProjectStore(deps.workspaceRoot(exec.agent) as string, args.projectId),
            typeof deps.captures === 'function' ? deps.captures(exec.agent) : deps.captures,
            args.input as never,
          )(snapshot)
          return { result: applied.result, files: applied.files }
        }),
      )
    },
  })

  registrar.tools.register({
    name: 'evidence.search_log',
    description:
      'Record 1–50 search-log entries for a VWA lane-2 project. This tool performs no searches; ' +
      'it validates and atomically records already-executed (or planned/failed) search events.',
    parameters: {
      ...common(),
      input: {
        type: 'object',
        required: true,
        description: 'body: {entries: 1–50 SearchLog bodies minus system fields}',
      },
    },
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
    async execute(raw, exec) {
      const args = guard(raw)
      if ('ok' in args) return args
      return finish(
        runTool(deps, args, exec as ExecContext, { op: 'search_log', input: args.input }, (snapshot) => {
          const entries = (args.input as { entries?: unknown }).entries
          if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50) {
            throw new VwaFail(fail('SCHEMA_INVALID', 'entries must be an array of 1–50 search-log bodies'))
          }
          const now = new Date().toISOString()
          const ids: string[] = []
          for (const entry of entries as Record<string, unknown>[]) {
            const id = `search_${randomUUID()}`
            ids.push(id)
            if (['id', 'entityVersion', 'createdAt', 'updatedAt'].some((key) => key in entry))
              throw new VwaFail(fail('SCHEMA_INVALID', 'search system fields are runtime-owned'))
            const searchLog = { ...entry, id, entityVersion: 1, createdAt: now, updatedAt: now } as unknown as SearchLog
            const validate = authorDefValidator('SearchLog')
            if (!validate(searchLog)) throw new VwaFail(fail('SCHEMA_INVALID', ajvErrors(validate)))
            if (searchLog.state === 'executed' && !searchLog.executionEventRef && !searchLog.externalAttestation)
              throw new VwaFail(
                fail(
                  'SCHEMA_INVALID',
                  'executed search requires a tool event reference or explicit external attestation',
                ),
              )
            for (const targetId of searchLog.targetIds) {
              if (!snapshot.claims.some((claim) => claim.id === targetId)) {
                throw new VwaFail(fail('REFERENCE_INVALID', `search log references unknown claim ${targetId}`))
              }
            }
            if (searchLog.state === 'planned' && searchLog.executionEventRef !== undefined) {
              throw new VwaFail(fail('SCHEMA_INVALID', 'planned entries must not claim an execution event'))
            }
            snapshot.searches.push(searchLog)
          }
          return { result: { searchIds: ids } }
        }),
      )
    },
  })

  registrar.tools.register({
    name: 'argument.update',
    description:
      'Atomically mutate a VWA lane-2 argument graph: set the project contract, upsert claims/' +
      'evidence groups/arguments/issues, or bind the artifact. Full-graph validation runs before ' +
      'commit; failures report a stable error code and never partially commit.',
    parameters: {
      ...common(),
      input: {
        type: 'object',
        required: true,
        description: 'Mutation union: {op: set-contract|upsert|bind-artifact, …}',
      },
    },
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
    async execute(raw, exec) {
      const args = guard(raw)
      if ('ok' in args) return args
      return finish(
        runTool(deps, args, exec as ExecContext, { op: 'update', input: args.input }, (_snapshot, graph) => {
          const outcome = applyMutation(graph, args.input as Mutation)
          return { result: outcome }
        }),
      )
    },
  })

  registrar.tools.register({
    name: 'argument.review',
    description:
      'Run a lane-2 semantic review stage (sources|support|claims|arguments|all) over the current graph ' +
      'revision. Registers a background run and returns immediately; the run NEVER modifies the body or ' +
      'the author graph. Repeating the same requestId returns the run state without re-calling the model.',
    parameters: {
      ...common(),
      input: { type: 'object', required: true, description: 'body: {artifactId?, targetClaimIds?: Id[], stage}' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
    async execute(raw, exec) {
      const args = guard(raw)
      if ('ok' in args) return args
      const body = args.input as { artifactId?: string; targetClaimIds?: string[]; stage?: string }
      const stage = body.stage
      if (stage === undefined || (stage !== 'all' && stage !== 'audit' && !REVIEW_STAGES.has(stage))) {
        return fail('SCHEMA_INVALID', `stage must be sources|support|claims|arguments|all|audit, got ${String(stage)}`)
      }
      const root = deps.workspaceRoot(exec.agent)
      if (root === undefined) return fail('STORE_IO_FAILED', 'no workspace root is bound to this session', false)
      const store = new ProjectStore(root, args.projectId)
      const head = store.readHead()
      if (!head.ok) return head
      const runStore = new ReviewRunStore(root, args.projectId)
      const payloadHash = sha256Hex(stableJson({ expectedRevision: args.expectedRevision, input: args.input }))
      // §10.6: same requestId running → {completion:'running'}; same requestId
      // finished → the stored result; continuing requires a NEW requestId.
      const existing = runStore.findRunByRequestId(args.requestId)
      if (existing !== undefined) {
        if (existing.payloadHash !== undefined && existing.payloadHash !== payloadHash)
          return fail('IDEMPOTENCY_CONFLICT', 'requestId was used with a different review payload')
        const records = runStore.readRecords(existing.runId)
        return {
          ok: true,
          projectId: args.projectId,
          revision: head.data.head.revision,
          data:
            existing.status === 'running' || existing.status === 'queued'
              ? { completion: 'running' as const, runId: existing.runId, taskId: existing.taskId ?? existing.runId }
              : {
                  completion: existing.status === 'completed' ? ('completed' as const) : ('incomplete' as const),
                  status: existing.status,
                  runId: existing.runId,
                  records,
                  ...(runStore.readOutcome(existing.runId) === undefined
                    ? {}
                    : { result: runStore.readOutcome(existing.runId) }),
                  usage: {
                    calls: existing.calls,
                    inputTokens: existing.inputTokens,
                    outputTokens: existing.outputTokens,
                  },
                },
        }
      }
      // §11.1: requests that no longer match expectedRevision fail BEFORE any model call.
      if (args.expectedRevision !== head.data.head.revision) {
        return fail(
          'REVISION_CONFLICT',
          `expectedRevision ${args.expectedRevision} is not HEAD ${head.data.head.revision}`,
          true,
        )
      }
      if (deps.review === undefined) {
        return fail('REVIEW_UNAVAILABLE', 'no review adapter or background task service is mounted', true)
      }
      const resolved = typeof deps.review === 'function' ? deps.review(exec.agent) : deps.review
      if ('ok' in resolved) return resolved
      const runId = `run_${randomUUID()}`
      const taskId = runId
      const snapshot = head.data.snapshot
      if (
        body.targetClaimIds !== undefined &&
        (!Array.isArray(body.targetClaimIds) ||
          body.targetClaimIds.some((id) => typeof id !== 'string' || !snapshot.claims.some((c) => c.id === id)))
      )
        return fail('REFERENCE_INVALID', 'review targets must be existing claims in this project')
      if (body.artifactId !== undefined && !snapshot.artifacts.some((a) => a.id === body.artifactId))
        return fail('REFERENCE_INVALID', 'artifactId is not bound in this project')
      const stages: ReviewStage[] = stage === 'all' ? ALL_ORDER : [stage as ReviewStage]
      // Disabled without a task service (Appendix A): REVIEW_UNAVAILABLE, never a blocking call.
      let tasks: ReviewTaskService
      try {
        tasks = resolved.tasks ?? createHostTaskService(undefined)
      } catch {
        return fail('REVIEW_UNAVAILABLE', 'no background task service is mounted', true)
      }
      const review = { ...resolved, ...snapshot.contract.reviewSettings }
      // §11.4: quotes/context come from the exact-byte snapshot on disk unless the host overrides.
      const readSnapshot =
        review.readSnapshot ??
        ((sourceId: Id): string | undefined => {
          try {
            return readFileSync(join(store.snapshotDir, `${sourceId}.md`), 'utf8')
          } catch {
            return undefined
          }
        })
      // §12: the audit stage needs the bound artifact's ACTUAL bytes; the
      // artifact is resolved from the bound snapshot + the host text map.
      let artifact: { id: string; path: string; text: string } | undefined
      if (stage === 'audit' || stage === 'all') {
        const bound =
          body.artifactId !== undefined
            ? snapshot.artifacts.find((art) => art.id === body.artifactId)
            : snapshot.artifacts.length === 1
              ? snapshot.artifacts[0]
              : undefined
        if (bound === undefined) {
          return fail(
            'SCHEMA_INVALID',
            'the audit stage requires exactly one bound artifact (pass artifactId when several are bound)',
            false,
          )
        }
        const text = deps.artifactTexts.get(bound.path) ?? deps.readArtifact?.(root, bound.path)
        if (text !== undefined && sha256Hex(text) !== bound.contentHash)
          return fail('INPUT_CHANGED', 'artifact bytes changed after binding; re-bind before review', true)
        if (text === undefined)
          return fail('INPUT_CHANGED', `artifact text for ${bound.path} is not available to the runtime`, true)
        artifact = { id: bound.id, path: bound.path, text }
      }
      runStore.reserveRequest(runId, {
        schemaVersion: 1,
        requestId: args.requestId,
        runId,
        stage: stages.join('+'),
        targetClaimIds: resolveTargetClaimIds(snapshot, body),
        payloadHash,
        taskId,
        status: 'queued',
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
        startedAt: new Date().toISOString(),
      })
      const started = tasks.start(taskId, runId, async (signal) => {
        await executeReviewRun({
          deps: {
            root,
            adapter: review.adapter,
            budget: review.budget,
            ...(review.maxArtifactChars ? { maxArtifactChars: review.maxArtifactChars } : {}),
            ...(review.maxContextChars ? { maxContextChars: review.maxContextChars } : {}),
            contractHash: sha256Hex(stableJson(snapshot.contract)),
            readSnapshot,
            emitProgress: (event) => {
              tasks.emitProgress(event)
              review.emitProgress?.(event)
            },
          },
          runId,
          requestId: args.requestId,
          stages,
          targetClaimIds: resolveTargetClaimIds(snapshot, body),
          snapshot,
          signal,
          ...(artifact === undefined ? {} : { artifact }),
        })
      })
      if (!started) {
        const queued = runStore.readRequest(runId)!
        runStore.writeRequest(runId, { ...queued, status: 'incomplete' })
        return fail('REVIEW_UNAVAILABLE', 'background task owner cap exceeded (10)', true)
      }
      const queued = runStore.readRequest(runId)
      if (queued) runStore.writeRequest(runId, { ...queued, taskId: tasks.hostId?.(taskId) ?? taskId })
      return {
        ok: true,
        projectId: args.projectId,
        revision: head.data.head.revision,
        data: { completion: 'started' as const, runId, taskId: tasks.hostId?.(taskId) ?? taskId },
      }
    },
  })
}

/**
 * §10.6 target defaulting: an empty targetClaimIds means every claim with an
 * occurrence in the bound artifact (the named one, or the only one); with no
 * bound artifact, every project claim.
 */
export function resolveTargetClaimIds(
  snapshot: ProjectSnapshot,
  body: { artifactId?: string; targetClaimIds?: string[] },
): Id[] {
  if (body.targetClaimIds !== undefined && body.targetClaimIds.length > 0) return body.targetClaimIds
  const artifact =
    body.artifactId !== undefined
      ? snapshot.artifacts.find((candidate) => candidate.id === body.artifactId)
      : snapshot.artifacts.length === 1
        ? snapshot.artifacts[0]
        : undefined
  if (artifact !== undefined) return [...new Set(artifact.occurrences.map((occurrence) => occurrence.claimId))]
  return snapshot.claims.map((claim) => claim.id)
}

/** True when the lane-2 feature gate is on in the raw settings file (§13). */
export function semanticEnabled(dshHome: string): boolean {
  return readUserSettingsSync(dshHome)['semantic-enabled']
}

/**
 * Apply-time wiring: register the tools ONLY when semantic-enabled is true
 * (feature gate; cc/lane-1 unchanged). When the harness tools service is not
 * mounted in this context, the inject simply never fires.
 */
export function mountArgumentTools(ctx: Context, deps: ToolDeps, dshHome: string): void {
  if (!semanticEnabled(dshHome)) return
  // cordis passes the injected sub-context, not the service, to the callback.
  ctx.inject(['tools'], (injected: Context) => {
    const registrar = (injected as unknown as { tools: { register(definition: ToolDefinition): unknown } }).tools
    registerArgumentTools({ tools: registrar }, deps)
  })
}
