/**
 * JSON emission: resolve the `doctor-report.json` path under `$DSH_HOME`
 * (default `~/.dsh`) and write (mkdir + overwrite) a redacted report.
 * @module @dsh-cc/command-doctor/json
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DoctorReport } from './report.ts'

/**
 * Resolve the report path: `$DSH_HOME/tui/doctor-report.json`, falling back
 * to `~/.dsh/tui/doctor-report.json` when `DSH_HOME` is unset.
 */
export function doctorJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'tui', 'doctor-report.json')
}

/**
 * Write the report, creating parent directories and overwriting any existing
 * file.
 * @param path - the resolved target path.
 * @param report - the redacted report.
 */
export async function writeDoctorReport(path: string, report: DoctorReport): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}
