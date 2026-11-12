/**
 * Specs for the tool-discovery activation eval arms
 * (`docs/plans/2026-11-12-tool-discovery-activation.md` § "Runner",
 * § "Scoring"; `scripts/eval-discovery.mjs` and its `scripts/lib/` modules).
 *
 * Pinned here:
 *  - the v2 corpus schema: the class dimension, the class floors, the
 *    `negative-only` subset coupling and the exact-name-query refusal — plus the
 *    privacy rule (a message names the case id and the field path, never text);
 *  - the deterministic non-oracle stub judge: same input, same answers, and an
 *    answer envelope the production `expectedScore` can read;
 *  - every `live`-arm outcome mapping, driven through the production
 *    `createDiscoveryRuntime` with a scripted fake lane (runner refusal,
 *    cancellation, shared-deadline exhaustion, over-cap pool, exact-name
 *    short-circuit in both modes);
 *  - the CLI's three scored arms over a generated 60-case corpus.
 *
 * All corpus content below is synthetic: no real query, tool name or path.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { CLASSES, REQUIRED_CLASS_COUNTS, validateCorpus } from '../scripts/lib/eval-corpus.mjs'
import { stubAnswers } from '../scripts/lib/judge-stub.mjs'
import { DiscoveryCache } from '../src/discovery-cache.ts'
import { createDiscoveryRuntime } from '../src/discovery-runtime.ts'
import { DEFAULT_DISCOVERY_SETTINGS } from '../src/discovery-settings.ts'
import type { DiscoveryDecisionRequest, DiscoveryDecisionRun, DiscoveryRunner } from '../src/discovery-runtime.ts'
import type { DeferredEntry, DiscoveryRouteIdentity, DiscoverySettings } from '../src/discovery.ts'
import type { DiscoveryScope } from '../src/discovery-contract.ts'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(packageDir, 'scripts', 'eval-discovery.mjs')
const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// A generated corpus: 12 cases per class, all subset floors satisfied
// ---------------------------------------------------------------------------

/** Subsets cycled over the classes that need a target set. */
const TARGET_SUBSETS = ['chinese', 'synonym', 'restricted']

/** One generated case: unique id, unique candidate names, fixed shape. */
function syntheticCase(label: string, index: number) {
  const classIndex = CLASSES.indexOf(label)
  const subset = label === 'negative-only' ? 'none' : TARGET_SUBSETS[(classIndex + index) % TARGET_SUBSETS.length]
  const goldName = `synth_target_${classIndex}_${index}`
  return {
    id: `synth-${label}-${index}`,
    subset,
    class: label,
    query: `synthetic intent ${classIndex} number ${index}`,
    candidates: [
      { name: goldName, description: `Synthetic capability ${classIndex} ${index}.`, searchHint: 'synthetic', lexicalScore: 0 },
      { name: `synth_filler_${classIndex}_${index}`, description: 'Synthetic unrelated capability.', lexicalScore: 0 },
      { name: `synth_denied_${classIndex}_${index}`, description: 'Synthetic denied capability.', lexicalScore: 1, admitted: false },
    ],
    expectedNames: label === 'negative-only' ? [] : [goldName],
  }
}

/** A schema-valid corpus with `perClass` cases in every class. */
function syntheticCorpus(perClass = REQUIRED_CLASS_COUNTS['direct-fit']) {
  return {
    schemaVersion: 2,
    corpusVersion: 1,
    description: 'Synthetic corpus for the eval-arm specs.',
    cases: CLASSES.flatMap(label => Array.from({ length: perClass }, (_, index) => syntheticCase(label, index))),
  }
}

/** Every error message `validateCorpus` reports for one document. */
const errorsOf = (document: unknown): string[] => validateCorpus(document).errors

// ---------------------------------------------------------------------------
// validateCorpus — the v2 schema
// ---------------------------------------------------------------------------

describe('validateCorpus', () => {
  it('accepts a 60-case corpus with 12 cases in every class', () => {
    const corpus = syntheticCorpus()
    const result = validateCorpus(corpus)
    expect(result.errors).toEqual([])
    expect(result.floors).toEqual([])
    expect(result.cases).toHaveLength(60)
    for (const label of CLASSES) expect(result.counts[label]).toBe(12)
    expect(result.counts.chinese).toBeGreaterThanOrEqual(8)
    expect(result.counts.synonym).toBeGreaterThanOrEqual(6)
    expect(result.counts.none).toBeGreaterThanOrEqual(4)
    expect(result.counts.restricted).toBeGreaterThanOrEqual(2)
  })

  it('counts an alsoClasses membership toward that class floor', () => {
    const corpus = syntheticCorpus()
    // cases[0] is the first direct-fit case: declaring a second membership must
    // count toward keyword-stuffing without inflating direct-fit.
    corpus.cases[0] = { ...corpus.cases[0], alsoClasses: ['keyword-stuffing'] }
    const result = validateCorpus(corpus)
    expect(result.errors).toEqual([])
    expect(result.counts['direct-fit']).toBe(12)
    expect(result.counts['keyword-stuffing']).toBe(13)
  })

  it('rejects schemaVersion 1 and names the fix', () => {
    const corpus = { ...syntheticCorpus(), schemaVersion: 1 }
    const errors = errorsOf(corpus)
    expect(errors.some(message => message.includes('schemaVersion must be 2'))).toBe(true)
    expect(errors.some(message => message.includes('corpusVersion'))).toBe(true)
  })

  it('rejects a bare case array (the v1 layout) and a missing corpusVersion', () => {
    expect(errorsOf(syntheticCorpus().cases).some(message => message.includes('bare case array'))).toBe(true)
    const { corpusVersion: _dropped, ...withoutVersion } = syntheticCorpus()
    expect(errorsOf(withoutVersion).some(message => message.includes('corpusVersion must be an integer'))).toBe(true)
  })

  it('rejects a missing class and an unknown class label', () => {
    const missing = syntheticCorpus()
    delete (missing.cases[0] as { class?: string }).class
    expect(errorsOf(missing).some(message => message.includes('class must be one of'))).toBe(true)

    const unknown = syntheticCorpus()
    unknown.cases[0].class = 'made-up-class'
    expect(errorsOf(unknown).some(message => message.includes('class must be one of'))).toBe(true)
  })

  it('rejects alsoClasses that repeats the primary class or duplicates a label', () => {
    const repeats = syntheticCorpus()
    repeats.cases[0] = { ...repeats.cases[0], class: 'direct-fit', alsoClasses: ['direct-fit'] }
    expect(errorsOf(repeats).some(message => message.includes('must not repeat the primary class'))).toBe(true)

    const duplicates = syntheticCorpus()
    duplicates.cases[0] = { ...duplicates.cases[0], class: 'direct-fit', alsoClasses: ['multi-intent', 'multi-intent'] }
    expect(errorsOf(duplicates).some(message => message.includes('duplicate entry'))).toBe(true)
  })

  it('rejects a negative-only case outside the none subset', () => {
    const corpus = syntheticCorpus()
    corpus.cases[0] = { ...corpus.cases[0], class: 'negative-only', subset: 'chinese', expectedNames: [] }
    expect(errorsOf(corpus).some(message => message.includes('class negative-only requires subset none'))).toBe(true)
  })

  it('rejects a query that equals a candidate name', () => {
    const corpus = syntheticCorpus()
    corpus.cases[0] = { ...corpus.cases[0], query: corpus.cases[0].candidates[0].name }
    const errors = errorsOf(corpus)
    expect(errors.some(message => message.includes('must not equal candidates[0].name'))).toBe(true)
    // Privacy: the message names the field path, never the text.
    expect(errors.some(message => message.includes(corpus.cases[0].candidates[0].name))).toBe(false)
  })

  it('rejects a class below its 12-case floor and reports it as a floor deficit', () => {
    const corpus = syntheticCorpus()
    corpus.cases = corpus.cases.filter(entry => entry.id !== 'synth-direct-fit-0')
    const result = validateCorpus(corpus)
    expect(result.counts['direct-fit']).toBe(11)
    expect(result.floors).toHaveLength(1)
    expect(result.floors[0]).toContain('class direct-fit: 11 case(s)')
    // A floor deficit is also a schema error, so `selfcheck` cannot pass.
    expect(result.errors).toContain(result.floors[0])
  })
})

// ---------------------------------------------------------------------------
// stubAnswers — deterministic, non-oracle, production-shaped
// ---------------------------------------------------------------------------

/** One judged candidate as the pool hands it to `buildQuestions`. */
const stubCandidate = (id: string, name: string, description: string, searchHint?: string) =>
  ({ id, name, description, ...searchHint === undefined ? {} : { searchHint } })

const STUB_QUERY = 'extract the captions from the scanned pdf'

const STUB_CANDIDATES = [
  stubCandidate('c0', 'pdf_extractor', 'Extract headings, captions, and tables from a PDF.', 'pdf extract captions'),
  stubCandidate('c1', 'calendar_planner', 'Schedule meetings onto a team calendar.'),
  stubCandidate('c2', 'csv_summarizer', 'Average the numeric columns of a delimited file.'),
]

describe('stubAnswers', () => {
  it('is deterministic across two calls', () => {
    expect(stubAnswers(STUB_CANDIDATES, STUB_QUERY)).toEqual(stubAnswers(STUB_CANDIDATES, STUB_QUERY))
  })

  it('answers both questions for every candidate in a readable envelope', () => {
    const answers = stubAnswers(STUB_CANDIDATES, STUB_QUERY)
    expect(Object.keys(answers).sort()).toEqual(
      ['c0_direct', 'c0_relevance', 'c1_direct', 'c1_relevance', 'c2_direct', 'c2_relevance'],
    )
    for (const id of ['c0', 'c1', 'c2']) {
      const relevance = answers[`${id}_relevance`]
      expect(relevance.type).toBe('score')
      expect(relevance.confidence).toBe(1)
      expect(relevance.score).toBeGreaterThanOrEqual(0)
      expect(relevance.score).toBeLessThanOrEqual(4)
      const probabilities = Object.values(relevance.probabilities as Record<string, number>)
      expect(Object.keys(relevance.probabilities as Record<string, number>).sort()).toEqual(['0', '1', '2', '3', '4'])
      expect(probabilities.every(mass => Number.isFinite(mass) && mass >= 0)).toBe(true)
      expect(probabilities.reduce((sum, mass) => sum + mass, 0)).toBeCloseTo(1, 10)

      const direct = answers[`${id}_direct`]
      expect(direct.type).toBe('noul')
      expect(direct.noul).toBeGreaterThanOrEqual(0)
      expect(direct.noul).toBeLessThanOrEqual(1)
      expect(direct.confidence).toBe(1)
    }
  })

  it('scores a metadata match above an unrelated candidate, and never reads gold labels', () => {
    const answers = stubAnswers(STUB_CANDIDATES, STUB_QUERY)
    const matching = answers.c0_relevance
    const unrelated = answers.c1_relevance
    expect(matching.probabilities['4']).toBeGreaterThan(unrelated.probabilities['4'])
    expect(answers.c0_direct.noul).toBeGreaterThan(answers.c1_direct.noul)
    // The same candidates under a query with no shared content flatten out.
    const offTopic = stubAnswers(STUB_CANDIDATES, 'synthetic unaffected phrasing')
    expect(offTopic.c0_direct.noul).toBe(offTopic.c1_direct.noul)
  })

  it('bridges a Chinese query to English tool metadata', () => {
    const answers = stubAnswers(
      [
        stubCandidate('c0', 'text_translator', 'Translate paragraphs between natural languages.', 'translate language'),
        stubCandidate('c1', 'csv_summarizer', 'Average the numeric columns of a file.'),
      ],
      '把这段 JSON 说明翻译成英文',
    )
    expect(answers.c0_direct.noul).toBeGreaterThan(answers.c1_direct.noul)
    expect(answers.c0_relevance.probabilities['4']).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The live arm's outcome mappings, in-process
// ---------------------------------------------------------------------------

/** The design's § "Settings" table, with the mode under test. */
function settings(overrides: Partial<DiscoverySettings> = {}): DiscoverySettings {
  return { ...DEFAULT_DISCOVERY_SETTINGS, mode: 'active', ...overrides }
}

/** A deliberately wide route: nothing is window-limited here. */
const WIDE_ROUTE: DiscoveryRouteIdentity = {
  provider: 'gw',
  model: 'eval-model',
  revision: 'rev-1',
  perRequestTokens: 100_000,
  perQuestionTokens: 10_000,
  maxQuestions: 64,
  maxOutputTokens: 512,
}

const SCOPE: DiscoveryScope = { projectKey: 'proj', sessionId: 'sess', agentId: 'agent', originSeq: 1 }

/** One pool entry as the snapshot accessor hands it over. */
function entry(name: string, overrides: Partial<DeferredEntry> = {}): DeferredEntry {
  return {
    name,
    description: `${name} capability.`,
    alwaysLoad: false,
    activated: false,
    admitted: true,
    lexicalScore: 0,
    ...overrides,
  }
}

/** A scripted lane: the same three faces the runtime consumes. */
class ScriptedLane implements DiscoveryRunner {
  readonly requests: DiscoveryDecisionRequest[] = []

  behavior: 'answered' | 'unavailable' = 'answered'

  identifyRoute(): DiscoveryRouteIdentity {
    return WIDE_ROUTE
  }

  scope(): DiscoveryScope {
    return SCOPE
  }

  async run(request: DiscoveryDecisionRequest): Promise<DiscoveryDecisionRun> {
    this.requests.push(request)
    if (this.behavior === 'unavailable') return { status: 'unavailable', reason: 'timeout', decisionId: 'd1' }
    const state = request.state as { query: string; candidates: Array<{ id: string; name: string; description: string; searchHint?: string }> }
    return {
      status: 'answered',
      answers: stubAnswers(state.candidates, state.query) as never,
      decisionId: `d${this.requests.length}`,
    }
  }
}

/** A runtime over fixed entries, with a fresh in-memory cache. */
function runtime(options: {
  mode: 'shadow' | 'active'
  lane: ScriptedLane
  entries: readonly DeferredEntry[]
  now?: () => number
}) {
  return createDiscoveryRuntime({
    readSettings: () => settings({ mode: options.mode }),
    snapshotEntries: () => options.entries,
    resolveRunner: () => options.lane,
    cache: new DiscoveryCache({ maxEntries: 16, ttlMs: 60_000 }),
    ...options.now === undefined ? {} : { now: options.now },
  })
}

/** Replicated entries under unique names, for the bound scenarios. */
function replicated(total: number): DeferredEntry[] {
  return Array.from({ length: total }, (_, index) => entry(`capability_${index}`))
}

describe('the live arm outcome mappings', () => {
  it('maps a runner timeout onto a whole lexical fallback (unavailable)', async () => {
    const lane = new ScriptedLane()
    lane.behavior = 'unavailable'
    const evaluation = await runtime({ mode: 'active', lane, entries: replicated(3) })
      .evaluate({ query: 'capability zero', maxResults: 3, actor: {}, lexicalNames: [] })
    expect(evaluation).toEqual({ kind: 'lexical', reason: 'unavailable' })
    expect(lane.requests).toHaveLength(1)
  })

  it('maps shared-deadline exhaustion onto incomplete and starts no second batch', async () => {
    let ticks = 0
    const lane = new ScriptedLane()
    const evaluation = await runtime({
      mode: 'active',
      lane,
      entries: replicated(DEFAULT_DISCOVERY_SETTINGS.batchSize + 2),
      now: () => { ticks += 600; return ticks },
    }).evaluate({ query: 'capability zero', maxResults: 3, actor: {}, lexicalNames: [] })
    expect(evaluation).toEqual({ kind: 'lexical', reason: 'incomplete' })
    expect(lane.requests).toHaveLength(1)
  })

  it('returns cancelled for a pre-aborted caller and calls no runner', async () => {
    const controller = new AbortController()
    controller.abort()
    const lane = new ScriptedLane()
    const evaluation = await runtime({ mode: 'active', lane, entries: replicated(3) })
      .evaluate({ query: 'capability zero', maxResults: 3, actor: {}, lexicalNames: [], signal: controller.signal })
    expect(evaluation).toEqual({ kind: 'cancelled' })
    expect(lane.requests).toHaveLength(0)
  })

  it('maps an over-cap pool onto bounds without truncating it', async () => {
    const lane = new ScriptedLane()
    const evaluation = await runtime({
      mode: 'active',
      lane,
      entries: replicated(DEFAULT_DISCOVERY_SETTINGS.maxCandidates + 1),
    }).evaluate({ query: 'capability zero', maxResults: 3, actor: {}, lexicalNames: [] })
    expect(evaluation).toEqual({ kind: 'lexical', reason: 'bounds' })
    expect(lane.requests).toHaveLength(0)
  })

  it('short-circuits an exact-name query: shadow keeps lexical, active activates it alone', async () => {
    const entries = [entry('capability_zero'), entry('capability_one')]

    const shadowLane = new ScriptedLane()
    expect(await runtime({ mode: 'shadow', lane: shadowLane, entries })
      .evaluate({ query: 'capability_zero', maxResults: 3, actor: {}, lexicalNames: ['capability_zero'] }))
      .toEqual({ kind: 'lexical', reason: 'exact' })
    expect(shadowLane.requests).toHaveLength(0)

    const activeLane = new ScriptedLane()
    expect(await runtime({ mode: 'active', lane: activeLane, entries })
      .evaluate({ query: 'capability_zero', maxResults: 3, actor: {}, lexicalNames: [] }))
      .toEqual({ kind: 'selected', names: ['capability_zero'] })
    expect(activeLane.requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The CLI arms over a generated corpus
// ---------------------------------------------------------------------------

interface CliRun {
  code: number
  stdout: string
  stderr: string
}

/** Spawn the CLI in the package directory; a non-zero exit is data, not a throw. */
async function runCli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: packageDir,
      timeout: 120_000,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof failure.code === 'number' ? failure.code : -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

describe('eval-discovery.mjs over a generated corpus', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-eval-arms-'))
  const corpusPath = join(scratch, 'corpus.json')
  writeFileSync(corpusPath, JSON.stringify(syntheticCorpus(), null, 2), 'utf8')

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('runs selfcheck cleanly', async () => {
    const run = await runCli(['--mode', 'selfcheck', '--corpus', corpusPath])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('schemaVersion 2, corpusVersion 1: 60 case(s) valid')
    for (const label of CLASSES) expect(run.stdout).toContain(label)
  })

  it('always prints a well-formed judge-stub report', async () => {
    const run = await runCli(['--mode', 'judge-stub', '--corpus', corpusPath])
    expect([0, 1]).toContain(run.code)
    expect(run.stdout).toContain('corpusVersion 1')
    expect(run.stdout).toContain('split: tune')
    // One line per class plus the aggregate row; the gate block closes the report.
    for (const label of CLASSES) expect(run.stdout).toContain(label)
    expect(run.stdout).toContain('overall')
    expect(run.stdout).toContain('gates (split: tune)')
    expect(run.stdout).toMatch(/result: (PASS|FAIL)/)
    // Privacy: no query text reaches the report.
    expect(run.stdout).not.toContain('synthetic intent')
  })

  it('passes the live scenario battery', async () => {
    const run = await runCli(['--mode', 'live', '--corpus', corpusPath])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('nominal evidence')
    expect(run.stdout).toContain('scenario assertions')
    expect(run.stdout).toMatch(/result: PASS/)
    expect(run.stdout).not.toContain('synthetic intent')
  })
})
