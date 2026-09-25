/**
 * Human-facing `/auto-mode` command: introspection for the `auto`-mode
 * classifier configuration. `/auto-mode defaults` prints the built-in slot
 * lists (`$defaults`-expanded built-ins only); `/auto-mode config` prints the
 * effective `permissions.autoMode` slice as the permission-rules engine sees
 * it — trusted-scoped (D12: the cascade assembles this key from trusted
 * layers only), with each slot list `$defaults`-expanded and the classifier
 * sub-config resolved; `/auto-mode review [full]` folds the CURRENT session's
 * `permission/classifier` + `permission/probe` audit events into a verdict
 * table (S5) — the `full` variant additionally prints audited full-text
 * inputs (`classifier.auditFullText`).
 *
 * All text derived from session/settings data passes through the shared
 * control-character sanitizer (`./sanitize.ts`); attacker-carried ANSI or
 * terminal control sequences must never reach the TUI. No model call, no
 * session write.
 * @module @dsh-cc/command-auto-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  CLASSIFIER_EVENT,
  DEFAULT_ALLOW_EXCEPTIONS,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_SOFT_DENY,
  PROBE_EVENT,
  expandSlot,
  pickGaugeRouteName,
  type ClassifierBackend,
} from '@dsh-cc/permission-rules'
import { helpable } from '@dsh-cc/command-usage'
import { sanitize } from './sanitize.ts'

export { sanitize } from './sanitize.ts'

export const name = 'command-auto-mode'
export const inject = ['commands']

/** The merged `permissions.autoMode` section as consumers resolve it. */
interface AutoModeSection {
  soft_deny?: string[]
  hard_deny?: string[]
  allow?: string[]
  environment?: string[]
  classifyAllShell?: boolean
  classifier?: {
    enabled?: boolean
    route?: string
    backend?: 'haiku' | 'auto'
    gaugeAllowThreshold?: number
    gaugeAllowEvidence?: boolean
    timeoutMs?: number
    cacheMaxEntries?: number
    auditFullText?: boolean
  }
  probe?: {
    enabled?: boolean
    route?: string
    backend?: 'haiku' | 'auto'
    timeoutMs?: number
    toolPatterns?: string[]
  }
}

/** Structural face of the settings provider: resolved (merged) section read. */
type SettingsLike = { get(ns: string): unknown }

/** The `$defaults`-expanded view of one slot list. */
function slotView(configured: readonly string[] | undefined, defaults: readonly string[]): Record<string, unknown> {
  return {
    configured: configured ?? null,
    expanded: expandSlot(configured ?? ['$defaults'], defaults),
  }
}

/** `/auto-mode defaults` — the built-in slot lists, `$defaults`-expanded. */
export function renderDefaults(): string {
  return sanitize(JSON.stringify({
    soft_deny: DEFAULT_SOFT_DENY,
    hard_deny: DEFAULT_HARD_DENY,
    allow: DEFAULT_ALLOW_EXCEPTIONS,
    environment: DEFAULT_ENVIRONMENT,
  }, null, 2))
}

/** The effective backend for one section (classifier or probe), computed by the caller from live state (design doc §4.6). Omitted on the render ⇒ byte-identical legacy output (the gauge-less compat contract). */
export interface EffectiveClassifier {
  /** The effective route NAME (explicit value | 'gauge' armed-auto | 'haiku'). */
  routeName: string
  /** How the route was picked. */
  source: 'explicit' | 'auto-gauge' | 'default'
  /** The armed gauge alias (`provider/model` + protocol), or null. */
  gauge?: { route: string; protocol: string } | null
}

/** The pinned route-selection policy sentence (§4.6). */
const ROUTE_POLICY = 'explicit route > backend auto (gauge when armed) > haiku'

/** `/auto-mode config` — the effective trusted-scoped autoMode slice. */
export function renderConfig(autoMode: AutoModeSection | undefined, effective?: EffectiveClassifier, effectiveProbe?: EffectiveClassifier): string {
  const classifier = autoMode?.classifier
  const classifierView: Record<string, unknown> = {
    enabled: classifier?.enabled === true,
    route: classifier?.route ?? 'haiku',
    timeoutMs: classifier?.timeoutMs ?? 8000,
    cacheMaxEntries: classifier?.cacheMaxEntries ?? 256,
    auditFullText: classifier?.auditFullText === true,
  }
  const payload: Record<string, unknown> = {
    classifier: classifierView,
    classifyAllShell: autoMode?.classifyAllShell === true,
    slots: {
      soft_deny: slotView(autoMode?.soft_deny, DEFAULT_SOFT_DENY),
      hard_deny: slotView(autoMode?.hard_deny, DEFAULT_HARD_DENY),
      allow: slotView(autoMode?.allow, DEFAULT_ALLOW_EXCEPTIONS),
      environment: slotView(autoMode?.environment, DEFAULT_ENVIRONMENT),
    },
  }
  if (effective !== undefined) {
    // Honest backend report (§4.6): the gauge-less fields stay as computed
    // above; the new fields carry the policy-resolved route and the armed
    // gauge alias. `gaugeAllowThreshold` reports the CONFIGURED value only —
    // the adapter applies its own default constant at consumption.
    const route = effective.routeName
    const gauge = effective.gauge ?? null
    classifierView.route = route
    classifierView.routeSource = effective.source
    classifierView.routePolicy = ROUTE_POLICY
    classifierView.backend = classifier?.backend ?? 'haiku'
    classifierView.gaugeAllowThreshold = classifier?.gaugeAllowThreshold ?? null
    classifierView.gaugeAllowEvidence = classifier?.gaugeAllowEvidence ?? null
    classifierView.gaugeRoute = gauge?.route ?? null
    classifierView.gaugeProtocol = gauge?.protocol ?? null
  }
  if (effectiveProbe !== undefined) {
    // PR-C: the probe's own backend discrimination, mirroring the
    // classifier's shape (no gaugeAllowThreshold — the noul gate is a
    // corpus-frozen constant, not a setting).
    const probe = autoMode?.probe
    const gauge = effectiveProbe.gauge ?? null
    payload.probe = {
      enabled: probe?.enabled !== false,
      backend: probe?.backend ?? 'haiku',
      route: effectiveProbe.routeName,
      routeSource: effectiveProbe.source,
      routePolicy: ROUTE_POLICY,
      gaugeRoute: gauge?.route ?? null,
      gaugeProtocol: gauge?.protocol ?? null,
    }
  }
  return sanitize(JSON.stringify(payload, null, 2))
}

/** One folded audit row (S5). Every string field is session-derived. */
interface ReviewRow {
  type: 'classifier' | 'probe'
  tool: string
  verdict: string
  failure: string
  rule: string
  reason: string
  latencyMs: number
  cacheHit: boolean
  secondPass: boolean
  input: string
}

/** The review cap: only the most recent 20 audit rows are printed (S5). */
const REVIEW_ROWS = 20

/**
 * Fold a session log into review rows, in log order (oldest first). Foreign
 * and malformed events are skipped — pre-S5 events (no rule/reason/input)
 * fold with empty cells (forward compatibility).
 */
export function foldReviewRows(events: readonly unknown[]): ReviewRow[] {
  const rows: ReviewRow[] = []
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const { type, data } = event as { type?: unknown; data?: unknown }
    if (type !== CLASSIFIER_EVENT && type !== PROBE_EVENT) continue
    if (typeof data !== 'object' || data === null) continue
    const d = data as Record<string, unknown>
    rows.push({
      type: type === CLASSIFIER_EVENT ? 'classifier' : 'probe',
      tool: typeof d.tool === 'string' ? d.tool : '',
      verdict: typeof d.verdict === 'string' ? d.verdict : '',
      failure: typeof d.failure === 'string' ? d.failure : '',
      rule: typeof d.rule === 'string' ? d.rule : '',
      reason: typeof d.reason === 'string' ? d.reason : '',
      latencyMs: typeof d.latencyMs === 'number' ? d.latencyMs : 0,
      cacheHit: d.cacheHit === true,
      secondPass: d.secondPass === true,
      input: typeof d.input === 'string' ? d.input : '',
    })
  }
  return rows
}

/** Sanitize a session-derived cell: control chars stripped, whitespace collapsed, empty ⇒ `-`. */
function cell(value: string): string {
  const collapsed = sanitize(value).replace(/\s+/g, ' ').trim()
  return collapsed === '' ? '-' : collapsed
}

/** `/auto-mode review [full]` — the audit verdict table for this session. */
export function renderReview(events: readonly unknown[], full: boolean): string {
  const rows = foldReviewRows(events)
  if (rows.length === 0) {
    return 'no permission/classifier or permission/probe audit events in this session yet.'
  }
  const recent = rows.slice(-REVIEW_ROWS)
  const skipped = rows.length - recent.length
  const headers = ['', 'tool', 'verdict', 'failure', 'rule', 'reason', 'latencyMs', 'cache', '2nd']
  const cells = recent.map((row, index) => [
    `<${row.type}> #${rows.length - recent.length + index + 1}`,
    cell(row.tool),
    cell(row.verdict),
    cell(row.failure),
    cell(row.rule),
    cell(row.reason),
    String(row.latencyMs),
    row.cacheHit ? 'yes' : 'no',
    row.secondPass ? 'yes' : 'no',
  ])
  const width = headers.map((header, column) => Math.max(header.length, ...cells.map(row => row[column]!.length)))
  const lines = [
    `permission/classifier + permission/probe audit — ${rows.length} event(s)${skipped > 0 ? `, showing the most recent ${REVIEW_ROWS}` : ''} (newest last):`,
    headers.map((header, column) => header.padEnd(width[column]!)).join('  '),
    ...cells.map(row => row.map((value, column) => value.padEnd(width[column]!)).join('  ').trimEnd()),
  ]
  if (full) {
    const withInput = recent.filter(row => row.input !== '')
    for (const row of withInput) {
      lines.push('', `<${row.type}> ${cell(row.tool)} — input:`, sanitize(row.input))
    }
    if (withInput.length === 0) {
      lines.push('', '(no inputs recorded — classifier.auditFullText is off, or the events predate the flag; audit is digest-only)')
    }
  }
  return lines.join('\n')
}

/** Face of the merged `model-aliases` gauge alias entry (object form, §4.3). */
type GaugeEntry = { provider?: unknown; model?: unknown; protocol?: unknown }

/**
 * The armed gauge alias from the merged `model-aliases` overlay (§4.3):
 * object form `{provider, model}` + the protocol bit (explicit
 * `protocol: 'systemone'` or the `llmbox_systemone/` family-prefix
 * heuristic). `null` when the entry is unresolvable as a System One lane.
 */
function gaugeInfo(settings: SettingsLike): { route: string; protocol: string } | null {
  const overlay = settings.get('model-aliases') as Record<string, unknown> | undefined
  const entry = overlay?.gauge as GaugeEntry | string | undefined
  if (entry === undefined || entry === null || typeof entry !== 'object') return null
  const { provider, model, protocol } = entry
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  const resolved =
    typeof protocol === 'string' ? protocol
      : model.includes('llmbox_systemone/') ? 'systemone'
        : undefined
  return resolved === undefined ? null : { route: `${provider}/${model}`, protocol: resolved }
}

/**
 * Compute the §4.6 effective classifier from live state: explicit route wins
 * verbatim; otherwise the shared policy helper decides (gauge only when
 * armed via `backend: 'auto'`). Requires the settings provider; a caller
 * without it renders the legacy one-arg output.
 */
function effectiveClassifier(
  ctx: Context,
  autoMode: AutoModeSection | undefined,
  settings: SettingsLike,
): EffectiveClassifier {
  const explicit = autoMode?.classifier?.route
  if (explicit !== undefined) {
    return {
      routeName: explicit,
      source: 'explicit',
      gauge: explicit === 'gauge' ? gaugeInfo(settings) : null,
    }
  }
  const backend = (autoMode?.classifier?.backend ?? 'haiku') as ClassifierBackend
  const routeName = pickGaugeRouteName(ctx, undefined, backend)
  if (routeName === 'gauge') {
    return { routeName: 'gauge', source: 'auto-gauge', gauge: gaugeInfo(settings) }
  }
  return { routeName: 'haiku', source: 'default', gauge: null }
}

/**
 * PR-C: compute the effective PROBE backend from live state — the same §4.6
 * policy as the classifier, over the `probe` section.
 */
function effectiveProbe(
  ctx: Context,
  autoMode: AutoModeSection | undefined,
  settings: SettingsLike,
): EffectiveClassifier {
  const explicit = autoMode?.probe?.route
  if (explicit !== undefined) {
    return {
      routeName: explicit,
      source: 'explicit',
      gauge: explicit === 'gauge' ? gaugeInfo(settings) : null,
    }
  }
  const backend = (autoMode?.probe?.backend ?? 'haiku') as ClassifierBackend
  const routeName = pickGaugeRouteName(ctx, undefined, backend)
  if (routeName === 'gauge') {
    return { routeName: 'gauge', source: 'auto-gauge', gauge: gaugeInfo(settings) }
  }
  return { routeName: 'haiku', source: 'default', gauge: null }
}

function executeAutoMode(ctx: Context, settings: SettingsLike | undefined, invocation: CommandInvocation): CommandResult {
  const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
  const subcommand = parts[0] ?? ''
  if (subcommand === 'defaults') {
    return { kind: 'success', text: renderDefaults() }
  }
  if (subcommand === 'config') {
    if (settings === undefined) {
      return { kind: 'error', text: 'No settings provider is mounted in this composition.' }
    }
    const permissions = settings.get('permissions') as { autoMode?: AutoModeSection } | undefined
    return { kind: 'success', text: renderConfig(
      permissions?.autoMode,
      effectiveClassifier(ctx, permissions?.autoMode, settings),
      effectiveProbe(ctx, permissions?.autoMode, settings),
    ) }
  }
  if (subcommand === 'review') {
    const arg = parts[1] ?? ''
    if (arg !== '' && arg !== 'full') {
      return { kind: 'error', text: 'unknown review argument; usage: /auto-mode review [full]' }
    }
    const events = (invocation.agent?.session?.snapshotEvents() ?? []) as readonly unknown[]
    return { kind: 'success', text: renderReview(events, arg === 'full') }
  }
  return {
    kind: 'error',
    text: 'unknown subcommand; usage: /auto-mode defaults | /auto-mode config | /auto-mode review [full]',
  }
}

/**
 * Register `/auto-mode`. The permission engine's view of the autoMode slice is
 * the merged settings section (`installSectionSafe` reads the same published
 * document), so the command reads it through the settings provider directly.
 * `review` reads the invocation agent's session log (same access pattern as
 * `/permissions`).
 * @param ctx - context carrying the command registry and settings provider.
 */
export function apply(ctx: Context): void {
  const settings = ctx.get('settings') as SettingsLike | undefined
  ctx.commands.register(helpable({
    name: 'auto-mode',
    description: 'show auto-mode classifier defaults, the effective trusted-scoped configuration, or this session\'s permission audit',
    input: { hint: '[defaults|config|review [full]]' },
    handler: (invocation: CommandInvocation) => executeAutoMode(ctx, settings, invocation),
  }, {
    subcommands: [
      { word: 'defaults', summary: 'print the built-in slot lists ($defaults-expanded)' },
      { word: 'config', summary: 'print the effective autoMode slice (trusted-scoped, expanded)' },
      { word: 'review', args: '[full]', summary: 'fold this session\'s classifier/probe audit events into a verdict table; full adds audited inputs' },
    ],
  }))
}
