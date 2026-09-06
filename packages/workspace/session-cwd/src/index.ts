/**
 * Session-scoped working directory for DeepSeek Harness CC (WS1 + WS2).
 * Registers the `worktree/entered` session event type at load (required for
 * persistence compatibility), maintains foldable session cwd state, exposes
 * `getSessionCwd` / `setSessionCwd`, and installs the `tools/pre-execute`
 * workspace boundary guard (prepend, ahead of permission-rules) that routes
 * out-of-workspace fs targets to an approval ask.
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
import { sessionCwdStore, type SessionCwdStore } from './state.ts'
import { getSessionCwd, setSessionCwd, type SessionCwdOptions } from './api.ts'

export { WORKTREE_ENTERED_EVENT, foldSessionCwd, appendWorktreeEntered, type WorktreeEnteredEventData } from './events.ts'
export { SessionCwdStore, sessionCwdStore, foldSessionCwdState, reduceSessionCwdState, EMPTY_SESSION_CWD_STATE, type SessionCwdState } from './state.ts'
export { getSessionCwd, setSessionCwd, type SessionCwdOptions } from './api.ts'
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

/**
 * Plugin entry point: install the workspace boundary guard. The event-type
 * registration happens at module load (the `./events.ts` side-effect import
 * above), so even API-only consumers register the type.
 * @param ctx - the Cordis context.
 * @param config - runtime configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.boundaryEnabled ?? true) {
    const listenerConfig: BoundaryListenerConfig = {
      ...config.fsTools !== undefined ? { fsTools: config.fsTools } : {},
    }
    registerSessionCwdBoundary(ctx, listenerConfig)
  }
}

/** Convenience face for host code that does not import the pure APIs directly. */
export const sessionCwd = {
  /** Read the authoritative session working directory. */
  get(agent: Agent, options?: SessionCwdOptions): string {
    return getSessionCwd(agent, options)
  },
  /** Change the session working directory (durable `worktree/entered` event). */
  set(agent: Agent, path: string, options?: SessionCwdOptions): void {
    setSessionCwd(agent, path, options)
  },
  /** The process-wide cwd overlay. */
  store: sessionCwdStore as SessionCwdStore,
}

// No default export: cordis-plugin-loader unwrapExports prefers `.default`, so
// a convenience object without `apply` fails preset mount as "invalid plugin".
