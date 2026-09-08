/**
 * Coordinator mode: an agent-scoped orchestration role over continuable
 * subagents. Activation (Config `enabled` or the `DSH_COORDINATOR_MODE` env)
 * restricts the agent's correspondence to delegation and read-only tools,
 * installs a coordinator prompt section, and brings up the model-facing
 * scheduling tools ({@link spawn_worker}, {@link send_to_worker},
 * {@link worker_broadcast}, {@link worker_tasks}).
 *
 * Result return and completion waking are NOT reimplemented here: the subagent
 * manager already injects its `subagent-settled` notice into this coordinator's
 * inbox as a waking message when a worker settles
 * (`@deepseek-ai/dsh-subagent`'s continuation settlement delivery), and a worker
 * can address the coordinator directly with its `send_message` control tool.
 * This package adds the coordinator role and its naming/messaging surface
 * around those seams and documents the reuse.
 * @module @dsh-cc/coordinator
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolRestriction } from '@dsh-cc/tools'
import { COORDINATOR_SECTION_ORDER, COORDINATOR_SECTION_TEXT } from './section.ts'

/**
 * The ambient host registry's tool-definition parameter: the vendored
 * registry is structurally identical but carries a distinct nominal token
 * brand, so definitions cross the host seam through this alias.
 */
type HostToolDefinition = Parameters<Context['tools']['register']>[0]


/** Default tool visibility mask: deny the two canonical code-editing tools. */
export const DEFAULT_COORDINATOR_RESTRICT: ToolRestriction = { deny: ['write', 'edit'] }

/** Config governing one coordinator agent's mode activation. */
export interface CoordinatorConfig {
  /**
   * Activate coordinator mode. Defaults to the `DSH_COORDINATOR_MODE` env flag
   * (`1`, `true`, or `yes`), so a deployment toggles it without config edits.
   */
  readonly enabled?: boolean
  /**
   * The tool visibility mask applied to the coordinator agent's scope on
   * activation. Deployment-chosen write-tool names go in `deny`; a curated
   * `allow` list narrows to a fixed set instead. Defaults to
   * {@link DEFAULT_COORDINATOR_RESTRICT}.
   */
  readonly restrict?: ToolRestriction
  /** Prompt order of the coordinator section (default 110). */
  readonly sectionOrder?: number
}

const SPAWN_WORKER = 'spawn_worker'
const SEND_TO_WORKER = 'send_to_worker'
const WORKER_BROADCAST = 'worker_broadcast'
const WORKER_TASKS = 'worker_tasks'

/**
 * Resolve whether coordinator mode is active for this configuration.
 * @param config - resolved deployment config.
 * @returns whether to activate coordinator mode on this agent's scope.
 */
export function isCoordinatorActive(config: CoordinatorConfig): boolean {
  if (config.enabled !== undefined) return config.enabled
  const env = process.env.DSH_COORDINATOR_MODE
  if (env === undefined) return false
  return env === '1' || env === 'true' || env === 'yes'
}

/**
 * The durable `name -> childId` and `childId -> name` worker bookkeeping for
 * one coordinator agent. Owned solely by the installed mode; no worker outlives
 * the containing CoordinatorInstall properly (each entry is disposable).
 */
class WorkerRegistry {
  private readonly nameToId = new Map<string, SessionId>()
  private readonly idToName = new Map<SessionId, string>()

  /** The coordinator-scoped spawn provider name. */
  readonly provider: string

  constructor(provider: string) {
    this.provider = provider
  }

  /** Record one named worker after its durable child id is known. */
  track(name: string, childId: SessionId): void {
    this.nameToId.set(name, childId)
    this.idToName.set(childId, name)
  }

  /** Resolve one name to its durable child id, or `undefined` when unknown. */
  resolve(name: string): SessionId | undefined {
    return this.nameToId.get(name)
  }

  /**
   * Resolve a worker reference that is either a registered name or one of the
   * tracked durable child ids, or `undefined` when it matches neither.
   */
  resolveAny(reference: string): SessionId | undefined {
    const byName = this.nameToId.get(reference)
    if (byName !== undefined) return byName
    for (const childId of this.idToName.keys()) {
      if (String(childId) === reference) return childId
    }
    return undefined
  }

  /** Drop a worker from the registry without touching its session. */
  untrack(name: string): void {
    const childId = this.nameToId.get(name)
    this.nameToId.delete(name)
    if (childId !== undefined) this.idToName.delete(childId)
  }

  /** Snapshot of the registered named workers in insertion order. */
  entries(): { name: string; childId: SessionId }[] {
    return [...this.nameToId].map(([name, childId]) => ({ name, childId }))
  }
}

/**
 * The registrations installed when coordinator mode activates on one agent's
 * scope. Each registration is scoped to that agent's context and owned by the
 * returned disposer, so disabling the mode (fiber disposal) removes the prompt
 * section, the scheduling tools, and the tool restriction together.
 * @param agent - the coordinator agent whose scope receives the registrations.
 * @param ctx - context carrying the tool registry and subagent service.
 * @param config - resolved deployment config.
 * @returns a disposer that restores the coordinator agent's full surface.
 */
export function installCoordinatorMode(
  agent: Agent,
  ctx: Context,
  config: CoordinatorConfig = {},
): () => void {
  const provider = ctx.subagents
  const registry = new WorkerRegistry('spawn')

  // Scoped tool registration helper: each tool's execute resolves the live
  // coordinator agent and its durable id for authority and attribution.
  const disposals: (() => void)[] = []

  disposals.push(agent.ctx.systemPrompt.section({
    name: 'coordinator:mode',
    order: config.sectionOrder ?? COORDINATOR_SECTION_ORDER,
    text: COORDINATOR_SECTION_TEXT,
  }))

  disposals.push(agent.ctx.tools.register(defineTool({
    name: SPAWN_WORKER,
    description:
      'Start one named background worker to carry out a task in the shared workspace. '
      + 'Name it for later send_to_worker and worker_tasks use. When the worker finishes you receive a '
      + 'subagent-settled waking message, and a worker may also send you a message directly with its '
      + 'send_message tool. Delegation is the only way to change the workspace in coordinator mode.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'A stable name to address the worker by later; must be unique among your active workers.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'A self-contained task for the worker. It shares your workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          worker: { type: 'string', required: true },
          worker_id: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `worker ${args.name} started as ${value.worker_id}`,
      }],
    },
    async execute(args, exec) {
      const started = await provider.startContinuable({
        provider: registry.provider,
        label: args.name,
        request: {
          prompt: [{ type: 'text' as const, text: args.prompt }],
          parent: agent,
        },
        signal: exec.signal,
      })
      registry.track(args.name, started.childId)
      return { worker: args.name, worker_id: started.childId }
    },
  }) as unknown as HostToolDefinition))

  disposals.push(agent.ctx.tools.register(defineTool({
    name: SEND_TO_WORKER,
    description:
      'Send a message to one of your named workers. It steers a running worker at its next step boundary '
      + 'and wakes an idle or parked one. Use it to redirect, extend, or clarify work already delegated. '
      + 'Returns only delivery confirmation; the worker answers in a later message or through its '
      + 'subagent-settled finish notice.',
    parameters: {
      worker: {
        type: 'string',
        required: true,
        description: 'The name the worker was started with, or its durable worker id.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the worker.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          worker: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `message delivered to worker ${args.worker} as message ${value.messageId}`,
      }],
    },
    async execute(args, exec) {
      const childId = registry.resolveAny(args.worker)
      if (childId === undefined) {
        throw new Error(`unknown worker "${args.worker}": start it with spawn_worker first`)
      }
      const messageId = await provider.sendMessage(
        agent,
        childId,
        [{ type: 'text' as const, text: args.message }],
        { signal: exec.signal },
      )
      return { worker: args.worker, messageId }
    },
  }) as unknown as HostToolDefinition))

  disposals.push(agent.ctx.tools.register(defineTool({
    name: WORKER_BROADCAST,
    description:
      'Send the same message to every one of your active named workers, steering running ones and waking idle ones. ',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to every active worker.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `broadcast delivered to ${value.sent} worker${value.sent === 1 ? '' : 's'}`,
      }],
    },
    async execute(args, exec) {
      const entries = registry.entries()
      let sent = 0
      for (const entry of entries) {
        await provider.sendMessage(
          agent,
          entry.childId,
          [{ type: 'text' as const, text: args.message }],
          { signal: exec.signal },
        )
        sent += 1
      }
      return { sent }
    },
  }) as unknown as HostToolDefinition))

  disposals.push(agent.ctx.tools.register(defineTool({
    name: WORKER_TASKS,
    description:
      'List your active named workers and their durable ids, with a live status. '
      + 'Use it to recall what you delegated, not to poll for results — you are told when one finishes. '
      + 'One-shot children and workers you cannot read are omitted from the live view.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            worker: { type: 'string', required: true },
            worker_id: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['running', 'idle', 'ready'] },
          },
        },
      },
      render: (_args, value) => value.length === 0
        ? [{ type: 'text', text: '(no active workers)' }]
        : [{
          type: 'text',
          text: value.map(row => `${row.worker} [${row.status}] — ${row.worker_id}`).join('\n'),
        }],
    },
    async execute(_args, _exec) {
      const entries = registry.entries()
      const rows: { worker: string; worker_id: string; status: 'running' | 'idle' | 'ready' }[] = []
      for (const entry of entries) {
        const live = ctx.agents.get(entry.childId)
        const status = live === undefined ? 'ready' : (live.status === 'running' ? 'running' : 'idle')
        rows.push({ worker: entry.name, worker_id: entry.childId, status })
      }
      return rows
    },
  }) as unknown as HostToolDefinition))

  disposals.push(agent.ctx.tools.restrict(config.restrict ?? DEFAULT_COORDINATOR_RESTRICT))

  return () => {
    const failures: unknown[] = []
    for (const dispose of disposals.splice(0).reverse()) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke coordinator mode registrations')
    }
  }
}

/**
 * The coordinator-mode namespace plugin. Mount it in an agent's scope (as a
 * preset composes into `agent.ctx`) to activate coordinator mode for that
 * agent. When mode is inactive this is a no-op that registers nothing, so a
 * preset may mount it unconditionally and Coordination engages only when
 * enabled. Requires an agent scope when active, because tool restriction is an
 * agent-scoped operation.
 * @param ctx - context; must carry an `agent` when mode is active.
 * @param config - deployment config, optionally overriding the env flag.
 */
export function apply(ctx: Context, config: CoordinatorConfig = {}): () => void {
  if (!isCoordinatorActive(config)) return () => {}
  const agent = ctx.get('agent')
  if (agent === undefined) {
    // A coordinator masked across every agent would be a deployment mistake;
    // refusing keeps the misconfiguration visible at load time.
    throw new Error('dsh-coordinator requires an agent-scoped context (agent.ctx) when coordinator mode is active')
  }
  return installCoordinatorMode(agent, ctx, config)
}

export const name = 'coordinator'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']
