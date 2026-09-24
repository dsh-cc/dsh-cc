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
    timeoutMs?: number
    cacheMaxEntries?: number
    auditFullText?: boolean
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

/** `/auto-mode config` — the effective trusted-scoped autoMode slice. */
export function renderConfig(autoMode: AutoModeSection | undefined): string {
  const classifier = autoMode?.classifier
  const payload = {
    classifier: {
      enabled: classifier?.enabled === true,
      route: classifier?.route ?? 'haiku',
      timeoutMs: classifier?.timeoutMs ?? 8000,
      cacheMaxEntries: classifier?.cacheMaxEntries ?? 256,
      auditFullText: classifier?.auditFullText === true,
    },
    classifyAllShell: autoMode?.classifyAllShell === true,
    slots: {
      soft_deny: slotView(autoMode?.soft_deny, DEFAULT_SOFT_DENY),
      hard_deny: slotView(autoMode?.hard_deny, DEFAULT_HARD_DENY),
      allow: slotView(autoMode?.allow, DEFAULT_ALLOW_EXCEPTIONS),
      environment: slotView(autoMode?.environment, DEFAULT_ENVIRONMENT),
    },
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

function executeAutoMode(settings: SettingsLike | undefined, invocation: CommandInvocation): CommandResult {
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
    return { kind: 'success', text: renderConfig(permissions?.autoMode) }
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
    handler: (invocation: CommandInvocation) => executeAutoMode(settings, invocation),
  }, {
    subcommands: [
      { word: 'defaults', summary: 'print the built-in slot lists ($defaults-expanded)' },
      { word: 'config', summary: 'print the effective autoMode slice (trusted-scoped, expanded)' },
      { word: 'review', args: '[full]', summary: 'fold this session\'s classifier/probe audit events into a verdict table; full adds audited inputs' },
    ],
  }))
}
