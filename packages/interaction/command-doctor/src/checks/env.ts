/**
 * `env` checks for `/doctor`: dsh-cc version, harness version, Node engines,
 * and platform facts.
 * @module @dsh-cc/command-doctor/checks/env
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Check } from '../report.ts'
import { nodeSatisfiesEngines, readEngines, readVersion } from '../version.ts'

/** Duck-typed host-surfaced harness version (string or `{ version }`). */
export function harnessVersion(ctx: Context): string | undefined {
  const value = ctx.get('harnessVersion')
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const record = value as { version?: unknown }
    if (typeof record.version === 'string') return record.version
  }
  return undefined
}

/** Collect the env group checks. */
export function envChecks(ctx: Context): Check[] {
  const checks: Check[] = []
  const dshCc = readVersion()
  checks.push({
    id: 'env.dsh-cc',
    group: 'env',
    status: 'ok',
    summary: `dsh-cc ${dshCc}`,
    evidence: { version: dshCc },
  })
  const harness = harnessVersion(ctx)
  if (harness === undefined) {
    checks.push({
      id: 'env.harness',
      group: 'env',
      status: 'skip',
      summary: 'harnessVersion seam not mounted',
    })
  } else {
    checks.push({
      id: 'env.harness',
      group: 'env',
      status: 'ok',
      summary: `harness ${harness}`,
      evidence: { version: harness },
    })
  }
  const node = process.version
  const engines = readEngines()
  const satisfies = nodeSatisfiesEngines(node)
  checks.push({
    id: 'env.node',
    group: 'env',
    status: satisfies ? 'ok' : 'fail',
    summary: satisfies ? `node ${node} satisfies ${engines}` : `node ${node} does not satisfy ${engines}`,
    detail: satisfies ? undefined : `required range: ${engines}`,
    fix: satisfies ? undefined : 'upgrade Node to a version within the required range',
    evidence: { node, engines },
  })
  checks.push({
    id: 'env.os',
    group: 'env',
    status: 'info',
    summary: `${process.platform} ${process.arch}`,
    evidence: { os: process.platform, arch: process.arch },
  })
  return checks
}
