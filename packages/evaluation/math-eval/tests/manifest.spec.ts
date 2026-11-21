import { describe, expect, it } from 'vitest'
import { validateRunManifest } from '../src/manifest.js'
import { MANIFEST_DEFAULTS } from '../src/types.js'
import { getConfig } from '../src/ablation.js'

// Strict run-manifest schema (docs/plans/2026-11-21-mathematical-research-harness.md §9.1):
// unknown fields rejected; documented v4 defaults written out; discovery null or complete.
const MINIMAL = { goal: 'prove the benchmark slices', createdAt: '2026-11-21T00:00:00.000Z' }

describe('validateRunManifest', () => {
  it('accepts the minimal manifest and materializes the documented defaults', () => {
    const result = validateRunManifest(MINIMAL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.budget).toEqual({ attempts: 8, tokens: 200_000, wallClockMs: 1_800_000 })
    expect(result.value.allowHumanFidelity).toBe(false)
    expect(result.value.tierPolicy).toBe('main')
    expect(result.value.discovery).toBeNull()
    expect(result.value.trustedExamples).toEqual([])
    expect(result.value.createdAt).toBe(MINIMAL.createdAt)
    // The defaults are the same objects the design writes out.
    expect(MANIFEST_DEFAULTS.budget).toEqual(result.value.budget)
    expect(MANIFEST_DEFAULTS.tierPolicy).toBe(result.value.tierPolicy)
  })

  it('accepts an explicit fully-specified manifest unchanged', () => {
    const result = validateRunManifest({
      ...MINIMAL,
      budget: { attempts: 1, tokens: 1000, wallClockMs: 60_000 },
      allowHumanFidelity: true,
      tierPolicy: 'delegated',
      discovery: {
        selectionK: 4,
        convergenceG: 0.85,
        rngSeed: 20261121,
        populationSize: 32,
        programLanguage: 'python',
        evaluatorSignature: 'sha256:abc',
      },
      trustedExamples: [{ problemId: 'minif2f-1', source: 'miniF2F', sha256: 'a'.repeat(64) }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.budget.attempts).toBe(1)
    expect(result.value.tierPolicy).toBe('delegated')
    expect(result.value.discovery?.selectionK).toBe(4)
    expect(result.value.trustedExamples).toHaveLength(1)
  })

  it('rejects unknown fields at every level of the schema', () => {
    const top = validateRunManifest({ ...MINIMAL, surprise: 1 })
    expect(top.ok).toBe(false)
    if (top.ok) return
    expect(top.errors).toContain('manifest: unknown field "surprise"')

    const budget = validateRunManifest({ ...MINIMAL, budget: { attempts: 2, retries: 3 } })
    expect(budget.ok).toBe(false)
    if (budget.ok) return
    expect(budget.errors).toContain('budget: unknown field "retries"')

    const discovery = validateRunManifest({
      ...MINIMAL,
      discovery: {
        selectionK: 4,
        convergenceG: 0.5,
        rngSeed: 1,
        populationSize: 8,
        programLanguage: 'python',
        evaluatorSignature: 'sig',
        extra: true,
      },
    })
    expect(discovery.ok).toBe(false)
    if (discovery.ok) return
    expect(discovery.errors).toContain('discovery: unknown field "extra"')

    const trusted = validateRunManifest({
      ...MINIMAL,
      trustedExamples: [{ problemId: 'p', source: 'miniF2F', sha256: 'h', note: 'n' }],
    })
    expect(trusted.ok).toBe(false)
    if (trusted.ok) return
    expect(trusted.errors).toContain('trustedExamples[0]: unknown field "note"')
  })

  it('rejects a missing goal/createdAt and a malformed enum or budget', () => {
    const noGoal = validateRunManifest({ createdAt: MINIMAL.createdAt })
    expect(noGoal.ok).toBe(false)
    if (!noGoal.ok) expect(noGoal.errors).toContain('goal: expected a non-empty string')

    const badDate = validateRunManifest({ ...MINIMAL, createdAt: 'not-a-timestamp' })
    expect(badDate.ok).toBe(false)
    if (!badDate.ok) expect(badDate.errors.some((e) => e.startsWith('createdAt:'))).toBe(true)

    const badTier = validateRunManifest({ ...MINIMAL, tierPolicy: 'auto' })
    expect(badTier.ok).toBe(false)
    if (!badTier.ok) expect(badTier.errors).toContain('tierPolicy: expected one of main|delegated')

    const badBudget = validateRunManifest({ ...MINIMAL, budget: { attempts: 0, tokens: -1 } })
    expect(badBudget.ok).toBe(false)
    if (!badBudget.ok) {
      expect(badBudget.errors).toContain('budget.attempts: expected a positive integer')
      expect(badBudget.errors).toContain('budget.tokens: expected a positive integer')
    }

    const notObject = validateRunManifest('nope')
    expect(notObject.ok).toBe(false)
    if (!notObject.ok) expect(notObject.errors).toEqual(['manifest: expected an object'])
  })

  it('treats discovery null and absent identically', () => {
    const absent = validateRunManifest(MINIMAL)
    const explicitNull = validateRunManifest({ ...MINIMAL, discovery: null })
    expect(absent.ok && explicitNull.ok).toBe(true)
    if (!absent.ok || !explicitNull.ok) return
    expect(absent.value).toEqual(explicitNull.value)
  })

  it('carries no per-config attempt override: the F1 exception is ablation data, not manifest data', () => {
    // §8.3: every config shares the manifest envelope except F1, whose
    // attempts=1 cap is declared in the ablation matrix.
    expect(MANIFEST_DEFAULTS.budget.attempts).toBe(8)
    expect(getConfig('F1').attemptsOverride).toBe(1)
    const result = validateRunManifest({ ...MINIMAL, budget: { attempts: 3 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.budget.attempts).toBe(3)
    expect(Object.keys(result.value)).not.toContain('attemptsOverride')
  })
})
