/**
 * Session-log file I/O: read session events from a plain JSONL file, stdin
 * (`-`), or a `.zstd` compressed log (via the `zstd` CLI, `DSH_ZSTD_BIN`
 * overridable). Extracted verbatim from `bin.ts` (which previously kept it
 * private) so other packages can import it (plan 2026-09-20 §3.4 dogfooding).
 *
 * @module @dsh-cc/cache-trajectory/session-log-io
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { SessionLogEvent } from './index.ts'

/** Parse a session log (plain JSONL, `-` for stdin, `.zstd` via the zstd CLI). */
export function readSessionEvents(path: string): SessionLogEvent[] {
  let text: string
  if (path === '-') {
    text = readFileSync(0, 'utf8')
  } else if (path.endsWith('.zstd')) {
    const zstdBin = process.env.DSH_ZSTD_BIN ?? 'zstd'
    const result = spawnSync(zstdBin, ['-dc', path], { encoding: 'utf8', maxBuffer: 1 << 30 })
    if (result.status !== 0) {
      throw new Error(`cache-trajectory-bin: zstd -dc ${path} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
    }
    text = result.stdout
  } else {
    text = readFileSync(path, 'utf8')
  }
  const events: SessionLogEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    events.push(JSON.parse(line) as SessionLogEvent)
  }
  return events
}
