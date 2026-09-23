/**
 * The `tools/pre-execute` wiring of the permission service: the DecideDeps
 * dependency face, the optional LLM classifier stage (auto-stage), and the
 * listener that consults the stage before applying the shared post-waterfall
 * mapping. Extracted from index.ts for the file-size budget — behavior is
 * identical to the inline constructor block; ordering with the other
 * constructor registrations is preserved by the call site.
 * @module @dsh-cc/permission-rules/pre-execute
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { PreToolDecision, ToolExecution } from '@dsh-cc/tools'
import { resolveDetailedAlias } from '@dsh-cc/model-aliases'
import { createClassifierStreamAdapter, type ClassifierStream } from './classifier-lane.ts'
import {
  appendSessionClassifier,
  createAutoStage,
  type AutoStage,
} from './auto-stage.ts'
import { exec as nodeExec } from 'node:child_process'
import { decideCallVerbose, effectiveMode, mapPostWaterfall, type DecideDeps } from './decide.ts'
import type { Config, PermissionSettings } from './settings-schema.ts'
import type { PermissionMode, PermissionRuleSet } from './types.ts'

/**
 * The structural host face the wiring needs from PermissionRulesService.
 * Every accessor reads live state, so a settings reload is observed on the
 * next call.
 */
export type PreExecuteHost = {
  /** The plugin config (schema defaults already applied). */
  config: Config
  bashToolName: string
  fileEditTools: ReadonlySet<string>
  readOnlyTools: ReadonlySet<string>
  /** The current settings-resolved section. */
  settingsSection(): PermissionSettings
  /** The live merged default mode. */
  defaultMode(): PermissionMode
  /** The live merged rule set. */
  rules(): PermissionRuleSet
  bypassDisabled(): boolean
  sessionAllowMatches(exec: ToolExecution): boolean
  /** Hands the built auto stage back to the service (rebuilt on reload). */
  onAutoStage(stage: AutoStage): void
}

/**
 * Build the DecideDeps face, the auto stage, and register the pre-execute
 * listener. Called from the service constructor at the historical position
 * (after guard registration and the settings inject, before the approval
 * listener).
 */
export function registerPreExecute(ctx: Context, host: PreExecuteHost): void {
  const decideDeps: DecideDeps = {
    classifierEnabled: host.config.classifierEnabled !== false,
    exemptSandboxedBashFromToolAsk: host.config.exemptSandboxedBashFromToolAsk === true,
    bashToolName: host.bashToolName,
    fileEditTools: host.fileEditTools,
    readOnlyTools: host.readOnlyTools,
    settings: () => host.settingsSection(),
    defaultMode: () => host.defaultMode(),
    rules: () => host.rules(),
    bypassDisabled: () => host.bypassDisabled(),
    sessionAllowMatches: (exec) => host.sessionAllowMatches(exec),
    shellMode: () => ctx.get('shell')?.sandboxMode as SandboxMode | undefined,
  }

  // The optional LLM classifier stage (§4.1/§4.4 of the LLM risk-classifier
  // design). The llm stream seam is wired via ctx.inject so a missing llm
  // service is a silent no-op rather than a required dependency.
  let llmStream: ClassifierStream | undefined
  ctx.inject(['llm'], (scope) => {
    llmStream = createClassifierStreamAdapter(scope.llm, message => ctx.logger.warn(message))
  })

  const autoStage: AutoStage = createAutoStage({
    settingsRead: () => host.settingsSection(),
    get stream() {
      return llmStream
    },
    resolveRoute: (exec) => {
      const route = host.settingsSection().autoMode?.classifier?.route ?? 'haiku'
      // Detail-preserving path (resolveDetailedAlias, NOT toOneShotRoute —
      // that helper drops reasoningEffort by design for the other one-shot
      // lanes): the classifier needs the route's effort ($level suffix or
      // alias target) so the lane can ride the cheapest declared level.
      // The calling agent's logged request header fills the provider for a
      // string-form (model-only) alias; a complete {provider, model} alias
      // needs no parent (session-title-provider precedent).
      const parent = exec.agent?.session.requestHeader()?.config as
        | { provider?: string; model?: string }
        | undefined
      const resolved = resolveDetailedAlias(ctx, route).route
      if (resolved === undefined) return undefined
      const provider = resolved.provider ?? parent?.provider
      const model = resolved.model ?? parent?.model
      if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return undefined
      return {
        provider,
        model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      }
    },
    warn: (message) => ctx.logger.warn(message),
    // R5 debug channel: opt-in via DSH_PERMISSION_CLASSIFIER_DEBUG=1, from
    // the plugin's scoped process logger — raw classifier output NEVER
    // enters session events (the digest-only audit contract stands). Raw
    // output may echo tool input (including secrets), so this stays an
    // explicitly opt-in channel with no redaction machinery.
    ...(process.env.DSH_PERMISSION_CLASSIFIER_DEBUG === '1'
      ? { debug: (message: string) => (ctx.logger as { debug?: (msg: string) => void }).debug?.(`[permission-rules] ${message}`) }
      : {}),
    audit: (session, event) => {
      appendSessionClassifier(session, event)
    },
    // A8 stale-mode revalidation: the SAME effective-mode resolution the
    // waterfall uses (plan overlay → session fold → defaultMode fallback).
    modeOf: (exec) => effectiveMode(decideDeps, exec),
    // D7 tool-history fold filter — the same set the waterfall's read-only
    // exemption consults.
    readOnlyTools: host.readOnlyTools,
    // S3 enrichment runner: bounded child process (cwd passed per call by
    // the stage — the session cwd); a failure rejects and the `<context>`
    // section is omitted (fail-open).
    runCommand: (cmd, opts) => new Promise<string>((resolve, reject) => {
      nodeExec(cmd, { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), timeout: opts.timeoutMs }, (error, stdout) => {
        if (error !== null) reject(error)
        else resolve(stdout)
      })
    }),
  })
  host.onAutoStage(autoStage)

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decided = decideCallVerbose(decideDeps, exec)
    // Armed + auto + LOW + passthrough-only ⇒ the LLM stage decides (§4.1;
    // D3: rule-derived asks are NOT arbitrated by the LLM): verdict allow
    // ⇒ allow, verdict ask/failure ⇒ ask(reason). The stage consult reads
    // the PRE-mapping DecidedCall, exactly as before.
    const escalated = await autoStage.maybeEscalate(decided, exec)
    if (escalated !== undefined) {
      return escalated === 'allow' ? { kind: 'allow' } : { kind: 'ask', reason: escalated.reason }
    }
    // The ONE shared post-waterfall mapping (D2/D3) — the decide.ts function,
    // not a duplicated inline proxy (the old LOW+ask→allow proxy is deleted).
    const decision = mapPostWaterfall(decideDeps, exec, decided)
    if (decision.kind === 'allow') return { kind: 'allow' }
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
    if (decision.kind === 'ask') return { kind: 'ask', ...decision.reason === undefined ? {} : { reason: decision.reason } }
    return next()
  })
}
