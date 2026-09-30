/**
 * The model-facing release valve: `release_agent` — a one-parameter tool that
 * evicts a direct continuable child's resident activation through the shared
 * `runRelease` operation (`@dsh-cc/command-agents/release`), so the model
 * surface and `/agents release <id>` render ONE copy set (plan
 * docs/plans/2026-09-30-subagent-release-valve.md §4 D2).
 *
 * Mount precedent (F16): `apply()` invokes the register function and DROPS
 * its disposer — registrations live with the tools seam's context lifetime;
 * the register returns `undefined` when the tools seam is absent.
 *
 * @module @dsh-cc/subagent-task/release-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@dsh-cc/tools'
import {
  renderReleaseOutcome,
  runRelease,
  type ReleaseRegistryLike,
  type ReleaseSubagentsLike,
} from '@dsh-cc/command-agents/release'

/** The registered tool name. */
export const RELEASE_AGENT_TOOL = 'release_agent'

interface ReleaseArgs {
  /** Id of a direct continuable child of this session. */
  agent_id: string
}

/**
 * Register the `release_agent` tool.
 * @param ctx - the plug context.
 * @returns the registration disposer, or undefined when the tools seam is
 *   absent (the F16 mount precedent).
 */
export function registerReleaseAgentTool(ctx: Context): (() => void) | undefined {
  const tools = ctx.get('tools') as {
    register(def: unknown): () => void
  } | undefined
  if (tools === undefined) return undefined

  return tools.register(defineTool({
    name: RELEASE_AGENT_TOOL,
    description:
      'Release a direct continuable subagent: its resident activation is evicted, '
      + 'and with it the resident activations of any descendants (a running turn is '
      + 'aborted; no separate interrupt needed). Eviction is cooperative — a turn that '
      + 'refuses cancellation keeps its slot until it settles (this tool reports that '
      + 'as still-resident with the release still in flight instead of hanging). A '
      + 'slot toward the 25-child capacity guard is freed only when the agent was '
      + 'running; idle agents hold no slot but are still evicted (one-way); an '
      + 'already-settled agent is a harmless no-op. The persisted session survives on '
      + 'disk. Within THIS session a released agent cannot be continued: '
      + '`send_message` resolves but runs no turn (a known upstream '
      + 'cold-resume-after-drain gap); continuation from a future session is not '
      + 'currently verified. `list_agents` and `/agents` still list a released agent '
      + '(the durable catalog is retained); `/agents` marks it [released] for the '
      + 'rest of this process.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description:
          'Id of a direct continuable child of this session (see list_agents). '
          + 'Grandchildren are refused — release their direct parent instead.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: ReleaseArgs, value: { text: string }) => [
        { type: 'text', text: value.text },
      ],
    },
    // Double-release converges to releasing/not-resident; safe to run in parallel.
    isConcurrencySafe: () => true,
    async execute(args: ReleaseArgs, exec: { agent?: Agent; signal: AbortSignal }) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('release_agent requires a calling agent (exec.agent was undefined)')
      }
      const subagents = ctx.get('subagents') as ReleaseSubagentsLike | undefined
      const agents = agent.ctx?.get?.('agents') as ReleaseRegistryLike | undefined
      const outcome = await runRelease({
        parent: agent,
        id: args.agent_id,
        subagents,
        agents,
        signal: exec.signal,
      })
      return { text: renderReleaseOutcome(outcome) }
    },
  }))
}
