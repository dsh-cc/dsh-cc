/**
 * The bridge's hook runner: run every hook configured for a Claude Code point
 * whose matcher selects the event, fold the outputs, and persist the
 * `hook/invoked`/`hook/result` pair. Split from index.ts for the line budget;
 * apply() builds it once via {@link createRunPoint} with the resolved config
 * dependencies (the runner itself stays a pure function of those deps).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ccToolAliases } from '@dsh-cc/tools'
import {
  appendHookInvoked,
  appendHookResult,
  matchesMatcher,
  mergeHookOutputs,
  type HookIssue,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@dsh-cc/hook-protocol'
import type { ClaudeCodeHookConfig } from './config.ts'
import { dispatchHook } from './dispatch.ts'

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

/** The bridge-config fields the runner reads (structural subset of `Config`). */
interface RunPointConfig {
  projectDir?: string
  allowedHttpHookUrls?: string[]
  httpAllowedEnvVars?: string[]
  enablePromptHooks?: boolean
  enableAgentHooks?: boolean
}

/** Everything the runner closes over, resolved once by apply(). */
export interface RunPointDeps {
  ctx: Context
  /** Parsed CC hook config: point → matcher groups. */
  parsed: ClaudeCodeHookConfig
  config: RunPointConfig
  defaultTimeoutMs: number
  stderrSummaryMaxChars: number
  /** The http-hook header interpolation policy (a deployment's fixed allowlist). */
  httpAllowedEnvVars: () => ReadonlySet<string>
  /**
   * Best-effort sink for hook issues (safety-loop F5) — timeout, spawn failure,
   * non-0/2 exit, JSON parse failure. Optional (absent when no dsh-home path is
   * available); the appender itself never throws.
   */
  recordIssue?: (issue: HookIssue) => void
}

/**
 * Build the runner. See index.ts for the per-point call sites; the returned
 * function's contract is unchanged from the pre-split in-apply closure.
 */
export function createRunPoint(deps: RunPointDeps): (point: string, matchQuery: string, payload: unknown, opts: { agent?: Agent; turn?: number; readonly signal: AbortSignal }) => Promise<MergedHookOutcome> {
  const { ctx, parsed, config, defaultTimeoutMs, stderrSummaryMaxChars, httpAllowedEnvVars, recordIssue } = deps
  /**
   * Run every hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn. Detached lifecycle points omit the pair. Returns the merged outcome (a neutral,
   * already-most-restrictive view) for the caller to map onto its extension point
   * decision. `matchQuery` is the event's matcher subject (tool name, session
   * source, …), tested against every CC alias of the subject; `''` for events
   * that ignore matchers.
   */
  return async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: { agent?: Agent; turn?: number; readonly signal: AbortSignal },
  ): Promise<MergedHookOutcome> {
    const groups: MatcherGroup[] = parsed[point] ?? []
    const outputs: HookOutput[] = []
    // Run the hook in the agent's session workspace (the `session/new` cwd on the session
    // header), not the executor or entry-point process's launch dir.
    const workdir = opts.agent?.session.header.cwd
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to the session
    // workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    // A string matcher subject (tool name, session source, …) may be a harness
    // tool name the CC config spells differently. Match against every CC alias
    // (e.g. harness `read` also answers to `Read`, `read_image` to `Read`) so a
    // CC-written matcher like `Read|Write` or `Bash` fires for the harness
    // execution. A non-tool subject (a source tag, '' for matcher-less events)
    // has no aliases and collapses to the input itself.
    const matchQueries = ccToolAliases(matchQuery)
    for (const group of groups) {
      if (!matchQueries.some(query => matchesMatcher(group.matcher, query, 'claude-code'))) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await dispatchHook(ctx, hook, {
          payload,
          defaultTimeoutMs,
          ...hookEnv !== undefined ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          ...opts.agent !== undefined ? { agent: opts.agent } : {},
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
          ...config.allowedHttpHookUrls !== undefined ? { allowedHttpHookUrls: config.allowedHttpHookUrls } : {},
          httpAllowedEnvVars: httpAllowedEnvVars(),
          enablePromptHooks: config.enablePromptHooks ?? false,
          enableAgentHooks: config.enableAgentHooks ?? false,
        })
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (recordIssue !== undefined) recordHookIssues(recordIssue, point, handlerId, output, effectiveTimeoutMs(hook, defaultTimeoutMs))
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }
}

/** The effective timeout budget of one hook in ms (its per-hook value or the default). */
function effectiveTimeoutMs(hook: { timeoutSec?: number }, defaultTimeoutMs: number): number {
  return hook.timeoutSec !== undefined ? hook.timeoutSec * 1000 : defaultTimeoutMs
}

/**
 * Record the diagnostics-visible issues of one finished hook run (F5 detector
 * table): timeout, spawn failure (no exit code and not a timeout), a non-0/2
 * exit (2 is an intentional block, not an error), and a JSON parse failure.
 */
function recordHookIssues(record: (issue: HookIssue) => void, point: string, handlerId: string, output: HookOutput, timeoutMs: number): void {
  const base = { dialect: 'claude-code' as const, point, handlerId }
  if (output.timedOut) {
    record({ ...base, ts: new Date().toISOString(), kind: 'timeout', detail: `timed out after ${timeoutMs} ms` })
    return
  }
  if (output.exitCode === undefined) {
    record({ ...base, ts: new Date().toISOString(), kind: 'spawn-failure', detail: 'hook could not be spawned (no exit code)' })
    return
  }
  if (output.exitCode !== 0 && output.exitCode !== 2) {
    record({ ...base, ts: new Date().toISOString(), kind: 'exit-code', detail: `exit ${output.exitCode}: ${output.stderr}` })
  }
  if (output.parseFailure) {
    record({ ...base, ts: new Date().toISOString(), kind: 'parse-failure', detail: `exit 0 stdout looked like JSON but failed to decode: ${output.stdout}` })
  }
}
