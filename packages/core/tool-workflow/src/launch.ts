/**
 * Source resolution, inline-meta handling, and async launch for the
 * CC-parity `workflow` tool (plan §3.2–§3.5). Precedence is
 * `scriptPath > script > name`, matching CC documentation verbatim. The
 * handler performs the synchronous prefix and returns immediately: the
 * launch receipt mirrors CC's documented `WorkflowOutput` subset.
 * @module @dsh-cc/tool-workflow/launch
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkflowEngine, WorkflowRun, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { extractInlineMeta } from './meta-extract.ts'
import type { CcWorkflowRunRegistry } from './registry.ts'
import { resumeJournalGoneError } from './registry.ts'
import type { ToolWorkflowRunSource } from './types.ts'

/** Model-facing parameters (all optional at the schema level; validated here). */
export interface WorkflowToolParams {
  script?: string
  name?: string
  scriptPath?: string
  args?: unknown
  /** Transitional compat with the harness form; mutually exclusive with an inline meta block. */
  meta?: { name: string; description: string }
  /** Accepted and ignored, mirroring CC (the script's meta block sets the title). */
  title?: string
  /** Accepted and ignored, mirroring CC. */
  description?: string
  /** Resume one of this session's earlier runs by runId (same-session replay; see the tool description). */
  resumeFromRunId?: string
  [key: string]: unknown
}

/** The documented `async_launched` receipt subset (CC `WorkflowOutput`). */
export interface WorkflowLaunchReceipt {
  status: 'async_launched'
  taskId?: string
  taskType?: 'local_workflow'
  workflowName?: string
  runId?: string
  summary?: string
  warning?: string
  error?: string
}

/** The leading meta-block contract quoted in refusals (see `meta-extract.ts`). */
export const META_FORM_PLACEHOLDER = 'export const meta = { name, description }'

const ALLOWED_KEYS = ['script', 'name', 'scriptPath', 'args', 'meta', 'title', 'description', 'resumeFromRunId'] as const

/** Refusal text for any key outside the documented table. */
export function unknownKeyRefusal(key: string): string {
  return `workflow: unknown option "${key}" (allowed: ${ALLOWED_KEYS.join(', ')})`
}

/** Both-meta ambiguity error (plan §3.2: the file's inline meta wins nothing by dispute). */
export const BOTH_META_REFUSAL =
  'workflow: both an inline `export const meta` block and the transitional `meta` parameter were supplied — they are mutually exclusive; keep exactly one'

/** Resolve the script source by precedence; a miss on `name` lists the probed directories. */
export function resolveScriptSource(params: WorkflowToolParams, cwd: string):
  { script: string; source: ToolWorkflowRunSource; fileName?: string } {
  if (typeof params.scriptPath === 'string' && params.scriptPath.length > 0) {
    // An arbitrary path relative to the session cwd; a file-policy denial
    // surfaces verbatim (same posture as the `read` tool).
    const path = isAbsolute(params.scriptPath) ? params.scriptPath : resolve(cwd, params.scriptPath)
    const script = readFileSync(path, 'utf8')
    return { script, source: 'scriptPath', fileName: params.scriptPath }
  }
  if (typeof params.script === 'string' && params.script.length > 0) {
    return { script: params.script, source: 'inline' }
  }
  if (typeof params.name === 'string' && params.name.length > 0) {
    const safeName = params.name.replaceAll('..', '').replaceAll('/', '')
    const project = join(cwd, '.claude', 'workflows', `${safeName}.js`)
    const user = join(resolveDshHome(), 'workflows', `${safeName}.js`)
    for (const [candidate, source] of [[project, 'project-saved'], [user, 'user-saved']] as const) {
      try {
        return { script: readFileSync(candidate, 'utf8'), source, fileName: safeName }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw new Error(
      `workflow: no saved workflow named "${params.name}" — probed ${project} and ${user} ` +
      '(save it first with the write tool: project `.claude/workflows/<name>.js` or the user workflows directory)',
    )
  }
  throw new Error('workflow: one of scriptPath, script, or name is required (precedence scriptPath > script > name)')
}

export interface LaunchDeps {
  engine: WorkflowEngine
  registry: CcWorkflowRunRegistry
  maxResultChars: number
  /** Log-grade sink for the saved-name disagreement note. */
  warn?: (message: string) => void
}

export interface LaunchExec {
  agent: Agent
  signal?: AbortSignal
  /** The harness tool-execution token; undefined = top-level call (drives durable-event recording). */
  parent?: unknown
}

/**
 * The synchronous launch prefix shared by the tool body and the scripted
 * tests: resolve source, extract meta, start the engine, register the run,
 * and return the documented receipt. `engine.start` throwing synchronously
 * on meta/parse failure yields CC's documented no-start receipt
 * `{status: "async_launched", error}` with no `taskId` (no task was
 * registered; semantically forced, not faked).
 */
export function startWorkflowRun(deps: LaunchDeps, params: WorkflowToolParams, exec: LaunchExec): WorkflowLaunchReceipt {
  for (const key of Object.keys(params)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) throw new Error(unknownKeyRefusal(key))
  }
  // Resume seam: validate synchronously and read the journal text in the SAME
  // tick (TOCTOU absorption, design §3.2); a vanished file surfaces as the
  // structured "journal gone" refusal, never a raw fs error.
  let resumeOf: WorkflowRunId | undefined
  let journalText: string | undefined
  if (params.resumeFromRunId !== undefined) {
    if (typeof params.resumeFromRunId !== 'string' || params.resumeFromRunId.length === 0) {
      throw new Error('workflow: resumeFromRunId must be a non-empty runId string')
    }
    const projection = deps.registry.validateResume(params.resumeFromRunId)
    try {
      journalText = readFileSync(projection.journalPath, 'utf8')
    } catch {
      throw resumeJournalGoneError(params.resumeFromRunId)
    }
    resumeOf = params.resumeFromRunId as WorkflowRunId
  }
  const cwd = exec.agent.session.header.cwd ?? process.cwd()
  const { script, source, fileName } = resolveScriptSource(params, cwd)

  let body: string
  let meta: unknown
  if (source === 'inline') {
    const extracted = extractInlineMeta(script)
    if (!extracted.ok) {
      if (extracted.missing && params.meta !== undefined) {
        // Legal combination: `script` + `meta` param and no inline block.
        body = script
        meta = params.meta
      } else {
        return { status: 'async_launched', error: extracted.error }
      }
    } else {
      if (params.meta !== undefined) throw new Error(BOTH_META_REFUSAL)
      body = extracted.body
      meta = extracted.meta
    }
  } else {
    // `name`/`scriptPath` alone: the file carries its own inline meta; a
    // `meta` param on this path is the both-meta ambiguity error.
    if (params.meta !== undefined) throw new Error(BOTH_META_REFUSAL)
    const extracted = extractInlineMeta(script)
    if (!extracted.ok) return { status: 'async_launched', error: extracted.error }
    body = extracted.body
    meta = extracted.meta
  }

  const typedMeta = meta as { name: string; description: string }

  // Saved-name disagreement: file name governs lookup, meta name governs
  // display; surfaced as the receipt's `warning` field plus a log-grade note.
  let warning: string | undefined
  if (fileName !== undefined && typedMeta.name !== fileName.replace(/\.js$/, '')) {
    warning = `workflow: the script's meta name "${typedMeta.name}" disagrees with its file name "${fileName}" (file name governs lookup, meta name governs display)`
    deps.warn?.(warning)
  }

  let run: WorkflowRun
  try {
    run = deps.engine.start({
      script: body,
      meta: typedMeta,
      ...params.args !== undefined ? { args: params.args } : {},
      parent: exec.agent,
      ...exec.signal !== undefined ? { signal: exec.signal } : {},
    })
  } catch (error) {
    return { status: 'async_launched', error: error instanceof Error ? error.message : String(error) }
  }

  deps.registry.register({
    run,
    meta: typedMeta,
    args: params.args,
    scriptText: script,
    source,
    startedAt: Date.now(),
    session: exec.agent.session,
    agent: exec.agent,
    maxResultChars: deps.maxResultChars,
    record: exec.parent === undefined,
    ...resumeOf !== undefined ? { resumeOf, journalText: journalText! } : {},
  })

  return {
    status: 'async_launched',
    taskId: run.id,
    taskType: 'local_workflow',
    workflowName: typedMeta.name,
    runId: run.id,
    summary: typedMeta.description,
    ...warning !== undefined ? { warning } : {},
  }
}
