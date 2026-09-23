/**
 * Work-discarding enrichment (S3): when the classifier's call discards work,
 * snapshot the git working tree so the model sees what is about to be lost.
 * Best-effort — any failure ⇒ '' (the `<context>` section is simply omitted).
 * @module @dsh-cc/permission-rules/enrichment
 */

/**
 * The work-discarding command patterns: a bash command matching ANY of these
 * may destroy uncommitted work. Best-effort heuristics by design (CC ships
 * the same class of list).
 */
export const WORK_DISCARDING: readonly RegExp[] = [
  /git reset --hard/,
  /git clean\s+(?:-[a-z]*\s+)*-[a-z]*[fdx]/,
  /git checkout\s+[^|;&]*--/,
  /git restore\b/,
  /\brm\s+(?:-\w+\s+)*-\w*[rf]/,
  /\brmdir\b/,
]

/** The git status probe run on a match. */
export const GIT_STATUS_COMMAND = 'git -c status.showUntrackedFiles=all status --porcelain'

/** The enriched context snapshot cap (chars). */
const SNAPSHOT_CAP = 512

/**
 * One shell runner. `cwd` is the session cwd; `timeoutMs` bounds the child.
 * Rejects on failure (non-zero exit, timeout) — callers treat that as "no data".
 */
export type CommandRunner = (cmd: string, opts: { cwd?: string; timeoutMs: number }) => Promise<string>

/**
 * Build the enrichment `<context>` body for one bash command: on a
 * {@link WORK_DISCARDING} match, run the git porcelain status via `runner`
 * (1000 ms budget) and return `uncommitted-work snapshot:\n…` (≤512 chars of
 * output) or `working tree clean`. Anything else — non-matching command,
 * absent runner, any error — returns `''`.
 */
export async function enrichContext(command: string, runner?: CommandRunner): Promise<string> {
  if (runner === undefined) return ''
  if (!WORK_DISCARDING.some(pattern => pattern.test(command))) return ''
  let output: string
  try {
    output = await runner(GIT_STATUS_COMMAND, { timeoutMs: 1000 })
  } catch {
    return ''
  }
  const trimmed = output.trim()
  if (trimmed.length === 0) return 'working tree clean'
  return `uncommitted-work snapshot:\n${trimmed.slice(0, SNAPSHOT_CAP)}`
}
