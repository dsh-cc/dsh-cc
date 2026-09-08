/**
 * The decision waterfall for one tool call, extracted from the service so the
 * engine core stays modular. Pure functions over a structural dependency face
 * (`DecideDeps`) that `PermissionRulesService` supplies in its constructor.
 *
 * Stage order: the risk-classifier escalation runs first (a hard-deny HIGH in
 * every mode; an ask MEDIUM outside bypassPermissions, with session-scoped
 * grants overriding the ask), then the normal mode-aware waterfall proceeds.
 * Under `auto`, a classifier-LOW call whose waterfall decision is `ask` is
 * auto-allowed (the classifier proxies the prompt); MEDIUM/HIGH already
 * returned above.
 *
 * @module @dsh-cc/permission-rules/decide
 */

import type { ToolExecution } from '@dsh-cc/tools'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { evaluatePermission } from './evaluate.ts'
import { assessBashCommand, assessFilePath, type RiskAssessment } from './classifier.ts'
import { isBashToolName, subjectOf } from './matchers.ts'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { foldPermissionMode } from './mode.ts'
import type { PermissionDecision, PermissionMode, PermissionRuleSet } from './types.ts'

/**
 * Structural dependency face the service supplies to the decision waterfall.
 * `settings()` returns the classifier-relevant slice of the settings-resolved
 * section; `defaultMode()`/`rules()` read the live merged state so a settings
 * reload is observed on the next call.
 */
export type DecideDeps = {
  /** Whether the risk-classifier escalation stage runs. */
  classifierEnabled: boolean
  /** Whether sandboxed bash skips a whole-tool `ask`. */
  exemptSandboxedBashFromToolAsk: boolean
  /** The shell-command tool name for content extraction. */
  bashToolName: string
  /** File-edit tool names auto-allowed under `acceptEdits` mode. */
  fileEditTools: ReadonlySet<string>
  /** Read-only tool names auto-allowed under `plan` mode. */
  readOnlyTools: ReadonlySet<string>
  /** The classifier-relevant slice of the current settings section. */
  settings(): { dangerousPatterns?: string[]; additionalDirectories?: string[]; protectedFiles?: string[] }
  /** The fallback (deployment-default) permission mode. */
  defaultMode(): PermissionMode
  /** The live merged rule set. */
  rules(): PermissionRuleSet
  /** Whether switching to `bypassPermissions` is disabled. */
  bypassDisabled(): boolean
  /** Session-scoped allowlist match (seed-once handled inside the service). */
  sessionAllowMatches(exec: ToolExecution): boolean
  /** The host shell service's sandbox mode, when mounted. */
  shellMode(): SandboxMode | undefined
}

/**
 * The effective mode for one call: plan overlays, else the session override.
 */
function effectiveMode(deps: DecideDeps, exec: ToolExecution): PermissionMode {
  const agent = exec.agent
  if (agent !== undefined && foldPlanMode(agent.session.snapshotEvents())) return 'plan'
  const recorded = agent === undefined ? undefined : foldPermissionMode(agent.session.snapshotEvents())
  return recorded ?? deps.defaultMode()
}

/** Whether a call is sandboxed bash for the whole-tool-ask exemption. */
function sandboxedBash(deps: DecideDeps, exec: ToolExecution): boolean {
  if (!deps.exemptSandboxedBashFromToolAsk) return false
  if (!isBashToolName(exec.name, deps.bashToolName)) return false
  const mode = deps.shellMode()
  return mode !== undefined && mode !== 'danger-full-access'
}

/**
 * Classify the risk of one call for the escalation stage. Bash-like tools
 * classify their command; file-edit tools classify their target path; other
 * tools are LOW. Skipped entirely when `classifierEnabled` is false.
 */
function classify(deps: DecideDeps, exec: ToolExecution): RiskAssessment {
  if (!deps.classifierEnabled) return { level: 'LOW', reasons: [] }
  const args = exec.arguments as Record<string, unknown>
  const session = exec.agent?.session
  if (isBashToolName(exec.name, deps.bashToolName) && typeof args.command === 'string') {
    return assessBashCommand(args.command, deps.settings().dangerousPatterns)
  }
  if (deps.fileEditTools.has(exec.name) && typeof args.file_path === 'string') {
    const settings = deps.settings()
    return assessFilePath(args.file_path, {
      cwd: session?.header?.cwd ?? '',
      ...settings.additionalDirectories === undefined ? {} : { additionalDirectories: settings.additionalDirectories },
      ...settings.protectedFiles === undefined ? {} : { protectedFiles: settings.protectedFiles },
    })
  }
  return { level: 'LOW', reasons: [] }
}

/**
 * The verbose result of the decision waterfall: the raw waterfall decision
 * (BEFORE any auto-mode proxying) plus the computed risk and effective mode.
 * The async classifier stage (§4.1 of the LLM risk-classifier design) needs
 * all three to decide whether to consult the LLM and how to escalate.
 */
export type DecidedCall = { decision: PermissionDecision; risk: RiskAssessment; mode: PermissionMode; isReadOnly: boolean }

/**
 * The sync, pure waterfall WITHOUT the auto-proxy conversion. Under `auto`, a
 * classifier-LOW call whose waterfall decision is `ask` is returned as `ask`
 * here — `decideCall` applies the proxy on top.
 */
export function decideCallVerbose(deps: DecideDeps, exec: ToolExecution): DecidedCall {
  const risk = classify(deps, exec)
  const isReadOnly = deps.readOnlyTools.has(exec.name)
  if (risk.level === 'HIGH') {
    return {
      decision: { kind: 'deny', reason: `blocked by risk classifier: ${risk.reasons.join('; ')}` },
      risk,
      mode: effectiveMode(deps, exec),
      isReadOnly,
    }
  }
  const mode = effectiveMode(deps, exec)
  if (risk.level === 'MEDIUM') {
    if (mode === 'bypassPermissions') return { decision: { kind: 'allow' }, risk, mode, isReadOnly }
    // Session-scoped approval memory (WS4-PR-B): a rule the user granted via
    // "Allow for this session" overrides the MEDIUM early-return ask. Checked
    // after the HIGH safety deny, before the MEDIUM ask. `plan` still asks —
    // read-only confinement outranks a session grant.
    if (mode !== 'plan' && deps.sessionAllowMatches(exec)) return { decision: { kind: 'allow' }, risk, mode, isReadOnly }
    return {
      decision: { kind: 'ask', reason: `requires approval by risk classifier: ${risk.reasons.join('; ')}` },
      risk,
      mode,
      isReadOnly,
    }
  }
  const subject = subjectOf(exec, deps.bashToolName)
  const decision = evaluatePermission({
    toolName: exec.name,
    ...subject === undefined ? {} : { subject },
    // Bypass-immune rules are enforced by the monotonic guard layer, not the
    // waterfall — pass an empty bypassImmune so the guard is authoritative.
    rules: { ...deps.rules(), bypassImmune: [] },
    mode,
    ...deps.bypassDisabled() ? { bypassDisabled: true } : {},
    isFileEdit: deps.fileEditTools.has(exec.name),
    isReadOnly,
    sandboxedBashExempt: sandboxedBash(deps, exec),
  })
  return { decision, risk, mode, isReadOnly }
}

/**
 * Fold the engine decision for one call. Bypass-immune matches fall to the
 * guard layer, not here. The risk-classifier escalation runs first (a
 * hard-deny HIGH in every mode; an ask MEDIUM outside bypassPermissions),
 * then the normal waterfall proceeds unchanged. Under `auto`, a classifier-LOW
 * call whose waterfall decision is `ask` is auto-allowed (the classifier
 * proxies the prompt); MEDIUM/HIGH already returned above.
 */
export function decideCall(deps: DecideDeps, exec: ToolExecution): PermissionDecision {
  const { decision, risk, mode } = decideCallVerbose(deps, exec)
  // auto proxies every LOW-risk ask: at this point the call is classifier-LOW
  // (MEDIUM and HIGH returned above), so low-risk asks auto-allow.
  if (mode === 'auto' && risk.level === 'LOW' && decision.kind === 'ask') {
    return { kind: 'allow' }
  }
  return decision
}
