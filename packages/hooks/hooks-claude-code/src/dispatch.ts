/**
 * Run one configured hook of any executor kind (`command`/`http`/`prompt`/`agent`)
 * and decode its neutral outcome. Split from index.ts for the line budget; the
 * only caller is the bridge's hook runner (run-point.ts).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  runHook,
  runHttpHook,
  type HookCommand,
  type HookOutput,
} from '@dsh-cc/hook-protocol'
import type { ModelRoutes } from '@dsh-cc/model-aliases'
import { toAgentOptions } from '@dsh-cc/model-aliases'
import { contentToHookOutput, emptyHookOutput, interpolatePrompt } from './hook-output.ts'

/** Everything {@link dispatchHook} needs beyond the hook itself. */
interface DispatchOptions {
  payload: unknown
  defaultTimeoutMs: number
  /** Extra env vars for a `command` hook (`CLAUDE_PROJECT_DIR`, …). */
  env?: Record<string, string>
  /** Working directory for a `command` hook. */
  cwd?: string
  /** Explicit owning-operation signal. */
  signal: AbortSignal
  /** Firing agent, required to fork a `prompt`/`agent` hook's subagent. */
  agent?: Agent
  /** Firing event used to guard per-event structured fields. */
  expectedEventName: string
  /** URL-pattern allowlist for `http` hooks (undefined = unrestricted). */
  allowedHttpHookUrls?: string[]
  /** Env-var names allowed to interpolate into `http` header values. */
  httpAllowedEnvVars: ReadonlySet<string>
  /** Whether `prompt` hooks may fork a small-model subagent. */
  enablePromptHooks: boolean
  /** Whether `agent` hooks may fork a verification subagent. */
  enableAgentHooks: boolean
}

/** Minimal structural subset of the `subagents` fork seam used by prompt/agent executors. */
interface HookSubagentLike {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: unknown
  }): Promise<{
    result: Promise<{ stopReason: string; content: readonly { type: string; text?: string }[] }>
  }>
}

/**
 * Run one configured hook of any executor kind and decode its neutral outcome.
 * `command` runs through {@link runHook} (the shell executor); `http` runs
 * through {@link runHttpHook} (a POST with allowlisted header interpolation).
 * `prompt` and `agent` fork a one-shot small-model/verification subagent when
 * the corresponding enable flag is set; a configured-but-disabled hook of those
 * kinds is skipped with a warn, and without a `subagents` service or parent agent
 * they degrade to the old warned no-op.
 * @param ctx - the plug context (gateway to the `subagents` service and logging).
 * @param hook - the configured hook of any kind.
 * @param opts - payload, timeouts, env/cwd, signal, event, and the http policy.
 * @returns the decoded output plus the run's wall-clock duration.
 */
export async function dispatchHook(ctx: Context, hook: HookCommand, opts: DispatchOptions): Promise<{ output: HookOutput; durationMs: number }> {
  const now = (): number => performance.now()
  const started = now()
  if (hook.type === 'http') {
    return runHttpHook(hook, {
      payload: opts.payload,
      allowedEnvVars: opts.httpAllowedEnvVars,
      ...opts.allowedHttpHookUrls !== undefined ? { allowedHttpHookUrls: opts.allowedHttpHookUrls } : {},
      defaultTimeoutMs: opts.defaultTimeoutMs,
      signal: opts.signal,
      expectedEventName: opts.expectedEventName,
      now,
    })
  }
  if (hook.type === 'prompt' || hook.type === 'agent') {
    const enabled = hook.type === 'prompt' ? opts.enablePromptHooks : opts.enableAgentHooks
    if (!enabled) {
      warnOnce(ctx, `hooks-claude-code: ${opts.expectedEventName} ${hook.type} hook is disabled (set ${hook.type === 'prompt' ? 'enablePromptHooks' : 'enableAgentHooks'} to run it)`)
      return { output: emptyHookOutput(), durationMs: now() - started }
    }
    const subagents = ctx.get?.('subagents') as HookSubagentLike | undefined
    if (!subagents || !opts.agent) {
      warnOnce(ctx, `hooks-claude-code: ${opts.expectedEventName} ${hook.type} hook cannot run (no subagents service or parent agent)`)
      return { output: emptyHookOutput(), durationMs: now() - started }
    }
    const prompt = interpolatePrompt(hook.prompt, opts.payload)
    // Model stamping goes through the ccModelRoutes alias service: an authored
    // `model:` resolves as an alias (never a literal id), and an omitted model
    // defaults to the cheap lane (`resolve('haiku')` — the configured haiku
    // alias; unconfigured → inherit). Missing service → no stamp (inherit).
    const routes = ctx.get('ccModelRoutes') as ModelRoutes | undefined
    const agentOptions = toAgentOptions(
      hook.model !== undefined ? routes?.resolve(hook.model) : routes?.resolve('haiku'),
    )
    let run
    try {
      run = await subagents.start('fork', {
        label: hook.type === 'prompt' ? 'hook-prompt' : 'hook-agent',
        signal: opts.signal,
        prompt: [{ type: 'text', text: prompt }],
        parent: opts.agent,
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      })
    } catch (error: unknown) {
      ctx.logger.warn(`hooks-claude-code: ${opts.expectedEventName} ${hook.type} hook could not fork a subagent: ${String(error)}`)
      return { output: emptyHookOutput(), durationMs: now() - started }
    }
    const result = await run.result
    const decoded = contentToHookOutput(result, (m) => ctx.logger.debug(m))
    if (decoded.error !== undefined) {
      ctx.logger.warn(`hooks-claude-code: ${opts.expectedEventName} ${hook.type} hook errored: ${decoded.error.message}`)
    }
    return { output: decoded.output, durationMs: now() - started }
  }
  return runHook(ctx.shell, hook, {
    payload: opts.payload,
    defaultTimeoutMs: opts.defaultTimeoutMs,
    ...opts.env !== undefined ? { env: opts.env } : {},
    ...opts.cwd !== undefined ? { cwd: opts.cwd } : {},
    signal: opts.signal,
    trailingNewline: true,
    expectedEventName: opts.expectedEventName,
  }, now)
}

/** Warn once per skip reason so a repeated disabled hook does not spam the log. */
const warnedSkips = new Set<string>()
function warnOnce(ctx: Context, message: string): void {
  if (warnedSkips.has(message)) return
  warnedSkips.add(message)
  ctx.logger.warn(message)
}
