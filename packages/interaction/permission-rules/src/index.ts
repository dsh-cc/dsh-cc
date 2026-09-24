/**
 * Claude Code-compatible permission-rule engine. Owns a source-labelled rule
 * set (Config `rules` merged with the optional `permissions` settings section),
 * a `tools/pre-execute` listener that folds a mode-aware decision, and the
 * monotonic guard layer that enforces bypass-immune content rules so neither a
 * mode switch nor `bypassPermissions` can override them. A risk-classifier
 * escalation stage hard-denies catastrophic commands and asks on protected or
 * out-of-scope file writes before the normal waterfall. Rules fail loud at
 * load; settings hot-reloads by rebuilding merged state and re-registering
 * guards.
 *
 * @module @dsh-cc/permission-rules
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecution } from '@dsh-cc/tools'
import { foldSessionCwd } from '@dsh-cc/session-cwd'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { installSectionSafe } from '@dsh-cc/settings-ns'
// Side-effect type import: declaration-merges `ctx.shell` (the capability fact
// `sandboxMode` this plugin reads for the sandboxed-bash exemption). No value
// dependency on the seam.
import type {} from '@deepseek-ai/dsh-shell'
import { parseRule, ruleString } from './parser.ts'
import { criticalDenyRules } from './critical-deny.ts'
import { pinDefaultMode } from './default-mode-pin.ts'
import { mergeRuleSets } from './evaluate.ts'
import { filterAutoAllowRules } from './auto-rule-filter.ts'
import { registerPreExecute } from './pre-execute.ts'
import type { AutoStage } from './auto-stage.ts'
import type { PiProbe } from './pi-probe.ts'
import {
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSet,
  type PermissionRuleSource,
} from './types.ts'
import {
  foldPlanMode,
  foldPermissionMode,
  switchSessionPermissionMode,
} from './mode.ts'
import { ruleMatches, subjectOf } from './matchers.ts'
import { SessionAllowlist, foldSessionAllows } from './session-allowlist.ts'
import { createSandboxApprovalListener } from './approval-listener.ts'

export {
  SESSION_ALLOW_EVENT,
  SessionAllowlist,
  appendSessionAllow,
  foldSessionAllows,
  type SessionAllowEventData,
} from './session-allowlist.ts'
export {
  createSandboxApprovalListener,
  isSandboxEscalation,
  type SandboxApprovalListenerConfig,
} from './approval-listener.ts'

export {
  foldPlanMode,
  foldSandboxMode,
  foldPermissionMode,
  foldResumeSandbox,
  setPermissionMode,
  PERMISSION_MODE_EVENT,
} from './mode.ts'
export {
  CLASSIFIER_EVENT,
  appendSessionClassifier,
  foldClassifiers,
  createAutoStage,
  DENY_STREAK_THRESHOLD,
  DENY_TOTAL_THRESHOLD,
  TRIP_NOTICE,
  foldDenyBackstop,
  type AutoModeSettings,
  type AutoModeClassifierSettings,
  type AutoModeProbeSettings,
  type ClassifierAuditEventData,
} from './auto-stage.ts'
export {
  PROBE_EVENT,
  appendSessionProbe,
  foldProbes,
  createPiProbe,
  matchesScanSet,
  probeInputText,
  probeWarningText,
  type PiProbe,
  type PiProbeDeps,
  type ProbeAuditEventData,
  type ProbeFoldDecision,
} from './pi-probe.ts'
export {
  CLASSIFIER_BREAKER_THRESHOLD,
  BREAKER_FAILURE_TAGS,
  RouteBreaker,
  trailingRouteFailureStreak,
} from './classifier-breaker.ts'
export {
  createLlmClassifier,
  expandSoftDeny,
  DEFAULT_SOFT_DENY,
  type LlmVerdict,
  type LlmClassification,
  type ClassifierAuditEvent,
  type ClassifierFailure,
} from './llm-classifier.ts'
export {
  DEFAULT_ALLOW_EXCEPTIONS,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  expandSlot,
} from './slots.ts'
export {
  PERMISSION_MODES,
  SWITCHABLE_PERMISSION_MODES,
  PLAN_READONLY_REASON,
  type PermissionMode,
  type SwitchablePermissionMode,
} from './types.ts'
export {
  parseRuleString,
  ruleString,
  contentMatches,
} from './parser.ts'
export { canonicalizeHostname, isWebFetchRuleTool } from './domain.ts'
export { summarizeChildHandoff, handoffWarningText, HANDOFF_ASK_STORM, type ChildHandoffSummary } from './return-check.ts'
export { filterAutoAllowRules } from './auto-rule-filter.ts'
export { DEFAULT_MEDIUM_PATTERNS, DEFAULT_DANGEROUS_PATTERNS, CRITICAL_BASH_PATTERNS } from './classifier.ts'
export { parseRuleSafe, contentSubsumes, ruleSubsumes } from './subsumption.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted permission-rule engine, when this plugin is composed. */
    permissionRules: PermissionRulesService
  }
}

/** The settings namespace carrying `permissions.allow/deny/ask/defaultMode`. */
export const PERMISSION_SETTINGS_NAMESPACE = 'permissions' as SettingsNamespace

export {
  permissionSettingsSchema,
  ConfigSchema,
  DEFAULT_FILE_EDIT_TOOLS,
  DEFAULT_READ_ONLY_TOOLS,
  type PermissionSettings,
  type ConfigRules,
  type Config,
} from './settings-schema.ts'
import {
  ConfigSchema,
  permissionSettingsSchema,
  type Config,
  type ConfigRules,
  type PermissionSettings,
} from './settings-schema.ts'

/** Build a settings-resolved rule set from a settings section. */
function settingsRuleSet(settings: PermissionSettings, source: PermissionRuleSource): PermissionRuleSet {
  return {
    allow: (settings.allow ?? []).map(raw => parseRule(raw, 'allow', source)),
    deny: (settings.deny ?? []).map(raw => parseRule(raw, 'deny', source)),
    ask: (settings.ask ?? []).map(raw => parseRule(raw, 'ask', source)),
    bypassImmune: [],
  }
}

/** One short model-facing sentence per permission mode for the prompt context. */
const MODE_SENTENCE: Record<PermissionMode, string> = {
  default: 'Permission mode: default. Tool calls follow allow/deny/ask rules; unmatched calls pass through.',
  acceptEdits: 'Permission mode: acceptEdits. File edits are auto-allowed; other calls follow the rules.',
  plan: 'Permission mode: plan. Only read-only tools may run; submit the plan via exit_plan_mode.',
  auto: 'Permission mode: auto. Low-risk approval prompts are auto-allowed; medium-risk prompts still ask the user.',
  bypassPermissions: 'Permission mode: bypassPermissions. Permission prompts are skipped and the sandbox is full access, except bypass-immune and catastrophic commands which remain denied.',
}

/**
 * The engine's Service Definition plus the mode/rule write and read surface.
 */
export class PermissionRulesService extends Service {
  static Config: z<Config> = ConfigSchema

  static inject = ['tools']

  private readonly bashToolName: string
  private readonly fileEditTools: ReadonlySet<string>
  private readonly readOnlyTools: ReadonlySet<string>
  private readonly settingsSource: PermissionRuleSource
  private readonly rulesConfig: ConfigRules
  /** Config-`bypassImmune` rules; {@link bypassImmuneRules} adds the curated critical tier on top. */
  private readonly configBypassImmuneRules: readonly PermissionRule[]
  /** Rebuilt on mount and settings change (curated tier depends on `criticalDeny` settings). */
  private bypassImmuneRules: readonly PermissionRule[]
  /** Reads the currently authoritative settings section (swapped by the settings hook). */
  private settingsRead: () => PermissionSettings = () => ({})
  /** Live merged state; rebuilt on settings change so listeners read a fresh snapshot. */
  private state: { rules: PermissionRuleSet; defaultMode: PermissionMode }
  /** Disposers for the currently registered monotonic guards. */
  private guardDisposers: (() => void)[] = []
  /** Session-scoped approval memory (WS4-PR-B): rules granted via the UI's "Allow for this session". */
  private readonly sessionAllowlist = new SessionAllowlist()
  /** Session ids already seeded from their log's `permission/session-allow` audit events. */
  private readonly allowlistSeeded = new Set<string>()
  /** The optional LLM classifier stage (armed per call from the live settings slice). */
  private autoStage: AutoStage | undefined
  /** The optional input-layer PI probe (S7); scans post-execute results in auto mode. */
  private piProbe: PiProbe | undefined
  /** The waterfall dependency face (S6 return-check mode gate); assigned in `registerGuards`. */

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'permissionRules')
    // The schema applied the defaults, so these are non-optional at runtime.
    this.bashToolName = config.bashToolName as string
    this.fileEditTools = new Set(config.fileEditTools)
    this.readOnlyTools = new Set(config.readOnlyTools)
    this.settingsSource = config.settingsSource as PermissionRuleSource
    this.rulesConfig = config.rules as ConfigRules | undefined ?? {}
    this.configBypassImmuneRules = (this.rulesConfig.bypassImmune ?? []).map(raw => parseRule(raw, 'deny', 'config'))
    this.bypassImmuneRules = [...this.configBypassImmuneRules, ...this.criticalRules()]
    this.state = { rules: this.configRuleSet(), defaultMode: config.defaultMode as PermissionMode }

    // Monotonic guard layer for bypass-immune rules: never overridable.
    this.registerGuards()

    // Optional settings inject: absent `ctx.settings` leaves only the Config
    // rules in force, exactly as the fallback contract requires. A stored
    // change re-enters reload() to rebuild merged state and the guards.
    ctx.inject(['settings'], () => {
      // Idempotent install: a duplicate namespace skips the throwing
      // installSection and wires live reads + settings/updated instead.
      installSectionSafe(ctx, PERMISSION_SETTINGS_NAMESPACE, permissionSettingsSchema(), {}, {
        setSource: (current) => { this.settingsRead = current },
        onChange: () => this.reload(),
        validate: value => this.validateSettings(value),
      })
    })

    // The decision waterfall + optional LLM classifier stage wiring lives in
    // ./pre-execute.ts (extracted for the file-size budget; ordering with the
    // registrations above is preserved by this call's constructor position).
    registerPreExecute(ctx, {
      config,
      bashToolName: this.bashToolName,
      fileEditTools: this.fileEditTools,
      readOnlyTools: this.readOnlyTools,
      settingsSection: () => this.settingsSection(),
      defaultMode: () => this.state.defaultMode,
      rules: () => this.state.rules,
      bypassDisabled: () => this.bypassDisabled(),
      sessionAllowMatches: (exec) => this.sessionAllowMatches(exec),
      onAutoStage: (stage) => { this.autoStage = stage },
      onPiProbe: (probe) => { this.piProbe = probe },
      pauseAuto: (exec, notice) => {
        const agent = exec.agent
        if (agent === undefined) return
        // D5: honest provenance (S4's origin parameter), never the
        // "changed by the user" template; manual re-entry resets counters.
        this.setMode(agent, 'default', notice)
      },
    })

    // WS3 sandbox integration: the approval-seam listener auto-approves
    // sandbox escalations in `auto` mode when the session has a resolvable
    // workspace root. Registered ahead of any UI provider so an eligible
    // escalation never reaches the modal queue; every auto-approval is
    // audit-logged to the session log (`scope: 'sandbox-auto'`).
    ctx.on('approval/request', createSandboxApprovalListener({
      modeOf: (agent) => {
        if (foldPlanMode(agent.session.snapshotEvents())) return 'plan'
        return foldPermissionMode(agent.session.snapshotEvents()) ?? this.state.defaultMode
      },
      workspaceOf: (agent) => this.sessionWorkspaceOf(agent),
    }))

    // Pin sessions created while the deployment default is a sandbox-affecting or
    // plan mode so a fresh session inherits the default durably.
    ctx.on('session/created', (session) => {
      pinDefaultMode(session, this.state.defaultMode, this.bypassDisabled(), () =>
        this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined)
    })

    // Optional model-facing mode sentence. Injected via ctx.inject so a missing
    // system-prompt seam is a silent no-op rather than a required dependency.
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'permission:mode',
        order: 116,
        text: (context) => {
          const agent = context.agent
          if (agent === undefined) return ''
          const mode = foldPlanMode(agent.session.snapshotEvents())
            ? 'plan'
            : (foldPermissionMode(agent.session.snapshotEvents()) ?? this.state.defaultMode)
          return MODE_SENTENCE[mode]
        },
      })
    })
  }

  /** The current settings-resolved section, defaulting to the schema default. */
  private settingsSection(): PermissionSettings {
    return this.settingsRead()
  }

  /**
   * S6/D9 subagent-handoff return checks. Runs ONLY for spawn tools
   * (`subagent`/`subagent_fork`, via the CC `Task` alias), ONLY in effective
   * `auto` mode, warn-only, and never throws (the listener wraps this in the
   * probe's fail-open catch).
   *
   * ARM (a): when the child session is resolvable — `result.value.agentId`
   * (the Task tool's output schema, packages/subagent/task/src/tool.ts) +
   * the `agents` registry (`ctx.agents.get(id)`, the one-shot-ledger face,
   * packages/subagent/task/src/one-shot-ledger.ts:77-80) — fold the child's
   * classifier/probe audit and warn on deny/breaker/trip/≥5-ask. An
   * unresolvable child under a resolver that THREW logs a debug note only —
   * never a fabricated warning.
   *
   * ARM (b) ALWAYS: screen the returned report text through the S7 probe
   * machinery (`piProbe.screen` — same instance, lane, breaker, audit) and
   * warn the parent to treat a flagged report as suspect.
   */

  /** Reject a settings section the engine could not act on — fail loud at the settings boundary. */
  private validateSettings(value: PermissionSettings): void {
    for (const raw of [...value.allow ?? [], ...value.deny ?? [], ...value.ask ?? []]) {
      parseRule(raw, 'allow', this.settingsSource)
    }
    if (value.defaultMode !== undefined && !PERMISSION_MODES.includes(value.defaultMode)) {
      throw new Error(`permission: unknown defaultMode ${JSON.stringify(value.defaultMode)}`)
    }
  }

  /** Rebuild merged state and re-register guards (mount and settings change). */
  private reload(): void {
    const settings = this.settingsSection()
    // The curated critical tier may gain settings `criticalDeny` entries —
    // rebuild the bypass-immune list, then the merged state and guards.
    this.bypassImmuneRules = [...this.configBypassImmuneRules, ...this.criticalRules()]
    this.state = {
      rules: mergeRuleSets(settingsRuleSet(settings, this.settingsSource), this.configRuleSet()),
      defaultMode: settings.defaultMode ?? this.config.defaultMode ?? 'default',
    }
    this.registerGuards()
    // Drop the memoized LLM classifier when the autoMode slice changed, so
    // the next armed call rebuilds it from fresh settings.
    this.autoStage?.rebuild()
    // S7: reset the probe's breaker state (the operator's "I fixed the lane").
    this.piProbe?.rebuild()
  }

  /** Curated critical-bash deny rules (built-ins + settings `criticalDeny`; mounting in ./critical-deny.ts). */
  private criticalRules(): readonly PermissionRule[] {
    return criticalDenyRules(this.settingsRead().criticalDeny, message => this.debug(message))
  }

  /** Debug log (best-effort; the process logger's debug may be absent). */
  private debug(message: string): void {
    ;(this.ctx.logger as { debug?: (msg: string) => void }).debug?.(`[permission-rules] ${message}`)
  }

  /** Parse the Configource-`config` rule set. */
  private configRuleSet(): PermissionRuleSet {
    const { allow = [], deny = [], ask = [] } = this.rulesConfig
    return {
      allow: allow.map(raw => parseRule(raw, 'allow', 'config')),
      deny: deny.map(raw => parseRule(raw, 'deny', 'config')),
      ask: ask.map(raw => parseRule(raw, 'ask', 'config')),
      bypassImmune: this.bypassImmuneRules,
    }
  }

  /** (Re)register monotonic guards for the bypass-immune rules, idempotent. */
  private registerGuards(): void {
    for (const dispose of this.guardDisposers) dispose()
    this.guardDisposers = this.bypassImmuneRules.map(rule =>
      this.ctx.tools.guard((exec) => {
        const subject = subjectOf(exec, this.bashToolName)
        if (subject === undefined || !ruleMatches(rule, exec.name, subject)) return undefined
        return `denied by permission rule ${ruleString(rule.toolName, rule.content)} [${rule.source}] (bypass-immune)`
      }),
    )
  }

  /**
   * Whether the session-scoped allowlist matches this call. The session's
   * rules are seeded once from its log's `permission/session-allow` audit
   * events, so a resumed session keeps its grants. Agent-less calls never
   * match (there is no session to scope to).
   */
  private sessionAllowMatches(exec: ToolExecution): boolean {
    const agent = exec.agent
    if (agent === undefined) return false
    const id = String(agent.session.id)
    if (!this.allowlistSeeded.has(id)) {
      this.allowlistSeeded.add(id)
      this.sessionAllowlist.seed(id, foldSessionAllows(agent.session.snapshotEvents()))
    }
    return this.sessionAllowlist.matches(id, exec.name, subjectOf(exec, this.bashToolName))
  }

  /**
   * The session's workspace root: the durable `worktree/entered` fold
   * (session-cwd, WS1), falling back to the session header cwd. Undefined
   * when the session never recorded a cwd — the sandbox listener then cannot
   * verify an escalation is in-scope and falls through to the normal ask.
   */
  private sessionWorkspaceOf(agent: Agent): string | undefined {
    return foldSessionCwd(agent.session.snapshotEvents()) ?? agent.session.header?.cwd
  }

  /**
   * Grant a session-scoped allow rule on the agent's session: in-memory match
   * for the rest of this session plus a `permission/session-allow` audit
   * event. Never touches the `permissions` settings namespace.
   * @param agent - the agent whose session is granted the rule.
   * @param rule - the rule string (e.g. `Bash(npm )` or a whole-tool name).
   */
  addSessionAllow(agent: Agent, rule: string): void {
    this.sessionAllowlist.add(agent.session, rule)
  }

  /**
   * Drop every session-scoped rule for the agent's session (audited clear
   * record in the session log).
   */
  clearSessionAllows(agent: Agent): void {
    this.sessionAllowlist.clear(agent.session)
  }

  /**
   * Whether switching to `bypassPermissions` is disabled by Config or the
   * settings section.
   */
  private bypassDisabled(): boolean {
    return this.config.disableBypassPermissionsMode === true
      || this.settingsSection().disableBypassPermissionsMode === 'disable'
  }

  /**
   * The LIVE merged settings default (`config.defaultMode`, overridden by the
   * settings section): rebuilt on every settings reload, so display surfaces
   * reading this always follow the currently authoritative default.
   */
  get defaultMode(): PermissionMode {
    return this.state.defaultMode
  }

  /**
   * Switch a session's permission mode durably. Semantics live in
   * `switchSessionPermissionMode` (./mode.ts): `plan` is owned by plan-mode
   * and throws; entering `bypassPermissions` pins the session sandbox to
   * `danger-full-access` and records the prior mode for restore; unknown or
   * disabled modes throw.
   * @param agent - the live agent whose session mode is changing.
   * @param mode - the new permission mode.
   * @param origin - optional provenance text for the injected announcement
   *   (S4/D5): replaces the default "(changed by the user)" suffix.
   */
  setMode(agent: Agent, mode: PermissionMode, origin?: string): void {
    switchSessionPermissionMode({
      agent,
      mode,
      defaultMode: this.state.defaultMode,
      bypassDisabled: this.bypassDisabled(),
      shellMode: this.ctx.get('shell')?.sandboxMode as SandboxMode | undefined,
      ...(origin === undefined ? {} : { origin }),
    })
  }

  /** The currently merged rule set (for introspection and host preview). */
  get ruleSet(): PermissionRuleSet {
    return this.state.rules
  }

  /**
   * The rule set a call in `mode` is evaluated against (D1 seam): in `auto`
   * mode the merged set with suspended allow rules filtered out
   * (`classifyAllShell` from the live autoMode section); every other mode
   * returns the merged set unchanged. The single seam for `/permissions` and
   * any future preview consumer.
   */
  effectiveRuleSet(mode: PermissionMode): PermissionRuleSet {
    if (mode !== 'auto') return this.state.rules
    return filterAutoAllowRules(this.state.rules, {
      classifyAllShell: this.settingsSection().autoMode?.classifyAllShell === true,
    })
  }
}

export default PermissionRulesService
