/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, subagent
 * start/stop, and a set of lifecycle/observe events (PermissionRequest,
 * PermissionDenied, Notification (permission_prompt), PostCompact, SessionEnd,
 * StopFailure, TaskCreated, TeammateIdle, and a first-run Setup approximation).
 * It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * Payload construction, hook dispatch/decoding, and the hook runner live in the
 * payloads / dispatch / hook-output / run-point modules; turn-safety state and
 * shaping live in the turn-safety module.
 * `updatedInput` is logged and warned but not honored. `prompt` and `agent`
 * executors fork a one-shot subagent when their enable flags are set. Bespoke
 * behavior should use typed native plugins on the same extension points; see the
 * [hook-bridges Agent Note](../../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md).
 * @module @dsh-cc/hooks-claude-code
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import {
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  hookDiagnosticsWriter,
} from '@dsh-cc/hook-protocol'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'
import type { MatcherGroup } from '@dsh-cc/hook-protocol'
import type { HooksSeam } from '@dsh-cc/plugin-loader'
import { failedStatus, loadedStatus } from './status.ts'
import { registerEvents } from './register-events.ts'

export type { HookBridgeStatus } from './status.ts'
import { createRunPoint } from './run-point.ts'
import { createTurnSafety } from './turn-safety.ts'
import { sessionStartPayload, setupPayload, sessionResumePayload } from './payloads.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
    /**
     * The plugin hooks seam, provided unconditionally by this bridge (mirrors
     * the cc-shell `mcp` seam): loader fibers merge plugin hooks through it.
     */
    hooks?: HooksSeam
  }
}

export const name = 'hooks-claude-code'
// `bash` is required to run hooks; the rest are read opportunistically via
// ctx.get so a deployment can load this bridge without every extension point present.
export const inject = ['shell']

/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Optional: when unset, defaults to `$DSH_HOME/hooks.json` (resolved via
   * `ctx.dshHomePath`); when that too is unavailable, the bridge logs and
   * registers no hooks.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process.
   * TODO(per-session-hook-config): per-session discovery of a project-local
   * `hooks.json` from each `session/new.cwd`.
   */
  configPath?: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's session workspace (`session.header.cwd`, the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
  /**
   * URL-pattern allowlist (`*` wildcard) enforced before any `http` hook POST.
   * Absent/empty (the schemastery default) is unrestricted — the safe default
   * that cannot silently block http hooks; non-empty restricts to matching URLs.
   */
  allowedHttpHookUrls?: string[]
  /** Env-var names allowed to interpolate into `http` hook header values. */
  httpAllowedEnvVars?: string[]
  /**
   * Run configured `prompt` hooks by forking a small-model one-shot subagent
   * (default `false` — a configured-but-disabled `prompt` hook is skipped with a
   * warning, preserving the old safe default).
   */
  enablePromptHooks?: boolean
  /**
   * Run configured `agent` hooks by forking a verification subagent (default
   * `false` — same disabled-skip behavior as `enablePromptHooks`).
   */
  enableAgentHooks?: boolean
}

export const Config: z<Config> = z.object({
  configPath: z.string(),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  allowedHttpHookUrls: z.array(z.string()),
  httpAllowedEnvVars: z.array(z.string()),
  enablePromptHooks: z.boolean().default(false),
  enableAgentHooks: z.boolean().default(false),
})

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`hooks-claude-code: ${name} must be a positive integer`)
  }
}

/**
 * Read a dsh-home path without throwing when the boot-provided `dshHomePath`
 * resolver is absent — cordis throws on the property access itself (not a
 * plain `undefined`), so every read must be guarded.
 */
function dshHomeFile(ctx: Context, ...segments: string[]): string | undefined {
  try {
    return ctx.dshHomePath?.(...segments)
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config): void {
  // Resolve the hook config path: an explicit config value wins, otherwise
  // default to $DSH_HOME/hooks.json via ctx.dshHomePath. With neither available
  // (e.g. an app-boot that does not provide dshHomePath), the boot config is
  // empty and the bridge logs — but apply() CONTINUES: the `hooks` seam below
  // is provided unconditionally, so plugin hooks merged later still fire.
  const configPath = config.configPath || dshHomeFile(ctx, 'hooks.json')
  // The parsed boot config; `{}` when there is no path or the read/parse fails
  // (each logged, with the hookBridgeStatus provide as before).
  const parsed: ClaudeCodeHookConfig = {}
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  // F5: hook issues (config warnings among them) append to the dsh-home
  // diagnostics JSONL; without a dshHomePath the writer is a no-op.
  const diagnosticsPath = dshHomeFile(ctx, 'hooks', 'diagnostics.jsonl')
  const recordIssue = diagnosticsPath !== undefined ? hookDiagnosticsWriter(diagnosticsPath) : undefined
  if (!configPath) {
    ctx.logger.info('no hooks config path; hooks disabled')
    // Instance-scoped status for /doctor: no module-level singleton.
    ctx.provide('hookBridgeStatus', failedStatus('', 'no hooks config path', config))
  } else {
    // Validate before config parsing so a bad value cannot be hidden by its early return.
    assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
    // Parse once at load. A read or parse failure logs and registers nothing.
    try {
      const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
      const result = parseClaudeCodeConfig(raw, {
        ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
        ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
      })
      for (const [event, groups] of Object.entries(result.config)) parsed[event] = groups
      for (const s of result.skipped) {
        ctx.logger.warn(`hooks-claude-code: skipping "${s.type}" hook on ${s.event} (${s.reason})`)
      }
      // F6: every parse warning is logged AND recorded as a `config` diagnostic.
      for (const w of result.warnings) {
        const detail = `unsupported ${w.hookType} on ${w.event}${w.matcher !== undefined ? ` (matcher "${w.matcher}")` : ''}: ${w.keys.length > 0 ? w.keys.join(', ') : 'unknown event key'}`
        ctx.logger.warn(`hooks-claude-code: ${detail}`)
        recordIssue?.({ ts: new Date().toISOString(), dialect: 'claude-code', point: w.event, kind: 'config', detail })
      }
      ctx.provide('hookBridgeStatus', loadedStatus(configPath, parsed, result.skipped, config))
    } catch (error: unknown) {
      ctx.logger.warn(`hooks-claude-code: could not load hook config "${configPath}": ${String(error)} — no hooks registered`)
      ctx.provide('hookBridgeStatus', failedStatus(configPath, String(error), config))
    }
  }

  // Emit-shaped points run detached, so track their chains; disposal aborts
  // active hooks and drains continuations before resolving.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()
  // Every subagent id seen via subagent/start (or its paired end). Used to
  // restrict the TeammateIdle bridge to subagent scopes, since `agent/status`
  // itself does not distinguish root from child agents.
  const subagentIds = new Set<string>()
  ctx.effect(() => () => detached.drain(), 'hooks-claude-code: drain detached hook runs')

  // The http-hook header interpolation policy: the effective allowlist is the
  // configured names resolved once (a deployment's fixed allowlist, not a
  // per-run knob).
  const httpAllowedEnvVars = (): ReadonlySet<string> => new Set(config.httpAllowedEnvVars ?? [])
  const runPoint = createRunPoint({ ctx, parsed, config, defaultTimeoutMs, stderrSummaryMaxChars, httpAllowedEnvVars, ...recordIssue !== undefined ? { recordIssue } : {} })

  // The plugin hooks seam (the `hooks` guest contract from @dsh-cc/plugin-loader),
  // provided UNCONDITIONALLY — including with no boot config or a failed boot
  // parse — so a plugin shipping hooks/hooks.json still gets its hooks merged
  // and fired (plan docs/plans/2026-09-08-plugin-hooks-seam.md).
  ctx.provide('hooks', {
    mergePluginHooks(pluginName: string, raw: unknown, pluginRoot?: string): () => void {
      let result
      try {
        result = parseClaudeCodeConfig(raw, {
          ...pluginRoot !== undefined ? { pluginRoot } : {},
          ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
        })
      } catch (error: unknown) {
        // D1 (mcp-seam precedent): a bad plugin config (e.g. an invalid matcher
        // regex) skips the plugin's hooks with a warn — never throws.
        ctx.logger.warn(`hooks-claude-code: skipping hooks for plugin "${pluginName}": ${String(error)}`)
        recordIssue?.({ ts: new Date().toISOString(), dialect: 'claude-code', point: 'hooks', kind: 'config', detail: `plugin "${pluginName}" hooks rejected: ${String(error)}` })
        return () => {}
      }
      for (const s of result.skipped) {
        ctx.logger.warn(`hooks-claude-code: skipping "${s.type}" hook on ${s.event} (${s.reason})`)
      }
      for (const w of result.warnings) {
        const detail = `unsupported ${w.hookType} on ${w.event}${w.matcher !== undefined ? ` (matcher "${w.matcher}")` : ''}: ${w.keys.length > 0 ? w.keys.join(', ') : 'unknown event key'}`
        ctx.logger.warn(`hooks-claude-code: ${detail}`)
        recordIssue?.({ ts: new Date().toISOString(), dialect: 'claude-code', point: w.event, kind: 'config', detail })
      }
      // COPY-ON-WRITE merge: runPoint snapshots the per-event array reference
      // at the start of each dispatch, so replacing (not splicing) keeps any
      // in-flight snapshot stable — an in-place splice during dispose would
      // skip groups mid-iteration.
      const addedGroups = new Set<MatcherGroup>()
      const addedEvents = new Set<string>()
      for (const [event, groups] of Object.entries(result.config)) {
        parsed[event] = [...(parsed[event] ?? []), ...groups]
        for (const group of groups) addedGroups.add(group)
        addedEvents.add(event)
      }
      return () => {
        for (const event of addedEvents) {
          const remaining = (parsed[event] ?? []).filter(group => !addedGroups.has(group))
          if (remaining.length === 0) delete parsed[event]
          else parsed[event] = remaining
        }
      }
    },
  })

  // F1/F2/F3 turn-safety cluster (stop-block counters, cap override, halt and
  // notice shaping), built once like the run point.
  const turnSafety = createTurnSafety({ ctx, ...recordIssue !== undefined ? { recordIssue } : {} })

  // SessionStart injects context when its detached hook resolves; a slow hook
  // may miss the first request.
  // TODO(session-start-gating): add a startup gate before promising first-turn delivery.
  ctx.on('agent/session-start', ({ agent, source }) => {
    detached.track(runPoint('SessionStart', source, sessionStartPayload(ctx, agent, source), { agent, signal: detached.signal })
      .then((merged) => {
        turnSafety.detachedOutcome('SessionStart', merged, agent)
        const context = turnSafety.contextFrom(merged)
        if (context) agent.inject(context)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`)
      }))
    // Setup first-run approximation: a `startup` source means the session was
    // seeded brand-new (no prior history), so it is the closest harness analog
    // to Claude Code's initial boot. resume/clear/compact sources skip it.
    if (source === 'startup') {
      detached.track(runPoint('Setup', 'init', setupPayload(ctx, agent), { agent, signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('Setup', merged, agent) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: Setup hook failed: ${String(error)}`) }))
    }
    // SessionResume: a session resuming prior history. Only the `resume` source
    // fires it — dsh has no emit point for `clear`/`compact`, so those stay
    // unimplemented (see docs).
    if (source === 'resume') {
      detached.track(runPoint('SessionResume', '', sessionResumePayload(ctx, agent, source), { agent, signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('SessionResume', merged, agent) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SessionResume hook failed: ${String(error)}`) }))
    }
  })

  // All event listeners (UserPromptSubmit, Pre/PostToolUse, Stop, subagent
  // lifecycle, approval, observe, SessionEnd, StopFailure, TaskCreated,
  // TeammateIdle) live in register-events.ts, extracted to keep this entry
  // under the 500-line source budget.
  registerEvents({ ctx, detached, runPoint, turnSafety, subagentChildren, subagentIds })
}

// Public surface preserved from the pre-split monolith: prompt interpolation and
// subagent-result decoding stay importable from the package root.
export { contentToHookOutput, interpolatePrompt } from './hook-output.ts'
