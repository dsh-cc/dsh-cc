/**
 * Synthetic offline evaluation of the S1-04 memory-extraction decision gate
 * (design docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md
 * §"Release evaluation and rollback" and the eval row of the test table).
 *
 * This spec is the OFFLINE HALF of the release evaluation. It
 *
 * - validates `eval/extraction-golden.json` (240 synthetic windows: 100
 *   positives, 100 negatives, 40 deterministic-fallback cases);
 * - rebuilds every window through the REAL builder (`buildWindowFor`) and runs
 *   it through the REAL gate (`decideWindow`) with a fake, configurable
 *   decision runner — no model, no route, no network;
 * - proves the deterministic half only: every incomplete, over-budget and
 *   source-changed window falls back to extraction, and no fallback window is
 *   ever sent to the decision model;
 * - writes `eval/report-<ISO timestamp>.json` (per-window probability,
 *   expected label, actual action, audit, fallback, usage, wall time) and marks
 *   it `validForRelease: false`.
 *
 * A mock report is NEVER a releasable conclusion: the stub answers by class
 * (`stubPolicy` in the golden file), so it measures plumbing, never model
 * quality. An accuracy claim needs the real configured decision route and an
 * operator run; nothing here may populate the offline gates in eval/README.md.
 *
 * Run from the repo root:
 *   DSH_EXTRACTION_EVAL=1 pnpm vitest run packages/memory/memory-consolidation/tests/eval-extraction-systemone.spec.ts
 * Without `DSH_EXTRACTION_EVAL=1` the suite skips.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  BoundDecisionRunner,
  DecisionRequest,
  DecisionRouteIdentity,
  DecisionRun,
  DecisionScope,
  SystemOneAnswer,
} from '@dsh-cc/systemone'
import {
  DEFAULT_EXTRACTION_DECISION_SETTINGS,
  type ExtractionDecisionSettings,
} from '../src/extraction-settings.ts'
import type { ExtractionWindow, GateExtractReason, IndexSnapshot } from '../src/extraction-window.ts'
import { EXTRACTION_QUESTION_KEY } from '../src/extraction-gate.ts'
import { buildWindowFor, decideWindow, mintScope } from '../src/extraction-gate-runner.ts'
import { verifySkipCommit } from '../src/extraction-precommit.ts'

const PKG = join(import.meta.dirname, '..')
const GOLDEN_PATH = join(PKG, 'eval', 'extraction-golden.json')
const REPORT_DIR = join(PKG, 'eval')
const enabled = process.env.DSH_EXTRACTION_EVAL === '1'
const skipReason = enabled ? undefined : 'set DSH_EXTRACTION_EVAL=1 to run the extraction-gate golden evaluation'

/** What the stub answers for a window, derived from its class only. */
const STUB_POLICY = { positive: 0.9, negative: 0.02, fallback: 0.02, sourceChangedRetry: 0.9 }
/** The probability a report is produced with; part of the invalid-for-release stamp. */
const STUB_SKIP_THRESHOLD = 0.05

/** The three fallback kinds a window defect can force. */
type FallbackKind = 'incomplete' | 'over-budget' | 'source-changed'

interface GoldenEvent { seq: number; kind: 'user' | 'assistant' | 'tool'; text: string; isError?: boolean }
interface GoldenWindow { fromExclusive: number; throughInclusive: number; existingIndex: string; events: GoldenEvent[] }

interface GoldenDefect {
  kind: 'image-block' | 'missing-seq' | 'compacted-range' | 'index-failed' | 'index-truncated' | 'over-budget' | 'source-changed'
  budgets?: Partial<ExtractionDecisionSettings>
}

interface GoldenCase {
  id: string
  class: 'positive' | 'negative' | 'fallback'
  subclass: string
  window: GoldenWindow
  defect?: GoldenDefect
  expected: { label: 'extract' | 'skip' | 'fallback-extract'; factClass?: string; fallback?: FallbackKind; reason?: FallbackKind }
}

interface GoldenFile { schemaVersion: number; description: string; labelDefinition: string; stubPolicy: string; cases: GoldenCase[] }

/** One reported window. `probability` is the stub's answer, never a model's. */
interface CaseReport {
  id: string
  class: GoldenCase['class']
  subclass: string
  expectedLabel: GoldenCase['expected']['label']
  expectedFactClass: string | null
  expectedReason: string | null
  probability: number | null
  action: 'extract' | 'skip'
  reason: GateExtractReason | 'source-changed' | null
  audit: boolean
  fallback: FallbackKind | null
  decisionAsked: boolean
  discardedSkips: number
  usage: { input_tokens: number; output_tokens: number } | null
  wallMs: number
}

interface EvalReport {
  schemaVersion: 1
  generatedAt: string
  goldenFile: string
  harness: {
    kind: 'mock'
    stubPolicy: string
    stubProbabilities: typeof STUB_POLICY
    skipProbability: number
    auditEveryNSkips: number
    routeAlias: string
    identity: DecisionRouteIdentity
  }
  releaseConclusion: 'invalid-for-release'
  validForRelease: false
  summary: {
    cases: number
    positives: number
    negatives: number
    fallbacks: number
    decisionsAsked: number
    skips: number
    extracts: number
    audits: number
    discardedSkips: number
    fallbacksByKind: Record<FallbackKind, number>
  }
  cases: CaseReport[]
}

/** One surface event from the golden window, with the case's defect applied. */
function toSessionEvent(event: GoldenEvent, index: number, defect?: GoldenDefect): SessionEvent {
  const seq = defect?.kind === 'missing-seq' && index > 0 ? undefined : event.seq
  const base = { seq, time: 0, surfaceOp: 'append' }
  switch (event.kind) {
    case 'user': {
      const content: unknown[] = [{ type: 'text', text: event.text }]
      // A user message with a non-text block is not reconstructable as text.
      if (defect?.kind === 'image-block' && index === 0) content.push({ type: 'image', source: { kind: 'file', path: 'synthetic.png' } })
      return { ...base, type: 'user/message', data: { id: `synthetic-user-${index}`, role: 'user', content, source: { kind: 'user' } } } as unknown as SessionEvent
    }
    case 'assistant':
      return {
        ...base,
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { id: `synthetic-assistant-${index}`, role: 'assistant', content: [{ type: 'text', text: event.text }], source: { kind: 'model', provider: 'stub', model: 'stub' } }, stream: [] },
      } as unknown as SessionEvent
    case 'tool':
      return {
        ...base,
        type: 'tool/result',
        data: { message: { content: [{ type: 'text', text: event.text }], isError: event.isError === true } },
      } as unknown as SessionEvent
  }
}

/** The events one case reviews, plus a compaction replacement when the defect asks for one. */
function eventsOf(golden: GoldenCase): SessionEvent[] {
  const events = golden.window.events.map((event, index) => toSessionEvent(event, index, golden.defect))
  if (golden.defect?.kind === 'compacted-range') {
    const head = golden.window.throughInclusive
    events.push({
      type: 'assistant/message',
      seq: head + 1,
      time: 0,
      surfaceOp: { op: 'replace', startSeq: golden.window.events[0]!.seq, endSeq: head },
      data: { turn: 1, step: 1, message: { id: 'synthetic-summary', role: 'assistant', content: [{ type: 'text', text: 'Synthetic compaction summary (never evidence).' }] }, stream: [] },
    } as unknown as SessionEvent)
  }
  return events
}

/** A synthetic topic index, or the defect's unreadable / over-cap variant. */
function indexOf(golden: GoldenCase): IndexSnapshot {
  switch (golden.defect?.kind) {
    case 'index-failed':
      return { kind: 'failed' }
    case 'index-truncated':
      // 205 synthetic lines exceed the 200-line injection cap ⇒ never reviewed.
      return { kind: 'text', text: Array.from({ length: 205 }, (_, i) => `- synthetic-topic-${i}.md: synthetic index line ${i}`).join('\n') }
    default:
      return golden.window.existingIndex === '' ? { kind: 'absent' } : { kind: 'text', text: golden.window.existingIndex }
  }
}

/** The effective settings of one case: shipped defaults, active mode, defect budgets. */
function settingsOf(golden: GoldenCase): ExtractionDecisionSettings {
  return {
    ...DEFAULT_EXTRACTION_DECISION_SETTINGS,
    mode: 'active',
    ...golden.defect?.budgets,
  }
}

/** A synthetic Agent whose session holds exactly the case's events. */
function fakeAgent(events: SessionEvent[], sessionId: string): Parameters<typeof buildWindowFor>[0]['agent'] {
  return {
    options: {},
    session: { id: sessionId, events, header: { id: sessionId, cwd: '/synthetic/workspace' }, snapshotEvents: () => events },
  } as never
}

const IDENTITY: DecisionRouteIdentity = {
  provider: 'stub-provider',
  model: 'stub-model',
  revision: 'stub-revision-1',
  perRequestTokens: 4000,
  perQuestionTokens: 1000,
  maxQuestions: 4,
  maxOutputTokens: 500,
}

interface StubRunner {
  readonly runner: BoundDecisionRunner
  readonly requests: DecisionRequest[]
  readonly answered: number[]
  setProbability(probability: number): void
}

/** A fake, configurable bound runner: one answered noul per request, no retries. */
function stubRunner(probability: number): StubRunner {
  const requests: DecisionRequest[] = []
  const answered: number[] = []
  let current = probability
  const scope = (originSeq?: number): DecisionScope => ({
    projectKey: 'a'.repeat(64),
    sessionId: 'synthetic-session',
    agentId: 'synthetic-agent',
    originSeq: originSeq ?? -1,
  })
  const runner: BoundDecisionRunner = {
    identifyRoute: () => IDENTITY,
    scope,
    run: async (request): Promise<DecisionRun> => {
      requests.push(request)
      answered.push(current)
      return {
        status: 'answered',
        answers: { [EXTRACTION_QUESTION_KEY]: { type: 'noul', noul: current } as SystemOneAnswer },
        model: IDENTITY.model,
        usage: { input_tokens: 900, output_tokens: 12 },
        decisionId: `synthetic-decision-${requests.length}`,
        inputHash: `synthetic-input-${requests.length}`,
      }
    },
  }
  return { runner, requests, answered, setProbability: (next) => { current = next } }
}

/** The probability the stub answers for one case, plus the follow-up ask when needed. */
function stubProbabilityOf(golden: GoldenCase): number {
  if (golden.defect?.kind === 'source-changed') return STUB_POLICY.negative
  return golden.class === 'positive' ? STUB_POLICY.positive : STUB_POLICY.negative
}

/**
 * Run one golden window through the production builder and the production gate
 * and describe the outcome. Deterministic fallbacks (incomplete, over-budget)
 * never reach the runner; a source-changed window answers skip, fails the
 * pre-commit check and is re-reviewed (and extracted) on the next stop.
 */
async function runCase(golden: GoldenCase, skipOrdinal: { value: number }): Promise<CaseReport> {
  const started = performance.now()
  const settings = settingsOf(golden)
  const events = eventsOf(golden)
  const agent = fakeAgent(events, `synthetic-${golden.id}`)
  const signal = new AbortController().signal
  const index = indexOf(golden)
  const stub = stubRunner(stubProbabilityOf(golden))
  const through = golden.window.throughInclusive
  const window: ExtractionWindow = buildWindowFor({ agent, from: golden.window.fromExclusive, through, index, settings })
  const report: CaseReport = {
    id: golden.id,
    class: golden.class,
    subclass: golden.subclass,
    expectedLabel: golden.expected.label,
    expectedFactClass: golden.expected.factClass ?? null,
    expectedReason: golden.expected.reason ?? null,
    probability: null,
    action: 'extract',
    reason: null,
    audit: false,
    fallback: null,
    decisionAsked: false,
    discardedSkips: 0,
    usage: null,
    wallMs: 0,
  }

  if (golden.defect?.kind === 'source-changed') {
    // Ask once: the window looks skippable. Then the session moves before the
    // commit, so `verifySkipCommit` must discard the verdict (design §"State
    // machine and commit rules").
    const outcome = await decideWindow({ agent, window, through, signal, resolveRunner: () => stub.runner, readSettings: () => settings })
    expect(outcome.verdict.kind, `${golden.id}: the source-changed window must first answer skip`).toBe('skip')
    report.probability = stub.answered[0] ?? null
    report.decisionAsked = true
    report.usage = { input_tokens: 900, output_tokens: 12 }
    const preCommit = await verifySkipCommit({
      capture: { window, runner: outcome.runner, scope: outcome.scope, through },
      isCurrent: () => true,
      readMode: () => settings.mode,
      evidenceHead: () => through + 2,
      readIndex: async () => ({ snapshot: index, promptIndex: golden.window.existingIndex }),
      rebuild: (snapshot) => buildWindowFor({ agent, from: golden.window.fromExclusive, through: through + 2, index: snapshot, settings }),
      mintScope,
    })
    expect(preCommit, `${golden.id}: a moved evidence head must discard the skip`).toBe('discard')
    report.discardedSkips = 1
    // The next stop reviews every unreviewed event: the extraction opportunity
    // survives the discarded verdict.
    events.push(
      toSessionEvent({ seq: through + 1, kind: 'user', text: 'Synthetic follow-up turn (head advanced).' }, 1),
      toSessionEvent({ seq: through + 2, kind: 'user', text: 'Synthetic follow-up turn (head advanced again).' }, 3),
    )
    stub.setProbability(STUB_POLICY.sourceChangedRetry)
    const retry = await decideWindow({ agent, window: buildWindowFor({ agent, from: golden.window.fromExclusive, through: through + 2, index, settings }), through: through + 2, signal, resolveRunner: () => stub.runner, readSettings: () => settings })
    expect(retry.verdict.kind, `${golden.id}: the re-review must extract`).toBe('extract')
    report.action = 'extract'
    report.reason = 'source-changed'
    report.fallback = 'source-changed'
    report.wallMs = Math.max(0, performance.now() - started)
    return report
  }

  const outcome = await decideWindow({ agent, window, through, signal, resolveRunner: () => stub.runner, readSettings: () => settings })
  report.reason = outcome.verdict.kind === 'extract' ? outcome.verdict.reason : null
  if (outcome.verdict.kind === 'skip') {
    report.probability = outcome.verdict.probability
    report.decisionAsked = true
  } else if (stub.requests.length > 0) {
    report.probability = stub.answered[0] ?? null
    report.decisionAsked = true
  }
  if (report.decisionAsked) report.usage = { input_tokens: 900, output_tokens: 12 }

  if (outcome.verdict.kind === 'skip') {
    // Coordinator skip-audit rule, mirrored for reporting only: the ordinal
    // increments first and every Nth eligible skip extracts (design §"State
    // machine and commit rules"). The gate itself never audits.
    skipOrdinal.value += 1
    const audit = skipOrdinal.value % settings.auditEveryNSkips === 0
    report.audit = audit
    report.action = audit ? 'extract' : 'skip'
    if (audit) report.reason = 'audit'
  } else if (outcome.verdict.kind === 'extract') {
    report.action = 'extract'
    report.fallback = outcome.verdict.reason === 'incomplete' || outcome.verdict.reason === 'over-budget'
      ? outcome.verdict.reason
      : null
  }
  if (golden.class === 'fallback') {
    // `reason` stays the verdict's own reason (the deterministic fallback label),
    // so the assertions below compare real gate output, not an annotation.
    report.fallback = golden.expected.fallback ?? report.fallback
    report.audit = false
    report.action = 'extract'
  }
  report.wallMs = Math.max(0, performance.now() - started)
  return report
}

describe('extraction-gate golden evaluation (env-gated)', () => {
  it.skipIf(skipReason !== undefined)(`validates the golden set and emits a mock report${skipReason ? ` — SKIPPED: ${skipReason}` : ''}`, async () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile

    // ---- the golden set itself (construction invariants from eval/README.md).
    expect(golden.schemaVersion).toBe(1)
    expect(golden.labelDefinition.length).toBeGreaterThan(80)
    expect(golden.cases).toHaveLength(240)
    const byClass = (cls: GoldenCase['class']) => golden.cases.filter((c) => c.class === cls)
    expect(byClass('positive')).toHaveLength(100)
    expect(byClass('negative')).toHaveLength(100)
    expect(byClass('fallback')).toHaveLength(40)
    const subclassCounts = (cls: GoldenCase['class']) => {
      const counts = new Map<string, number>()
      for (const c of byClass(cls)) counts.set(c.subclass, (counts.get(c.subclass) ?? 0) + 1)
      return counts
    }
    const positives = subclassCounts('positive')
    for (const required of ['user-preference', 'explicit-correction', 'project-constraint', 'tool-trap', 'cross-message-confirmation']) {
      expect(positives.get(required) ?? 0, `positive subclass ${required} needs at least 20 windows`).toBeGreaterThanOrEqual(20)
    }
    const negatives = subclassCounts('negative')
    for (const required of ['progress-only', 'duplicate-index-entry', 'tool-noise', 'unconfirmed-assistant-guess']) {
      expect(negatives.get(required) ?? 0, `negative subclass ${required} needs at least 20 windows`).toBeGreaterThanOrEqual(20)
    }
    expect(subclassCounts('fallback')).toEqual(new Map([['incomplete-window', 15], ['over-budget', 15], ['source-changed', 10]]))
    expect(new Set(golden.cases.map((c) => c.id)).size).toBe(240)
    for (const c of golden.cases) {
      expect(c.window.events.length, `${c.id} needs at least one event`).toBeGreaterThan(0)
      expect(c.window.events.at(-1)!.seq).toBe(c.window.throughInclusive)
      expect(c.window.events[0]!.seq).toBeGreaterThan(c.window.fromExclusive)
      for (const event of c.window.events) {
        // Synthetic-only guard: no real home directories or user paths in the data.
        expect(event.text, `${c.id} carries a real-looking path`).not.toMatch(/\/Users\/|\/home\/|\/private\/tmp\/|\.config\/dsh/)
      }
      if (c.class === 'positive') {
        expect(c.expected.label).toBe('extract')
        expect(c.expected.factClass, `${c.id} needs a durable fact class`).toBeTruthy()
      } else if (c.class === 'negative') {
        expect(c.expected.label).toBe('skip')
      } else {
        expect(c.expected.label).toBe('fallback-extract')
        expect(c.defect, `${c.id} needs a defect`).toBeTruthy()
        expect(c.expected.fallback).toBe(c.expected.reason)
      }
    }

    // ---- run every window through the real builder + real gate, stub runner.
    const skipOrdinal = { value: 0 }
    const cases: CaseReport[] = []
    for (const c of golden.cases) cases.push(await runCase(c, skipOrdinal))

    const fallbackCount = (kind: FallbackKind) => cases.filter((c) => c.fallback === kind).length
    const report: EvalReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      goldenFile: 'eval/extraction-golden.json',
      harness: {
        kind: 'mock',
        stubPolicy: golden.stubPolicy,
        stubProbabilities: STUB_POLICY,
        skipProbability: STUB_SKIP_THRESHOLD,
        auditEveryNSkips: DEFAULT_EXTRACTION_DECISION_SETTINGS.auditEveryNSkips,
        routeAlias: DEFAULT_EXTRACTION_DECISION_SETTINGS.routeAlias,
        identity: IDENTITY,
      },
      releaseConclusion: 'invalid-for-release',
      validForRelease: false,
      summary: {
        cases: cases.length,
        positives: cases.filter((c) => c.class === 'positive').length,
        negatives: cases.filter((c) => c.class === 'negative').length,
        fallbacks: cases.filter((c) => c.class === 'fallback').length,
        decisionsAsked: cases.filter((c) => c.decisionAsked).length,
        skips: cases.filter((c) => c.action === 'skip').length,
        extracts: cases.filter((c) => c.action === 'extract').length,
        audits: cases.filter((c) => c.audit).length,
        discardedSkips: cases.reduce((sum, c) => sum + c.discardedSkips, 0),
        fallbacksByKind: { incomplete: fallbackCount('incomplete'), 'over-budget': fallbackCount('over-budget'), 'source-changed': fallbackCount('source-changed') },
      },
      cases,
    }

    // ---- report schema (the only shape a future operator run must match).
    expect(Object.keys(report).sort()).toEqual(['cases', 'generatedAt', 'goldenFile', 'harness', 'releaseConclusion', 'schemaVersion', 'summary', 'validForRelease'])
    expect(report.releaseConclusion).toBe('invalid-for-release')
    expect(report.validForRelease).toBe(false)
    expect(report.summary.cases).toBe(golden.cases.length)
    expect(report.summary.fallbacksByKind).toEqual({ incomplete: 15, 'over-budget': 15, 'source-changed': 10 })
    expect(report.cases).toHaveLength(240)
    for (const entry of report.cases) {
      expect(Object.keys(entry).sort()).toEqual([
        'action', 'audit', 'class', 'decisionAsked', 'discardedSkips', 'expectedFactClass', 'expectedLabel',
        'expectedReason', 'fallback', 'id', 'probability', 'reason', 'subclass', 'usage', 'wallMs',
      ])
      expect(['extract', 'skip']).toContain(entry.action)
      expect(Number.isFinite(entry.wallMs) && entry.wallMs >= 0).toBe(true)
      if (!entry.decisionAsked) {
        expect(entry.probability).toBeNull()
        expect(entry.usage).toBeNull()
      }
    }

    // ---- the deterministic half: every fallback window extracts, never skips,
    // and an incomplete/over-budget window is never sent to the decision model.
    for (const entry of report.cases.filter((c) => c.class === 'fallback')) {
      expect(entry.action, `${entry.id} must fall back to extraction`).toBe('extract')
      expect(entry.fallback, `${entry.id} fallback kind`).toBe(entry.expectedReason)
      expect(entry.reason, `${entry.id} fallback reason`).toBe(entry.expectedReason)
      if (entry.fallback === 'source-changed') {
        expect(entry.discardedSkips, `${entry.id} must discard the stale skip`).toBe(1)
        expect(entry.decisionAsked, `${entry.id} re-reviews after the change`).toBe(true)
      } else {
        expect(entry.decisionAsked, `${entry.id} must not reach the decision model`).toBe(false)
      }
    }
    // No decision request may originate from an incomplete/over-budget window:
    // `probability` stays null exactly for those windows.
    expect(report.cases.filter((c) => c.class === 'fallback' && c.fallback !== 'source-changed' && c.probability === null)).toHaveLength(30)

    // ---- publish the artifact (never a release conclusion).
    mkdirSync(REPORT_DIR, { recursive: true })
    const out = join(REPORT_DIR, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    console.warn(`S1-04 extraction eval mock report written: ${out} (invalid-for-release)`)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ validForRelease: false, schemaVersion: 1 })
  })
})
