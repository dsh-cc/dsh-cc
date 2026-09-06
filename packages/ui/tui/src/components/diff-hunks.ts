/**
 * Line-level diff computation for file edit cards. Hunks are derived from a
 * true line LCS using Hirschberg's linear-space divide-and-conquer over
 * dynamic-programming rows, so memory stays O(n + m) even for large files.
 * When either side exceeds DIFF_LCS_LINE_CAP lines, computation falls back to
 * the cheaper common prefix/suffix heuristic (a single coarse middle hunk) so
 * pathological inputs stay fast and allocation-light.
 * @module @dsh-cc/tui/components/diff-hunks
 */

/**
 * One contiguous run of changed lines. Unchanged context is deliberately not
 * stored — the renderer derives context and collapse markers from the
 * surrounding line numbers.
 */
export interface DiffHunk {
  /** 1-based line number in the old text where this hunk's removals begin. */
  readonly oldStart: number
  /** 1-based line number in the new text where this hunk's additions begin. */
  readonly newStart: number
  /** Lines deleted from the old text, in file order. */
  readonly removed: readonly string[]
  /** Lines added to the new text, in file order. */
  readonly added: readonly string[]
}

/**
 * Maximum lines per side handled by exact LCS. Beyond this the single-middle
 * prefix/suffix heuristic is used instead (quadratic-time DP is skipped).
 */
export const DIFF_LCS_LINE_CAP = 4000

/**
 * Split text into lines, dropping a single trailing empty line produced by a
 * final newline so `a\nb\n` → `['a','b']` (not `['a','b','']`). A bare empty
 * string yields `[]`.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Trim the longest common line-exact prefix; return [prefixLength, oldRest, newRest]. */
function trimCommonPrefix(
  oldLines: readonly string[],
  newLines: readonly string[],
): [number, string[], string[]] {
  const min = Math.min(oldLines.length, newLines.length)
  let i = 0
  while (i < min && oldLines[i] === newLines[i]) i++
  return [i, oldLines.slice(i), newLines.slice(i)]
}

/** Trim the longest common line-exact suffix; return [oldRest, newRest]. */
function trimCommonSuffix(
  oldLines: readonly string[],
  newLines: readonly string[],
): [string[], string[]] {
  const min = Math.min(oldLines.length, newLines.length)
  let i = 0
  while (i < min && oldLines[oldLines.length - 1 - i] === newLines[newLines.length - 1 - i]) i++
  return [oldLines.slice(0, oldLines.length - i), newLines.slice(0, newLines.length - i)]
}

/** Edit script ops over the (prefix/suffix-trimmed) middle region. */
const EQUAL = 0
const DELETE = 1
const INSERT = 2

/** Map lines to dense integer ids so DP comparisons are O(1) instead of string compares. */
function intern(lines: readonly string[], pool: Map<string, number>): number[] {
  return lines.map(line => {
    let id = pool.get(line)
    if (id === undefined) {
      id = pool.size
      pool.set(line, id)
    }
    return id
  })
}

/**
 * Final DP row for LCS(a, b): row[j] is the LCS length of `a` against the
 * first j lines of `b`. Two rolling rows keep memory at O(b.length).
 */
function lcsRow(a: readonly number[], b: readonly number[]): Int32Array {
  const m = b.length
  let prev = new Int32Array(m + 1)
  let curr = new Int32Array(m + 1)
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    curr[0] = 0
    for (let j = 1; j <= m; j++) {
      curr[j] = av === b[j - 1]!
        ? prev[j - 1]! + 1
        : prev[j]! >= curr[j - 1]! ? prev[j]! : curr[j - 1]!
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev
}

/**
 * Append a minimal edit script for `a` → `b` to `out` via Hirschberg's
 * divide-and-conquer: split `a`, find the `b` split point that maximizes the
 * combined LCS, recurse. Linear space, O(len(a) · len(b)) time.
 */
function editScript(a: readonly number[], b: readonly number[], out: number[]): void {
  if (a.length === 0) {
    for (let j = 0; j < b.length; j++) out.push(INSERT)
    return
  }
  if (b.length === 0) {
    for (let i = 0; i < a.length; i++) out.push(DELETE)
    return
  }
  if (a.length === 1) {
    // Base case: align the single line against its first match in b.
    const av = a[0]!
    let hit = -1
    for (let j = 0; j < b.length; j++) {
      if (b[j] === av) {
        hit = j
        break
      }
    }
    for (let j = 0; j < b.length; j++) out.push(j === hit ? EQUAL : INSERT)
    if (hit === -1) out.push(DELETE)
    return
  }
  const mid = a.length >> 1
  const l1 = lcsRow(a.slice(0, mid), b)
  const l2 = lcsRow(a.slice(mid).reverse(), b.slice().reverse())
  let bestJ = 0
  let best = -1
  for (let j = 0; j <= b.length; j++) {
    const score = l1[j]! + l2[b.length - j]!
    if (score > best) {
      best = score
      bestJ = j
    }
  }
  editScript(a.slice(0, mid), b.slice(0, bestJ), out)
  editScript(a.slice(mid), b.slice(bestJ), out)
}

/** Fold an edit script into hunks, tracking 1-based line numbers on both sides. */
function hunksFromScript(
  script: readonly number[],
  oldMiddle: readonly string[],
  newMiddle: readonly string[],
  prefixLen: number,
): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: { oldStart: number; newStart: number; removed: string[]; added: string[] } | null =
    null
  let oi = 0
  let ni = 0
  for (const op of script) {
    if (op === EQUAL) {
      current = null
      oi++
      ni++
      continue
    }
    if (current === null) {
      current = {
        oldStart: prefixLen + oi + 1,
        newStart: prefixLen + ni + 1,
        removed: [],
        added: [],
      }
      hunks.push(current)
    }
    if (op === DELETE) {
      current.removed.push(oldMiddle[oi]!)
      oi++
    } else {
      current.added.push(newMiddle[ni]!)
      ni++
    }
  }
  return hunks
}

/**
 * Compute the changed hunks between two versions of a file. Returns hunks in
 * file order; each hunk covers one contiguous run of changed lines (an
 * unchanged line between two changes starts a new hunk). Identical inputs
 * yield `[]`. Inputs larger than DIFF_LCS_LINE_CAP lines per side fall back
 * to a single coarse hunk from the common prefix/suffix trim.
 */
export function computeHunks(oldText: string, newText: string): readonly DiffHunk[] {
  if (oldText === newText) return []
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  const [prefixLen, oldRest, newRest] = trimCommonPrefix(oldLines, newLines)
  const [oldMiddle, newMiddle] = trimCommonSuffix(oldRest, newRest)
  if (oldMiddle.length === 0 && newMiddle.length === 0) return []

  // Guard rail: exact LCS is quadratic in the input sizes. When either side
  // exceeds the cap, fall back to the legacy heuristic: the trimmed middle
  // becomes one coarse hunk (context and markers are the renderer's job).
  if (oldLines.length > DIFF_LCS_LINE_CAP || newLines.length > DIFF_LCS_LINE_CAP) {
    return [{ oldStart: prefixLen + 1, newStart: prefixLen + 1, removed: oldMiddle, added: newMiddle }]
  }

  const pool = new Map<string, number>()
  const script: number[] = []
  editScript(intern(oldMiddle, pool), intern(newMiddle, pool), script)
  return hunksFromScript(script, oldMiddle, newMiddle, prefixLen)
}
