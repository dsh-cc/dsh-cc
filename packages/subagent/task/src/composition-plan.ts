/**
 * Child composition bridge (harness 0.2.1-rc.5 migration, plan C5).
 *
 * Upstream removed per-spawn `toolFilter` / `persona` from the subagent start
 * request: "the selected preset owns persona and tool composition". dsh-cc's CC
 * agent definitions still carry both, and a preset cannot express them here (the
 * descriptor cannot carry a preset id; an explicit preset does not inherit the
 * parent composition; one preset per definition cannot encode dispatch-kind
 * differences such as the ephemeral `ToolSearch` strip).
 *
 * So the plan is applied to the child directly, at `agent/created`, on every
 * creation epoch — fresh, fork, ephemeral and `source: 'resume'`:
 *
 * - the listener MUST return `undefined`: `agent/created` is dispatched through
 *   cordis `serial`, which stops at the first non-nullish return, and both
 *   `tools.restrict` and `systemPrompt.section` return disposers;
 * - `tools.restrict` must run on `agent.ctx` (an unscoped caller throws);
 * - the filter must already be sanitized: unknown names and the reserved
 *   `run_code` throw inside `restrict` and would roll the child back;
 * - the persona registers as `deployment:persona-prefix`, the name a scoped
 *   section uses to shadow the parent persona (any other name would stack).
 *
 * Continuable children re-materialize from a durable descriptor that no longer
 * records composition, so the plan also lives in the resume pin (persona text +
 * filter) and is re-read by `recover` when the in-memory entry is gone (a
 * fresh process).
 *
 * @module @dsh-cc/subagent-task/composition-plan
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRestriction } from '@dsh-cc/claude-code-agents'

/** Composition to apply to one child agent. */
export interface ChildComposition {
  /** Gated persona text registered as the child's `deployment:persona-prefix`. */
  readonly persona?: string | undefined
  /** Sanitized tool restriction applied on the child's scoped context. */
  readonly toolFilter?: ToolRestriction | undefined
}

/** Minimal structural faces of the two services used here. */
interface RestrictableTools {
  restrict?(filter: ToolRestriction): unknown
}

interface SectionPrompt {
  section?(options: { name: string; order: number; text: string }): unknown
  getSectionOrder?(name: string): number
}

const plans = new Map<string, ChildComposition>()
const applied = new WeakSet<object>()

/**
 * Record the composition for a child before dispatch.
 * @param childId - the reserved durable child id (becomes the session id).
 * @param composition - persona/filter to apply when the agent is announced.
 */
export function planComposition(childId: string, composition: ChildComposition): void {
  if (composition.persona === undefined && composition.toolFilter === undefined) return
  plans.set(childId, composition)
}

/** Drop one plan (failed dispatch rollback). */
export function clearComposition(childId: string): void {
  plans.delete(childId)
}

/** The in-memory plan for one child, when still present. */
export function compositionOf(childId: string): ChildComposition | undefined {
  return plans.get(childId)
}

/**
 * Install the `agent/created` listener.
 * @param ctx - the task plugin context (used for logging).
 * @param recover - reads a plan back from durable state for resumed children.
 */
export function installCompositionListener(
  ctx: Context,
  recover?: (childId: string) => ChildComposition | undefined,
): void {
  ctx.on('agent/created', (payload: { agent: Agent }) => {
    const { agent } = payload
    const childId = String(agent.id)
    const composition = plans.get(childId) ?? recover?.(childId)
    if (composition === undefined) return
    if (applied.has(agent)) return
    applied.add(agent)
    applyComposition(ctx, agent, composition)
    // Composition applied: keep the plan for later resume epochs of the same
    // durable child (the in-memory entry is what makes a same-process resume
    // cheap; a fresh process recovers it from the pin).
  }, { global: true })
}

/**
 * Apply one composition to a child's scoped context. Never throws: a rejected
 * restriction is logged, because failing here would roll back child creation.
 * @param ctx - logging context.
 * @param agent - the announced child.
 * @param composition - the plan to apply.
 */
function applyComposition(ctx: Context, agent: Agent, composition: ChildComposition): void {
  const childCtx = agent.ctx as unknown as { tools?: RestrictableTools; systemPrompt?: SectionPrompt }
  if (composition.toolFilter !== undefined) {
    const tools = childCtx.tools
    if (tools?.restrict === undefined) {
      ctx.logger.warn('cc-task: child composition skipped the tool restriction: no tools service on the child context')
    } else {
      try {
        tools.restrict(composition.toolFilter)
      } catch (error) {
        ctx.logger.warn(`cc-task: child tool restriction rejected: ${String(error)}`)
      }
    }
  }
  const persona = composition.persona
  if (persona === undefined || persona.length === 0) return
  const prompt = childCtx.systemPrompt
  if (prompt?.section === undefined) {
    ctx.logger.warn('cc-task: child composition skipped the persona: no systemPrompt service on the child context')
    return
  }
  try {
    prompt.section({
      name: 'deployment:persona-prefix',
      order: prompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 0,
      text: persona,
    })
  } catch (error) {
    ctx.logger.warn(`cc-task: child persona registration rejected: ${String(error)}`)
  }
}

/**
 * Compose the filter an ephemeral one-shot receives: the sanitized filter keeps
 * its shape, but eager `ToolSearch` is stripped from the allow list so a
 * read-only child cannot regain tool search after the classifier ran.
 * @param filter - the sanitized restriction (undefined when unrestricted).
 * @param ephemeral - whether the definition classifies as a read-only one-shot.
 * @returns the filter to apply, or undefined when nothing changes.
 */
export function ephemeralToolFilter(
  filter: ToolRestriction | undefined,
  ephemeral: boolean,
): ToolRestriction | undefined {
  if (!ephemeral || filter === undefined) return filter
  if (filter.allow === undefined) return filter
  const allow = filter.allow.filter(name => name !== 'ToolSearch')
  return { ...filter, allow }
}
