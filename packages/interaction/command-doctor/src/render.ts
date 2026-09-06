/**
 * `/doctor` text rendering: default (ok collapsed) and verbose (everything
 * expanded) views over one redacted report. ASCII-only, no emoji.
 * @module @dsh-cc/command-doctor/render
 */

import { CHECK_GROUPS, type Check, type DoctorReport } from './report.ts'

export interface RenderOptions {
  /** Expand every check and print evidence. */
  readonly verbose?: boolean
}

/** Render one status token padded to a stable column width. */
function statusToken(status: Check['status']): string {
  return status.padEnd(4, ' ')
}

/** Render one check's evidence as a compact `k=v` list. */
function evidenceText(check: Check): string | undefined {
  const entries = Object.entries(check.evidence ?? {})
  if (entries.length === 0) return undefined
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')
}

/** Render one check, expanding per the mode. */
function renderCheck(lines: string[], check: Check, verbose: boolean): void {
  const expand = verbose || check.status !== 'ok'
  lines.push(`  ${statusToken(check.status)} ${check.id}: ${check.summary}`)
  if (!expand) return
  if (check.detail !== undefined) lines.push(`    ${check.detail}`)
  if (check.fix !== undefined) lines.push(`    fix: ${check.fix}`)
  const evidence = evidenceText(check)
  if (evidence !== undefined) lines.push(`    evidence: ${evidence}`)
}

/**
 * Render the report as human shell text.
 * @param report - the redacted report.
 * @param options - `{ verbose }` switches to the expanded view.
 */
export function formatDoctorReport(report: DoctorReport, options: RenderOptions = {}): string {
  const verbose = options.verbose === true
  const lines: string[] = []
  lines.push(`dsh-cc ${report.env.dshCc}`)
  if (report.env.harness !== undefined) lines.push(`harness ${report.env.harness}`)
  lines.push(`node ${report.env.node}`)
  lines.push(`os ${report.env.os} ${report.env.arch}`)
  lines.push(`cwd ${report.env.cwd}`)
  lines.push('')
  for (const group of CHECK_GROUPS) {
    const groupChecks = report.checks.filter(check => check.group === group)
    if (groupChecks.length === 0) continue
    lines.push(`${group}:`)
    for (const check of groupChecks) renderCheck(lines, check, verbose)
  }
  const s = report.summary
  lines.push('')
  lines.push(`summary: ${s.ok} ok, ${s.warn} warn, ${s.fail} fail, ${s.skip} skip, ${s.info} info`)
  return lines.join('\n')
}
