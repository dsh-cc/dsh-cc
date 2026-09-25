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
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { ccToolAliases } from '@dsh-cc/tools'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveDetailedAlias } from '@dsh-cc/model-aliases'
import { createWarnOnce } from './route-policy.ts'
import { resolveClassifierBackend, resolveProbeBackend } from './gauge-backend.ts'
import { createClassifierStreamAdapter, type ClassifierStream } from './classifier-lane.ts'
import {
  appendSessionClassifier,
  createAutoStage,
  type AutoStage,
} from './auto-stage.ts'
import { exec as nodeExec } from 'node:child_process'
import { decideCallVerbose, effectiveMode, mapPostWaterfall, type DecideDeps } from './decide.ts'
import { createPiProbe, appendSessionProbe, foldProbes, probeInputText, type PiProbe } from './pi-probe.ts'
import { foldClassifiers } from './classifier-audit.ts'
import { summarizeChildHandoff, handoffWarningText } from './return-check.ts'
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
  /** Hands the built PI probe back to the service (rebuilt on reload). */
  onPiProbe(probe: PiProbe): void
  /** S4/D5 trip action: downgrade the session to default with the notice. */
  pauseAuto(exec: ToolExecution, notice: string): void
}

/**
 * Detail-preserving alias resolution shared by the classifier stage and the
 * PI probe (NOT toOneShotRoute — that helper drops reasoningEffort by design
 * for the other one-shot lanes): the calling agent's logged request header
 * fills the provider for a string-form (model-only) alias; a complete
 * {provider, model} alias needs no parent (session-title-provider precedent).
 */
function resolveDetailedRoute(
  ctx: Context,
  exec: ToolExecution,
  routeName: string,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const parent = exec.agent?.session.requestHeader()?.config as
    | { provider?: string; model?: string }
    | undefined
  const resolved = resolveDetailedAlias(ctx, routeName).route
  if (resolved === undefined) return undefined
  const provider = resolved.provider ?? parent?.provider
  const model = resolved.model ?? parent?.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return undefined
  return {
    provider,
    model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
  }
}

async function returnCheck(
  ctx: Context,
  decideDeps: DecideDeps,
  piProbe: PiProbe,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  decision: PostToolDecision & { kind: 'accept' },
): Promise<PostToolDecision> {
    if (!ccToolAliases(exec.name).includes('Task')) return decision
    if (effectiveMode(decideDeps, exec) !== 'auto') return decision
    let out: PostToolDecision & { kind: 'accept' } = decision
    // ARM (b) — report-text screening through the shared probe core.
    const input = probeInputText(result.content)
    if (input !== undefined) out = await piProbe.screen(exec, input, out)
    // ARM (a) — child audit fold (needs the structured value; failures and
    // background launches without an agentId are silently unresolvable).
    const value = result.isError ? undefined : (result as { value?: { agentId?: unknown } }).value
    const agentId = typeof value?.agentId === 'string' && value.agentId.length > 0 ? value.agentId : undefined
    if (agentId === undefined) return out
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const label = typeof args.description === 'string' ? args.description : 'unnamed'
    type ChildSession = {
      ownEvents?: () => readonly unknown[]
      snapshotEvents?: () => readonly unknown[]
      /** Legacy event array fallback (the one-shot-ledger probe order). */
      events?: readonly unknown[]
    }
    let events: readonly unknown[] | undefined
    try {
      const child = (ctx.get('agents') as { get?(id: string): { session?: ChildSession } | undefined } | undefined)?.get?.(agentId)
      const session = child?.session
      if (typeof session?.ownEvents === 'function') events = session.ownEvents()
      else if (typeof session?.snapshotEvents === 'function') events = session.snapshotEvents()
      else events = session?.events
    } catch (error: unknown) {
      // Resolver threw: a debug note only — no fabricated warning.
      ;(ctx.logger as { debug?: (message: string) => void }).debug?.(
        `permission-rules: subagent return check could not resolve child ${agentId}: ${String(error)}`,
      )
      return out
    }
    if (events === undefined) return out
    const summary = summarizeChildHandoff(foldClassifiers(events as never), foldProbes(events as never))
    if (!summary.warn) return out
    const warning: UserMessage = createUserMessage({
      content: [{ type: 'text', text: handoffWarningText(label, summary.reason) }],
      source: { kind: 'plugin', plugin: 'permission-rules' },
    })
    return { ...out, additionalContexts: [...(out.additionalContexts ?? []), warning] }
  }

/**
 * Build the DecideDeps face, the auto stage, and register the pre-execute
 * listener. Called from the service constructor at the historical position
 * (after guard registration and the settings inject, before the approval
 * listener).
 */
export function registerPreExecute(ctx: Context, host: PreExecuteHost): void {
  // Per-process policy warn-once ledger (§4.5) — ONE emitter for the plugin.
  const policyWarnOnce = createWarnOnce((message) => ctx.logger.warn(message))
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
    // §4.5 backend composition (PR-B B2b): the policy helper picks the
    // route NAME (explicit > backend auto armed-gauge > haiku); a chat name
    // resolves exactly as today, an armed/explicit gauge assembles the
    // System One lane from the alias + `llm-pi-ai` provider record +
    // credential-ref chain. The PI probe seam below stays chat-only.
    resolveRoute: (exec) =>
      resolveClassifierBackend(ctx, exec, {
        route: host.settingsSection().autoMode?.classifier?.route,
        backend: host.settingsSection().autoMode?.classifier?.backend ?? 'haiku',
        warnOnce: policyWarnOnce,
        resolveChatRoute: (e, name) => resolveDetailedRoute(ctx, e, name),
      }),
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
    // Fix B evidence source: the merged allow rules (settings + grants +
    // config — the collector applies the user-originated source filter).
    allowEvidenceRules: () => decideDeps.rules().allow,
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
    // S4/D5 trip action: honest provenance notice + auto → default downgrade
    // (host wires setMode; manual re-entry resets the counters).
    pauseAuto: (exec, notice) => host.pauseAuto(exec, notice),
  })
  host.onAutoStage(autoStage)

  // S7 input-layer PI probe: deps mirror the classifier face. Same §4.5
  // route-policy composition over the probe section (own `autoMode.probe`
  // route/backend, consumption default 'haiku') and the SAME env-gated
  // debug channel (raw probe output, process log only). The classifier
  // wiring above is untouched.
  const piProbe: PiProbe = createPiProbe({
    settingsRead: () => host.settingsSection(),
    get stream() {
      return llmStream
    },
    resolveRoute: (exec) =>
      resolveProbeBackend(ctx, exec, {
        route: host.settingsSection().autoMode?.probe?.route,
        backend: host.settingsSection().autoMode?.probe?.backend ?? 'haiku',
        warnOnce: policyWarnOnce,
        resolveChatRoute: (e, name) => resolveDetailedRoute(ctx, e, name),
      }),
    warn: (message) => ctx.logger.warn(message),
    audit: (session, event) => {
      appendSessionProbe(session, event)
    },
    ...(process.env.DSH_PERMISSION_CLASSIFIER_DEBUG === '1'
      ? { debug: (message: string) => (ctx.logger as { debug?: (msg: string) => void }).debug?.(`[permission-rules] ${message}`) }
      : {}),
    // A8: the SAME effective-mode resolution the stage and waterfall use
    // (plan overlay → session fold → defaultMode fallback), folded fresh at
    // every scan — never cached.
    modeOf: (exec) => effectiveMode(decideDeps, exec),
  })
  host.onPiProbe(piProbe)

  // S7 post-execute listener — DEFAULT order, post-next composition (A1
  // sideband redesign). NOTE on waterfall semantics (cordis `waterfall`
  // composes outermost-first; `{ prepend: true }` = outermost): the
  // context-crusher's prepend-order listener composes AROUND this one, so
  // `next()` here returns the crusher's (possibly content-rewritten) fold.
  // The probe deliberately scans the PRE-REWRITE ORIGINAL result content
  // (CCR-independent vantage) and delivers its warning via the
  // `additionalContexts` SIDEBAND on the downstream decision — a content
  // rewriter cannot clobber a sideband, so CC adjacency of
  // warning-to-content is approximated rather than exact.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'accept') return downstream
    try {
      let decision: PostToolDecision = await piProbe.scan(exec, result, downstream)
      // S6/D9 subagent-handoff return checks: warn-only, fail-open, auto-only.
      if (decision.kind === 'accept') decision = await returnCheck(ctx, decideDeps, piProbe, exec, result, decision)
      return decision
    } catch (error: unknown) {
      // Fail-open (context-crusher D6 idiom): a probe fault must NEVER
      // throw into the waterfall — a throw turns the user's tool result
      // into an error result (data loss).
      ctx.logger.warn(`permission-rules: pi-probe degraded to passthrough: ${String(error)}`)
      return downstream
    }
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decided = decideCallVerbose(decideDeps, exec)
    // Armed + auto + LOW + passthrough-only ⇒ the LLM stage decides (§4.1;
    // D3: rule-derived asks are NOT arbitrated by the LLM): verdict allow
    // ⇒ allow, verdict ask/failure ⇒ ask(reason). The stage consult reads
    // the PRE-mapping DecidedCall, exactly as before.
    const escalated = await autoStage.maybeEscalate(decided, exec)
    if (escalated !== undefined) {
      if (escalated === 'allow') return { kind: 'allow' }
      // S4/D6 deny-and-continue: a stage hard deny rides the existing
      // deny→error-tool-result delivery (the turn continues) wrapped with a
      // good-faith boundary instruction — nothing is halted.
      if (escalated.kind === 'deny') {
        return {
          kind: 'deny',
          reason: `Blocked by auto mode (hard rule: ${escalated.rule}): ${escalated.reason}. Treat this boundary in good faith: find a safer approach consistent with the user's actual request; do not try to route around this block.`,
        }
      }
      return { kind: 'ask', reason: escalated.reason }
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
