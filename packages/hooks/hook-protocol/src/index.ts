/**
 * Shared, non-plugin hook protocol library: matching, command execution and
 * decoding, restrictive outcome merging, durable event helpers, and detached
 * run quiescence. Claude Code and Codex bridges own their distinct payloads,
 * environment rules, matcher mode, and typed extension-point mappings.
 * @module @dsh-cc/hook-protocol
 */

export type {
  AgentHook,
  CommandHook,
  HookCommand,
  HookCommandType,
  HookDialect,
  HookOutput,
  HttpHook,
  MatcherGroup,
  MatcherMode,
  PromptHook,
} from './types.ts'
export { matcherDiagnostic, matchesMatcher } from './matcher.ts'
export { parseHookOutput } from './codec.ts'
export { DEFAULT_HOOK_TIMEOUT_MS, runHook } from './runner.ts'
export type { RunHookOptions, RunHookResult } from './runner.ts'
export { DEFAULT_HTTP_HOOK_TIMEOUT_MS, interpolateEnvVars, runHttpHook } from './http.ts'
export type { RunHttpHookOptions, RunHttpHookResult } from './http.ts'
export { mergeHookOutputs } from './merge.ts'
export type { MergedDecision, MergedHookOutcome } from './merge.ts'
export { appendHookInvoked, appendHookResult, DEFAULT_STDERR_SUMMARY_MAX_CHARS, summarizeStderr } from './events.ts'
export type { HookInvocation, HookResultRecord } from './events.ts'
export { createDetachedRuns } from './detached.ts'
export type { DetachedRuns } from './detached.ts'
export { hookDiagnosticsWriter, readHookDiagnostics } from './diagnostics.ts'
export type { HookIssue, HookIssueKind } from './diagnostics.ts'
