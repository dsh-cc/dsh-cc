/**
 * Persisted composer prompt history. Prompts (not slash commands) are stored
 * as JSON-lines under the profile data dir so ↑/↓ recall survives restarts.
 * fs access is best-effort: a corrupt or unwritable file degrades silently to
 * an empty history and never breaks a session.
 *
 * One JSON string per physical line — the encoding is unambiguous for
 * multi-line prompts (embedded newlines are escaped by JSON.stringify, so a
 * single entry never spans multiple physical lines). Plain-line storage would
 * split a multi-line prompt across lines and corrupt line-based loading.
 *
 * @module @dsh-cc/tui/history
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Maximum entries retained; the oldest are dropped when exceeded. */
export const HISTORY_CAP = 500

/**
 * Resolve the data directory (the `tui` dir). An injected `dir` overrides;
 * otherwise mirrors {@link resume-target} resolution: `$DSH_HOME/tui` or
 * `~/.dsh/tui`.
 */
function dataDir(dir?: string): string {
  if (dir !== undefined) return dir
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'tui')
}

/** Absolute path to the history file under the data dir. */
export function historyFilePath(dir?: string): string {
  return join(dataDir(dir), 'history.txt')
}

/**
 * The default `tui` data dir (`$DSH_HOME/tui` or `~/.dsh/tui`) with no
 * override — the parent of the per-project `projects/<key>` buckets and the
 * home of the legacy global files {@link coldCutGlobalHistory} sets aside.
 */
export function defaultTuiDir(): string {
  return dataDir()
}

/**
 * One-time migration off the pre-project *global* history files. Before
 * history was bucketed per project, prompts and bash commands both lived in
 * single files under `$DSH_HOME/tui` (`history.txt`, `bash-history.txt`),
 * leaking across every directory — the very reason per-project history now
 * exists. Those files carry no provenance, so they cannot be split back onto
 * their projects; they are set aside as `<name>.global.bak` (a previous backup
 * is overwritten) and each project starts its history empty. Best-effort: a
 * missing source or unwritable dir is a silent no-op that never breaks boot.
 *
 * @param tuiDir the `tui` directory holding the legacy global files
 *   (`$DSH_HOME/tui`, or `~/.dsh/tui`).
 */
export function coldCutGlobalHistory(tuiDir: string): void {
  const moves = {
    'history.txt': 'history.global.bak',
    'bash-history.txt': 'bash-history.global.bak',
  } as const
  for (const [from, to] of Object.entries(moves)) {
    const src = join(tuiDir, from)
    const dst = join(tuiDir, to)
    // Drop any prior backup (POSIX rename would overwrite it, Windows refuses
    // to — clearing first makes both platforms behave the same), then move the
    // legacy global file aside. Missing source is the common no-op.
    try {
      rmSync(dst, { force: true })
    } catch {
      // Unwritable — best-effort.
    }
    try {
      renameSync(src, dst)
    } catch {
      // Missing source (or unwritable dir) — best-effort, never break boot.
    }
  }
}

/**
 * Normalise an entry list: drop empty/whitespace-only entries, suppress
 * consecutive duplicates, and cap to {@link HISTORY_CAP} (keeping the newest).
 */
function normalize(entries: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    if (entry.length === 0 || entry.trim().length === 0) continue
    if (out.length > 0 && out[out.length - 1] === entry) continue
    out.push(entry)
  }
  return out.slice(-HISTORY_CAP)
}

/**
 * Read persisted history (oldest→newest). Missing or corrupt file → `[]`;
 * never throws.
 */
export function loadHistory(dir?: string): string[] {
  try {
    const content = readFileSync(historyFilePath(dir), 'utf8')
    const lines = content.split('\n')
    const entries: string[] = []
    for (const line of lines) {
      if (line.length === 0) continue
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'string' && parsed.length > 0) entries.push(parsed)
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Write the full list (capped, consecutive-duplicate suppressed) to disk as
 * JSON-lines. Returns the normalised list so callers can keep their in-memory
 * copy in sync with what was actually persisted. Best-effort: fs failures are
 * swallowed (the returned list still reflects the intended state).
 */
export function saveHistory(entries: readonly string[], dir?: string): string[] {
  const normalized = normalize(entries)
  try {
    mkdirSync(dataDir(dir), { recursive: true })
    const content = normalized.length === 0
      ? ''
      : `${normalized.map(entry => JSON.stringify(entry)).join('\n')}\n`
    writeFileSync(historyFilePath(dir), content)
  } catch {
    // Persistence is best-effort; never break the session over a write.
  }
  return normalized
}
