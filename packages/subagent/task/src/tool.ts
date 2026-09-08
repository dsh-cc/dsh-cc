/**
 * The CC-compatible Task tool: `subagent_type` dispatch over the per-workspace
 * `.claude/agents` definitions discovered by the AgentRegistry.
 *
 * The internal tool name is `subagent_fork` so the CC display-name mapping
 * (Task) and permission/hook rows keyed on it keep working. The harness rows
 * `tool-subagent` and `tool-subagent-fork` are disabled in the cc preset in
 * favour of this definition — see `packages/preset/cc/agent.cordis.yml`.
 *
 * Dispatch rules:
 * - `subagent_type` omitted (or the `general-purpose` sentinel) → a fresh
 *   spawn of the caller, no definition participation, no parent history.
 * - `subagent_type` equal to the `fork` sentinel → a conversation-inheriting
 *   fork of the caller (CC `subagent_type: "fork"`). The sentinel wins over a
 *   workspace file of the same name; `.claude/agents/fork.md` is unreachable.
 * - A type matching a definition under the session cwd → spawn with the
 *   definition's system prompt delivered as the child `persona`, the model's
 *   task text as the first user message, a routes-resolved `agentOptions`
 *   override, and the definition's tool restriction (sanitized of tool names
 *   this composition no longer registers).
 * - A type matching a plugin agent's scoped id (`plugin:agent`, from the
 *   `subagents` seam's namespaced providers) → the identical fold: the
 *   provider's `AgentDefinition` is dispatched through the same `spawn`
 *   provider mechanics; no new start path exists for plugin agents.
 * - Any other type → an error result listing the available types.
 *
 * The seam's capability contract (`assertCapabilities`) is honoured
 * transitively: spawn and fork both support persona/toolFilter/depthLimit, so
 * every field this tool forwards is legal.
 *
 * The background/collect start mechanics (env kill-switch parsing, capacity
 * guard, pin preallocation, `startBackground`/`collectForeground`) live in
 * `./background-start.ts`; the public policy names are re-exported here to
 * keep the module's public surface unchanged.
 *
 * @module @dsh-cc/subagent-task/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { defineTool } from '@dsh-cc/tools'
import { cwdOf } from '@dsh-cc/memory'
import type { ModelRoutes } from '@dsh-cc/model-aliases'
import { toAgentOptions } from '@dsh-cc/model-aliases'
import type { AgentRegistry } from './registry.ts'
import { PluginAgentIndex } from './plugin-agents.ts'
import { SpawnPinCapture } from './resume-capture.ts'
import { preloadDeferredFilterTools, renderPreloadLines, type ToolSearchActivateSeam } from './preload-tools.ts'
import { sanitizeToolFilter } from './sanitize-filter.ts'
import {
  backgroundTasksDisabled,
  collectForeground,
  preparedBackground,
  startBackground,
  wantsBackground,
  type SubagentsLike,
} from './background-start.ts'

export {
  MAX_LIVE_CONTINUABLE_CHILDREN,
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
  backgroundTasksDisabled,
} from './background-start.ts'

/** The registered tool name (the CC display mapping surfaces it as `Task`). */
export const TASK_TOOL = 'subagent_fork'

/** The sentinel a model uses to ask for a plain spawn with no definition. */
const GENERAL_PURPOSE = 'general-purpose'

/** The sentinel a model uses to inherit the parent's completed-turn prefix. */
const FORK_SENTINEL = 'fork'

/** The default delegation-depth cap for a Task child (matches the harness default). */
const DEFAULT_MAX_DEPTH = 3

/** The upstream harness issue that keeps fork children one-shot. */
const FORK_BACKGROUND_ISSUE = 'deepseek-harness#2124'

/**
 * Tool names this composition keeps restrictable without registering a
 * visible definition. The cc preset disables the two harness subagent tool
 * rows (`subagent` + `subagent_fork`) in favour of this tool, so the CC
 * frontmatter `Task` translation `['subagent', 'subagent_fork']` must stay in
 * the restrictable universe even though `subagent` is only reserved (not
 * registered — one visible Task is enough). `workflow` is the deferred row's
 * name for the same reason.
 *
 * `subagent_fork` itself needs no reservation: `registerTaskTool` registers
 * the visible definition below, and `restrict()` accepts registered names.
 * Filter sanitization reads the live `ctx.tools.view().restrictableNames` set,
 * so these reservations (plus every registered row and every mounted MCP tool)
 * are exactly the names a subagent toolFilter may carry.
 */
const RESERVED_TOOL_NAMES = ['subagent', 'workflow'] as const

interface TaskArgs {
  /** The CC agent type to dispatch to; omit for a plain spawn. */
  subagent_type?: string
  /** A short (3-5 word) task label, persisted with the child run. */
  description: string
  /** The task text delivered as the child's first user message. */
  prompt: string
  /**
   * Start the child as a durable background agent and return immediately with
   * its agent id; the child's report/finish notice arrives as a waking message.
   * Default false (foreground, wait for the final text).
   */
  run_in_background?: boolean
}

/**
 * Register the Task tool.
 * @param ctx - the plug context.
 * @param registry - the per-workspace definition cache.
 * @param capture - the spawn-time resume-pin capture; undefined (the default,
 *   no `resumePins` plugin config) writes no pins and runs no preflight.
 * @returns the registration disposer, or undefined when the tools seam is absent.
 */
export function registerTaskTool(
  ctx: Context,
  registry: AgentRegistry,
  capture?: SpawnPinCapture,
  pluginIndex: PluginAgentIndex = new PluginAgentIndex(ctx),
): (() => void) | undefined {
  const tools = ctx.get('tools') as {
    register(def: unknown): () => void
    reserve(name: string): () => void
    get(name: string): unknown
    /**
     * Duck-typed `view()`: the only API that lists reserved+registered names
     * in one set (deferred MCP tools are reserved, not in `schemas()`).
     * `@internal` on ToolRuntime, so it is structural here and optional —
     * a seam without it degrades to an empty known set.
     *
     * Pass the calling agent: MCP tools register on the standing-scope layer
     * of the cc preset, which `view()` without a scope does not see.
     */
    view?(scope?: unknown): { restrictableNames: ReadonlySet<string> }
  } | undefined
  if (tools === undefined) return undefined

  // Keep the disabled harness `subagent` row's name restrictable (the CC
  // frontmatter `Task` translates to both `subagent` and `subagent_fork`), and
  // `workflow` for the deferred workflow row.
  for (const name of RESERVED_TOOL_NAMES) tools.reserve(name)

  return tools.register(defineTool({
    name: TASK_TOOL,
    description:
      'Delegate a well-scoped task to a subagent. The child starts with a fresh conversation: '
      + 'write a self-contained prompt (paths, constraints, what to return). Pass `subagent_type` '
      + 'to run a named agent from the session workspace (`.claude/agents`) or a plugin agent by '
      + 'its scoped id (`plugin:agent`) — see the "Available '
      + 'subagents" section of the system prompt for the current list. Omit `subagent_type` (or '
      + 'use "general-purpose") for a plain spawn that inherits your tools but not your history. '
      + 'Pass `subagent_type: "fork"` to inherit completed parent turns (and the prompt cache, '
      + 'when the child stays on the same model). The child runs to completion and returns its '
      + 'final text. Unknown types fail with the available list. '
      + 'Omit `run_in_background` (foreground) when this turn\u2019s answer to the human depends on '
      + 'the child: the call blocks until the child finishes and returns its final text. Pass '
      + '`run_in_background: true` when the human can keep talking while the child works: the call '
      + 'returns promptly once the child has accepted its first turn (with its `agentId`), and you '
      + 'are told when it finishes via a waking message; synthesize on the wake, do not poll. '
      + 'A definition with `background: true` backgrounds on omit; pass `run_in_background: false` '
      + 'when this turn needs that child\u2019s result \u2014 explicit true/false always win over the pin. '
      + 'One task, one instance: every new task is a fresh call to this tool (a plain spawn \u2014 '
      + 'never `subagent_type: "fork"`, which inherits your context), even when an idle child of '
      + 'the same type exists. `send_message` continues only an existing child\u2019s CURRENT '
      + 'assignment (steer it in flight, same-task follow-ups); a continued child resumes inside '
      + 'its full prior conversation with its original definition snapshot. (Reporting your own '
      + 'result to your parent via `send_message` is always fine.) '
      + 'Continue a background child later with `send_message` addressed to its id; inspect it with '
      + '`list_agents` and stop its current turn with `interrupt_agent`. '
      + 'A foreground wait may be user-promoted to background while it runs: if a tool result '
      + 'carries `status: \'async_launched\'` with `backgroundedByUser: true`, treat it exactly '
      + 'like a background launch — the result arrives as a later wake; do not poll. '
      + 'Note: `fork` cannot run in the background (upstream harness issue #2124).',
    parameters: {
      subagent_type: {
        type: 'string',
        description:
          'Named agent from `.claude/agents`, a plugin agent by its scoped id ("plugin:agent"), '
          + 'or the sentinels "general-purpose" (fresh spawn) '
          + 'and "fork" (inherit completed parent turns). "fork" is reserved and wins over a '
          + 'workspace file of the same name. Bare plugin agent names are not addressable — use '
          + 'the full scoped id.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) task label, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The task text delivered to the child as its first user message.',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'Explicit true starts a durable background child (returns its agentId; the report or '
          + 'finish notice arrives as a waking message) and explicit false forces foreground \u2014 '
          + 'both win over a definition pin. Omitted: background when the definition pins '
          + '`background: true`, foreground otherwise.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          status: { type: 'string', enum: ['completed', 'async_launched'] },
          agentId: { type: 'string' },
          backgroundedByUser: { type: 'boolean' },
        },
      },
      render: (_args: TaskArgs, value: { text: string; status?: string; agentId?: string }) => [
        { type: 'text', text: value.text },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args: TaskArgs, exec: { agent?: Agent; signal: AbortSignal; token?: unknown }) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('subagent_fork requires a calling agent (exec.agent was undefined)')
      }
      const seam = ctx.get('subagents') as SubagentsLike | undefined
      if (seam === undefined) throw new Error('subagent_fork unavailable: no subagents seam')

      const type = args.subagent_type?.trim()
      const base = {
        label: args.description,
        prompt: [{ type: 'text' as const, text: args.prompt }],
        parent: agent,
        signal: exec.signal,
        maxDepth: DEFAULT_MAX_DEPTH,
      }

      const disabled = backgroundTasksDisabled()
      if (type === undefined || type.length === 0 || type === GENERAL_PURPOSE) {
        if (wantsBackground(args, undefined, disabled)) {
          return startBackground(seam, preparedBackground(base, capture), capture)
        }
        return collectForeground(ctx, seam, preparedBackground(base, capture), capture, exec)
      }

      if (type === FORK_SENTINEL) {
        // Rejected BEFORE any seam call: fork children are one-shot until the
        // upstream harness continuable-fork prefix-reuse issue lands.
        if (wantsBackground(args, undefined, disabled)) {
          throw new Error(
            'subagent_type "fork" cannot run in the background: fork children are one-shot '
            + `until upstream harness issue ${FORK_BACKGROUND_ISSUE} resolves. Workaround: use a `
            + 'plain background spawn instead (omit subagent_type, or name a definition) with '
            + 'run_in_background: true.',
          )
        }
        const run = await seam.start(FORK_SENTINEL, base)
        return settle(run)
      }

      const root = cwdOf(agent)
      let definition = await registry.resolve(root, type)
      if (definition === undefined) {
        // Fall through to the seam's plugin agents (exact scoped-id match).
        // Builtin providers are excluded by the index's structural guard.
        definition = pluginIndex.resolve(type)
      }
      if (definition === undefined) {
        const fileTypes = (await registry.list(root)).map(def => def.agentType)
        const pluginIds = pluginIndex.knownIds()
        const available = [...fileTypes, ...pluginIds].join(', ')
        throw new Error(
          `unknown subagent_type "${type}"`
          + (available.length > 0
            ? `; available in this workspace: ${available}`
            : '; this workspace defines no agents')
          // A colon in the requested type means a scoped plugin id was
          // intended: name the unmount/renamed causes explicitly.
          + (type.includes(':')
            ? ' — plugin agent not found — the plugin may be unmounted or the agent renamed'
            : ''),
        )
      }

      const dispatchDefinition = async (definition: AgentDefinition): Promise<
        Awaited<ReturnType<typeof collectForeground>> | Awaited<ReturnType<typeof startBackground>>
      > => {
        const routes = ctx.get('ccModelRoutes') as ModelRoutes | undefined
        const agentOptions = toAgentOptions(routes?.resolve(definition.model))
        // LIVE known set, read at execute time so MCP tools mounted or deferred
        // after this plugin's apply (including hash-suffixed public names) are
        // all restrictable candidates for the child's filter. Pass the calling
        // agent: MCP tools live on the standing-scope layer, which the global
        // view (no scope) does not include.
        const knownNames = tools.view?.(agent).restrictableNames ?? new Set<string>()
        const toolFilter = definition.toolRestriction !== undefined
          ? sanitizeToolFilter(definition.toolRestriction, message => ctx.logger.warn(message), knownNames)
          : undefined
        // Spawn-time pre-activation (named definitions only): explicit deferred
        // MCP names in the raw `tools:` allow-list are activated through the
        // duck-typed toolSearch seam BEFORE the child starts, on BOTH dispatch
        // paths. Activation is process-global — every admitting agent's schema
        // grows after the spawn.
        const preloadText = renderPreloadLines(preloadDeferredFilterTools({
          raw: definition.toolRestriction,
          sanitized: toolFilter,
          toolSearch: ctx.get('toolSearch') as ToolSearchActivateSeam | undefined,
          agent,
          tools,
          warn: message => ctx.logger.warn(message),
        }))
        const folded = {
          ...base,
          persona: definition.systemPrompt,
          ...(toolFilter !== undefined ? { toolFilter } : {}),
          ...(agentOptions !== undefined ? { agentOptions } : {}),
        }
        if (wantsBackground(args, definition, disabled)) {
          const result = await startBackground(seam, preparedBackground(folded, capture, definition, routes), capture)
          return preloadText === '' ? result : { ...result, text: `${result.text}\n${preloadText}` }
        }
        const result = await collectForeground(ctx, seam, preparedBackground(folded, capture, definition, routes), capture, exec)
        return preloadText === '' ? result : { ...result, text: `${result.text}\n${preloadText}` }
      }
      return dispatchDefinition(definition)
    },
  }))
}

/** Await a run's terminal result and project it onto the tool output shape. */
async function settle(run: { result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }> }): Promise<{ text: string; status: 'completed' }> {
  let result
  try {
    result = await run.result
  } catch (error) {
    throw new Error(`subagent run failed: ${(error as Error).message}`)
  }
  if (result.stopReason !== 'completed') {
    throw new Error(`subagent run stopped with reason "${result.stopReason}"`)
  }
  const text = (result.output ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  return { text, status: 'completed' as const }
}
