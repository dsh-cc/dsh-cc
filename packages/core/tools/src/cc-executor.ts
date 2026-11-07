/**
 * FORK DRIFT (D7 — executor composition): the `native` / `code` / `both`
 * ToolExecutor plugin.
 *
 * Upstream split tool execution into pluggable {@link ToolExecutor}s
 * (`ctx.tools.setExecutor`): the registry now only registers and resolves
 * definitions, while an executor owns the model-facing projection and the
 * batch settlement. This module re-hosts the fork's Code Mode presentation
 * (`run_code` transport, generated SDK section, `code` collapse rule) as such
 * an executor over upstream's `executeToolBatch` + `ToolExecutionPipeline`.
 *
 * Ported from the pre-re-vendor fork (`code-mode.ts`, `run-code-defs.ts`,
 * `runtime-schemas.ts`) with the deltas this fork keeps:
 * - `'code'` / `'both'` presentation modes (the `'both'` mode has no
 *   code-only rule — its native calls do execute);
 * - `tool/code-dispatch-start` / `tool/code-dispatch` session events plus the
 *   live `tools/code-dispatch-log` waterfall (fork event vocabulary, already
 *   registered in `KNOWN_SESSION_EVENT_TYPES` by `./types.ts`);
 * - `run_code` cwd resolution through `ctx.workingDirectory`;
 * - no `sandbox_permissions` / `justification` controls and no
 *   `approveEscalation` flow: dsh-cc resolves the standing sandbox policy
 *   outside this transport, so the request never carries a `sandboxPolicy`.
 *
 * The per-call execution-identity instrumentation is the registry's
 * `tools/execute` waterfall hook (`./current-execution.ts`), NOT a wrapper
 * here.
 * @module @dsh-cc/tools/executor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction, PtcRunResult, PtcRunSandbox, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { RUN_CODE_NAME, ToolNotFoundError } from './contracts.ts'
import type {
  CodeDispatchLog, ToolDefinition, ToolExecutionResult, ToolRunContext,
} from './contracts.ts'
import type {
  ToolBatchInput, ToolBatchResult, ToolExecutor, ToolModelInput, ToolPromptSection,
} from './executor.ts'
import type { ToolsService } from './index.ts'
import { ToolExecutionPipeline, executeToolBatch, toolErrorMessage } from './pipeline.ts'
import { renderToolsSdkPy } from './py-sdk-doc.ts'
import { jsonSchemaToPy } from './py-types.ts'
import { defineTool, parameterSchemaSpecToJsonSchema, projectToolSchema } from './schema.ts'
import { jsonSchemaToTs, renderToolsSdk, type ToolSdkSchema } from './ts-types.ts'
import { CODE_DISPATCH_EVENT, CODE_DISPATCH_START_EVENT } from './types.ts'
// Type-only: resolves `ctx.workingDirectory` and `ctx.systemPrompt` augmentations.
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** The foreign-CLI-compatible presentation modes this executor implements. */
export type ToolPresentationMode = 'native' | 'code' | 'both'

/** Executor configuration shared by plugin mounting and direct construction. */
export interface Config {
  /** `native` = function-calling; `code` = `run_code` only; `both` = both forms (no code-only rule). */
  mode: ToolPresentationMode
  /** Maximum overlapping concurrency-safe `run_code` sub-dispatches. */
  maxParallelSubCalls: number
}

/** Validated executor configuration. */
export const Config: z<Partial<Config>, Config> = z.object({
  mode: z.union(['native', 'code', 'both'] as const).default('native'),
  maxParallelSubCalls: z.natural().min(1).default(10),
})

/**
 * Prompt order of the `code` collapse statement: after the persona and before
 * the per-tool guidance band, so the model reads which tools it may call
 * before it reads what each one is for.
 */
const COLLAPSE_SECTION_ORDER = 99

/** The `tools:sdk` section order: inside the 100–199 tool-guidance band, after per-tool guidance. */
const SDK_SECTION_ORDER = 150

/**
 * The model-facing statement of the `code` collapse. Names the consequence
 * (the call fails) and the route (inside the program), because a rule the
 * model can only discover by being denied is one it corrects too late.
 */
const CODE_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`

/** The `description` parameter's model-facing description (language-independent). */
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
  = 'Clear, concise description of what this program does in active voice, '
    + '5-10 words (shown in the UI). Examples: "Count TODO markers across packages"; '
    + '"Read failing test and its fixture"; "Rename config key in every cordis.yml".'

/** Language-specific `run_code` schema text: the tool `description` and its `code` parameter description. */
interface RunCodeFlavor {
  /** The tool `description` the model sees for this language. */
  readonly description: string
  /** The `code` parameter's description for this language. */
  readonly codeDescription: string
}

/**
 * The TypeScript flavor: the fallback for a schema read with no runtime
 * mounted ({@link resolveFlavor} owns which readers reach that).
 */
const TYPESCRIPT_FLAVOR: RunCodeFlavor = {
  description:
    'Execute a TypeScript program against the available tools. Takes two required '
    + 'arguments: `code`, the BODY of an async function (erasable syntax only; top-level '
    + '`await` and `return` work), and `description`, a short summary of what the program '
    + 'does. Call tools as `await tools.name(args)` per the declarations in the system '
    + 'prompt. Only what you print or return comes back — curate it.',
  codeDescription: 'The program: the body of an async TypeScript function.',
}

/**
 * The Python flavor: the body of an async function, top-level `await` and
 * `return`, answer via `print` and/or the returned value.
 */
const PYTHON_FLAVOR: RunCodeFlavor = {
  description:
    'Execute a Python program against the available tools. Takes two required '
    + 'arguments: `code`, the BODY of an async function (top-level `await` and `return` '
    + 'work), and `description`, a short summary of what the program does. Call tools as '
    + '`await tools.name(args)` per the declarations in the system prompt. Answer '
    + 'with `print(...)` and/or `return <value>` — only that comes back, so curate it.',
  codeDescription: 'The program: the body of an async Python function.',
}

/** Languages Code Mode ships a presentation for (schema flavor + SDK renderer). */
export type CodeSdkLanguage = 'typescript' | 'python'

const RUN_CODE_FLAVORS: Record<string, RunCodeFlavor> = {
  typescript: TYPESCRIPT_FLAVOR,
  python: PYTHON_FLAVOR,
} satisfies Record<CodeSdkLanguage, RunCodeFlavor>

const SDK_RENDERERS: Record<string, (schemas: ToolSdkSchema[]) => string> = {
  typescript: renderToolsSdk,
  python: renderToolsSdkPy,
} satisfies Record<CodeSdkLanguage, (schemas: ToolSdkSchema[]) => string>

/**
 * Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
 * schema-emission time so the model-visible `run_code` schema always matches
 * the SDK section's language.
 * @param peekRuntime - runtime reader that does not throw when none is mounted.
 * @returns the flavor the emitted schema must use.
 */
function resolveFlavor(peekRuntime: () => PtcRuntime | undefined): RunCodeFlavor {
  const runtime = peekRuntime()
  if (runtime === undefined) return TYPESCRIPT_FLAVOR
  // Own-property read: a language like `toString`/`constructor` would otherwise
  // resolve an inherited Object.prototype member as a flavor.
  const flavor = RUN_CODE_FLAVORS[runtime.language]
  if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === undefined) {
    const known = Object.keys(RUN_CODE_FLAVORS).map(name => JSON.stringify(name)).join(', ')
    throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
  }
  return flavor
}

/**
 * Read the active runtime, rejecting a missing provider and an unsupported
 * language. Read at use time (assembly / `run_code` execution), NOT via static
 * `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
 * behind it — hostage to a code runtime existing even under `mode: 'native'`.
 * @param ctx - executor context containing the runtime provider.
 * @param mode - the presentation mode that requires the runtime (for the message).
 * @returns the mounted PTC runtime.
 */
export function requirePtcRuntime(ctx: Context, mode: ToolPresentationMode): PtcRuntime {
  const runtime = ctx.get('ptcRuntime')
  if (!runtime) {
    throw new Error(`dsh-tools: mode "${mode}" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or set tools mode to "native"`)
  }
  if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
    const known = Object.keys(SDK_RENDERERS).map(name => JSON.stringify(name)).join(', ')
    throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
  }
  return runtime
}

/**
 * Escalation guidance appended wherever the model sees a sandbox denial or
 * the `run_code` schema: wider access is per-execution, evidence-first, and
 * never replayed.
 * @param runtime - the active runtime, or undefined when none is mounted.
 * @returns the guidance tail, or an empty string when the runtime enforces no file policy.
 */
function escalationGuidance(runtime: PtcRuntime | undefined): string {
  return runtime?.sandboxMode === undefined ? ''
    : ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.'
}

/**
 * Snapshot one binding call's argument as lossless JSON, then snapshot that
 * detached value again so dispatch and logging stay independent.
 * @param value - the raw binding argument.
 * @returns the dispatched and the logged snapshots.
 */
function jsonNormalizeArgs(value: unknown): { dispatched: unknown; logged: unknown } {
  let snapshot: JsonValue | undefined
  try {
    snapshot = snapshotJsonValue(value) as JsonValue | undefined
  } catch (error: unknown) {
    throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (snapshot === undefined) {
    throw new Error('tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)')
  }
  const logged = snapshotJsonValue(snapshot)
  /* v8 ignore next -- snapshot is already a detached lossless JSON value. */
  if (logged === undefined) {
    throw new Error('tool arguments could not be detached for durable logging')
  }
  return { dispatched: snapshot, logged }
}

/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
const JSON_INDENT = '  '

/**
 * ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
 * renderer also caps TOTAL indentation there, compacting deeper subtrees, so
 * formatted output remains linear in the canonical JSON size.
 */
const MAX_JSON_INDENT_CHARS = 10

/** A pending fragment in the iterative JSON presentation traversal. */
type JsonRenderTask =
  | { kind: 'text'; text: string }
  | { kind: 'value'; value: JsonValue; depth: number; compact: boolean }

/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
function renderJsonValue(value: Exclude<JsonValue, string>): string {
  const chunks: string[] = []
  const tasks: JsonRenderTask[] = [{ kind: 'value', value, depth: 0, compact: false }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'text') {
      chunks.push(task.text)
      continue
    }

    const current = task.value
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      chunks.push(String(current))
      continue
    }
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
      continue
    }

    const compact = task.compact || (task.depth + 1) * JSON_INDENT.length > MAX_JSON_INDENT_CHARS
    const childDepth = task.depth + 1
    if (Array.isArray(current)) {
      chunks.push('[')
      if (current.length === 0) {
        chunks.push(']')
        continue
      }
      tasks.push({ kind: 'text', text: compact ? ']' : `\n${JSON_INDENT.repeat(task.depth)}]` })
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index]
        /* v8 ignore next -- canonical JsonValue arrays are dense. */
        if (item === undefined) throw new Error('cannot render a sparse JSON array')
        tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
        tasks.push({
          kind: 'text',
          text: compact
            ? index === 0 ? '' : ','
            : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}`,
        })
      }
      continue
    }

    const keys = Object.keys(current)
    chunks.push('{')
    if (keys.length === 0) {
      chunks.push('}')
      continue
    }
    tasks.push({ kind: 'text', text: compact ? '}' : `\n${JSON_INDENT.repeat(task.depth)}}` })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) throw new Error('cannot render a missing JSON object key')
      const item = current[key]
      /* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
      if (item === undefined) throw new Error('cannot render an undefined JSON object property')
      tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
      tasks.push({
        kind: 'text',
        text: compact
          ? `${index === 0 ? '' : ','}${JSON.stringify(key)}:`
          : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `,
      })
    }
  }
  return chunks.join('')
}

/**
 * Render one present program completion value for the model-facing result text.
 * @param value - the canonical completion value.
 * @returns the model-facing text.
 */
function renderValue(value: JsonValue): string {
  return typeof value === 'string' ? value : renderJsonValue(value)
}

/** Thrown by `run_code` when the program run itself failed (exception, budget, abort, substrate death). */
export class CodeRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RUN_FAILED')
    this.name = 'CodeRunFailedError'
  }
}

/** Canonical value returned by the outer Code Mode transport. */
type RunCodeOutput = { logs: string[]; result?: JsonValue; sandbox?: PtcRunSandbox }

/**
 * Resolve the program's working directory from the Session's directory state.
 * Only Agent-owned programs require it; unowned programs can run without this
 * service.
 * @param ctx - executor context.
 * @param exec - the outer `run_code` execution.
 * @returns the session directory, or undefined for an unowned program.
 */
async function resolveWorkingDirectory(ctx: Context, exec: ToolRunContext): Promise<string | undefined> {
  if (exec.agent === undefined) return undefined
  const directories = ctx.get('workingDirectory')
  if (directories === undefined) throw new Error('dsh-tools: run_code with an Agent requires workingDirectory')
  return directories.ensure(exec.agent, exec.signal)
}

/**
 * Build the reserved `run_code` transport outside registered capabilities.
 * @param ctx - executor context owning policy listeners and active program cleanup.
 * @param executor - shared invocation pipeline for nested calls.
 * @param maxParallel - maximum overlapping concurrency-safe sub-dispatches.
 * @param shell - supplies the executor's presentation mode for schema text.
 * @returns the transport definition with runtime-dependent schema text.
 */
export function createRunCodeTool(
  ctx: Context,
  executor: ToolExecutionPipeline,
  maxParallel: number,
): ToolDefinition {
  // Retain services for log settlement after the executor context becomes inactive.
  const tools: ToolsService = ctx.tools
  const logger = ctx.logger
  const peekRuntime = (): PtcRuntime | undefined => ctx.get('ptcRuntime')

  /** A failed log-content listener preserves the settled content and cannot fail the dispatch. */
  async function shapeDispatchLog(dispatch: CodeDispatchLog): Promise<ContentBlock[]> {
    try {
      return await ctx.waterfall(
        scopeTarget(tools, dispatch.agent), 'tools/code-dispatch-log', dispatch,
        () => Promise.resolve(dispatch.content),
      )
    } catch (error: unknown) {
      logger.warn(`tools: code-dispatch-log listener failed for ${dispatch.name}: ${toolErrorMessage(error)}; logging the original settled content`)
      return dispatch.content
    }
  }

  const definition = defineTool({
    name: RUN_CODE_NAME,
    // The description and `code` parameter description are placeholders here:
    // the language-aware getters installed below replace both, resolving the
    // loaded runtime's flavor at schema-emission time so the schema the MODEL
    // sees matches the SDK section's language. Argument VALIDATION still keys
    // off this static spec (defineTool closes over it), which is language-
    // independent (one required string `code`).
    description: TYPESCRIPT_FLAVOR.description,
    parameters: {
      code: { type: 'string', required: true, description: TYPESCRIPT_FLAVOR.codeDescription },
      description: {
        type: 'string',
        required: true,
        description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
              denied: { type: 'boolean', required: true },
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
          },
        },
      },
      render: (_args, value) => {
        const rendered = value.result === undefined ? '' : renderValue(value.result)
        const parts = [value.logs.join('\n'), rendered].filter(part => part.length > 0)
        // Surface file-sandbox outcomes on the curated result so the model can react to a denial.
        if (value.sandbox?.enforcement === 'partial') parts.push('File sandbox enforcement is partial on this host.')
        if (value.sandbox?.denied) parts.push(`The ${value.sandbox.mode} file sandbox denied an operation.${escalationGuidance(peekRuntime())}`)
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(run_code completed with no output)' }]
      },
    },
    async execute(args, exec): Promise<RunCodeOutput> {
      if (args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string')
      }
      const runtime = requirePtcRuntime(ctx, 'code')
      const callSignal = exec.signal
      // Only Agent-owned programs require directory state.
      const cwd = await resolveWorkingDirectory(ctx, exec)

      // The run-scoped abort: follows the outer signal in, and fires when the
      // run settles for ANY reason, so an in-flight sub-dispatch is aborted
      // (its executor kills on this signal) instead of orphaned, and
      // queued-unstarted dispatches are abandoned.
      const runController = new AbortController()
      const onOuterAbort = (): void => { runController.abort(callSignal.reason) }
      callSignal.addEventListener('abort', onOuterAbort, { once: true })

      let dispatches = 0
      // The per-run scheduler uses the pipeline's staged interface and follows
      // the same concurrency rules as the native loop. It also follows the
      // native loop's SEQUENCING: every ordered stage (the dispatch-start
      // append, prepare = pre-execute/guards, complete = post-execute, context
      // deferral, the settle append) runs inside ONE driver lane, so ordered
      // policy stages never overlap each other and only the
      // around-dispatch/body stage runs concurrently. Starts are strictly
      // submission-ordered; results commit in submission order through the
      // head-of-line cursor. Consecutive parallel-classified calls overlap up
      // to maxParallel; an exclusive call waits for the pool to drain, runs
      // alone, and holds its barrier until its COMMIT (post-execute included)
      // completes, exactly like a native exclusive group. Classification is
      // re-read via executionMode() immediately before each start.
      interface PendingDispatch {
        /** Ordered stage: append the start event, await prepare, launch the body into `flight`. */
        start(): Promise<void>
        classify(): 'parallel' | 'exclusive'
        abandon(): void
        /** Ordered stage: post-execute + context deferral + settle event, in submission order. */
        commit(): Promise<void>
        /** The launched around-dispatch/body stage; resolved until start() replaces it. */
        flight: Promise<void>
        /** True once the dispatch stage parked its outcome; the commit cursor waits on it. */
        settled: boolean
        /** The classification this entry started under; an exclusive holds its barrier through commit(). */
        mode?: 'parallel' | 'exclusive'
      }
      const pendingQueue: PendingDispatch[] = []
      const inFlight = new Set<Promise<void>>()
      /** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
      const logWork = new Set<Promise<void>>()
      const commitQueue: PendingDispatch[] = []
      let exclusiveActive = false
      let driving = false
      let driverRun: Promise<void> = Promise.resolve()
      let wake: (() => void) | undefined
      const wakeup = (): void => {
        const release = wake
        wake = undefined
        release?.()
      }
      /**
       * The single ordered lane. Each pass commits the head-of-line settled
       * dispatch (ordered post-execute), then starts the next queued entry if
       * its slot is free (ordered pre-execute), and otherwise sleeps until a
       * body settles or a new submission arrives. One run reaching the
       * empty-queues/empty-pool state is quiescence.
       */
      const drive = (): Promise<void> => {
        if (driving) return driverRun
        driving = true
        driverRun = (async () => {
          try {
            for (;;) {
              // Create the wakeup promise before inspecting state so a settle or
              // submission arriving between the checks and the await cannot be lost.
              const signal = new Promise<void>((resolve) => { wake = resolve })
              const commitHead = commitQueue[0]
              if (commitHead !== undefined && commitHead.settled) {
                commitQueue.shift()
                await commitHead.commit()
                // The barrier covers post-execute: later starts wait for the
                // exclusive call's full pipeline, as under the native loop.
                if (commitHead.mode === 'exclusive') exclusiveActive = false
                continue
              }
              const head = pendingQueue[0]
              if (head !== undefined) {
                if (runController.signal.aborted) {
                  pendingQueue.shift()
                  head.abandon()
                  continue
                }
                // Reclassify at start time (fail-closed on registry changes).
                const mode = head.classify()
                const capacity = !exclusiveActive
                  && (mode === 'exclusive' ? inFlight.size === 0 : inFlight.size < maxParallel)
                if (capacity) {
                  if (mode === 'exclusive') exclusiveActive = true
                  head.mode = mode
                  pendingQueue.shift()
                  // Joined before start() so the commit cursor sees submission
                  // order; nothing commits it until `settled` flips.
                  commitQueue.push(head)
                  await head.start()
                  const flight: Promise<void> = head.flight.finally(() => {
                    inFlight.delete(flight)
                    wakeup()
                  })
                  inFlight.add(flight)
                  continue
                }
              }
              if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return
              await signal
            }
          } finally {
            driving = false
            wake = undefined
          }
        })()
        return driverRun
      }
      /** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
      const drainDispatches = async (): Promise<void> => {
        // The abort already fired: the driver abandons queued-unstarted
        // entries, awaits the live pool, and drains the ordered commit lane —
        // including a commit already in progress when the program returned.
        await drive()
        // Every settle event is appended inside the open run_code turn
        // (tasks self-remove on settlement).
        while (logWork.size > 0) await Promise.allSettled([...logWork])
      }

      // Read through a call, not a bare property: the abort state genuinely
      // changes across awaits, and a direct `.aborted` re-check after one
      // would be narrowed away by control flow analysis.
      const runOver = (): boolean => runController.signal.aborted

      const binding = (schema: ToolSchema): PtcBindingFunction => async (rawArgs: unknown): Promise<JsonValue> => {
        const { name } = schema
        if (runOver()) {
          throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`)
        }
        const normalized = jsonNormalizeArgs(rawArgs)
        const n = ++dispatches
        const subCallId: ToolCallId = `${String(exec.callId)}:code:${n}` as ToolCallId
        const input = {
          callId: subCallId,
          rootCallId: exec.rootCallId,
          name,
          schema,
          arguments: normalized.dispatched,
          ...exec.agent ? { agent: exec.agent } : {},
          ...exec.toolSet !== undefined ? { toolSet: exec.toolSet } : {},
          parent: exec.token,
          signal: runController.signal,
        }
        type DispatchOutcome = { isError: true; message: string } | { isError: false; value: JsonValue }
        const outcome = await new Promise<DispatchOutcome>((resolve, reject) => {
          // Set by the dispatch stage (or start() for a pre-settled result): what commit() finalizes in submission order.
          let parked:
            | { kind: 'post-result' | 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }
            | undefined
          const settle = (result: ToolExecutionResult): void => {
            // The program gets its value NOW: the log-content listener (for
            // example, a spill backend) must never delay the binding or occupy
            // a dispatch slot. The event append is tracked side work; the run's
            // settlement drains logWork so every settle event is still appended
            // inside the open turn.
            resolve(result.isError
              ? { isError: true, message: result.error.message }
              : { isError: false, value: result.value })
            const agent = exec.agent
            if (agent === undefined) return
            const task: Promise<void> = (async () => {
              // The listener may replace the durable copy with a preview and
              // locator; the program's value and model-visible result are
              // untouched.
              const logged = await shapeDispatchLog({
                exec, agent, subCallId, name, isError: result.isError,
                // The registry deep-froze this projection at result
                // finalization; append snapshots the final copy again, so
                // the log stays detached.
                content: result.content,
              })
              agent.session.append(CODE_DISPATCH_EVENT, {
                rootCallId: exec.rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name,
                // The SIBLING parse of the dispatched value: byte-identical JSON,
                // but a separate object — a tool mutating its args cannot desync
                // this record from what it actually received.
                arguments: normalized.logged,
                isError: result.isError,
                content: logged,
                ...result.meta !== undefined ? { meta: result.meta } : {},
              })
            })().finally(() => { logWork.delete(task) })
            logWork.add(task)
          }
          pendingQueue.push({
            flight: Promise.resolve(),
            settled: false,
            // Re-read per driver pass against the same agent view the SDK
            // declared; fail-closed exclusive when undeclared/invalid.
            classify: () => executor.executionMode(input).kind,
            abandon: () => {
              reject(new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`))
            },
            async start(): Promise<void> {
              exec.agent?.session.append(CODE_DISPATCH_START_EVENT, {
                rootCallId: exec.rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name,
                arguments: normalized.logged,
              })
              // Ordered prepare runs INSIDE the driver lane: the next entry's
              // pre-execute waits for this resolution, as under the native
              // scheduler. Only the launched body below overlaps.
              const prepared = await executor.prepare(input)
              if (prepared.kind === 'dispatch') {
                this.flight = executor.dispatch(prepared.exec).then((dispatchOutcome) => {
                  parked = { kind: dispatchOutcome.kind, exec: prepared.exec, result: dispatchOutcome.result }
                  this.settled = true
                })
                return
              }
              parked = { kind: prepared.kind, exec: prepared.exec, result: prepared.result }
              this.settled = true
            },
            async commit(): Promise<void> {
              /* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
              if (parked === undefined) return
              const result = await executor.complete(parked.exec, parked)
              for (const context of result.additionalContexts ?? []) {
                exec.deferContext(context)
              }
              // The composite forwards `additionalContexts` above and
              // `concludesTurn` here from the nested result. Only a successful
              // nested result can carry the terminal marker
              // (ToolExecutionFailure types it never), so a policy-converted
              // failure cannot stop the turn through a recovering program.
              if (result.concludesTurn) exec.concludeTurn()
              settle(result)
              // Backpressure on pending event-append tasks: each task retains
              // a full result while a slow backend stores it, so the pool cap
              // bounds their count. Beyond the cap, the ordered lane waits, so
              // later sub-calls cannot start and pending I/O/memory cannot grow
              // without bound.
              while (logWork.size > maxParallel) await Promise.race(logWork)
            },
          })
          wakeup()
          void drive()
        })
        // A budget expiry or outer cancel that occurs while this call was in
        // flight already aborted the dispatch; stop the program now rather
        // than hand it a result from a run that is over.
        if (runOver()) {
          throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`)
        }
        // The worker turns a binding rejection into ToolCallError and adds
        // only the binding name. Native content and internal error metadata
        // stay outside the program-facing failure contract.
        if (outcome.isError) throw new Error(outcome.message)
        return outcome.value
      }

      // Null-prototype + defineProperty, mirroring the worker-side namespace
      // build: a registered tool named `__proto__` must become an ordinary
      // own key (a plain-object assignment would hit the prototype setter,
      // silently dropping the binding), and the runtime host resolves
      // binding names as own properties only.
      const functions: Record<string, PtcBindingFunction> = Object.create(null) as Record<string, PtcBindingFunction>
      // Enumerate the CALLING AGENT's visible set (scoped tools join,
      // restricted globals vanish) — the same view the SDK section declared,
      // so a program can bind exactly what its prompt promised; sub-dispatch
      // re-resolves per call through the same view (exec.agent threads down).
      for (const schema of tools.schemas(exec.agent, exec.toolSet)) {
        if (schema.name === RUN_CODE_NAME) continue
        Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(deepFreeze(schema)) })
      }

      try {
        let result: PtcRunResult
        try {
          result = await runtime.run(runtime.resolve({
            program: args.code,
            bindings: [{
              global: 'tools',
              functions,
              errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
            }],
            signal: runController.signal,
            ...cwd !== undefined ? { cwd } : {},
          }))
        } finally {
          // Abort sub-dispatches and drain every in-flight dispatch before
          // closing the turn (queued-unstarted ones are abandoned unlogged).
          // Binding failures remain observable through their individual promises.
          runController.abort('run_code settled')
          await drainDispatches()
        }

        if (result.error) {
          const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : ''
          const sandboxText = result.sandbox === undefined ? ''
            : `\nFile sandbox: ${result.sandbox.mode}${result.sandbox.enforcement === undefined ? '' : `; enforcement: ${result.sandbox.enforcement}`}${result.sandbox.denied ? '; operation denied' : ''}.`
          throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}${sandboxText}${result.sandbox?.denied ? escalationGuidance(runtime) : ''}`)
        }
        return {
          logs: result.logs,
          ...result.sandbox === undefined ? {} : { sandbox: result.sandbox },
          ...result.value !== undefined ? { result: result.value } : {},
        }
      } finally {
        callSignal.removeEventListener('abort', onOuterAbort)
      }
    },
    // The model-authored description is the call's always-visible UI label
    // (the bash `description` precedent); the program itself rides rawInput.
    presentCall: args => ({
      card: 'generic',
      title: args.description,
      kind: 'execute',
      rawInput: args.code,
    }),
    // Deliberately no presentResult: the generic card fallback keeps this
    // title and reads durable result content without duplicating a large raw
    // result into the host view payload.
  })
  // Resolve the language flavor lazily, at the moment the registry projects the
  // schema (`schemaOf` destructures `description`/`parameters`). The definition
  // is minted once at registration, before a runtime is known; deferring here
  // is the least invasive point that still emits the loaded runtime's language.
  Object.defineProperty(definition, 'description', {
    enumerable: true,
    get: () => {
      const runtime = peekRuntime()
      const instructions = runtime?.executionInstructions
      return resolveFlavor(peekRuntime).description
        + (instructions ? ` ${instructions}` : '')
        + (runtime === undefined ? '' : " The working directory is the Session's current directory.")
        + escalationGuidance(runtime)
    },
  })
  Object.defineProperty(definition, 'parameters', {
    enumerable: true,
    // Recompile through the same spec→schema projection defineTool used, so
    // the emitted schema always matches the validated specification.
    get: () => parameterSchemaSpecToJsonSchema({
      code: { type: 'string', required: true, description: resolveFlavor(peekRuntime).codeDescription },
      description: { type: 'string', required: true, description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION },
    }) as unknown as Record<string, unknown>,
  })
  return definition
}

/**
 * A `native` / `code` / `both` executor over the shared batch pipeline.
 *
 * `native` describes every visible capability as a function definition.
 * `code` describes only the reserved `run_code` transport, adds the generated
 * SDK section and the code-only rule, and rejects a model-direct call naming
 * any other tool. `both` describes both forms and states no code-only rule,
 * because its native calls do execute.
 */
export class CcToolExecutor implements ToolExecutor {
  readonly sections: readonly ToolPromptSection[]
  private readonly pipeline: ToolExecutionPipeline
  private readonly mode: ToolPresentationMode
  private readonly maxParallelSubCalls: number
  private codeTransport: ToolDefinition | undefined

  constructor(
    private readonly ctx: Context,
    config: Partial<Config> = {},
    private readonly maxParallel: () => number = () => 10,
  ) {
    const resolved = Config(config)
    this.mode = resolved.mode
    this.maxParallelSubCalls = resolved.maxParallelSubCalls
    const tools: ToolsService = ctx.tools
    this.sections = this.mode === 'native' ? [] : [
      {
        name: 'tools:code-only',
        order: COLLAPSE_SECTION_ORDER,
        // The SAME predicate the executor denies by, so the prompt cannot state
        // a rule the executor does not enforce.
        text: () => this.mode === 'code' ? CODE_ONLY_INSTRUCTION : '',
        interpolate: false,
      },
      {
        name: 'tools:sdk',
        order: SDK_SECTION_ORDER,
        text: definitions => this.renderSdk(definitions),
        interpolate: false,
      },
    ]
    // The reserved transport lives outside the registry's layers, so a
    // model-direct `run_code` call must resolve through this source override in
    // every non-native mode (a native registry has no definition for it).
    const source = this.mode === 'native' ? {} : {
      get: (name: string, scope?: Parameters<typeof tools.executable>[1], toolSet?: Parameters<typeof tools.executable>[2]): ToolDefinition | undefined =>
        name === RUN_CODE_NAME ? this.requireCodeTransport() : tools.executable(name, scope, toolSet),
      // Only `code` collapses: a model-direct call naming anything but
      // `run_code` fails there. `both` and nested sub-dispatches pass through.
      reject: (name: string, nested: boolean): Error | undefined =>
        this.mode !== 'code' || nested || name === RUN_CODE_NAME
          ? undefined
          : new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`),
    }
    this.pipeline = new ToolExecutionPipeline(ctx, source)
  }

  /**
   * Describe the model's callable tools for the configured presentation.
   * @param tools - currently visible capability definitions, after scoped restrictions.
   * @returns schemas and names used to validate tool ordering.
   */
  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    if (this.mode === 'native') {
      return { schemas: tools.map(definition => projectToolSchema(definition, false)) }
    }
    // Validate the runtime language BEFORE projecting schemas: the transport's
    // language-aware description/parameters getters read the runtime, and this
    // keeps the renderer-table rejection the canonical assembly-time error for
    // a language with no SDK renderer.
    requirePtcRuntime(this.ctx, this.mode)
    const transport = projectToolSchema(this.requireCodeTransport(), false)
    if (this.mode === 'code') return { schemas: [transport], knownNames: [RUN_CODE_NAME] }
    return {
      schemas: [...tools.map(definition => projectToolSchema(definition, false)), transport],
      knownNames: [...tools.map(definition => definition.name), RUN_CODE_NAME],
    }
  }

  /** Regenerate the generated-SDK section from the calling step's visible tools. */
  private renderSdk(definitions: readonly ToolDefinition[]): string {
    const runtime = requirePtcRuntime(this.ctx, this.mode)
    const render = SDK_RENDERERS[runtime.language]
    /* v8 ignore next -- requirePtcRuntime rejects an unknown language before this runs. */
    if (render === undefined) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`)
    return render(definitions
      .filter(definition => definition.name !== RUN_CODE_NAME)
      .map((definition): ToolSdkSchema => {
        const output = snapshotJsonValue(definition.output.schema)
        /* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
        if (output === undefined) throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`)
        return { ...projectToolSchema(definition, true), output }
      }))
  }

  /** Execute a complete batch through the shared pipeline. */
  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, this.maxParallel)
  }

  /**
   * Build (once) and return the reserved transport.
   * @internal Public only so specs and the schema gate can project its schema
   * without a registered definition; not part of the executor contract.
   */
  requireCodeTransport(): ToolDefinition {
    this.codeTransport ??= createRunCodeTool(this.ctx, this.pipeline, this.maxParallelSubCalls)
    return this.codeTransport
  }
}

export { RUN_CODE_NAME, CODE_DISPATCH_EVENT, CODE_DISPATCH_START_EVENT }
export { jsonSchemaToPy, jsonSchemaToTs, renderToolsSdk, renderToolsSdkPy }
export type { ToolSdkSchema }

/** Cordis plugin name. */
export const name = 'cc-tool-executor'
/** Tool registration, shared dispatch, prompt sections, and the code runtime. */
export const inject = ['tools', 'systemPrompt']

/**
 * Register the fork executor in the mounting (root) scope.
 * @param ctx - context owning this executor's selection and lifetime.
 * @param config - presentation mode and program subcall concurrency.
 */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  ctx.tools.setExecutor(new CcToolExecutor(ctx, config))
}
