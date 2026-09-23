/**
 * The decision waterfall for one tool call, extracted from the service so the
 * engine core stays modular. Pure functions over a structural dependency face
 * (`DecideDeps`) that `PermissionRulesService` supplies in its constructor.
 *
 * Stage order: the risk-classifier HIGH deny runs first (in every mode),
 * then the normal mode-aware waterfall, then ONE shared post-waterfall
 * mapping (`mapPostWaterfall`, D2/D3): rule deny/mode allow stand, rule asks
 * honor a session grant (non-plan), MEDIUM passthrough honors a session
 * grant, else asks with the risk reason, LOW passthrough flows downstream.
 * There is no LOW+ask→allow proxy: in `auto` mode explicit ask rules prompt
 * (strict-rule auto, D11). Under `auto`, the merged rule set flows through
 * `filterAutoAllowRules` before evaluation (D1 rule suspension).
 *
 * @module @dsh-cc/permission-rules/decide
 */

import type { ToolExecution } from '@dsh-cc/tools'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { evaluatePermission } from './evaluate.ts'
import { assessBashCommand, assessFilePath, type RiskAssessment } from './classifier.ts'
import { filterAutoAllowRules } from './auto-rule-filter.ts'
import { isBashToolName, subjectOf } from './matchers.ts'
import { foldPlanMode } from './mode.ts'
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
  settings(): {
    dangerousPatterns?: string[]
    mediumPatterns?: string[]
    additionalDirectories?: string[]
    protectedFiles?: string[]
    autoMode?: { classifyAllShell?: boolean }
  }
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
    return assessBashCommand(args.command, deps.settings().dangerousPatterns, deps.settings().mediumPatterns)
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
  // MEDIUM no longer short-circuits before the waterfall (D2/A1): the
  // waterfall runs for LOW and MEDIUM alike; grants and the MEDIUM ask are
  // applied post-waterfall in mapPostWaterfall.
  const mode = effectiveMode(deps, exec)
  const subject = subjectOf(exec, deps.bashToolName)
  const decision = evaluatePermission({
    toolName: exec.name,
    ...subject === undefined ? {} : { subject },
    // Bypass-immune rules are enforced by the monotonic guard layer, not the
    // waterfall — pass an empty bypassImmune so the guard is authoritative.
    // Under `auto`, broad allow rules are suspended at evaluation time (D1).
    rules: {
      ...mode === 'auto'
        ? filterAutoAllowRules(deps.rules(), { classifyAllShell: deps.settings().autoMode?.classifyAllShell === true })
        : deps.rules(),
      bypassImmune: [],
    },
    mode,
    ...deps.bypassDisabled() ? { bypassDisabled: true } : {},
    isFileEdit: deps.fileEditTools.has(exec.name),
    isReadOnly,
    sandboxedBashExempt: sandboxedBash(deps, exec),
  })
  return { decision, risk, mode, isReadOnly }
}

/**
 * The ONE shared post-waterfall mapping (D2/D3), consumed by BOTH `decideCall`
 * and the index.ts listener — no duplicated proxy survives. Given the raw
 * waterfall decision:
 * - rule deny ⇒ stands; rule/mode allow ⇒ stands (a MEDIUM risk no longer
 *   outranks a matched allow — deliberate, CC-faithful);
 * - rule ask ⇒ stands, except a session grant (mode !== 'plan') allows —
 *   grant-on-ask, which also applies at LOW risk;
 * - passthrough at MEDIUM ⇒ a session grant (mode !== 'plan') allows, else
 *   bypassPermissions allows, else ask with the risk reason (in `plan` this
 *   leftover ask/passthrough already hit the evaluate plan wrap ⇒ deny);
 * - passthrough at LOW ⇒ unchanged (downstream, e.g. the LLM stage).
 */
export function mapPostWaterfall(
  deps: DecideDeps,
  exec: ToolExecution,
  decided: DecidedCall,
): PermissionDecision {
  const { decision, risk, mode } = decided
  if (decision.kind === 'allow' || decision.kind === 'deny') return decision
  if (decision.kind === 'ask') {
    if (mode !== 'plan' && deps.sessionAllowMatches(exec)) return { kind: 'allow' }
    return decision
  }
  // passthrough:
  if (risk.level === 'MEDIUM') {
    if (mode !== 'plan' && deps.sessionAllowMatches(exec)) return { kind: 'allow' }
    if (mode === 'bypassPermissions') return { kind: 'allow' }
    return { kind: 'ask', reason: `requires approval by risk classifier: ${risk.reasons.join('; ')}` }
  }
  return decision
}

/**
 * Fold the engine decision for one call: HIGH deny first, then the waterfall,
 * then the shared post-waterfall mapping. There is NO LOW+ask→allow auto
 * proxy (D3 — removed; auto mode is strict-rule: matched ask rules prompt).
 */
export function decideCall(deps: DecideDeps, exec: ToolExecution): PermissionDecision {
  return mapPostWaterfall(deps, exec, decideCallVerbose(deps, exec))
}
