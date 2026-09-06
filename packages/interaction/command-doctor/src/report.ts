/**
 * Structured `/doctor` report data model: check types, report shape, and the
 * summary counter fold. No cordis imports, so the types and fold are
 * unit-testable in isolation.
 * @module @dsh-cc/command-doctor/report
 */

/** One check's outcome severity. */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip' | 'info'

/** The stable group ordering of the report. */
export type CheckGroup =
  | 'env'
  | 'session'
  | 'models'
  | 'mcp'
  | 'hooks'
  | 'web'
  | 'storage'
  | 'git'
  | 'plugins'
  | 'seams'

/** Stable render/JSON ordering of the check groups. */
export const CHECK_GROUPS: readonly CheckGroup[] = [
  'env', 'session', 'models', 'mcp', 'hooks', 'web', 'storage', 'git', 'plugins', 'seams',
]

/** One named health observation inside the report. */
export interface Check {
  /** Kebab, dotted id (e.g. `models.alias.blueprint`). Adding an id is not breaking. */
  readonly id: string
  /** The group the check belongs to. */
  readonly group: CheckGroup
  /** The check's outcome. */
  readonly status: CheckStatus
  /** One-line human summary. */
  readonly summary: string
  /** Optional expanded human detail for non-ok (or verbose) rendering. */
  readonly detail?: string | undefined
  /** Whitelisted primitive evidence; scrubbed by `redactReport` before render/JSON. */
  readonly evidence?: Readonly<Record<string, string | number | boolean | null>> | undefined
  /** Optional suggested fix for warn/fail rows. */
  readonly fix?: string | undefined
}

/** The structured health report `/doctor` renders and writes as JSON. */
export interface DoctorReport {
  /** Bumps only on a breaking schema change; adding check ids is not breaking. */
  readonly schemaVersion: 1
  /** ISO timestamp of report generation. */
  readonly generatedAt: string
  /** Wall-clock duration of the collection, in milliseconds. */
  readonly durationMs: number
  /** Environment header facts. */
  readonly env: {
    readonly dshCc: string
    readonly harness?: string
    readonly node: string
    readonly os: string
    readonly arch: string
    readonly cwd: string
  }
  /** Every collected check, in group order. */
  readonly checks: readonly Check[]
  /** Per-status counts. */
  readonly summary: { ok: number; warn: number; fail: number; skip: number; info: number }
}

/** Fold the checks into per-status counts. */
export function countSummary(checks: readonly Check[]): DoctorReport['summary'] {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0, info: 0 }
  for (const check of checks) summary[check.status] += 1
  return summary
}
