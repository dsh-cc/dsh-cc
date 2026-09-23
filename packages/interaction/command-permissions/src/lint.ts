/**
 * `/permissions lint` — read-only rule-hygiene report over the permission
 * engine's cross-source rule set, plus a proposed before/after diff for the
 * user settings layer. `--apply` performs ONLY the user-layer cleanup through
 * the settings cascade's `editUserSection` raw-user seam; project/policy/
 * session layers are never written, and removals never cross behavior groups
 * (`ruleSubsumes` requires equal behavior).
 * @module @dsh-cc/command-permissions/lint
 */

import {
  PERMISSION_SETTINGS_NAMESPACE,
  parseRuleSafe,
  ruleString,
  ruleSubsumes,
} from '@dsh-cc/permission-rules'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSet,
  PermissionRuleSource,
} from '@dsh-cc/permission-rules/types'
import { SOURCE_PRIORITY } from '@dsh-cc/permission-rules/types'
import { KNOWN_HARNESS_TOOLS, ccToolAliases } from '@dsh-cc/tools'

/** One hygiene finding about a single rule. */
export interface LintFinding {
  kind: 'malformed' | 'duplicate' | 'subsumed' | 'broad' | 'unknownTool'
  source: PermissionRuleSource
  behavior: PermissionBehavior
  toolName: string
  /** The rule string (raw source string for `malformed`). */
  rule: string
  detail: string
}

const FINDING_LABEL: Record<LintFinding['kind'], string> = {
  malformed: 'malformed (unparseable rule string)',
  duplicate: 'exact duplicate',
  subsumed: 'subsumed by a broader rule in the same source and behavior group',
  broad: 'broad grant (whole-tool allow)',
  unknownTool: 'unknown tool name',
}

/** A settings provider surface this command needs (structural, like the engine face). */
type SettingsProviderLike = {
  readonly writable?: boolean
  editUserSection?(ns: string, edit: (raw: Record<string, unknown>) => Record<string, unknown> | undefined): Promise<void>
}

const BEHAVIORS = ['allow', 'deny', 'ask'] as const
type ListKey = (typeof BEHAVIORS)[number]

/** Whether a tool name is known to the harness or the CC vocabulary. */
function isKnownTool(toolName: string): boolean {
  return ccToolAliases(toolName).some(alias => KNOWN_HARNESS_TOOLS.has(alias))
}

/** Whether a rule is a bare whole-tool `Bash` allow (a broad persistent grant). */
function isBroadBashAllow(rule: PermissionRule): boolean {
  return rule.behavior === 'allow' && rule.toolName === 'Bash' && rule.content === undefined
}

/**
 * Lint the engine's cross-source rule set: exact duplicates and prefix-subsumed
 * rules within one source+behavior group, bare whole-tool `Bash` allows, and
 * unknown tool names. Read-only — the parsed engine rules carry no raw strings,
 * so malformed strings are reported by the user-layer scan only.
 */
export function lintRuleSet(rules: PermissionRuleSet): LintFinding[] {
  const findings: LintFinding[] = []
  for (const rule of [...rules.allow, ...rules.deny, ...rules.ask]) {
    if (isBroadBashAllow(rule)) {
      findings.push({ kind: 'broad', source: rule.source, behavior: rule.behavior, toolName: rule.toolName, rule: ruleString(rule.toolName, rule.content), detail: 'whole-tool allow; consider a narrower prefix rule' })
    }
    if (!isKnownTool(rule.toolName)) {
      findings.push({ kind: 'unknownTool', source: rule.source, behavior: rule.behavior, toolName: rule.toolName, rule: ruleString(rule.toolName, rule.content), detail: `tool "${rule.toolName}" matches no harness or CC tool name` })
    }
  }
  // Duplication/subsumption only within one source+behavior group, per tool.
  const groups = new Map<string, PermissionRule[]>()
  for (const rule of [...rules.allow, ...rules.deny, ...rules.ask]) {
    if (rule.content === undefined) continue
    const key = `${rule.source}|${rule.behavior}|${rule.toolName}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [rule])
    else group.push(rule)
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = 0; j < group.length; j += 1) {
        if (i === j) continue
        const a = group[i]!
        const b = group[j]!
        if (!ruleSubsumes(a, b)) continue
        if (a.content === b.content) {
          if (i < j) findings.push({ kind: 'duplicate', source: b.source, behavior: b.behavior, toolName: b.toolName, rule: ruleString(b.toolName, b.content), detail: `identical to another ${b.source} ${b.behavior} rule` })
        } else {
          findings.push({ kind: 'subsumed', source: b.source, behavior: b.behavior, toolName: b.toolName, rule: ruleString(b.toolName, b.content), detail: `covered by ${ruleString(a.toolName, a.content)}` })
        }
        break
      }
    }
  }
  return findings
}

/** The user-layer lint result: malformed findings, and the proposed cleanup. */
export interface UserLayerLint {
  findings: LintFinding[]
  /** Raw user-layer lists as found. */
  before: Partial<Record<ListKey, string[]>>
  /** Raw user-layer lists after removing duplicates and subsumed entries. */
  after: Partial<Record<ListKey, string[]>>
}

/**
 * Lint the RAW user settings section (rule strings, not engine rules):
 * flags malformed strings (kept — apply never rewrites unparseable entries),
 * and computes the cleaned lists (exact duplicates and same-behavior subsumed
 * entries removed, first/broader kept). Bare `Bash` allows and unknown tool
 * names are flagged but kept.
 */
export function lintUserSection(raw: Record<string, unknown>): UserLayerLint {
  const findings: LintFinding[] = []
  const before: Partial<Record<ListKey, string[]>> = {}
  const after: Partial<Record<ListKey, string[]>> = {}
  for (const behavior of BEHAVIORS) {
    const list = raw[behavior]
    if (!Array.isArray(list)) continue
    const strings = list.filter((entry): entry is string => typeof entry === 'string')
    before[behavior] = strings
    const kept: string[] = []
    const keptRules: PermissionRule[] = []
    for (const entry of strings) {
      const parsed = parseRuleSafe(entry, behavior, 'userSettings')
      if (parsed === undefined) {
        findings.push({ kind: 'malformed', source: 'userSettings', behavior, toolName: '?', rule: entry, detail: 'the rule string does not parse' })
        kept.push(entry)
        continue
      }
      if (isBroadBashAllow(parsed)) {
        findings.push({ kind: 'broad', source: 'userSettings', behavior, toolName: parsed.toolName, rule: entry, detail: 'whole-tool allow; consider a narrower prefix rule' })
      }
      if (!isKnownTool(parsed.toolName)) {
        findings.push({ kind: 'unknownTool', source: 'userSettings', behavior, toolName: parsed.toolName, rule: entry, detail: `tool "${parsed.toolName}" matches no harness or CC tool name` })
      }
      const cover = keptRules.find(kept => ruleSubsumes(kept, parsed))
      if (cover !== undefined) {
        findings.push({
          kind: parsed.content === cover.content ? 'duplicate' : 'subsumed',
          source: 'userSettings',
          behavior,
          toolName: parsed.toolName,
          rule: entry,
          detail: parsed.content === cover.content ? 'identical to an earlier entry' : `covered by ${ruleString(cover.toolName, cover.content)}`,
        })
        continue
      }
      kept.push(entry)
      keptRules.push(parsed)
    }
    after[behavior] = kept
  }
  return { findings, before, after }
}

/**
 * Render the lint report: findings grouped by source/behavior, then the
 * proposed user-layer before/after diff (removals marked `-`).
 */
export function renderLint(engineFindings: readonly LintFinding[], userLint: UserLayerLint | undefined): string {
  const lines = ['Permission rules lint (read-only)']
  const all = [...engineFindings, ...(userLint?.findings ?? [])]
  if (all.length === 0) {
    lines.push('  (no findings)')
  } else {
    for (const source of SOURCE_PRIORITY) {
      for (const behavior of BEHAVIORS) {
        const rows = all.filter(f => f.source === source && f.behavior === behavior)
        if (rows.length === 0) continue
        lines.push(`  ${source} ${behavior}:`)
        for (const f of rows) lines.push(`    ${f.rule} — ${FINDING_LABEL[f.kind]} (${f.detail})`)
      }
    }
  }
  lines.push('Proposed user-layer cleanup:')
  if (userLint === undefined) {
    lines.push('  (user settings layer not reachable)')
  } else {
    let any = false
    for (const behavior of BEHAVIORS) {
      const before = userLint.before[behavior]
      const after = userLint.after[behavior]
      if (before === undefined || after === undefined || before.length === after.length) continue
      any = true
      lines.push(`  ${behavior}:`)
      for (const entry of before) {
        if (!after.includes(entry)) lines.push(`    - ${entry}`)
        else lines.push(`      ${entry}`)
      }
    }
    if (!any) lines.push('  (no changes proposed)')
  }
  return lines.join('\n')
}

/**
 * Apply the proposed cleanup to the RAW user layer only, via
 * `editUserSection` (never project/policy/session layers; never across
 * behavior groups — removals come from `ruleSubsumes`, which requires equal
 * behavior). Returns a result message, or `undefined`-error text on
 * degradation.
 */
export async function applyUserLint(settings: unknown): Promise<string> {
  const provider = settings as SettingsProviderLike | undefined
  if (provider === undefined || typeof provider.editUserSection !== 'function' || provider.writable === false) {
    return 'Cannot apply — no writable settings provider with a raw user-layer edit seam is mounted.'
  }
  let removed = 0
  await provider.editUserSection(PERMISSION_SETTINGS_NAMESPACE, raw => {
    const lint = lintUserSection(raw)
    removed = 0
    for (const behavior of BEHAVIORS) {
      const before = lint.before[behavior]
      const after = lint.after[behavior]
      if (before !== undefined && after !== undefined) removed += before.length - after.length
    }
    if (removed === 0) return undefined
    const next: Record<string, unknown> = { ...raw }
    for (const behavior of BEHAVIORS) {
      if (lint.before[behavior] !== undefined) next[behavior] = lint.after[behavior]
    }
    return next
  })
  return removed === 0 ? 'Nothing to apply — the user layer is already clean.' : `Applied: removed ${removed} redundant user-layer rule(s).`
}
