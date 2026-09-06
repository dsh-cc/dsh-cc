/**
 * `/doctor` flag parsing and usage text. Pure and cordis-free.
 * @module @dsh-cc/command-doctor/flags
 */

export type DoctorFlags =
  | { kind: 'run'; verbose: boolean; json: boolean }
  | { kind: 'usage' }

/** The usage text shown for unknown flags (never an error result). */
export const DOCTOR_USAGE = [
  'Usage:',
  '  /doctor              session health report',
  '  /doctor --verbose    include slow probes and evidence',
  '  /doctor --json       write $DSH_HOME/tui/doctor-report.json (overwrites)',
].join('\n')

/** The usage formatter used by the handler for unknown tokens. */
export function formatUsage(): string {
  return DOCTOR_USAGE
}

/**
 * Parse the tokens after `/doctor`. `--verbose` and `--json` are
 * order-independent; any other token yields usage. Both flags collect
 * verbose and emit JSON.
 * @param rawInput - `invocation.rawInput`, the text after the command name.
 */
export function parseDoctorFlags(rawInput: string): DoctorFlags {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  let verbose = false
  let json = false
  for (const token of tokens) {
    if (token === '--verbose') verbose = true
    else if (token === '--json') json = true
    else return { kind: 'usage' }
  }
  return { kind: 'run', verbose, json }
}
