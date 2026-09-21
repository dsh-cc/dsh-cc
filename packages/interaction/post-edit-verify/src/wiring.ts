/**
 * Live wiring (design doc §3.2/§3.3): the `tools/post-execute` listener that
 * runs the verify command on an accepted edit/write and appends its outcome.
 * Fail-soft all the way — any failure returns the downstream decision
 * unchanged, never throwing into the waterfall.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { composeVerifyBlock } from './compose.ts'
import { matchRule } from './rules.ts'
import { createRunner, type Runner } from './runner.ts'
import { readUserRules } from './settings.ts'

/** Runtime editing tool names (doc §3.2; `multi_edit` does not exist). */
const EDITING_TOOLS = new Set(['edit', 'write'])

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** Guarded dshHome read (context-crusher index.ts pattern): cordis throws on the property access itself. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    return ctx.dshHomePath?.()
  } catch {
    return undefined
  }
}

export function registerListener(ctx: Context, shell: ShellExecutor): void {
  const runner: Runner = createRunner({ shell, logger: ctx.logger })
  // Read once at mount: no dshHome → the feature is inert (rules are a
  // user-layer file under dshHome; there is nothing to read).
  const dshHome = dshHomeOf(ctx)
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    try {
      return await appendVerify(ctx, runner, dshHome, exec, result, downstream)
    } catch (error: unknown) {
      // Fail-soft invariant of the seam (CCR precedent): a throw here would
      // turn the user's tool result into an error result (data loss).
      ctx.logger.warn(`post-edit-verify: degraded to passthrough: ${String(error)}`)
      return downstream
    }
  })
}

async function appendVerify(
  ctx: Context,
  runner: Runner,
  dshHome: string | undefined,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  downstream: PostToolDecision,
): Promise<PostToolDecision> {
  if (!EDITING_TOOLS.has(exec.name)) return downstream
  // Value-accept guard (doc §2): the runtime throws on content+value, so
  // never run (or compose onto) the value variant — skip before spawning.
  if (downstream.kind !== 'accept' || downstream.value !== undefined) {
    if (downstream.kind === 'accept') ctx.logger.debug('post-edit-verify: value-accept downstream — verify skipped')
    return downstream
  }
  if (dshHome === undefined) return downstream
  // Raw user-layer read per use (doc §3.4): cheap, hot-reload, project scope invisible.
  const settings = await readUserRules(dshHome)
  if (!settings.enabled) return downstream
  const sessionCwd = exec.agent === undefined ? undefined : getSessionCwd(exec.agent)
  const rule = matchRule(settings.rules, exec, sessionCwd)
  if (rule === undefined) return downstream
  const outcome = await runner.run(rule, exec, settings, sessionCwd)
  if (outcome.block === undefined) {
    ctx.logger.debug(`post-edit-verify: ${outcome.skipped ?? 'skipped'} — appending nothing`)
    return downstream
  }
  const composed = composeVerifyBlock(downstream, result, outcome.block)
  if (composed.skipped) ctx.logger.debug('post-edit-verify: downstream not composable — passthrough')
  return composed.decision
}
