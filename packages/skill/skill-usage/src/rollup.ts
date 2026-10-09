/**
 * U2 — the utility rollup (design
 * docs/plans/2026-10-09-skill-lifecycle-usage-gates.md §3.3/§3.4): an
 * observe-only report generator at the `session/created` seam plus a
 * `skills/learned-changed` churn invalidator. Every failure is swallowed +
 * debug-logged; nothing throws into an emitter.
 *
 * Staleness is watermark-based: the ledger's mtime at scan start is recorded
 * in the report header, and the report is recomputed when absent, older than
 * `rollup-stale-hours`, or when the ledger mtime has advanced past the
 * watermark. Publication is unique-temp-file + rename (atomic); if the ledger
 * advanced during the scan the published report is already stale by watermark
 * comparison and the next trigger recomputes — concurrent rollups converge,
 * last-writer-wins is safe.
 *
 * Accepted limitation (stated in the design): a single session running longer
 * than `rollup-stale-hours` never triggers a recompute — the rollup only runs
 * at `session/created`.
 *
 * @module
 */

import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { LEARNED_SKILLS_DIRNAME } from '@dsh-cc/skill-loader'
import { getSessionCwdForSession } from '@dsh-cc/session-cwd'
import { readJsonl } from '@dsh-cc/sidecar-io'
import { dshHomeFn, projectKeyOf } from '@dsh-cc/sidecar-io'
import { createMarkerIfAbsent, debug, ledgerPath, markerPath, type SkillLoadRow } from './ledger.ts'
import { DEFAULT_SKILL_USAGE_SETTINGS, readUserSettingsSync, type SkillUsageSettings } from './settings.ts'

/** Rollup report path for one workspace. */
export function reportPath(dshHome: string, projectKey: string): string {
  return join(dshHome, 'skill-usage', `utility-${projectKey}.md`)
}

const DAY_MS = 24 * 60 * 60 * 1000
// Demote-rule thresholds are design constants (§3.4), NOT settings knobs —
// the rule text is stated verbatim in the report.
const DEMOTE_AGE_DAYS = 14
const DEMOTE_COVERAGE_DAYS = 30

/** Minimal structural view of a catalog entry (`SkillSummary` upstream). */
interface CatalogSummary {
  name: string
  source: string
}

/** Structural `ctx.skills` surface — absent in providerless hosts/tests. */
interface SkillsSurface {
  list(options: { cwd: string }): Promise<readonly CatalogSummary[]> | readonly CatalogSummary[]
}

/** One learned skill from the learned-dir enumeration. */
interface LearnedEntry {
  name: string
  /** SKILL.md mtime (epoch ms) — the age basis. */
  mtimeMs: number
}

/** Aggregate per-skill load stats. */
interface SkillStats {
  allTime: number
  trailing30d: number
  sessions: Set<string>
  lastTs: number
}

/**
 * Register the rollup listeners (§3.2 trigger + churn invalidation).
 * @param ctx - the plug context.
 * @param readSettings - the cascade reader `registerSettings` returned (may
 *   be `undefined` — knobs then fall back to ship defaults).
 */
export function registerRollup(ctx: Context, readSettings: (() => SkillUsageSettings) | undefined): void {
  ctx.on('session/created', (session: Session) => {
    void runRollup(ctx, readSettings, session).catch((error: unknown) => {
      debug(ctx, `skill-usage: rollup failed: ${String(error)}`)
    })
  })
  ctx.on('skills/learned-changed', () => {
    try {
      const home = dshHomeFn(ctx)?.()
      if (home === undefined) return
      // The churn event carries no project key and learned skills are
      // dshHome-global — invalidate every workspace report.
      const dir = join(home, 'skill-usage')
      for (const entry of readdirSync(dir)) {
        if (!entry.startsWith('utility-') || !entry.endsWith('.md')) continue
        try {
          unlinkSync(join(dir, entry))
        } catch (error: unknown) {
          debug(ctx, `skill-usage: churn unlink failed: ${String(error)}`)
        }
      }
    } catch (error: unknown) {
      debug(ctx, `skill-usage: churn invalidation failed: ${String(error)}`)
    }
  })
}

/** The per-trigger rollup body. Never throws (caller also guards). */
async function runRollup(
  ctx: Context,
  readSettings: (() => SkillUsageSettings) | undefined,
  session: Session,
): Promise<void> {
  const home = dshHomeFn(ctx)?.()
  if (home === undefined) {
    debug(ctx, 'skill-usage: no dshHomePath — rollup is a no-op')
    return
  }
  // Resolve the cwd FIRST: projectKeyOf takes a string, so the undefined
  // guard must precede the call.
  const cwd = getSessionCwdForSession(session)
  if (typeof cwd !== 'string') {
    debug(ctx, 'skill-usage: rollup without a resolvable session cwd — skipped')
    return
  }
  const key = projectKeyOf(cwd)
  const settings = readSettings?.() ?? DEFAULT_SKILL_USAGE_SETTINGS

  // Raw user-layer enabled read (§3.5): disabled ⇒ no report, no marker, and
  // DELETE the existing marker — coverage means wall-clock while telemetry is
  // enabled. Existing report files are left untouched.
  let enabled: boolean
  try {
    enabled = readUserSettingsSync(home).enabled
  } catch {
    enabled = true
  }
  if (!enabled) {
    try {
      unlinkSync(markerPath(home, key))
    } catch (error: unknown) {
      debug(ctx, `skill-usage: marker delete failed: ${String(error)}`)
    }
    debug(ctx, 'skill-usage: telemetry disabled — report skipped, marker deleted')
    return
  }
  // Trigger #2 of two: a zero-load workspace starts coverage at its first
  // post-install session.
  await createMarkerIfAbsent(markerPath(home, key))

  if (!isStale(ctx, home, key, settings.rollupStaleHours)) return
  const report = await computeReport(ctx, home, key, cwd, readSettings)
  publish(ctx, home, key, report)
}

/** Staleness matrix (§3.3). True ⇒ recompute. */
function isStale(
  ctx: Context,
  home: string,
  key: string,
  rollupStaleHours: number,
): boolean {
  try {
    const path = reportPath(home, key)
    let stat
    try {
      stat = statSync(path)
    } catch {
      debug(ctx, 'skill-usage: report absent — recompute')
      return true
    }
    if (Date.now() - stat.mtimeMs > rollupStaleHours * 60 * 60 * 1000) {
      debug(ctx, 'skill-usage: report older than rollup-stale-hours — recompute')
      return true
    }
    const watermark = parseWatermark(readFileSync(path, 'utf8'))
    const ledgerStat = statSync(ledgerPath(home, key)) // missing ⇒ stale via throw
    if (ledgerStat.mtimeMs > watermark) {
      debug(ctx, 'skill-usage: ledger newer than the recorded watermark — recompute')
      return true
    }
    return false
  } catch (error: unknown) {
    // Ledger ENOENT falls here — no loads ever recorded ⇒ recompute.
    debug(ctx, `skill-usage: staleness check failed — recompute: ${String(error)}`)
    return true
  }
}

/** Parse `Input watermark: <ms>` from a report body; absent ⇒ 0. */
function parseWatermark(text: string): number {
  const match = text.match(/^Input watermark: ([0-9.]+)\.$/m)
  return match === null ? 0 : Number(match[1]) || 0
}

/** Enumerate `<dshHome>/learned-skills/<name>/SKILL.md` (D-C production path). */
function enumerateLearned(ctx: Context, home: string): LearnedEntry[] {
  try {
    const root = join(home, LEARNED_SKILLS_DIRNAME)
    const entries: LearnedEntry[] = []
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      try {
        entries.push({ name: dir.name, mtimeMs: statSync(join(root, dir.name, 'SKILL.md')).mtimeMs })
      } catch (error: unknown) {
        debug(ctx, `skill-usage: learned stat failed for ${dir.name}: ${String(error)}`)
      }
    }
    return entries
  } catch (error: unknown) {
    debug(ctx, `skill-usage: learned enumeration failed: ${String(error)}`)
    return []
  }
}

/** Compute the full report body (async: ledger read). Never throws. */
async function computeReport(
  ctx: Context,
  home: string,
  key: string,
  cwd: string,
  readSettings: (() => SkillUsageSettings) | undefined,
): Promise<string> {
  const ledger = ledgerPath(home, key)
  // Watermark = ledger mtime at scan START, recorded in the header.
  let watermark = 0
  try {
    watermark = statSync(ledger).mtimeMs
  } catch {
    // No ledger yet — watermark 0; the first append makes the report stale.
  }
  const rows = await readJsonl<SkillLoadRow>(ledger)

  const now = Date.now()
  const stats = new Map<string, SkillStats>()
  for (const row of rows) {
    if (typeof row?.skill !== 'string') continue
    const s = stats.get(row.skill) ?? { allTime: 0, trailing30d: 0, sessions: new Set<string>(), lastTs: 0 }
    s.allTime += 1
    if (row.ts >= now - 30 * DAY_MS) s.trailing30d += 1
    s.sessions.add(row.sessionId)
    s.lastTs = Math.max(s.lastTs, row.ts)
    stats.set(row.skill, s)
  }

  const learned = enumerateLearned(ctx, home)

  // Catalog: resolved LAZILY inside the handler (not at apply time) — absent
  // in providerless hosts/tests ⇒ classification from the learned-dir
  // enumeration alone, every learned skill listed unshadowed.
  let catalogUnavailable = false
  let shadowed = new Set<string>()
  try {
    const skills = ctx.get('skills') as SkillsSurface | undefined
    if (skills === undefined) {
      catalogUnavailable = true
    } else {
      // `scope` omitted — reads the global registry layers alone.
      const summaries = await skills.list({ cwd })
      // Shadowing (D-E): a learned skill whose name currently resolves to a
      // non-learned winner. NOTE: current shadowing cannot certify historical
      // ownership — loads of this name may have exercised either skill, past
      // or present; the report header says both.
      shadowed = new Set(
        summaries
          .filter((s) => s.source === 'learned')
          .filter((s) => summaries.some((o) => o.name === s.name && o.source !== 'learned'))
          .map((s) => s.name),
      )
    }
  } catch (error: unknown) {
    catalogUnavailable = true
    debug(ctx, `skill-usage: catalog list failed: ${String(error)}`)
  }
  if (catalogUnavailable) {
    debug(ctx, 'skill-usage: catalog unavailable — classifying from the learned dir alone')
  }

  // Coverage guard: the marker must exist and be older than 30d (§3.4 rule 4).
  let coverageOk = false
  let coverageSince: string | undefined
  try {
    const marker = readFileSync(markerPath(home, key), 'utf8')
    const since = Number(marker)
    coverageSince = new Date(since).toISOString()
    coverageOk = now - since > DEMOTE_COVERAGE_DAYS * DAY_MS
  } catch {
    coverageSince = undefined
  }

  const ageOf = (entry: LearnedEntry): number => Math.floor((now - entry.mtimeMs) / DAY_MS)
  const neverLoadedDays = readSettings?.().neverLoadedDays ?? DEFAULT_SKILL_USAGE_SETTINGS.neverLoadedDays

  const byLoads = [...stats.entries()]
    .sort((a, b) => b[1].allTime - a[1].allTime)
    .map(([name, s]) =>
      `- ${name}: ${s.trailing30d} / ${s.allTime} loads, ${s.sessions.size} sessions, last ${new Date(s.lastTs).toISOString().slice(0, 10)}`)
  const neverLoaded = learned
    .filter((l) => !stats.has(l.name) && ageOf(l) > neverLoadedDays)
    .map((l) => `- ${l.name}: last touched ${new Date(l.mtimeMs).toISOString().slice(0, 10)}, 0 loads`)
  const demote = learned
    .filter((l) => (stats.get(l.name)?.trailing30d ?? 0) === 0)
    .filter((l) => !shadowed.has(l.name))
    .filter((l) => ageOf(l) > DEMOTE_AGE_DAYS)
    .filter(() => coverageOk)
    .map((l) => `- ${l.name}: last touched ${new Date(l.mtimeMs).toISOString().slice(0, 10)}, 0 loads in 30d`)
  const insufficient = learned
    .filter((l) => (stats.get(l.name)?.trailing30d ?? 0) === 0 && !shadowed.has(l.name))
    .filter((l) => ageOf(l) > DEMOTE_AGE_DAYS)
    .filter(() => !coverageOk)
    .map((l) => `- ${l.name}: last touched ${new Date(l.mtimeMs).toISOString().slice(0, 10)}`)
  const shadowLines = learned
    .filter((l) => shadowed.has(l.name))
    .map((l) => `- ${l.name}: shadowed — attribution uncertain`)

  const lines = [
    `# Skill utility report — ${key} — generated ${new Date(now).toISOString()}`,
    `Observation coverage since: ${coverageSince ?? 'marker absent'} (wall-clock while telemetry is enabled; disabling deletes the marker and restarts coverage; zero-load periods still count).`,
    `Input watermark: ${watermark}.`,
    `Age basis: SKILL.md mtime (edits reset age). Loads are per-name; tool-form rows may carry provider; shadowed learned skills are attribution-uncertain, and current shadowing cannot certify historical ownership.`,
    `Classification source: catalog SkillSummary.source + learned dir enumeration.`,
    `## By loads (30d / all-time)`,
    ...byLoads,
    `## Never loaded (learned skills, untouched > ${neverLoadedDays})`,
    ...neverLoaded,
    `## Demote candidates (rule: learned, 0 loads in 30d, age > 14d, coverage ≥ 30d)`,
    ...demote,
    `Demotion is manual (manage_skill delete or edit) — this report takes no action.`,
    `## Insufficient observation window (excluded from demote list)`,
    ...insufficient,
    `## Shadowed learned skills (attribution uncertain)`,
    ...shadowLines,
    '',
  ]
  return lines.join('\n')
}

/** Publish atomically: unique temp file + rename (handoff-store precedent). */
function publish(ctx: Context, home: string, key: string, body: string): void {
  try {
    const file = reportPath(home, key)
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, file)
  } catch (error: unknown) {
    debug(ctx, `skill-usage: report publish failed: ${String(error)}`)
  }
}
