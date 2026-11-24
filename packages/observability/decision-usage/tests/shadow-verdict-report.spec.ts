/**
 * Report-script unit tests (design
 * docs/plans/2026-11-25-systemone-shadow-verdict-ledger.md §"Verification"):
 * Wilson LCB references against the imported helper (42/60 → 0.5958 FAILS,
 * 43/60 → 0.6132 the smallest passing k, 40/60 → 0.5613), gate booleans
 * faithful to every pre-registered conjunct, the two Node-verified
 * regression fixtures (50-complete + 50-timeout → rate 0.50, omitted pool
 * fields non-complete), the mixed-ceiling counterexample failing under the
 * minimum-ceiling rule, and rotation dedup on eventId. All legs run in
 * tmpdirs.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { wilsonLowerBound } from '../../../core/tool-search/scripts/lib/eval-metrics.mjs'
import {
  DISCOVERY_MIN_DISAGREEMENTS,
  evaluateDiscoveryGate,
  evaluateExtractionGate,
  evaluateSkillrecGate,
  isCoverageComplete,
  percentile,
  runReport,
} from '../scripts/shadow-verdict-report.mjs'
import { SHADOW_VERDICTS_FILE_NAME, SHADOW_VERDICTS_ROTATED_NAME } from '../src/shadow-verdicts.ts'

/** Write one verdict row (the writer's exact serialization shape). */
function verdictRow(eventId: string, feature: string, mode: string, payload: Record<string, unknown>, decisionIds: string[] = []): string {
  return JSON.stringify({ schemaVersion: 1, eventId, time: 1795486845000, feature, mode, decisionIds, payload })
}

/** A session directory fixture: project `p`, session `s`. */
async function sessionDir(home: string, projectKey = 'p', sessionId = 's'): Promise<string> {
  const dir = join(home, 'decision-usage', projectKey, sessionId)
  await mkdir(dir, { recursive: true })
  return dir
}

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'shadow-verdict-report-'))
}

const extractionPayload = { verdict: 'would-skip', probability: 0.05, skipThreshold: 0.15, fromExclusive: 1, throughInclusive: 9, surfaceEvents: 5, stateBytes: 100 }
const discoveryPayload = { queryHash8: 'a1b2c3d4e5f60708', suggested: ['Bash'], lexical: ['Grep'], differing: true, suggestedOnly: 1, lexicalOnly: 1, candidatesJudged: 4, originSeq: 7 }

describe('wilson references (the imported helper, one-sided z=1.645)', () => {
  it('42/60 → 0.5958 (FAILS the 0.60 line)', () => {
    expect(wilsonLowerBound(42, 60)).toBeCloseTo(0.5957822363291218, 6)
    expect(wilsonLowerBound(42, 60)!).toBeLessThan(0.60)
  })

  it('43/60 → 0.6132 (the smallest passing k)', () => {
    expect(wilsonLowerBound(43, 60)).toBeCloseTo(0.6132415626527694, 6)
    expect(wilsonLowerBound(43, 60)!).toBeGreaterThanOrEqual(0.60)
  })

  it('40/60 → 0.5613', () => {
    expect(wilsonLowerBound(40, 60)).toBeCloseTo(0.5612829631303803, 6)
  })
})

describe('isCoverageComplete (the undefined === undefined hole is closed)', () => {
  it('a complete shadow row', () => {
    expect(isCoverageComplete({ status: 'shadow', judged: 96, eligible: 96 })).toBe(true)
  })

  it('omitted pool fields are non-complete', () => {
    expect(isCoverageComplete({ status: 'unavailable', failureClass: 'timeout' })).toBe(false)
    expect(isCoverageComplete({ status: 'shadow' })).toBe(false)
  })

  it('judged < eligible is non-complete; unavailable status is non-complete', () => {
    expect(isCoverageComplete({ status: 'shadow', judged: 90, eligible: 128 })).toBe(false)
    expect(isCoverageComplete({ status: 'unavailable', judged: 96, eligible: 96 })).toBe(false)
  })
})

describe('extraction gate (doc 04 §303 conjuncts)', () => {
  it('fails on count alone even at n=200 with an unchecked would-skip', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    for (let i = 0; i < 200; i += 1) {
      rows.push(verdictRow(`e-${i}`, 'memory-extraction', 'shadow', { ...extractionPayload, verdict: 'extract-positive' }))
    }
    rows.push(verdictRow('e-would-skip', 'memory-extraction', 'shadow', extractionPayload))
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    const extraction = gates.find(g => g.gate === 'extraction-windows')!
    expect(extraction.pass).toBe(false)
    expect(extraction.detail).toContain('wouldSkip=1 checked=0')
  })

  it('passes when every would-skip is labeled checked', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    for (let i = 0; i < 100; i += 1) {
      rows.push(verdictRow(`e-${i}`, 'memory-extraction', 'shadow', { ...extractionPayload, verdict: i < 5 ? 'would-skip' : 'extract-positive' }))
    }
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    await writeFile(join(home, 'extraction-labels.jsonl'), [0, 1, 2, 3, 4].map(i => JSON.stringify({ eventId: `e-${i}`, checked: true })).join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    expect(gates.find(g => g.gate === 'extraction-windows')!.pass).toBe(true)
  })

  it('counts shadow rows only (active rows excluded from the soak)', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    for (let i = 0; i < 150; i += 1) {
      rows.push(verdictRow(`a-${i}`, 'memory-extraction', 'active', { ...extractionPayload, verdict: 'extract-positive' }))
    }
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    expect(gates.find(g => g.gate === 'extraction-windows')!.detail).toContain('n=0')
  })
})

describe('discovery gate (activation plan §77 conjuncts)', () => {
  it('fails while disagreements are unlabeled even at 60+ differing', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    for (let i = 0; i < DISCOVERY_MIN_DISAGREEMENTS + 5; i += 1) {
      rows.push(verdictRow(`d-${i}`, 'tool-discovery', 'shadow', discoveryPayload, [`dec-${i}`]))
    }
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    const discovery = gates.find(g => g.gate === 'discovery-disagreements')!
    expect(discovery.pass).toBe(false)
    expect(discovery.detail).toContain(`labeled=0`)
  })

  it('passes at 60 labeled with 60 correct (lcb = 1.0 ≥ 0.60)', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    const labels: string[] = []
    for (let i = 0; i < DISCOVERY_MIN_DISAGREEMENTS; i += 1) {
      rows.push(verdictRow(`d-${i}`, 'tool-discovery', 'shadow', discoveryPayload))
      labels.push(JSON.stringify({ eventId: `d-${i}`, judgeCorrect: true }))
    }
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    await writeFile(join(home, 'discovery-labels.jsonl'), labels.join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    expect(gates.find(g => g.gate === 'discovery-disagreements')!.pass).toBe(true)
  })
})

describe('skillrec gate (capacity revision conjuncts)', () => {
  it('the 50-complete + 50-timeout fixture reads rate 0.50, not 1.0', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    for (let i = 0; i < 50; i += 1) {
      rows.push(verdictRow(`c-${i}`, 'skill-recommendation', 'shadow', { status: 'shadow', judged: 96, eligible: 96, recommended: [], requestLatencyMs: 100, requestTimeoutMs: 5000 }))
      rows.push(verdictRow(`t-${i}`, 'skill-recommendation', 'shadow', { status: 'unavailable', failureClass: 'timeout', requestLatencyMs: 5000, requestTimeoutMs: 5000 }))
    }
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    const skillrec = gates.find(g => g.gate === 'skillrec-requests')!
    expect(skillrec.detail).toContain('coverage-complete=0.5000')
    expect(skillrec.pass).toBe(false)
  })

  it('a non-timeout unavailable row fails the remainder conjunct', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    for (let i = 0; i < 100; i += 1) {
      rows.push(verdictRow(`c-${i}`, 'skill-recommendation', 'shadow', { status: 'shadow', judged: 96, eligible: 96, recommended: [], requestLatencyMs: 100, requestTimeoutMs: 5000 }))
    }
    rows.push(verdictRow('e-1', 'skill-recommendation', 'shadow', { status: 'unavailable', failureClass: 'error', requestLatencyMs: 50, requestTimeoutMs: 5000 }))
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    const skillrec = gates.find(g => g.gate === 'skillrec-requests')!
    expect(skillrec.detail).toContain('nonCompleteAllTimeout=false')
    expect(skillrec.pass).toBe(false)
  })

  it('the mixed-ceiling counterexample FAILS under the minimum-ceiling rule (passes under max)', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    for (let i = 0; i < 94; i += 1) {
      rows.push(verdictRow(`a-${i}`, 'skill-recommendation', 'shadow', { status: 'shadow', judged: 1, eligible: 1, recommended: [], requestLatencyMs: 2500, requestTimeoutMs: 2000 }))
    }
    for (let i = 0; i < 6; i += 1) {
      rows.push(verdictRow(`b-${i}`, 'skill-recommendation', 'shadow', { status: 'shadow', judged: 1, eligible: 1, recommended: [], requestLatencyMs: 3000, requestTimeoutMs: 10000 }))
    }
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    const skillrec = gates.find(g => g.gate === 'skillrec-requests')!
    // p95 of the latency population is 3000; the minimum ceiling is 2000 → FAIL.
    expect(skillrec.detail).toContain('p95=3000ms ceiling(min)=2000ms')
    expect(skillrec.pass).toBe(false)
  })

  it('a healthy population passes', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const rows: string[] = []
    for (let i = 0; i < 100; i += 1) {
      rows.push(verdictRow(`h-${i}`, 'skill-recommendation', 'shadow', { status: 'shadow', judged: 96, eligible: 96, recommended: ['x'], requestLatencyMs: 400, requestTimeoutMs: 5000 }))
    }
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), rows.join('\n') + '\n', 'utf8')
    const gates = await runReport(home)
    expect(gates.find(g => g.gate === 'skillrec-requests')!.pass).toBe(true)
  })
})

describe('rotation dedup', () => {
  it('a row appearing in both generations counts once', async () => {
    const home = await tempHome()
    const dir = await sessionDir(home)
    const shared = verdictRow('dup-1', 'tool-discovery', 'shadow', discoveryPayload)
    const current = verdictRow('cur-1', 'tool-discovery', 'shadow', { ...discoveryPayload, differing: false })
    await writeFile(join(dir, SHADOW_VERDICTS_ROTATED_NAME), shared + '\n', 'utf8')
    await writeFile(join(dir, SHADOW_VERDICTS_FILE_NAME), shared + '\n' + current + '\n', 'utf8')
    const gates = await runReport(home)
    const discovery = gates.find(g => g.gate === 'discovery-disagreements')!
    // judgments=2 (dup-1 + cur-1), differing=1 (dup-1).
    expect(discovery.detail).toContain('judgments=2 differing=1')
  })
})

describe('percentile', () => {
  it('nearest-rank p95', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 95)).toBe(95)
    expect(percentile([1, 2, 3, 4], 50)).toBe(2)
  })
})
