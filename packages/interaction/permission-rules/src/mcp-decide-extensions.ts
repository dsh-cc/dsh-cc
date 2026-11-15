/**
 * The MCP classification seam of the decision waterfall (design D3/D6b),
 * extracted from `decide.ts` for the file-size budget.
 *
 * ONE resolution step per call: consume the service-supplied classification
 * (`DecideDeps.mcpToolClassOf`) and, for a `workspaceWrite` call, run the
 * protected screen — every argument string value is tested with the SAME
 * anchored wildcard matcher `assessFilePath` uses against the effective
 * `protectedFiles`. A hit drops the classification (the call reverts to
 * unclassified) and yields a deterministic ask composed like the VWA guard:
 * only the classification-skip outcome is replaced, never a deny, the HIGH
 * risk short-circuit, or a `bypassPermissions` decision.
 *
 * Guarantee scope (design D6b): the screen detects protected patterns in
 * argument STRING VALUES only — a project-wide write that never names its
 * targets is out of scope, which is the accepted residual risk of configuring
 * `workspaceWriteTools` at all. The `.dsh/vwa` state guard stays out (it is a
 * file-edit-tool-specific ask guard; `workspaceWrite` claims no VWA parity).
 *
 * @module @dsh-cc/permission-rules/mcp-decide-extensions
 */

import type { ToolExecution } from '@dsh-cc/tools'
import { DEFAULT_PROTECTED_FILES, protectedPatternMatch } from './classifier.ts'
import type { McpToolClass, McpToolClassResolution, McpToolClassSource } from './mcp-tool-classes.ts'
import type { PermissionDecision, PermissionMode } from './types.ts'

/** The classification fields carried on one `DecidedCall` (always co-present). */
export type DecidedMcpClass = {
  /** The resolved MCP class, absent for an unclassified call. */
  mcpClass?: McpToolClass
  /** Which layer classified the call; set iff `mcpClass` is set. */
  mcpClassSource?: McpToolClassSource
  /**
   * The protected pattern a `workspaceWrite` argument string value matched.
   * Set iff the screen dropped the classification (so `mcpClass` is absent).
   */
  protectedPattern?: string
}

/** Depth bound on the argument walk — a cyclic or absurdly deep value stays safe. */
const MAX_ARGUMENT_DEPTH = 32

/**
 * Resolve one call's MCP classification and apply the `workspaceWrite`
 * protected screen (design D3/D6b) — the single resolution step.
 * @param deps - the classification supplier plus the classifier settings slice.
 * @param exec - the call being decided.
 * @returns the carried fields: class+source, or the screen's matched pattern.
 */
export function resolveMcpClass(
  deps: {
    mcpToolClassOf(exec: ToolExecution): McpToolClassResolution | undefined
    settings(): { protectedFiles?: string[] }
  },
  exec: ToolExecution,
): DecidedMcpClass {
  const resolution = deps.mcpToolClassOf(exec)
  if (resolution === undefined) return {}
  if (resolution.mcpClass !== 'workspaceWrite') {
    return { mcpClass: resolution.mcpClass, mcpClassSource: resolution.mcpClassSource }
  }
  // The plugin settings schema materializes an absent `protectedFiles` as an
  // empty list, so an empty list is indistinguishable from "unset" — it keeps
  // the curated defaults effective (design D6b's guarantee; there is no
  // separate disable switch for the protected set).
  const configured = deps.settings().protectedFiles
  const patterns = configured === undefined || configured.length === 0 ? DEFAULT_PROTECTED_FILES : configured
  const pattern = protectedArgumentMatch(exec.arguments, patterns)
  if (pattern !== undefined) return { protectedPattern: pattern }
  return { mcpClass: resolution.mcpClass, mcpClassSource: resolution.mcpClassSource }
}

/**
 * The first protected pattern any argument string value matches (design D6b).
 * Per-value anchored matching — never a substring search over serialized JSON.
 * @param args - the call arguments (any JSON value).
 * @param patterns - the effective `protectedFiles` wildcard patterns.
 * @returns the matching pattern, or `undefined` when every value is clean.
 */
export function protectedArgumentMatch(args: unknown, patterns: readonly string[]): string | undefined {
  const values: string[] = []
  collectStrings(args, values)
  for (const value of values) {
    const pattern = protectedPatternMatch(value, patterns)
    if (pattern !== undefined) return pattern
  }
  return undefined
}

/** Recursively collect every string value in a JSON-shaped argument tree. */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > MAX_ARGUMENT_DEPTH) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out, depth + 1)
}

/**
 * D6b composition: a protected-pattern hit in a `workspaceWrite` call's
 * argument strings turns the classification-skip outcome into a deterministic
 * ask. Composes like the VWA guard (decide.ts): a waterfall deny and a
 * `bypassPermissions` decision stand untouched; a session grant may still
 * convert the ask to allow downstream (existing ask semantics).
 * @param mode - the effective permission mode for the call.
 * @param decision - the pre-mapping waterfall decision.
 * @param pattern - the matched protected pattern, when the screen hit.
 * @returns the ask when the screen hit and composed, else `decision`.
 */
export function workspaceWriteProtectedAsk(
  mode: PermissionMode,
  decision: PermissionDecision,
  pattern: string | undefined,
): PermissionDecision {
  if (pattern === undefined) return decision
  if (decision.kind === 'deny' || mode === 'bypassPermissions') return decision
  return { kind: 'ask', reason: `requires approval: workspaceWrite tool arguments match protected pattern ${pattern}` }
}
