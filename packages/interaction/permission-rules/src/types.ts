/**
 * Shared types for the permission-rule engine: rule, source, mode, and the
 * pure evaluation decision. Browser-safe — no Cordis/session imports, so the
 * host UI (which previews what a rule hits) can import this subpath directly.
 * @module @dsh-cc/permission-rules/types
 */

/** Where a {@link PermissionRule} came from, in descending evaluation priority. */
export type PermissionRuleSource =
  /** Highest priority — a rule imposed by the delegation/session layer. */
  | 'session'
  /** A rule passed on the command line at launch. */
  | 'cliArg'
  /** A rule imposed by an external policy document. */
  | 'policySettings'
  /** A rule from a feature-flag or launch-flag settings layer. */
  | 'flagSettings'
  /** A rule from the local (machine-scoped) settings layer. */
  | 'localSettings'
  /** A rule from the project/workspace-scoped settings layer. */
  | 'projectSettings'
  /** A rule from the user settings layer. */
  | 'userSettings'
  /** Lowest priority — a rule from the plugin's composition `Config`. */
  | 'config'

/**
 * Every {@link PermissionRuleSource} ordered highest-priority first. Content
 * rules are consulted in this order; the first source with a matching rule
 * decides. Ties within one source fall back to declaration order.
 */
export const SOURCE_PRIORITY: readonly PermissionRuleSource[] = [
  'session',
  'cliArg',
  'policySettings',
  'flagSettings',
  'localSettings',
  'projectSettings',
  'userSettings',
  'config',
]

/** The behavior a rule prescribes when its tool (and content, when present) matches. */
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

/** The engine's permission mode, controlling tool-class and safe-mode short-circuits. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto'

/** Every {@link PermissionMode}, for option advertisement and runtime validation of untrusted strings. */
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto']

/** Modes that may be written to a `permission/mode` event. `plan` is owned by plan-mode. */
export type SwitchablePermissionMode = Exclude<PermissionMode, 'plan'>
export const SWITCHABLE_PERMISSION_MODES: readonly SwitchablePermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'auto']

/**
 * Reason attached to a plan-mode denial of a non-read-only call. Lives here
 * (not in `mode.ts`) so the browser-safe `evaluate` module can import it
 * without pulling in the session-vocabulary side effect.
 */
export const PLAN_READONLY_REASON = 'plan mode is read-only; submit via exit_plan_mode'

/**
 * One parsed permission rule. `toolName` is the exact tool the rule governs;
 * `content` makes it a content-level rule (matched against the tool's subject
 * string, e.g. a shell command or a file path) rather than a whole-tool rule.
 */
export interface PermissionRule {
  /** The exact tool name this rule governs. */
  readonly toolName: string
  /**
   * The content subject, when present: matched against the tool call's
   * subject string with the rule's {@link ContentMatcher}. Absent means the
   * rule is whole-tool.
   */
  readonly content?: string
  /** How to compare a call's subject against {@link PermissionRule.content}. */
  readonly matcher?: ContentMatcher
  /** The behavior this rule prescribes on a match. */
  readonly behavior: PermissionBehavior
  /** Where this rule came from, used for priority when several match. */
  readonly source: PermissionRuleSource
}

/**
 * How a content rule compares a call's subject against its declared content.
 * A `wildcard` pattern uses `*` to match any run of characters (`\*` is a
 * literal asterisk); a `prefix` rule matches any subject starting with the
 * string; a `domain` rule (WebFetch only) matches the call's canonicalized
 * URL hostname against a domain pattern (exact, `*.suffix` subdomain-tree, or
 * single-label `*` wildcards).
 */
export type ContentMatcher =
  | { kind: 'wildcard'; pattern: string }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'domain'; hostname: string }

/** A group of rules by behavior, used as the engine's rule input. */
export interface PermissionRuleSet {
  /** Rules that allow matching calls. */
  readonly allow: readonly PermissionRule[]
  /** Rules that deny matching calls. */
  readonly deny: readonly PermissionRule[]
  /** Rules that route matching calls to an approval question. */
  readonly ask: readonly PermissionRule[]
  /**
   * Bypass-immune deny rules, consulted BEFORE any mode logic and enforced
   * through the monotonic guard layer so neither a mode switch nor
   * `bypassPermissions` can override them (e.g. dotfiles, shell config paths,
   * `.git` internals).
   */
  readonly bypassImmune: readonly PermissionRule[]
}

/** A rule set with empty arrays (the no-rules input). */
export const EMPTY_RULE_SET: PermissionRuleSet = { allow: [], deny: [], ask: [], bypassImmune: [] }

/**
 * The engine's decision for one call, consumed by the `tools/pre-execute`
 * listener. `passthrough` falls through to downstream listeners (ultimately
 * the approval seam).
 */
export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
  | { kind: 'passthrough' }

/** The input the pure {@link evaluatePermission} folds a decision from. */
export interface EvaluationInput {
  /** The tool being called. */
  readonly toolName: string
  /** The call's subject string (shell command, file path), when it has one. */
  readonly subject?: string
  /** The rules to evaluate, already parsed and source-labelled. */
  readonly rules: PermissionRuleSet
  /** The active permission mode. */
  readonly mode: PermissionMode
  /** Whether `bypassPermissions` mode is disabled (fall back to `default`). */
  readonly bypassDisabled?: boolean
  /**
   * Whether the call is a file-edit tool (auto-allowed under `acceptEdits`).
   * Resolved from a configured tool-name set by the plugin, or provided
   * directly by a host UI caller.
   */
  readonly isFileEdit?: boolean
  /**
   * Whether a sandboxed bash call should skip a whole-tool `ask` (allowed
   * instead). The plugin resolves this from the shell's confining sandbox;
   * host callers may compute it directly.
   */
  readonly sandboxedBashExempt?: boolean
  /**
   * Whether the call is read-only (auto-allowed under `plan` mode). Resolved
   * from a configured tool-name set by the plugin.
   */
  readonly isReadOnly?: boolean
}

export default PermissionRule
