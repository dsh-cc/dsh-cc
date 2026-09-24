/**
 * Human-facing `/learn` command: distills recurring session failure patterns
 * into the memory system. Dry-run by default; `apply` writes through the
 * real `@dsh-cc/memory` writeback path. Zero writes unless asked.
 * @module @dsh-cc/command-learn
 */

import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { helpable } from '@dsh-cc/command-usage'
import { projectSlug } from '@dsh-cc/memory'
import { LearnedSkillStore, sanitizeLearnedDescription } from '@dsh-cc/skill-loader'
import type {} from '@deepseek-ai/dsh-skill'
import { runForensics, type ForensicsResult } from '@dsh-cc/session-forensics'
import { isoDate, renderBlock, renderFinding } from './render.ts'
import { applyLearnings } from './write.ts'

export { LEARNING_DESCRIPTION, TOPIC_NAME, TOPIC_TYPE, renderBlock } from './render.ts'
export { applyLearnings } from './write.ts'

export const name = 'command-learn'
export const inject = ['commands', 'fs', 'skills']

/** Settings namespace carrying the `/learn` section (kebab-case). */
export const LEARN_SETTINGS_NAMESPACE = 'cc-learn' as SettingsNamespace

/** Raw (unresolved) settings section: tolerant, unknown siblings pass through. */
export type LearnSection = {
  enabled?: unknown
  days?: unknown
  'min-occurrences'?: unknown
  [key: string]: unknown
}

/** Defaults; used verbatim as the composition entry and when a key is absent. */
export const LEARN_DEFAULTS = { enabled: true, days: 14, 'min-occurrences': 2 } as const

/** Tolerant schema: every key `z.any()`; missing section resolves to defaults. */
export const LEARN_SECTION_SCHEMA: z<LearnSection> = z.object({
  enabled: z.any(),
  days: z.any(),
  'min-occurrences': z.any(),
})

/** Default recency window (days) when neither settings nor CLI override it. */
export const DEFAULT_DAYS = 14
/** Default minimum occurrence threshold. */
export const DEFAULT_MIN_OCCURRENCES = 2

/** One parsed `/learn` invocation. */
export interface LearnRequest {
  /** `apply` — write the topic file (default is a dry run). */
  readonly apply: boolean
  /** `all` — scan every project instead of the current one. */
  readonly all: boolean
  /** `days=N` recency override. */
  readonly days: number | undefined
  /** `promote=<kebab-name>` — promote the single finding into a learned skill (implies `apply`). */
  readonly promote: string | undefined
  /** Non-empty when a token was unrecognized or `days=`/`promote=` malformed. */
  readonly invalid: string | undefined
}

/**
 * Parse `/learn` argument tokens: `apply`, `all`, `days=N`, `promote=<kebab-name>`.
 * @param rawInput - exact text following the command name.
 */
export function parseLearn(rawInput: string): LearnRequest {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  let apply = false
  let all = false
  let days: number | undefined
  let promote: string | undefined
  let invalid: string | undefined
  for (const token of tokens) {
    if (token === 'apply') apply = true
    else if (token === 'all') all = true
    else if (/^days=\d+$/u.test(token)) days = Number(token.slice(5))
    else if (/^promote=([a-z0-9][a-z0-9-]{0,63})$/u.test(token)) promote = token.slice(8)
    else invalid = token
  }
  return { apply, all, days, promote, invalid }
}

/**
 * Resolve effective forensics options from the settings section and CLI
 * overrides (CLI wins). Pure; exported for unit tests.
 */
export function resolveOptions(
  section: LearnSection | undefined,
  request: LearnRequest,
): { days: number; minOccurrences: number } {
  const days = request.days
    ?? (typeof section?.days === 'number' && section.days > 0 ? section.days : DEFAULT_DAYS)
  const minOccurrences = typeof section?.['min-occurrences'] === 'number' && section['min-occurrences'] > 0
    ? section['min-occurrences']
    : DEFAULT_MIN_OCCURRENCES
  return { days, minOccurrences }
}

/**
 * Read the live `cc-learn` section. Returns undefined when no settings
 * provider is attached — callers fall back to the defaults.
 */
function readSection(ctx: Context): LearnSection | undefined {
  if (sectionSource !== undefined) return sectionSource()
  const settings = ctx.get('settings') as { get(ns: string): unknown } | undefined
  return settings?.get(LEARN_SETTINGS_NAMESPACE) as LearnSection | undefined
}

/** Live settings-source thunk, wired by installSection; undefined without a provider. */
let sectionSource: (() => LearnSection) | undefined

/** Harness-style sessions-store project key: `--<slug>--` around memory's ported slug. */
export function sessionsProjectKey(cwd: string): string {
  return `--${projectSlug(resolve(cwd))}--`
}

/** Human-readable ranked findings + the proposed block (dry-run output). */
export function renderDryRun(result: ForensicsResult): string {
  const s = result.stats
  const skipped = s.sessionsNoStream + s.sessionsUnreadable
  const head =
    `Scanned ${s.sessionsScanned} session(s) (${s.linesParsed} lines, ` +
    `${s.corruptLinesSkipped} corrupt skipped, ${s.truncatedTails} truncated tails).` +
    (skipped > 0 ? `, ${skipped} session dir(s) skipped (missing/unreadable stream)` : '')
  if (result.findings.length === 0) {
    return `${head}\nNo findings above the occurrence threshold — nothing to apply.`
  }
  const listed = result.findings
    .map((f, i) => `${i + 1}. ${f.title} (${f.occurrences} occurrences) — ${f.detail}`)
    .join('\n')
  return `${head}\n${result.findings.length} finding(s):\n${listed}\n\nProposed session-learnings.md block:\n\n${renderBlock(result, new Date().toISOString().slice(0, 10))}`
}

/** Execute `/learn`: dry-run renders findings + proposed block; apply writes. */
async function executeLearn(ctx: Context, request: LearnRequest): Promise<CommandResult> {
  const section = readSection(ctx)
  if (section?.enabled === false) {
    return { kind: 'success', text: '/learn is disabled (`cc-learn.enabled` is false in settings).' }
  }
  if (request.invalid !== undefined) {
    return { kind: 'error', text: `Unknown argument "${request.invalid}". Usage: /learn [apply] [all] [days=N] [promote=<name>]` }
  }
  const { days, minOccurrences } = resolveOptions(section, request)
  const home = resolveDshHome()
  const result = await runForensics(join(home, 'sessions'), {
    days,
    minOccurrences,
    ...(request.all ? {} : { project: sessionsProjectKey(process.cwd()) }),
  })
  const promote = request.promote
  // promote implies apply: a promotion without the memory write is not a
  // supported shape (§4.3).
  if (!(request.apply || promote !== undefined)) return { kind: 'success', text: renderDryRun(result) }
  if (result.findings.length === 0) {
    const nothing = 'no findings — existing session-learnings.md left untouched'
    return { kind: 'success', text: promote === undefined ? nothing : `${nothing} — nothing to promote` }
  }
  const outcome = await applyLearnings(ctx.fs, join(home, 'memory'), process.cwd(), result)
  const memoryText = `Wrote ${outcome.findings} learning(s) to ${outcome.file} and updated MEMORY.md.`
  if (promote === undefined) return { kind: 'success', text: memoryText }
  // Promotion path: exactly one finding, promoted into a learned skill. The
  // memory write above already happened and always stands (partial-outcome
  // semantics) — failures here never roll it back.
  if (result.findings.length > 1) {
    const titles = result.findings.map(finding => finding.title).join('; ')
    return {
      kind: 'error',
      text: `Promotion refused: /learn promotes exactly one finding, but this run found ${result.findings.length} (${titles}). Tighten days=/min-occurrences or promote later. The memory write to ${outcome.file} stands.`,
    }
  }
  const finding = result.findings[0]!
  const store = new LearnedSkillStore({
    dshHome: home,
    listClaimants: async () => {
      const candidates = await ctx.skills.list({ cwd: process.cwd() })
      // SkillSummary carries {name, provider, source}; map straight in —
      // the store keys shadowed-vs-stale on `source`.
      return candidates.map(candidate => ({ name: candidate.name, provider: candidate.provider, source: candidate.source }))
    },
    onChanged: () => { ctx.emit('skills/learned-changed') },
  })
  const created = await store.create({
    name: promote,
    description: sanitizeLearnedDescription(finding.title),
    learnedFrom: `/learn ${isoDate()}`,
    body: renderFinding(finding).join('\n'),
  })
  if (!created.ok) {
    return {
      kind: 'error',
      text: `Promotion failed at the ${PROMOTION_STAGES[created.code]} stage: ${created.detail} The memory write to ${outcome.file} stands.`,
    }
  }
  return {
    kind: 'success',
    text: `${memoryText} Promoted finding "${finding.title}" to learned skill at ${created.value.path}.`,
  }
}

/** Store refusal code → human stage name in the failure text. */
const PROMOTION_STAGES: Record<string, string> = {
  invalid_name: 'name',
  invalid_params: 'content',
  too_large: 'size',
  shadowed: 'claim',
  already_exists: 'collision',
  not_found: 'write',
}

/**
 * Register the `/learn` command and (optionally) the `cc-learn` settings
 * section. The settings section is optional: a host without a settings
 * provider leaves the command on its built-in defaults.
 * @param ctx - context carrying the command registry and filesystem service.
 */
export function apply(ctx: Context): void {
  // Optional settings inject: absent provider → defaults only (same fallback
  // contract as the onboarding section).
  ctx.inject(['settings'], (sctx) => {
    const settings = (sctx as unknown as { settings?: unknown }).settings as
      | { installSection?: (...args: unknown[]) => void }
      | undefined
    if (typeof settings?.installSection !== 'function') return
    settings.installSection(ctx, LEARN_SETTINGS_NAMESPACE, LEARN_SECTION_SCHEMA, { ...LEARN_DEFAULTS }, {
      setSource: (current: () => LearnSection) => { sectionSource = current },
      onChange: () => {},
    })
  })
  ctx.commands.register(helpable({
    name: 'learn',
    description: 'distill recurring session failure patterns into memory (dry-run by default)',
    input: { hint: '[apply] [all] [days=N] [promote=<name>]' },
    handler: (invocation: CommandInvocation) => executeLearn(ctx, parseLearn(invocation.rawInput)),
  }, {
    subcommands: [
      { word: 'apply', summary: 'write the session-learnings.md memory topic (default is a dry run)' },
      { word: 'all', summary: 'scan every project, not just the current workspace' },
      { word: 'days=N', summary: `recency window override (default ${DEFAULT_DAYS})` },
      { word: 'promote=<name>', summary: 'promote the single finding into a learned skill (implies apply)' },
    ],
    notes: [
      'Writes only with `apply` (or `promote=`); empty findings never touch existing memory.',
      '`promote=<name>` creates `<dshHome>/learned-skills/<name>/SKILL.md` and requires exactly one finding.',
      'Tuned via the `cc-learn` settings namespace (enabled, days, min-occurrences).',
    ],
  }))
}
