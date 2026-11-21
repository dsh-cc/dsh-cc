/**
 * Types for the mathematical research harness evaluation package
 * (docs/plans/2026-11-21-mathematical-research-harness.md §8.1–§8.3, §9.1).
 *
 * Structure only: nothing here performs model calls, kernel checks or file
 * ingestion. Types that describe artifacts owned by later waves (runner,
 * scorer, fixture ingestion) are marked as such.
 *
 * @module @dsh-cc/math-eval/types
 */

/** The nine ablation configurations of §8.3, in design-table order. */
export const CONFIG_KEYS = ['A', 'B', 'C', 'D', 'E', 'H', 'F', 'F1', 'G'] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** §6.3 claim-state taxonomy (M3 states included; the ledger enumerates them). */
export const CLAIM_STATUSES = [
  'open',
  'proven',
  'proven-of-formal-statement',
  'experiment-supported',
  'falsified',
  'revalidation-pending',
  'superseded',
  'fidelity-failed',
] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

/** §6.3: terminal states are never re-sources. */
export const TERMINAL_CLAIM_STATUSES = ['superseded', 'fidelity-failed'] as const

/**
 * §4.3 `statement_faithful` grades. `machine-confirmed` is deliberately absent
 * (retracted in r2): pair equivalence is advisory data, never a grade input.
 */
export const FIDELITY_GRADES = ['anchored', 'human-confirmed', 'model-assessed', 'disputed'] as const
export type FidelityGrade = (typeof FIDELITY_GRADES)[number]

/** §4.3 dispute reasons attached to a `disputed` grade. */
export const DISPUTE_REASONS = ['anchor-failed', 'model-judgment', 'infra-failure'] as const
export type DisputeReason = (typeof DISPUTE_REASONS)[number]

/** §8.3 budget envelope. Every config gets the same caps except F1's attempts=1. */
export interface Budget {
  attempts: number
  tokens: number
  wallClockMs: number
}

/** §9.1 discovery block; `null` in the manifest means discovery is off. */
export interface DiscoveryConfig {
  selectionK: number
  convergenceG: number
  rngSeed: number
  populationSize: number
  programLanguage: string
  evaluatorSignature: string
}

/** v1 lanes only (§9.1); no per-tier runtime dispatch is invented. */
export const TIER_POLICIES = ['main', 'delegated'] as const
export type TierPolicy = (typeof TIER_POLICIES)[number]

/**
 * A trusted example pinned into the run (§9.1 `trustedExamples`). The design
 * names the field but not its member shape; this is the minimal record the
 * later fidelity/anchored-reference wave extends — it is purposeful pinning
 * data, never benchmark content.
 */
export interface TrustedExample {
  problemId: string
  source: string
  /** sha256 of the trusted reference formalization artifact. */
  sha256: string
}

/** §9.1 strict run manifest. Unknown fields are rejected by the validator. */
export interface RunManifest {
  goal: string
  budget: Budget
  allowHumanFidelity: boolean
  tierPolicy: TierPolicy
  discovery: DiscoveryConfig | null
  trustedExamples: TrustedExample[]
  createdAt: string
}

/** §9.1 documented defaults (v4, written out). */
export const MANIFEST_DEFAULTS: Pick<
  RunManifest,
  'budget' | 'allowHumanFidelity' | 'tierPolicy' | 'discovery'
> = {
  budget: { attempts: 8, tokens: 200_000, wallClockMs: 1_800_000 },
  allowHumanFidelity: false,
  tierPolicy: 'main',
  discovery: null,
}

/** §8.1 per-fixture record; one per ingested benchmark slice. */
export interface FixtureRecord {
  source: string
  license: string
  fetchedAt: string
  sha256: string
  problemIds: string[]
}

/** §8.3 one row of the ablation matrix, as data. */
export interface AblationConfig {
  key: ConfigKey
  label: string
  prompt: boolean
  bashLean: boolean
  retrieval: boolean
  feedback: boolean
  /**
   * Search/multi-sample — inclusive of its extra sampling (§8.3). F1 keeps
   * this `true` and caps attempts at 1, so sampling cost stays separable.
   */
  search: boolean
  experience: boolean
  /** §8.3: F1 is the one declared budget exception. Absent elsewhere. */
  attemptsOverride?: number
}

/** Which mechanism a contrast isolates (§8.3 attribution, narrowed and honest). */
export const CONTRAST_FACTORS = ['retrieval', 'feedback', 'search', 'experience'] as const
export type ContrastFactor = (typeof CONTRAST_FACTORS)[number]

/** One isolated attribution contrast between two adjacent ablation configs. */
export interface AttributionContrast {
  id: string
  from: ConfigKey
  to: ConfigKey
  isolates: ContrastFactor
  /** The delta the row is allowed to claim, in design wording. */
  claim: string
}

/** Top-level field whitelist of the strict schema, exported for validators. */
export const RUN_MANIFEST_FIELDS = [
  'goal',
  'budget',
  'allowHumanFidelity',
  'tierPolicy',
  'discovery',
  'trustedExamples',
  'createdAt',
] as const

/**
 * Unknown-key rejection helper shared by every strict-schema validator here.
 * Returns one `<path>: unknown field "x"` message per offending key, sorted
 * for stable output; an empty array means the object carries no extraneous
 * field. Non-objects yield a single type error (the caller reports it).
 */
export function unknownFieldErrors(value: unknown, allowed: readonly string[], path: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${path}: expected an object`]
  }
  const allowedSet = new Set<string>(allowed)
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort()
    .map((key) => `${path}: unknown field "${key}"`)
}
