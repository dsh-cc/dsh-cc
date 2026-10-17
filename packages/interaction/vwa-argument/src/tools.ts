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

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { readUserSettingsSync } from './settings.ts'
import { sha256Hex, stableJson } from './schema.ts'
import { VwaFail, fail, ProjectStore, type Result } from './store.ts'
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
  /** Session capture registry for trusted-event projection (§10.3). */
  captures: CaptureRegistry
  /** Bound-artifact text by path (bind-artifact reads it, §10.5). */
  artifactTexts: Map<string, string>
  /** Source snapshot texts by sourceId (quote validation, §5.1). */
  snapshotTexts: Map<string, string>
  maxEntities: number
  /**
   * Review collaborators (§10.6/Appendix A). Absent → `argument.review` is
   * disabled with REVIEW_UNAVAILABLE (never a synchronous long call).
   */
  review?: {
    adapter: ReviewModelAdapter
    budget: ReviewBudget
    tasks?: ReviewTaskService
    readSnapshot?(sourceId: Id): string | undefined
    emitProgress?(event: { runId: Id; stage: string; message: string }): void
  }
}

/** The §10.6 stage union: the audit stage dispatches extract+align (§12). */
const REVIEW_STAGES = new Set(['sources', 'support', 'claims', 'arguments'])
const ALL_ORDER: ReviewStage[] = ['sources', 'support', 'claims', 'arguments', 'audit']

/** Tool arguments: common write fields plus the op body (§10.1). */
interface ToolArgs {
  projectId: string
  expectedRevision: number
  requestId: string
  input: Record<string, unknown>
}

const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    projectId: { type: 'string' },
    revision: { type: 'integer' },
    data: { type: 'object' },
    code: { type: 'string' },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
  },
  required: ['ok'],
}

const COMMON_PARAMS = {
  projectId: { type: 'string', required: true, description: 'Project id (prj_…)' },
  expectedRevision: { type: 'integer', required: true, description: 'Current project revision (CAS guard)' },
  requestId: { type: 'string', required: true, description: 'UUID v4 idempotency key' },
  input: { type: 'object', required: true, description: 'Operation body (per the VWA lane-2 tool contract)' },
}

function toText(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: stableJson(value) }]
}

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
  apply: (snapshot: ProjectSnapshot, graph: GraphContext) => { result: unknown; files?: { path: string; bytes: Buffer }[] },
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
      const graph = new GraphContext(snapshot, deps.maxEntities, deps.snapshotTexts)
      for (const [path, text] of deps.artifactTexts) graph.artifactTexts.set(path, text)
      return apply(snapshot, graph)
    },
  })
}

function guard(raw: unknown): ToolArgs {
  const args = raw as ToolArgs
  if (typeof args?.projectId !== 'string' || typeof args?.expectedRevision !== 'number'
    || typeof args?.requestId !== 'string' || typeof args?.input !== 'object' || args.input === null) {
    throw new VwaFail(fail('SCHEMA_INVALID', 'input must carry projectId, expectedRevision, requestId, input'))
  }
  return args
}

/** Mount the three lane-2 tools (caller gates on semantic-enabled, §13). */
export function registerArgumentTools(ctx: { tools: { register(definition: ToolDefinition): unknown } }, deps: ToolDeps): void {
  const common = () => ({
    projectId: COMMON_PARAMS.projectId,
    expectedRevision: COMMON_PARAMS.expectedRevision,
    requestId: COMMON_PARAMS.requestId,
  })
  const finish = (result: Result<unknown>): unknown => result

  ctx.tools.register({
    name: 'evidence.register',
    description:
      'Register a source snapshot and optional evidence excerpts for a VWA lane-2 project. '
      + 'The snapshot is an exact byte copy of the cited file; quotes are read by the runtime '
      + 'from the given UTF-16 spans and are never passed by the model.',
    parameters: {
      ...common(),
      input: { type: 'object', required: true, description: 'body: {path, metadata, excerpts}' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
    async execute(raw, exec) {
      const args = guard(raw)
      return finish(runTool(deps, args, exec as ExecContext, { op: 'register', input: args.input }, (snapshot) => {
        const applied = registerSourceApply(
          new ProjectStore(deps.workspaceRoot(exec.agent) as string, args.projectId),
          deps.captures,
          args.input as never,
        )(snapshot)
        return { result: applied.result, files: applied.files }
      }))
    },
  })

  ctx.tools.register({
    name: 'evidence.search_log',
    description:
      'Record 1–50 search-log entries for a VWA lane-2 project. This tool performs no searches; '
      + 'it validates and atomically records already-executed (or planned/failed) search events.',
    parameters: {
      ...common(),
      input: { type: 'object', required: true, description: 'body: {entries: 1–50 SearchLog bodies minus system fields}' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
    async execute(raw, exec) {
      const args = guard(raw)
      return finish(runTool(deps, args, exec as ExecContext, { op: 'search_log', input: args.input }, (snapshot) => {
        const entries = (args.input as { entries?: unknown }).entries
        if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50) {
          throw new VwaFail(fail('SCHEMA_INVALID', 'entries must be an array of 1–50 search-log bodies'))
        }
        const now = new Date().toISOString()
        const ids: string[] = []
        for (const entry of entries as Record<string, unknown>[]) {
          const id = `search_${randomUUID()}`
          ids.push(id)
          const searchLog = { id, entityVersion: 1, createdAt: now, updatedAt: now, ...entry } as unknown as SearchLog
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
      }))
    },
  })

  ctx.tools.register({
    name: 'argument.update',
    description:
      'Atomically mutate a VWA lane-2 argument graph: set the project contract, upsert claims/'
      + 'evidence groups/arguments/issues, or bind the artifact. Full-graph validation runs before '
      + 'commit; failures report a stable error code and never partially commit.',
    parameters: {
      ...common(),
      input: { type: 'object', required: true, description: 'Mutation union: {op: set-contract|upsert|bind-artifact, …}' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
    async execute(raw, exec) {
      const args = guard(raw)
      return finish(runTool(deps, args, exec as ExecContext, { op: 'update', input: args.input }, (_snapshot, graph) => {
        const outcome = applyMutation(graph, args.input as Mutation)
        return { result: outcome }
      }))
    },
  })

  ctx.tools.register({
    name: 'argument.review',
    description:
      'Run a lane-2 semantic review stage (sources|support|claims|arguments|all) over the current graph '
      + 'revision. Registers a background run and returns immediately; the run NEVER modifies the body or '
      + 'the author graph. Repeating the same requestId returns the run state without re-calling the model.',
    parameters: {
      ...common(),
      input: { type: 'object', required: true, description: 'body: {artifactId?, targetClaimIds?: Id[], stage}' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => toText(value) },
    async execute(raw, exec) {
      const args = guard(raw)
      if (deps.review === undefined) {
        return fail('REVIEW_UNAVAILABLE', 'no review adapter or background task service is mounted', true)
      }
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
      // §11.1: requests that no longer match expectedRevision fail BEFORE any model call.
      if (args.expectedRevision !== head.data.head.revision) {
        return fail('REVISION_CONFLICT', `expectedRevision ${args.expectedRevision} is not HEAD ${head.data.head.revision}`, true)
      }
      const runStore = new ReviewRunStore(root, args.projectId)
      // §10.6: same requestId running → {completion:'running'}; same requestId
      // finished → the stored result; continuing requires a NEW requestId.
      const existing = runStore.findRunByRequestId(args.requestId)
      if (existing !== undefined) {
        const records = runStore.readRecords(existing.runId)
        return {
          ok: true, projectId: args.projectId, revision: head.data.head.revision,
          data: existing.status === 'running'
            ? { completion: 'running' as const, runId: existing.runId, taskId: existing.runId }
            : {
              completion: existing.status === 'completed' ? ('completed' as const) : ('incomplete' as const),
              status: existing.status,
              runId: existing.runId,
              records,
            },
        }
      }
      const runId = `run_${randomUUID()}`
      const taskId = runId
      const snapshot = head.data.snapshot
      const stages: ReviewStage[] = stage === 'all' ? ALL_ORDER : [stage as ReviewStage]
      // Disabled without a task service (Appendix A): REVIEW_UNAVAILABLE, never a blocking call.
      let tasks: ReviewTaskService
      try {
        tasks = deps.review.tasks ?? createHostTaskService(undefined)
      } catch {
        return fail('REVIEW_UNAVAILABLE', 'no background task service is mounted', true)
      }
      const review = deps.review
      // §12: the audit stage needs the bound artifact's ACTUAL bytes; the
      // artifact is resolved from the bound snapshot + the host text map.
      let artifact: { id: string; path: string; text: string } | undefined
      if (stage === 'audit' || stage === 'all') {
        const bound = body.artifactId !== undefined
          ? snapshot.artifacts.find((art) => art.id === body.artifactId)
          : snapshot.artifacts.length === 1 ? snapshot.artifacts[0] : undefined
        if (bound === undefined) {
          return fail('SCHEMA_INVALID', 'the audit stage requires exactly one bound artifact (pass artifactId when several are bound)', false)
        }
        const text = deps.artifactTexts.get(bound.path)
        if (text === undefined) return fail('INPUT_CHANGED', `artifact text for ${bound.path} is not available to the runtime`, true)
        artifact = { id: bound.id, path: bound.path, text }
      }
      const started = tasks.start(taskId, runId, async (signal) => {
        await executeReviewRun({
          deps: {
            root,
            adapter: review.adapter,
            budget: review.budget,
            contractHash: sha256Hex(stableJson(snapshot.contract)),
            ...(review.readSnapshot === undefined ? {} : { readSnapshot: review.readSnapshot }),
            ...(review.emitProgress === undefined ? {} : { emitProgress: review.emitProgress }),
          },
          runId,
          requestId: args.requestId,
          stages,
          targetClaimIds: body.targetClaimIds ?? [],
          snapshot,
          signal,
          ...(artifact === undefined ? {} : { artifact }),
        })
      })
      if (!started) return fail('REVIEW_UNAVAILABLE', 'background task owner cap exceeded (10)', true)
      return {
        ok: true, projectId: args.projectId, revision: head.data.head.revision,
        data: { completion: 'started' as const, runId, taskId },
      }
    },
  })
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
  ctx.inject(['tools'], (tools: unknown) => {
    const registrar = tools as unknown as { register(definition: ToolDefinition): unknown }
    registerArgumentTools({ tools: registrar }, deps)
  })
}
