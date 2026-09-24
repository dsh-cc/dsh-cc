/**
 * Tool matcher (design doc §4.1): runtime `exec.name` spellings ONLY —
 * `edit`, `write`, and `NotebookEdit` (capitalized at runtime — a trap).
 * `mcp__…`-prefixed names are excluded inherently by Set membership. The
 * `toolNames` settings override replaces this set wholesale.
 *
 * @module
 */

/** Runtime tool names that trigger a diagnostics pull (doc §4.1). */
export const DEFAULT_TOOL_NAMES: readonly string[] = ['edit', 'write', 'NotebookEdit']

/** The file-path argument key per runtime tool name (`NotebookEdit` uses `notebook_path`). */
function pathKeyFor(toolName: string): 'file_path' | 'notebook_path' | undefined {
  if (toolName === 'NotebookEdit') return 'notebook_path'
  if (toolName === 'edit' || toolName === 'write') return 'file_path'
  return undefined
}

/**
 * Whether this execution triggers a diagnostics pull, and the touched file
 * path argument when it does. `mcp__…` names cannot be in the set, so they
 * never match by construction (doc §4.4).
 * @returns the absolute-or-relative file path, or `undefined` to skip.
 */
export function matchTool(exec: { name: string; arguments: unknown }, toolNames: readonly string[] | undefined): string | undefined {
  const set = toolNames ?? DEFAULT_TOOL_NAMES
  if (!set.includes(exec.name)) return undefined
  const key = pathKeyFor(exec.name)
  if (key === undefined) return undefined
  const args = exec.arguments as Record<string, unknown> | undefined
  const value = typeof args === 'object' && args !== null ? args[key] : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
