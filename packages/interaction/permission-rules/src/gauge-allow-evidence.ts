/**
 * Allow-evidence folding for the gauge lane (design doc 2026-09-25 §Fix B):
 * reconstruct the user-originated pre-authorizations (settings allow rules +
 * in-session "always allow" grants) relevant to one tool call, as slot lines
 * appended under the existing `Allowed exceptions:` heading. Gauge-lane-only
 * — chat paths never import this module.
 *
 * Trust posture (review B1/F2): sources are restricted to USER-originated
 * scopes; `projectSettings` (a repo-shipped write channel into the trusted
 * question) and `config`-layer noise are excluded. Suspended rules ARE
 * included deliberately — the widening is owned in the design doc.
 *
 * @module @dsh-cc/permission-rules/gauge-allow-evidence
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@dsh-cc/tools'
import { ruleMatchesTool } from './matchers.ts'
import { foldSessionAllows } from './session-allowlist.ts'
import { estimateSystemOneTokens } from './systemone-budget.ts'
import type { PermissionRule, PermissionRuleSource } from './types.ts'

/** User-originated scopes only; projectSettings/config/curated excluded (B1/F2). */
const EVIDENCE_SOURCES: ReadonlySet<PermissionRuleSource> = new Set([
  'session',
  'userSettings',
  'localSettings',
  'cliArg',
  'policySettings',
  'flagSettings',
])

/** Line/length/token budgets for the folded evidence block (doc-frozen). */
const MAX_LINE_CHARS = 160
const MAX_LINES = 24
const MAX_BLOCK_TOKENS = 128
/** Memo LRU bound (few live sessions per process). */
const MEMO_MAX_SESSIONS = 8

/** Cap one line to {@link MAX_LINE_CHARS} chars (ellipsized, codepoint-safe enough for prose). */
function capLine(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`
}

/** Memo LRU (few live sessions per process), keyed `sessionId:events.length`. */
const memo = new Map<string, PermissionRule[]>()

/**
 * Memoized `foldSessionAllows(snapshotEvents())` keyed `(sessionId,
 * events.length)` — no per-call re-scan. Session logs are append-only, so a
 * length change accompanies any content change. LRU ≤8 sessions.
 */
function foldedGrants(session: Session): PermissionRule[] {
  const events = session.snapshotEvents()
  const key = `${String(session.id)}:${events.length}`
  const hit = memo.get(key)
  if (hit !== undefined) {
    memo.delete(key)
    memo.set(key, hit)
    return hit
  }
  // Malformed grant strings must never throw into the escalation path —
  // tolerance lives HERE (the collector), not in the shared fold.
  let folded: PermissionRule[]
  try {
    folded = foldSessionAllows(events)
  } catch {
    folded = []
  }
  memo.set(key, folded)
  while (memo.size > MEMO_MAX_SESSIONS) {
    const oldest = memo.keys().next().value
    if (oldest === undefined) break
    memo.delete(oldest)
  }
  return folded
}

// ponytail: memo rides a function-object map — one file-local cache, no class.

/**
 * Collect the gauge evidence lines for one call, deterministic order:
 * static settings rules first (settings order), then session grants (grant
 * order). Empty array when nothing user-originated matches.
 */
export function collectGaugeAllowEvidence(opts: {
  exec: ToolExecution
  rules: readonly PermissionRule[]
  session: Session | undefined
}): string[] {
  const lines: string[] = []
  const push = (rule: PermissionRule, granted: boolean): void => {
    const spec = rule.content === undefined ? rule.toolName : `${rule.toolName}(${rule.content})`
    lines.push(capLine(granted ? `Pre-authorized this session: ${spec}` : `Pre-authorized: ${spec}`))
  }
  for (const rule of opts.rules) {
    if (!EVIDENCE_SOURCES.has(rule.source) || rule.behavior !== 'allow') continue
    if (!ruleMatchesTool(rule, opts.exec.name)) continue
    push(rule, false)
  }
  if (opts.session !== undefined) {
    for (const rule of foldedGrants(opts.session)) {
      if (!ruleMatchesTool(rule, opts.exec.name)) continue
      push(rule, true)
    }
  }
  // Block budget: lines over the cap collapse to one honest remainder line.
  const kept: string[] = []
  let tokens = 0
  for (const line of lines) {
    if (kept.length >= MAX_LINES) break
    const cost = estimateSystemOneTokens(line) + 0.15
    if (tokens + cost > MAX_BLOCK_TOKENS && kept.length > 0) break
    kept.push(line)
    tokens += cost
  }
  if (kept.length < lines.length) kept.push(`…and ${lines.length - kept.length} more pre-authorized rules`)
  return kept
}
