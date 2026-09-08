/**
 * Filesystem boundary enforcement (WS2). A `tools/pre-execute` listener
 * registered with `{ prepend: true }` — ahead of the permission-rules
 * waterfall — that inspects every `fs`-family call, resolves its target path
 * against the session cwd (WS1), and routes out-of-workspace targets to an
 * approval ask unless the session is in `bypassPermissions` (allowed with the
 * existing audit trail). The guard is a pre-execute convenience, not a hard
 * security boundary: it does not intercept system calls.
 *
 * @module @dsh-cc/session-cwd/listener
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@dsh-cc/tools'
import { sessionCwdStore, type SessionCwdStore } from './state.ts'

/** Listener configuration. */
export interface BoundaryListenerConfig {
  /** Tool names treated as filesystem operations; defaults to {@link DEFAULT_FS_TOOLS}. */
  fsTools?: readonly string[]
  /** The store the listener resolves the session cwd from; defaults to the shared one. */
  store?: SessionCwdStore
}

/** The standard fs/edit tool set, matched case-insensitively. */
export const DEFAULT_FS_TOOLS: readonly string[] = [
  'edit',
  'write',
  'read',
  'multi_edit',
  'notebook_edit',
  'str_replace_editor',
  'glob',
  'grep',
]

/** Whether one tool name is an fs operation (case-insensitive match). */
export function isFsTool(name: string, fsTools: readonly string[] = DEFAULT_FS_TOOLS): boolean {
  const normalized = name.toLowerCase()
  return fsTools.some(tool => tool.toLowerCase() === normalized)
}

/** Argument keys inspected, in order, for a call's target path. */
const TARGET_KEYS: readonly string[] = ['file_path', 'notebook_path', 'path', 'workdir', 'cwd']

/**
 * Extract the target path of one call from its arguments. The first present
 * string-valued target key wins; tools without a path argument yield
 * `undefined` (the listener then passes them through untouched).
 * @param exec - the pending tool execution.
 * @returns the raw target path, or `undefined` when the call has none.
 */
export function targetPathOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments as Record<string, unknown> | undefined
  if (args === undefined || typeof args !== 'object') return undefined
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Whether a target path lies inside the workspace root (boundary is
 * workspace-scoped, not path-scoped). Both sides are resolved, so `..`
 * segments and relative targets cannot slip past.
 * @param target - the raw target path.
 * @param root - the workspace root (the session cwd).
 * @returns true when the target is the root or inside it.
 */
export function isInsideWorkspace(target: string, root: string): boolean {
  // Relative targets resolve against the workspace root, not the process cwd.
  const targetPath = isAbsolute(target) ? resolve(target) : resolve(root, target)
  const rootPath = resolve(root)
  if (targetPath === rootPath) return true
  const rel = relative(rootPath, targetPath)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Read the session's current permission mode from its event log: the last
 * `permission/mode` value, or `undefined` without one. Local wire-face fold —
 * the mode is an upstream-extensible session event, not owned here.
 * @param events - session events in log order.
 * @returns the recorded mode, or `undefined`.
 */
export function readPermissionMode(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as unknown as { type: string; data?: { mode?: unknown } }
    if (event.type === 'permission/mode' && typeof event.data?.mode === 'string') {
      return event.data.mode
    }
  }
  return undefined
}

/**
 * The boundary decision for one call, factored out of the listener for direct
 * testing. `undefined` means "not my decision" (the caller must call `next`).
 * @param exec - the pending tool execution.
 * @param config - listener configuration.
 * @returns an ask decision for out-of-workspace targets, `allow` for
 *   bypassPermissions, or `undefined` when the guard has no opinion.
 */
export function boundaryDecision(
  exec: ToolExecution,
  config: BoundaryListenerConfig = {},
): PreToolDecision | undefined {
  if (!isFsTool(exec.name, config.fsTools ?? DEFAULT_FS_TOOLS)) return undefined
  const target = targetPathOf(exec)
  if (target === undefined) return undefined
  const agent = exec.agent
  if (agent === undefined) return undefined
  const store = config.store ?? sessionCwdStore
  const root = store.resolve(String(agent.session.id), agent.session.snapshotEvents()) ?? agent.session.header.cwd
  if (root === undefined) return undefined
  if (isInsideWorkspace(target, root)) return undefined
  if (readPermissionMode(agent.session.snapshotEvents()) === 'bypassPermissions') return { kind: 'allow' }
  return {
    kind: 'ask',
    reason: `Operation targets path outside session workspace: ${resolve(target)} (workspace: ${resolve(root)})`,
  }
}

/**
 * Register the boundary guard on `tools/pre-execute` with `{ prepend: true }`
 * so it runs before the permission-rules waterfall and every later listener.
 * Non-fs tools, pathless calls, agents without a resolvable cwd, and
 * in-workspace targets pass through to `next` untouched.
 * @param ctx - the Cordis context.
 * @param config - listener configuration.
 * @returns a disposer that unregisters the listener.
 */
export function registerSessionCwdBoundary(ctx: Context, config: BoundaryListenerConfig = {}): () => void {
  const dispose = ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = boundaryDecision(exec, config)
    return decision ?? next()
  }, { prepend: true })
  return dispose
}
