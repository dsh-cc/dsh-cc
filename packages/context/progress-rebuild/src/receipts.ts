/**
 * Bash exit-marker parsing and proof-command classification (spec pin 1 and
 * the design's verified-derivation receipts). Fail-closed: a missing or
 * non-zero exit marker never counts as verified, and `isError` results are
 * excluded upstream (infrastructure failures).
 *
 * @module @dsh-cc/progress-rebuild/receipts
 */

/**
 * Parse the harness bash `[exit code: N]` marker from concatenated result
 * text (the marker is rendered on its own last line). Returns the exit code,
 * or `null` when the marker is absent.
 */
export function parseExitMarker(text: string): number | null {
  const matches = text.matchAll(/\[exit code: (\d+)\]/g)
  let last: number | null = null
  for (const match of matches) last = Number(match[1])
  return last
}

/** Proof-command classes recognized in a bash command head. */
export type ProofClass = 'test' | 'presubmit' | 'build' | 'lint' | 'git-commit'

const CLASS_WORDS: readonly ProofClass[] = ['test', 'presubmit', 'build', 'lint']

/**
 * Classify a bash command by its first 4 whitespace tokens (case-insensitive).
 * A token counts for a class when it contains the class word (so `vitest`,
 * `npm test`, `pnpm build`, `eslint` all match); `git commit` matches as an
 * adjacent token pair. Returns `undefined` when no class matches.
 */
export function isProofCommand(command: string): boolean {
  return proofClass(command) !== undefined
}

/** Classify a command into its proof class, or `undefined`. */
export function proofClass(command: string): ProofClass | undefined {
  const tokens = command.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)
  for (const token of tokens) {
    for (const word of CLASS_WORDS) {
      if (token.includes(word)) return word
    }
  }
  if (tokens[0] === 'git' && tokens[1] === 'commit') return 'git-commit'
  return undefined
}

/** Short receipt label per proof class (design §3.3 template lines). */
export function receiptLabel(command: string): string {
  const cls = proofClass(command)
  switch (cls) {
    case 'test':
      return 'tests green (vitest)'
    case 'presubmit':
      return 'presubmit passed (presubmit)'
    case 'build':
      return 'build green (build)'
    case 'lint':
      return 'lint green (lint)'
    case 'git-commit':
      return 'commit created (git commit)'
    default:
      return 'verified'
  }
}
