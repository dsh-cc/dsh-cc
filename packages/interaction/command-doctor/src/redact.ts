/**
 * Pure report redaction: whitelist evidence primitives and scrub secret-like
 * substrings from every human string in the report. No cordis imports.
 * @module @dsh-cc/command-doctor/redact
 */

import type { Check, DoctorReport } from './report.ts'

/** Secret-like substrings scrubbed from summary/detail/fix/evidence strings. */
const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /sk-[A-Za-z0-9_-]+/gu, replacement: 'sk-[redacted]' },
  { pattern: /ghp_[A-Za-z0-9]+/gu, replacement: 'ghp_[redacted]' },
  { pattern: /xoxb-[A-Za-z0-9-]+/gu, replacement: 'xoxb-[redacted]' },
  { pattern: /Bearer\s+\S+/gu, replacement: 'Bearer [redacted]' },
]

/** Scrub secret-like substrings from one string. */
function scrub(value: string): string {
  let result = value
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/** Scrub one optional human field. */
function scrubOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : scrub(value)
}

/** Scrub evidence string values; non-string primitives pass through untouched. */
function scrubEvidence(
  evidence: Check['evidence'],
): Check['evidence'] {
  if (evidence === undefined) return undefined
  const entries = Object.entries(evidence).map(([key, value]) => [
    key,
    typeof value === 'string' ? scrub(value) : value,
  ] as const)
  return Object.fromEntries(entries)
}

/**
 * Return a redacted copy of the report. Evidence values must already be
 * primitives; only string evidence is scrubbed. Called once by the handler;
 * both the text render and the JSON write consume the redacted report.
 * @param report - the collected report.
 */
export function redactReport(report: DoctorReport): DoctorReport {
  return {
    ...report,
    checks: report.checks.map(check => ({
      ...check,
      summary: scrub(check.summary),
      detail: scrubOptional(check.detail),
      fix: scrubOptional(check.fix),
      evidence: scrubEvidence(check.evidence),
    })),
  }
}
