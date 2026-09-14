/**
 * Claude Code-compatible `worktree` settings section (WS-4 of
 * docs/plans/2026-09-14-cc-worktree-parity.md). Top-level namespaces are
 * kebab-case upstream; `worktree` is already a single lowercase word, so the
 * root location matches CC exactly. Exported as a standalone value so the
 * settings cascade and the tool-git-worktree consumer share one definition.
 * @module @dsh-cc/settings-cascade/worktree
 */

import z from '@deepseek-ai/schemastery'

/** Base-selection mode for new worktrees. */
export type WorktreeBaseRef = 'fresh' | 'head'

/** The `worktree` section body; every key stays absent when omitted. */
export interface Worktree {
  /**
   * `fresh` (default): new worktrees branch from the remote default branch
   * (`origin/HEAD`); `head`: branch from the literal current `HEAD`.
   */
  baseRef?: WorktreeBaseRef
  /** Sweep window in days — worktrees older than this become sweep candidates (default 30). */
  cleanupPeriodDays?: number
}

/**
 * Schemastery schema for the `worktree` section. Absence-preserving union
 * idiom (per {@link module:settings-cascade/auto-mode}): sub-keys absent
 * from every settings layer stay absent, and the section itself stays
 * `undefined` when absent — defaults apply only at consumption time.
 */
export const WorktreeSchema: z<Worktree | undefined> = z.union([
  z.object({
    baseRef: z.union([z.union(['fresh', 'head']), z.const(undefined)]),
    cleanupPeriodDays: z.union([z.number(), z.const(undefined)]),
  }),
  z.const(undefined),
]) as z<Worktree | undefined>

/** Consumption-time defaults (never materialized into settings files). */
export const WORKTREE_DEFAULTS: Required<Worktree> = {
  baseRef: 'fresh',
  cleanupPeriodDays: 30,
}

/**
 * Merge a parsed section over the documented defaults. Pure; used by every
 * consumer so no call site re-invents the fallbacks.
 */
export function worktreeSettings(value: Worktree | undefined): Required<Worktree> {
  return {
    baseRef: value?.baseRef ?? WORKTREE_DEFAULTS.baseRef,
    cleanupPeriodDays: value?.cleanupPeriodDays ?? WORKTREE_DEFAULTS.cleanupPeriodDays,
  }
}
