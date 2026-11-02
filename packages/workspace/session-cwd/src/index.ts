/**
 * Session-scoped working directory for DeepSeek Harness CC (WS1 + WS2).
 * Registers the `worktree/entered` session event type at load (required for
 * persistence compatibility), exposes the service-backed `getSessionCwd` /
 * `resolveSessionCwd` facade, hydrates the harness `workingDirectory` service
 * from legacy logs, and installs the `tools/pre-execute` workspace boundary
 * guard (prepend, ahead of permission-rules) that routes out-of-workspace fs
 * targets to an approval ask.
 *
 * @module @dsh-cc/session-cwd
 */

import z from '@deepseek-ai/schemastery'
// Side-effect module import: adds `worktree/entered` to the persistence
// layer's known-event-type set at plugin load — required even when only the
// pure APIs are consumed.
import './events.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  registerSessionCwdBoundary,
  type BoundaryListenerConfig,
} from './listener.ts'
import { getSessionCwd } from './api.ts'
import { installLegacyCwdHydration } from './hydration.ts'

export { WORKTREE_ENTERED_EVENT, foldSessionCwd, type WorktreeEnteredEventData } from './events.ts'
export { getSessionCwd, resolveSessionCwd, type SessionCwdOptions } from './api.ts'
export { installLegacyCwdHydration } from './hydration.ts'
export {
  registerSessionCwdBoundary,
  boundaryDecision,
  isFsTool,
  targetPathOf,
  isInsideWorkspace,
  readPermissionMode,
  DEFAULT_FS_TOOLS,
  type BoundaryListenerConfig,
} from './listener.ts'

/** Plugin runtime configuration. All optional; the schema applies the defaults shown. */
export interface Config {
  /** Whether the pre-execute workspace boundary guard is installed (default true). */
  boundaryEnabled?: boolean
  /** Tool names treated as filesystem operations; defaults to the standard fs set. */
  fsTools?: string[]
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  boundaryEnabled: z.boolean().default(true),
  fsTools: z.array(z.string()),
})

/** The plugin module face consumed by the Cordis loader. */
export const inject: readonly string[] = []

/** Contexts already granted the `cwd` prompt variable (duplicate registration throws in the prompt registry). */
const cwdVariableRegistered = new WeakSet<Context>()

/**
 * Plugin entry point: install legacy hydration and the workspace boundary
 * guard. The event-type registration happens at module load (the `./events.ts`
 * side-effect import above), so even API-only consumers register the type.
 * @param ctx - the Cordis context.
 * @param config - runtime configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  void installLegacyCwdHydration(ctx)
  // rc.5: the strict prompt-variable set only knows provider/model; the cc
  // personas (agent.cordis.yml / agent.vwa.cordis.yml) interpolate {{cwd}}.
  // session-cwd is its owner, so it also registers the variable.
  const systemPrompt = ctx.get?.('systemPrompt') as
    | { variable?(name: string, provider: (context: { agent?: Agent }) => string | undefined): unknown }
    | undefined
  if (systemPrompt?.variable !== undefined && !cwdVariableRegistered.has(ctx)) {
    cwdVariableRegistered.add(ctx)
    systemPrompt.variable('cwd', context =>
      context.agent !== undefined ? getSessionCwd(context.agent) : undefined)
  }
  if (config.boundaryEnabled ?? true) {
    const listenerConfig: BoundaryListenerConfig = {
      ...config.fsTools !== undefined ? { fsTools: config.fsTools } : {},
    }
    registerSessionCwdBoundary(ctx, listenerConfig)
  }
}

// No default export: cordis-plugin-loader unwrapExports prefers `.default`, so
// a convenience object without `apply` fails preset mount as "invalid plugin".
