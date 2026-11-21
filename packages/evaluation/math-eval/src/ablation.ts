/**
 * The §8.3 ablation matrix as data: nine configurations, one declared budget
 * exception (F1), and the four isolated attribution contrasts.
 *
 * Fidelity to the design table is the point of this module — thresholds and
 * comparisons are *not* implemented here (a later wave runs them); these are
 * the pinned definitions.
 *
 * @module @dsh-cc/math-eval/ablation
 */

import type { AblationConfig, AttributionContrast, ConfigKey } from './types.js'

/**
 * §8.3 table, in design order. Columns: prompt / bash+lean / retrieval /
 * feedback / search / experience. F1 is the search configuration with
 * attempts capped at 1 — the single declared budget exception, so no other
 * row may carry `attemptsOverride`.
 */
export const ABLATION_CONFIGS: readonly AblationConfig[] = [
  {
    key: 'A',
    label: 'A baseline',
    prompt: false,
    bashLean: false,
    retrieval: false,
    feedback: false,
    search: false,
    experience: false,
  },
  {
    key: 'B',
    label: 'B +prompt',
    prompt: true,
    bashLean: false,
    retrieval: false,
    feedback: false,
    search: false,
    experience: false,
  },
  {
    key: 'C',
    label: 'C +tools',
    prompt: true,
    bashLean: true,
    retrieval: false,
    feedback: false,
    search: false,
    experience: false,
  },
  {
    key: 'D',
    label: 'D +retrieval',
    prompt: true,
    bashLean: true,
    retrieval: true,
    feedback: false,
    search: false,
    experience: false,
  },
  {
    key: 'E',
    label: 'E +feedback',
    prompt: true,
    bashLean: true,
    retrieval: false,
    feedback: true,
    search: false,
    experience: false,
  },
  {
    key: 'H',
    label: 'H +retrieval+feedback',
    prompt: true,
    bashLean: true,
    retrieval: true,
    feedback: true,
    search: false,
    experience: false,
  },
  {
    key: 'F',
    label: 'F +search (over H)',
    prompt: true,
    bashLean: true,
    retrieval: true,
    feedback: true,
    search: true,
    experience: false,
  },
  {
    key: 'F1',
    label: 'F1 search@1',
    prompt: true,
    bashLean: true,
    retrieval: true,
    feedback: true,
    search: true,
    experience: false,
    attemptsOverride: 1,
  },
  {
    key: 'G',
    label: 'G full',
    prompt: true,
    bashLean: true,
    retrieval: true,
    feedback: true,
    search: true,
    experience: true,
  },
]

/**
 * §8.3 attribution, narrowed and honest: only these four contrasts may be
 * claimed. H→F isolates the search mechanism *inclusive of its extra
 * sampling*; F1 vs H separately reports the single-attempt variant so the
 * sampling cost stays separable.
 */
const ATTRIBUTION_CONTRASTS: readonly AttributionContrast[] = [
  {
    id: 'C->D',
    from: 'C',
    to: 'D',
    isolates: 'retrieval',
    claim: 'C→D isolates retrieval',
  },
  {
    id: 'C->E',
    from: 'C',
    to: 'E',
    isolates: 'feedback',
    claim: 'C→E isolates feedback',
  },
  {
    id: 'H->F',
    from: 'H',
    to: 'F',
    isolates: 'search',
    claim: 'H→F isolates the search mechanism inclusive of its extra sampling',
  },
  {
    id: 'F->G',
    from: 'F',
    to: 'G',
    isolates: 'experience',
    claim: 'F→G isolates experience',
  },
]

/** The four isolated contrasts as data (fresh array; the pinned list is private). */
export function attributionContrasts(): AttributionContrast[] {
  return ATTRIBUTION_CONTRASTS.map((contrast) => ({ ...contrast }))
}

/**
 * Look a config up by key. Throws on an unknown key: callers pass a typed
 * `ConfigKey`, so a miss is a programming error rather than a reportable
 * outcome.
 */
export function getConfig(key: ConfigKey): AblationConfig {
  const found = ABLATION_CONFIGS.find((config) => config.key === key)
  if (found === undefined) throw new Error(`unknown ablation config key: ${String(key)}`)
  return { ...found }
}
