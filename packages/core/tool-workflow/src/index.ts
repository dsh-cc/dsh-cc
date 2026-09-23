/**
 * The CC-parity model-facing `workflow` tool: launch a JavaScript
 * orchestration script that fans out subagents, returning immediately with
 * CC's documented `async_launched` receipt; the consolidated result arrives
 * later as one completion delivery (two-vein, see `registry.ts`). Script
 * parsing/execution/caps live behind `ctx.workflowEngine`; inline-meta
 * extraction, saved-source resolution, the run registry, the four durable
 * `tool-workflow/*` session events, and the `tool:workflow` prompt section
 * live here.
 * @module @dsh-cc/tool-workflow
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@dsh-cc/tools'
import type { ToolCallView, ToolResultView } from '@dsh-cc/tools'
import type { WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import { startWorkflowRun, unknownKeyRefusal, BOTH_META_REFUSAL, META_FORM_PLACEHOLDER } from './launch.ts'
import type { WorkflowLaunchReceipt, WorkflowToolParams } from './launch.ts'
import { mountCcWorkflowRunRegistry } from './registry.ts'

export const name = 'tool-workflow'
export const inject = ['tools', 'workflowEngine', 'systemPrompt']

export { CcWorkflowRunRegistry, mountCcWorkflowRunRegistry } from './registry.ts'
export { startWorkflowRun, resolveScriptSource, unknownKeyRefusal, BOTH_META_REFUSAL } from './launch.ts'
export type { WorkflowLaunchReceipt, WorkflowToolParams } from './launch.ts'
export { extractInlineMeta, META_FORM } from './meta-extract.ts'
export { parseJournal, serializeJournalLine } from './journal-lines.ts'
export type { JournalLine } from './journal-lines.ts'
export type { PendingWorkflowClaim, WorkflowJournalHandle } from './registry.ts'
export type { ToolWorkflowRunSource } from './types.ts'

/** Config: the model-facing tool name plus the delivery render cap. */
export interface Config {
  /** The model-facing tool name to register (default `workflow`). */
  toolName?: string
  /** Consolidated-delivery ceiling, in characters: a longer JSON value is truncated with a notice (default 50000). */
  maxResultChars?: number
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
  maxResultChars: z.natural().min(1).default(50_000),
})

/**
 * The script-authoring contract, per plan §3.7 item 2, embedded in the tool
 * description's script section. The prompt section holds the usage posture;
 * the description holds the parameter surface and the async contract.
 */
const DESCRIPTION = `Launch a JavaScript workflow script that orchestrates subagents at scale — an audit over many files, a migration, multi-angle research, adversarial verification — where you write the orchestration as a script instead of delegating turn by turn. The script, not you, holds the plan.

Parameters (precedence scriptPath > script > name):
- \`script\`: inline script. It MUST begin with a literal \`export const meta = { name, description }\` block (plain object literal: strings, numbers, booleans, null, arrays, nested objects, optional \`phases: [{title, detail?}]\`; comments and trailing commas allowed; no template literals, identifiers, spreads, computed keys, or functions). The rest of the body is plain JavaScript (NOT TypeScript) with top-level \`await\`, ending \`return <json>\`; hooks: \`agent(prompt, opts?)\`, \`parallel(thunks)\`, \`pipeline(items, ...stages)\`, \`phase(title)\`, \`log(message)\`, and the \`args\` global (the call's \`args\`). A failed child resolves \`null\` (filter with \`.filter(Boolean)\`); misused hooks throw errors that kill the run. Caps: concurrency \`min(16, max(1, cores - 2))\`, 1000 total agents, 4096 items per call.
- \`name\`: a workflow saved as \`.claude/workflows/<name>.js\` (project) or in the user workflows directory. The file carries its own meta block.
- \`scriptPath\`: path to a script file; takes precedence over \`script\` and \`name\`.
- \`args\`: JSON value exposed to the script as the global \`args\`.
- \`title\`/\`description\`: accepted and ignored (the script's meta block sets the title).
- \`meta\`: transitional parameter accepted only with an inline \`script\` that has NO meta block; supplying both is an error.
- \`resumeFromRunId\`: resume an earlier run of this session (same-session replay): every agent whose request is unchanged returns its saved result instantly, in start order; the first agent whose prompt/schema/route differs — or that failed or was still running last time — runs again, and so does every agent after it.

Async contract: the call returns a launch receipt immediately. The consolidated result arrives BY ITSELF as one completion message — do not poll or re-invoke. On launch failure the receipt carries \`error\` (check it before treating the run as started).`

/** The prompt section, plan §3.7 (order key `TOOL_WORKFLOW`, registered once). */
function promptSectionText(toolName: string): string {
  return `A workflow (the ${toolName} tool) runs a JavaScript script YOU write that plans and fans out subagent work: the script holds the plan and coordinates many agents; you only supply args and read the consolidated result. The script begins with a literal \`export const meta = { name, description }\` block, then plain JS with top-level await ending in \`return <json>\`; hooks are agent()/parallel()/pipeline()/phase()/log()/args; a failed child resolves null (filter with .filter(Boolean)); hook misuse, unknown options, unsupported schemas, and cap breaches (concurrency min(16, max(1, cores - 2)), 1000 total agents, 4096 items per call) kill the run.

Use a workflow ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration, or when the user says "ultracode" (an opt-in trigger only; it does not change any session effort level). Otherwise use ordinary tools: for one or two delegations, prefer plain subagent calls.

Sources: pass \`script\` inline, or \`name\` for a workflow saved at \`.claude/workflows/<name>.js\` (project; shadows the user workflows directory), or \`scriptPath\` for any script path (highest precedence). When the user asks to save or iterate on a workflow, write the file with your write tool and call with \`name\`/\`scriptPath\` — never re-paste a large script into the call; edit the file and pass \`scriptPath\`.

The call returns immediately with a launch receipt. The consolidated result arrives by itself as one message when the run completes: do not poll, do not re-invoke, just continue or wait. \`resumeFromRunId\` replays a same-session run: unchanged prefix returns saved results; the first changed or failed agent and everything after it re-runs.`
}

/** The pending-state card: a generic card titled by the workflow's identity. */
function presentWorkflowCall(args: WorkflowToolParams): ToolCallView {
  const title = args.scriptPath !== undefined
    ? `workflow: ${args.scriptPath}`
    : args.name !== undefined
      ? `workflow: ${args.name}`
      : typeof (args.meta as { name?: string } | undefined)?.name === 'string'
        ? `workflow: ${(args.meta as { name: string }).name}`
        : 'workflow'
  return { card: 'generic', title, rawInput: args.script ?? '' }
}

/** The completed-state card: keep the pending title; render result content as-is. */
function presentWorkflowResult(_args: WorkflowToolParams, _result: { content: unknown[]; isError: boolean }): ToolResultView {
  return { card: 'generic' }
}

/** Human-readable launch receipt text for the tool result. */
function renderReceipt(value: WorkflowLaunchReceipt): string {
  if (value.error !== undefined) return `Workflow not started: ${value.error}`
  const warning = value.warning !== undefined ? ` Warning: ${value.warning}` : ''
  return `Workflow "${value.workflowName}" launched in the background (runId ${value.runId}). The consolidated result arrives by itself; do not poll.${warning}`
}

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const resolved = Config(config)
  const toolName = resolved.toolName ?? 'workflow'
  const maxResultChars = resolved.maxResultChars ?? 50_000
  const disposeRegistry = mountCcWorkflowRunRegistry(ctx)
  const registry = ctx.ccWorkflowRunRegistry
  const logger = ctx.logger

  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: promptSectionText(toolName),
  })

  ctx.tools.register(defineTool({
    name: toolName,
    description: DESCRIPTION,
    parameters: {
      script: { type: 'string', description: 'Inline workflow script; must begin with a literal `export const meta = {...}` block.' },
      name: { type: 'string', description: 'A workflow saved in `.claude/workflows/<name>.js` or the user workflows directory.' },
      scriptPath: { type: 'string', description: 'Path to a script file; takes precedence over script and name.' },
      args: { type: 'json', description: 'JSON value exposed to the script as the global `args`.' },
      meta: { type: 'json', description: `Transitional harness-form meta block; only legal with an inline script that has no ${META_FORM_PLACEHOLDER} block.` },
      title: { type: 'string', description: 'Accepted and ignored (the meta block sets the title).' },
      description: { type: 'string', description: 'Accepted and ignored.' },
      resumeFromRunId: { type: 'string', description: 'Resume one of this session\'s earlier workflow runs by runId: settled agents return their saved results until the first mismatch (hash of prompt/schema/route); that agent and everything after it runs again.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'async_launched' },
          taskId: { type: 'string' },
          taskType: { type: 'string', const: 'local_workflow' },
          workflowName: { type: 'string' },
          runId: { type: 'string' },
          summary: { type: 'string' },
          warning: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReceipt(value as WorkflowLaunchReceipt) }],
    },
    async execute(rawArgs, exec) {
      if (exec.agent === undefined) {
        throw new Error('workflow tool requires a calling agent (exec.agent was undefined)')
      }
      const params = rawArgs as WorkflowToolParams
      for (const key of Object.keys(params)) {
        if (!['script', 'name', 'scriptPath', 'args', 'meta', 'title', 'description', 'resumeFromRunId'].includes(key)) {
          throw new Error(unknownKeyRefusal(key))
        }
      }
      if (params.meta !== undefined && (typeof params.script !== 'string' || params.script.length === 0)) {
        throw new Error(BOTH_META_REFUSAL)
      }
      // Launch-window abort bridge is unnecessary as a separate listener: the
      // launch prefix is fully synchronous, and `exec.signal` is passed to the
      // engine seam directly (plan §3.5 step 1).
      return startWorkflowRun(
        { engine: ctx.workflowEngine as WorkflowEngine, registry, maxResultChars, warn: m => logger.warn(m) },
        params,
        { agent: exec.agent, signal: exec.signal, parent: exec.parent },
      )
    },
    presentCall: args => presentWorkflowCall(args as WorkflowToolParams),
    presentResult: (args, result) => presentWorkflowResult(args as WorkflowToolParams, result),
  }))

  // Context disposal cancels in-flight runs and disarms settle delivery.
  return disposeRegistry
}
