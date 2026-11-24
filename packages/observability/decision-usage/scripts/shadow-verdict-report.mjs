#!/usr/bin/env node
/**
 * shadow-verdict-report.mjs — the flip-gate instrument for the three SystemOne
 * consumer features. Design: `docs/plans/2026-11-25-systemone-shadow-verdict-ledger.md`
 * § "Report script".
 *
 * run: node packages/observability/decision-usage/scripts/shadow-verdict-report.mjs \
 *        [--home ~/.dsh] [--export <dir>]
 *
 * Walks the two verdict generations (`shadow-verdicts.jsonl` and its `.1`
 * rotation) under every session directory of `<home>/decision-usage`,
 * deduplicated on `eventId`, joins `usage.jsonl` on `decisionId` where cost
 * attribution needs it, and prints one boolean GATE
 * line per feature. Prose explains; the booleans decide. Exit code is 0
 * whenever the report runs — shadow data is live-maintainer data, never a CI
 * fixture.
 *
 * Importing the real source, not a mirror (Node ≥ 22.18 strips TypeScript
 * types): the row parser and closed schemas come from `../src/shadow-verdicts.ts`,
 * and the Wilson lower bound from the tool-search eval metrics lib the
 * activation plan's flip policy already owns.
 */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseShadowVerdictLine } from '../src/shadow-verdicts.ts'
import { wilsonLowerBound } from '../../../core/tool-search/scripts/lib/eval-metrics.mjs'

/** Pre-registered gate constants (doc 04 §303, activation plan §77, capacity revision). */
export const EXTRACTION_MIN_WINDOWS = 100
export const DISCOVERY_MIN_DISAGREEMENTS = 60
export const DISCOVERY_MIN_LABELED = 60
export const DISCOVERY_WILSON_LCB = 0.60
export const SKILLREC_MIN_REQUESTS = 100
export const SKILLREC_COMPLETE_RATE = 0.99

/** One verdict row plus its session locator (never the query text). */

/** Read both verdict generations under one decision-usage home, deduped on eventId. */
export async function collectVerdictRows(home) {
  const root = join(home, 'decision-usage')
  const found = []
  let projects
  try {
    projects = await readdir(root)
  } catch {
    return []
  }
  for (const projectKey of projects) {
    let sessions
    try {
      sessions = await readdir(join(root, projectKey))
    } catch {
      continue
    }
    for (const sessionId of sessions) {
      const dir = join(root, projectKey, sessionId)
      for (const file of ['shadow-verdicts.jsonl.1', 'shadow-verdicts.jsonl']) {
        let text
        try {
          text = await readFile(join(dir, file), 'utf8')
        } catch {
          continue
        }
        for (const line of text.split('\n')) {
          const row = parseShadowVerdictLine(line)
          if (row !== undefined) found.push({ row, projectKey, sessionId })
        }
      }
    }
  }
  const byEvent = new Map()
  for (const located of found) byEvent.set(located.row.eventId, located)
  return [...byEvent.values()]
}

/** Read a labels file (`{"eventId": ..., ...}` per line); last-write-wins per eventId. */
export async function readLabels(dir, file) {
  const labels = new Map()
  let text
  try {
    text = await readFile(join(dir, file), 'utf8')
  } catch {
    return labels
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (typeof value.eventId === 'string' && value.eventId.length > 0) labels.set(value.eventId, value)
    } catch {
      // A malformed label line never breaks the report.
    }
  }
  return labels
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Nearest-rank percentile (the repo eval convention). */
export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]
}

/** The skill-rec completeness predicate (the `undefined === undefined` hole is closed). */
export function isCoverageComplete(payload) {
  if (payload.status !== 'shadow' && payload.status !== 'recommended') return false
  const judged = payload.judged
  const eligible = payload.eligible
  if (typeof judged !== 'number' || typeof eligible !== 'number') return false
  return judged === eligible
}


/** Doc 04 §303: ≥100 shadow windows AND every would-skip manually checked. */
export function evaluateExtractionGate(rows, labels) {
  const shadow = rows.filter(l => l.row.feature === 'memory-extraction' && l.row.mode === 'shadow')
  const wouldSkips = shadow.filter(l => l.row.payload.verdict === 'would-skip')
  const checked = wouldSkips.filter(l => labels.get(l.row.eventId)?.checked === true).length
  const distribution = new Map()
  for (const l of shadow) {
    const verdict = String(l.row.payload.verdict)
    distribution.set(verdict, (distribution.get(verdict) ?? 0) + 1)
  }
  const events = shadow.map(l => Number(l.row.payload.surfaceEvents ?? 0))
  const stateBytes = shadow.map(l => Number(l.row.payload.stateBytes ?? 0))
  const pass = shadow.length >= EXTRACTION_MIN_WINDOWS && checked === wouldSkips.length
  return {
    feature: 'memory-extraction',
    gate: 'extraction-windows',
    pass,
    detail:
      `n=${shadow.length} wouldSkip=${wouldSkips.length} checked=${checked} ` +
      `verdicts={${[...distribution.entries()].map(([k, v]) => `${k}:${v}`).join(', ')}} ` +
      `surfaceEvents(median=${median(events)},mean=${events.length === 0 ? 0 : Math.round(events.reduce((a, b) => a + b, 0) / events.length)}) ` +
      `stateBytes(median=${median(stateBytes)})`,
  }
}

/** Activation plan §77: ≥60 differing, ≥60 labeled, one-sided 95% Wilson LCB ≥ 0.60. */
export function evaluateDiscoveryGate(rows, labels) {
  const shadow = rows.filter(l => l.row.feature === 'tool-discovery' && l.row.mode === 'shadow')
  const differing = shadow.filter(l => l.row.payload.differing === true)
  const labeled = differing.filter(l => labels.has(l.row.eventId))
  const correct = labeled.filter(l => labels.get(l.row.eventId)?.judgeCorrect === true).length
  const lcb = wilsonLowerBound(correct, labeled.length) ?? 0
  const pass = differing.length >= DISCOVERY_MIN_DISAGREEMENTS && labeled.length >= DISCOVERY_MIN_LABELED && lcb >= DISCOVERY_WILSON_LCB
  const times = shadow.map(l => l.row.time)
  const span = times.length === 0 ? 'n/a' : `${new Date(Math.min(...times)).toISOString()}..${new Date(Math.max(...times)).toISOString()}`
  return {
    feature: 'tool-discovery',
    gate: 'discovery-disagreements',
    pass,
    detail:
      `judgments=${shadow.length} differing=${differing.length} labeled=${labeled.length} ` +
      `judgeCorrect=${correct} wilson-lcb=${lcb.toFixed(4)} shadow-span=${span}`,
  }
}

/** Capacity revision: ≥100 requests, coverage-complete ≥99%, remainder all timeout, p95 ≤ min ceiling. */
export function evaluateSkillrecGate(rows) {
  const shadow = rows.filter(l => l.row.feature === 'skill-recommendation' && l.row.mode === 'shadow')
  const complete = shadow.filter(l => isCoverageComplete(l.row.payload)).length
  const nonComplete = shadow.filter(l => !isCoverageComplete(l.row.payload))
  const nonCompleteAllTimeout = nonComplete.every(l => l.row.payload.status === 'unavailable' && l.row.payload.failureClass === 'timeout')
  const rate = shadow.length === 0 ? 0 : complete / shadow.length
  const latencies = shadow.map(l => Number(l.row.payload.requestLatencyMs ?? 0))
  const ceilings = shadow.map(l => Number(l.row.payload.requestTimeoutMs ?? 0)).filter(v => v > 0)
  const ceiling = ceilings.length === 0 ? 0 : Math.min(...ceilings)
  const p95 = percentile(latencies, 95)
  const pass =
    shadow.length >= SKILLREC_MIN_REQUESTS &&
    rate >= SKILLREC_COMPLETE_RATE &&
    nonCompleteAllTimeout &&
    (shadow.length === 0 || p95 <= ceiling)
  return {
    feature: 'skill-recommendation',
    gate: 'skillrec-requests',
    pass,
    detail:
      `n=${shadow.length} coverage-complete=${rate.toFixed(4)} nonComplete=${nonComplete.length} ` +
      `nonCompleteAllTimeout=${nonCompleteAllTimeout} p95=${p95}ms ceiling(min)=${ceiling}ms`,
  }
}

/** Metered input tokens per projectKey for the joined usage rows of one feature. */
export async function usageTokensByProject(home, feature) {
  const root = join(home, 'decision-usage')
  const tokens = new Map()
  let projects
  try {
    projects = await readdir(root)
  } catch {
    return tokens
  }
  for (const projectKey of projects) {
    let sessions
    try {
      sessions = await readdir(join(root, projectKey))
    } catch {
      continue
    }
    for (const sessionId of sessions) {
      let text
      try {
        text = await readFile(join(root, projectKey, sessionId, 'usage.jsonl'), 'utf8')
      } catch {
        continue
      }
      let total = 0
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const row = JSON.parse(trimmed)
          if (row.feature !== feature) continue
          if (row.phase === 'settle' && typeof row.actualInputTokens === 'number') total += row.actualInputTokens
        } catch {
          // A corrupt usage line never breaks the cost table.
        }
      }
      if (total > 0) tokens.set(projectKey, (tokens.get(projectKey) ?? 0) + total)
    }
  }
  return tokens
}

async function writeExports(dir, rows) {
  await mkdir(dir, { recursive: true })
  const wouldSkips = rows.filter(l => l.row.feature === 'memory-extraction' && l.row.mode === 'shadow' && l.row.payload.verdict === 'would-skip')
  const extractionLines = wouldSkips
    .map(l => JSON.stringify({
      eventId: l.row.eventId,
      probability: l.row.payload.probability,
      fromExclusive: l.row.payload.fromExclusive,
      throughInclusive: l.row.payload.throughInclusive,
      decisionIds: l.row.decisionIds,
      projectKey: l.projectKey,
      sessionId: l.sessionId,
    }))
    .join('\n')
  await writeFile(join(dir, 'extraction-would-skips.jsonl'), extractionLines + (extractionLines === '' ? '' : '\n'), 'utf8')
  const differing = rows.filter(l => l.row.feature === 'tool-discovery' && l.row.mode === 'shadow' && l.row.payload.differing === true)
  const discoveryLines = differing
    .map(l => JSON.stringify({
      eventId: l.row.eventId,
      queryHash8: l.row.payload.queryHash8,
      suggested: l.row.payload.suggested,
      lexical: l.row.payload.lexical,
      originSeq: l.row.payload.originSeq,
      decisionIds: l.row.decisionIds,
      projectKey: l.projectKey,
      sessionId: l.sessionId,
    }))
    .join('\n')
  await writeFile(join(dir, 'discovery-disagreements.jsonl'), discoveryLines + (discoveryLines === '' ? '' : '\n'), 'utf8')
}

/** Run the full report; returns the three gate lines. */
export async function runReport(home, exportDir) {
  const rows = await collectVerdictRows(home)
  const extractionLabels = await readLabels(exportDir ?? home, 'extraction-labels.jsonl')
  const discoveryLabels = await readLabels(exportDir ?? home, 'discovery-labels.jsonl')
  const gates = [
    evaluateExtractionGate(rows, extractionLabels),
    evaluateDiscoveryGate(rows, discoveryLabels),
    evaluateSkillrecGate(rows),
  ]
  if (exportDir !== undefined) await writeExports(exportDir, rows)
  return gates
}

async function main() {
  const args = process.argv.slice(2)
  let home = `${process.env.HOME ?? ''}/.dsh`
  let exportDir
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--home' && args[i + 1] !== undefined) {
      home = resolve(args[i + 1])
      i += 1
    } else if (args[i] === '--export' && args[i + 1] !== undefined) {
      exportDir = resolve(args[i + 1])
      i += 1
    }
  }
  const gates = await runReport(home, exportDir)
  const rows = await collectVerdictRows(home)
  for (const gate of gates) {
    console.log(`GATE ${gate.gate}: ${gate.pass ? 'PASS' : 'FAIL'} (${gate.detail})`)
  }
  const tokens = await usageTokensByProject(home, 'skill-recommendation')
  const tokenLines = [...tokens.entries()].map(([project, total]) => `  ${project}: ${total} input tokens`).join('\n')
  console.log(`skill-recommendation metered cost by project:\n${tokenLines === '' ? '  (none)' : tokenLines}`)
  console.log(`rows: ${rows.length} (deduplicated on eventId across both generations)`)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await main()
}
