/**
 * Frozen gate: eval-gate.yaml loading, baseline blob validation, and the
 * tier-honest comparator (plan §3.2/§3.3). Replay tier is a metric-definition
 * regression suite only — it never proves savings. Mock tier is a wiring
 * regression suite: capability + counters only; token axes are reported.
 *
 * @module @dsh-cc/token-efficiency/gate
 */
import { existsSync, readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { z } from 'zod'
import type { TaskDescriptor } from './corpus.ts'
import type { MetricVector } from './metrics.ts'

export const toleranceSchema = z.object({
  capability: z.int().min(0).refine(v => v === 0, 'tolerance.capability must be 0 at v1 — capability is boolean-ok, no numeric tolerance'),
})

export const gateConfigSchema = z.object({
  baseline: z.object({ ref: z.string().min(1), vector: z.string().min(1) }),
  tolerance: toleranceSchema,
  'require-improvement-on': z.array(z.string().min(1)).optional(),
})

export type GateConfig = z.infer<typeof gateConfigSchema>

const baselineBlobSchema = z.object({
  foldedAt: z.string().optional(),
  ref: z.string().min(1),
  vectors: z.record(z.string(), z.custom<MetricVector>(() => true)),
})

export type BaselineBlob = z.infer<typeof baselineBlobSchema>

/** Load and cross-validate eval-gate.yaml (plan §3.3 + honesty rule: `require-improvement-on` is only legal with ≥1 live task). */
export function loadGate(filePath: string, corpus: readonly TaskDescriptor[]): GateConfig {
  const raw = load(readFileSync(filePath, 'utf8'))
  const result = gateConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(`invalid gate config ${filePath}: ${
      result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const gate = result.data
  if (gate['require-improvement-on'] !== undefined && !corpus.some(t => t.kind === 'live')) {
    throw new Error(`invalid gate config ${filePath}: require-improvement-on requires at least one kind:live task in the corpus`)
  }
  return gate
}

/** Load and zod-validate the committed baseline vector blob. Throws if the file is absent. */
export function loadBaseline(filePath: string): BaselineBlob {
  if (!existsSync(filePath)) throw new Error(`baseline vector blob not found: ${filePath}`)
  const result = baselineBlobSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
  if (!result.success) {
    throw new Error(`invalid baseline blob ${filePath}: ${
      result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  return result.data
}

/** Machine-readable per-axis numeric diff (baseline → candidate) for tools. */
export function compareVectors(
  candidate: MetricVector,
  baseline?: MetricVector,
): Record<string, { before?: number | undefined; after?: number | undefined }> {
  const diff: Record<string, { before?: number | undefined; after?: number | undefined }> = {}
  const push = (key: string, before: number | undefined, after: number | undefined) => {
    if (before !== after) diff[key] = { before, after }
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
    push(`tokens.${key}`, baseline?.tokens[key], candidate.tokens[key])
  }
  push('costUsd', baseline?.costUsd, candidate.costUsd)
  const counterKeys = new Set([...Object.keys(candidate.counters), ...Object.keys(baseline?.counters ?? {})])
  for (const key of counterKeys) push(`counters.${key}`, baseline?.counters[key], candidate.counters[key])
  return diff
}

export interface TaskVerdict {
  task: string
  kind: string
  status: 'pass' | 'fail'
  detail: string
  axisDiff?: Record<string, { before?: number | undefined; after?: number | undefined }>
}

const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '=': (a, b) => a === b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
}

/** Evaluate a descriptor `counters.expect` entry like ">=1" against the candidate counter. */
function expectMet(expectation: string, actual: number | undefined): boolean {
  if (actual === undefined) return false
  for (const [op2, fn] of Object.entries(COMPARATORS)) {
    if (expectation.startsWith(op2)) return fn(actual, Number(expectation.slice(op2.length)))
  }
  return false
}

export function compareTask(opts: {
  descriptor: TaskDescriptor
  candidate: MetricVector
  baseline?: MetricVector
  gate: GateConfig
}): TaskVerdict {
  const { descriptor, candidate, baseline } = opts
  const verdict = (status: TaskVerdict['status'], detail: string, axisDiff?: TaskVerdict['axisDiff']): TaskVerdict =>
    ({ task: descriptor.id, kind: descriptor.kind, status, detail, ...(axisDiff && { axisDiff }) })

  if (descriptor.kind === 'replay') {
    if ('capability' in candidate) return verdict('fail', 'replay vectors must not carry a capability field')
    if (!baseline) return verdict('fail', `no baseline vector for task ${descriptor.id}`)
    const axisDiff = compareVectors(candidate, baseline)
    if (Object.keys(axisDiff).length > 0) {
      return verdict('fail', 'metric definitions changed or baseline stale: refresh the baseline in its own PR', axisDiff)
    }
    return verdict('pass', 'definition-stable')
  }

  if (descriptor.kind === 'mock-script') {
    if (candidate.capability?.ok !== true) return verdict('fail', 'capability regression')
    const axisDiff = compareVectors(candidate, baseline)
    for (const [key, expectation] of Object.entries(descriptor.counters?.expect ?? {})) {
      if (!expectMet(expectation, candidate.counters[key])) {
        return verdict('fail', `counter ${key} expected ${expectation}, got ${candidate.counters[key] ?? 'missing'}`, axisDiff)
      }
    }
    return verdict('pass', 'wiring assertions hold (token/cost axes reported, never gate mock tier)', axisDiff)
  }

  // live tier: v1 gate never evaluates live tasks mechanically (§3.2 — attached as PR evidence)
  return verdict('pass', 'live tier is not mechanically gated at v1')
}

export function runChecks(opts: {
  corpus: readonly TaskDescriptor[]
  candidateVectors: Record<string, MetricVector>
  baseline?: BaselineBlob
  gate: GateConfig
}): { verdicts: TaskVerdict[]; ok: boolean } {
  const verdicts = opts.corpus.map(descriptor => {
    const candidate = opts.candidateVectors[descriptor.id]
    if (!candidate) {
      return { task: descriptor.id, kind: descriptor.kind, status: 'fail' as const, detail: `no candidate vector for task ${descriptor.id}` }
    }
    return compareTask({
      descriptor,
      candidate,
      ...(opts.baseline?.vectors[descriptor.id] !== undefined
        ? { baseline: opts.baseline.vectors[descriptor.id] }
        : {}),
      gate: opts.gate,
    })
  })
  return { verdicts, ok: verdicts.every(v => v.status === 'pass') }
}
