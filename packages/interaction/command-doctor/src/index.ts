/**
 * Human-facing `/doctor` command: a product-grade session health report with
 * three renderings of one data object — default text, verbose text, and a
 * JSON file written under `$DSH_HOME`.
 * @module @dsh-cc/command-doctor
 */

import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { collect } from './collect.ts'
import { formatUsage, parseDoctorFlags } from './flags.ts'
import { doctorJsonPath, writeDoctorReport } from './json.ts'
import { redactReport } from './redact.ts'
import { formatDoctorReport } from './render.ts'

export { readVersion } from './version.ts'
export { DOCTOR_USAGE, parseDoctorFlags } from './flags.ts'
export { redactReport } from './redact.ts'
export { collect } from './collect.ts'
export type { Check, CheckGroup, CheckStatus, DoctorReport } from './report.ts'

export const name = 'command-doctor'
export const inject = ['commands']

/** Execute `/doctor [flags]` against the composed context. */
async function executeDoctor(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const flags = parseDoctorFlags(invocation.rawInput)
  if (flags.kind === 'usage') {
    return { kind: 'success', text: formatUsage() }
  }
  const t0 = performance.now()
  const collected = await collect(ctx, invocation, {
    verbose: flags.verbose || flags.json,
    now: () => new Date(),
    ms: () => performance.now() - t0,
  })
  const report = redactReport(collected)
  if (flags.json) {
    return { kind: 'success', text: await emitJson(report) }
  }
  return { kind: 'success', text: formatDoctorReport(report, { verbose: flags.verbose }) }
}

/** Write the JSON file and produce the short ack text (never the JSON body). */
async function emitJson(report: Parameters<typeof writeDoctorReport>[1]): Promise<string> {
  const path = doctorJsonPath()
  const summary = `summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skip} skip, ${report.summary.info} info`
  const ids = statusIds(report)
  try {
    await writeDoctorReport(path, report)
    return [`doctor report written: ${path}`, summary, ...ids].join('\n')
  } catch (error) {
    return [`failed to write ${path}: ${String(error)}`, summary, ...ids].join('\n')
  }
}

/** The fail/warn ids appended under the JSON ack. */
function statusIds(report: Parameters<typeof writeDoctorReport>[1]): string[] {
  const lines: string[] = []
  for (const status of ['fail', 'warn'] as const) {
    const ids = report.checks.filter(check => check.status === status).map(check => check.id)
    if (ids.length > 0) lines.push(`${status}: ${ids.join(', ')}`)
  }
  return lines
}

/**
 * Register the `/doctor` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'doctor',
    description: 'session health report',
    input: { hint: '[--verbose|--json]' },
    handler: (invocation: CommandInvocation) => executeDoctor(ctx, invocation),
  })
}
