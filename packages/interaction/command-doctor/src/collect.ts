/**
 * `/doctor` collection orchestration: runs every check group in stable order,
 * converting a thrown check into a `fail` row so the command always succeeds.
 * @module @dsh-cc/command-doctor/collect
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { envChecks } from './checks/env.ts'
import { gitChecks, gitInfo, type GitInfo } from './checks/git.ts'
import { hookChecks } from './checks/hooks.ts'
import { mcpChecks } from './checks/mcp.ts'
import { modelChecks } from './checks/models.ts'
import { pluginChecks } from './checks/plugins.ts'
import { seamChecks } from './checks/seams.ts'
import { sessionChecks } from './checks/session.ts'
import { storageChecks } from './checks/storage.ts'
import { webChecks } from './checks/web.ts'
import { countSummary, type Check, type CheckGroup, type DoctorReport } from './report.ts'
import { readVersion } from './version.ts'

/** Injected clock so reports are deterministic under test. */
export interface CollectClock {
  /** The report generation timestamp. */
  now(): Date
  /** A monotonic millisecond measure for `durationMs`. */
  ms(): number
}

/** Collection options: mode plus the injected clock. */
export interface CollectOptions extends CollectClock {
  /** Verbose mode adds slow probes and evidence. */
  verbose: boolean
}

/** Run one group's check function, converting a throw into a fail row. */
async function runGroup(
  group: CheckGroup,
  fn: () => Check[] | Promise<Check[]>,
): Promise<Check[]> {
  try {
    return await fn()
  } catch (error) {
    return [{
      id: `${group}.probe`,
      group,
      status: 'fail',
      summary: String(error),
    }]
  }
}

/**
 * Collect the full report for the live session.
 * @param ctx - the composed context (optional seams are duck-typed via get).
 * @param invocation - the `/doctor` invocation (its agent session).
 * @param options - mode flags plus the injected clock.
 */
export async function collect(
  ctx: Context,
  invocation: CommandInvocation,
  options: CollectOptions,
): Promise<DoctorReport> {
  const started = options.ms()
  const cwd = invocation.agent.session.header.cwd ?? process.cwd()
  let git: GitInfo | undefined
  if (options.verbose) git = gitInfo(cwd)
  const checks = [
    ...await runGroup('env', () => envChecks(ctx)),
    ...await runGroup('session', () => sessionChecks(ctx, invocation)),
    ...await runGroup('models', () => modelChecks(ctx, invocation, options)),
    ...await runGroup('mcp', () => mcpChecks(ctx, { ...(git === undefined ? {} : { git }), verbose: options.verbose })),
    ...await runGroup('hooks', () => hookChecks(ctx, options)),
    ...await runGroup('web', () => webChecks(ctx)),
    ...await runGroup('storage', () => storageChecks(ctx, invocation, options)),
    ...await runGroup('git', () => gitChecks(ctx, { verbose: options.verbose, cwd })),
    ...await runGroup('plugins', () => pluginChecks(ctx)),
    ...await runGroup('seams', () => seamChecks(ctx)),
  ]
  const harness = ctx.get('harnessVersion') as
    | string | { version?: string } | undefined
  const harnessVersion = typeof harness === 'string'
    ? harness
    : typeof harness?.version === 'string' ? harness.version : undefined
  return {
    schemaVersion: 1,
    generatedAt: options.now().toISOString(),
    durationMs: options.ms() - started,
    env: {
      dshCc: readVersion(),
      ...(harnessVersion === undefined ? {} : { harness: harnessVersion }),
      node: process.version,
      os: process.platform,
      arch: process.arch,
      cwd,
    },
    checks,
    summary: countSummary(checks),
  }
}
