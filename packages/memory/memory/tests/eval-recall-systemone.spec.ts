/**
 * W4 recall-selection quality eval — THIRD arm: the SystemOne decision selector
 * (design docs/plans/2026-11-02-systemone-03-memory-recall.md, task 4). Run from
 * the repo root:
 *   DSH_RECALL_EVAL=1 pnpm vitest run packages/memory/memory/tests/eval-recall-systemone.spec.ts
 *
 * Runs the new recall-decision path (`SystemOneRecallDecisionSelector`) over the
 * SAME `eval/fixture-memory` pool, golden queries and metrics as the two
 * baseline arms in `eval-recall-run.spec.ts`, and writes
 * `eval/report-systemone-<ISO-timestamp>.json` with per-query latency, delivered
 * selection (golden filenames), decision-usage tokens and the fixed fallback
 * reason. Metrics are scored with the shared `eval/lib.ts` math, so the W4 gate
 * compares the three arms directly.
 *
 * A REAL decision route is required — mocks cannot serve as release evidence.
 * The arm therefore rewrites no model response: it drives the production wire
 * stack (`createDecisionRunner` → `systemoneDecide` → real `fetch`) with real
 * route resolution (`resolveDetailedAlias`) over the single decision lane alias
 * (`DECISION_LANE_ALIAS`), its optional `systemone-decisions` pin row and the
 * provider connection facts of the existing route configuration. Credentials
 * are read only from the route configuration's `apiKeyEnv` (the same env
 * spelling fallback the host service uses) and never enter the report.
 *
 * Skips cleanly (never fails the suite) when `DSH_RECALL_EVAL !== '1'` or when
 * no real decision route is configured:
 *   DSH_RECALL_SYSTEMONE_ROUTE='{"provider":"…","model":"…","protocol":"systemone"}'
 *   DSH_RECALL_SYSTEMONE_ROUTES='{"gauge":{"revision":"…","actual-model-id":"…"}}'
 *   DSH_RECALL_SYSTEMONE_CONNECTION='{"baseURL":"https://…","apiKeyEnv":"…"}'
 * `DSH_RECALL_SYSTEMONE_ROUTES` carries the `systemone-decisions` `routes` dict
 * and is OPTIONAL: an absent row runs the registry defaults. Optional
 * `DSH_RECALL_SYSTEMONE_SETTINGS` overrides the kebab-case
 * `cc-systemone-memory-recall` section (thresholds, batch and size limits).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { apply as applyRoutes, resolveDetailedAlias } from '@dsh-cc/model-aliases'
import {
  DEFAULT_GAUGE_CONTEXT_WINDOW,
  DECISION_LANE_ALIAS,
  GAUGE_MODEL_CONTEXT_WINDOWS,
  createDecisionRunner,
  normalizeGaugeModelId,
} from '@dsh-cc/systemone'
import type {
  DecisionBudgetPermitProvider,
  DecisionRouteResolution,
  DecisionRun,
  DecisionScope,
  SystemOneUsage,
} from '@dsh-cc/systemone'
import { assignRecallTopicIds } from '../src/recall-decision.ts'
import type { RecallDecisionInput, RecallTopic } from '../src/recall-decision.ts'
import { SystemOneRecallDecisionSelector } from '../src/recall-decision-runner.ts'
import { recallDecisionSettings } from '../src/recall-decision-settings.ts'
import type { RecallDecisionSection, RecallDecisionSettings } from '../src/recall-decision-settings.ts'
import { scanRecallLayers } from '../src/recall-coordinator-support.ts'
import type { RecallDecisionBinding } from '../src/recall-coordinator-support.ts'
import { macroAverage, perQueryScore } from '../eval/lib.ts'

const PKG = join(import.meta.dirname, '..')
/** The fixture set under eval: the small default pool or the Chinese large pool. */
const FIXTURE_DIR = process.env.DSH_RECALL_EVAL_FIXTURE === 'zh' ? 'fixture-memory-zh' : 'fixture-memory'
const GOLDEN_NAME = process.env.DSH_RECALL_EVAL_FIXTURE === 'zh' ? 'golden-zh.json' : 'golden.json'
const FIXTURES = join(PKG, 'eval', FIXTURE_DIR)

/** The golden classes (kept in the order `eval/lib.ts` documents). */
const CLASSES = ['direct-topic', 'compositional', 'no-relevant-memory', 'ambiguous-phrasing'] as const

/** One golden query with its expected (required) and acceptable (tolerated) files. */
interface GoldenQuery {
  class: string
  query: string
  required: string[]
  tolerated: string[]
}

/** One resolved `systemone-decisions` pin row (camelCase, defaults applied). */
interface PinRow {
  revision: string
  /** Absent means "no version pin": any echoed model id is accepted (S1-01). */
  actualModelId?: string
  perRequestTokens: number
  perQuestionTokens: number
  maxOutputTokens: number
  maxQuestions: number
}

/** The provider connection facts of the trusted provider record. */
interface ConnectionRow {
  baseURL: string
  apiKeyEnv?: string
}

/** The resolved eval configuration (credentials included; never reported). */
interface EvalConfig {
  settings: RecallDecisionSettings
  route: { provider: string; model: string; protocol: string }
  pin: PinRow
  connection: ConnectionRow
  apiKey?: string
}

/** JSON env read; `undefined` when unset, invalid JSON stays a throw for the caller. */
function envJson<T>(name: string): T | undefined {
  const raw = process.env[name]
  return raw === undefined || raw.length === 0 ? undefined : (JSON.parse(raw) as T)
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isSafePositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/**
 * The lane alias's raw pin row from a `routes` dict, or `{}` when no row pins
 * it. Keys fold to lowercase (the host's `lookupRoutePin`), and the last
 * matching key wins; a non-object dict is a configuration error.
 */
function laneRow(routes: unknown): unknown {
  if (routes === undefined) return {}
  if (typeof routes !== 'object' || routes === null || Array.isArray(routes)) return undefined
  const folded = DECISION_LANE_ALIAS.toLowerCase()
  let row: unknown = {}
  for (const [key, value] of Object.entries(routes as Record<string, unknown>)) {
    if (key.toLowerCase() === folded) row = value
  }
  return row
}

/**
 * Resolve one pin row exactly as `@dsh-cc/decision-usage` does: absent fields
 * take the registry defaults (measured per-model window for the input bounds,
 * 32768 output, 32 questions, revision = the wire model id), while a PRESENT
 * but invalid field makes the alias unusable.
 */
function pinOf(row: unknown, wireModel: string): PinRow | undefined {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
  const record = row as Record<string, unknown>
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(record, key)
  const revision = has('revision') ? record.revision : wireModel
  if (!isNonEmptyString(revision)) return undefined
  const actualModelId = has('actual-model-id') ? record['actual-model-id'] : undefined
  if (actualModelId !== undefined && !isNonEmptyString(actualModelId)) return undefined
  const window = GAUGE_MODEL_CONTEXT_WINDOWS[normalizeGaugeModelId(wireModel)] ?? DEFAULT_GAUGE_CONTEXT_WINDOW
  const perRequestTokens = has('per-request-tokens') ? record['per-request-tokens'] : window
  const perQuestionTokens = has('per-question-tokens') ? record['per-question-tokens'] : window
  const maxOutputTokens = has('max-output-tokens') ? record['max-output-tokens'] : 32768
  const maxQuestions = has('max-questions') ? record['max-questions'] : 32
  if (!isSafePositive(perRequestTokens) || !isSafePositive(perQuestionTokens)) return undefined
  if (!isSafePositive(maxOutputTokens) || !isSafePositive(maxQuestions)) return undefined
  return {
    revision,
    ...(actualModelId !== undefined ? { actualModelId } : {}),
    perRequestTokens,
    perQuestionTokens,
    maxOutputTokens,
    maxQuestions,
  }
}

/**
 * Resolve the eval configuration from the environment, or the reason the arm
 * must skip. A route is usable only when the lane alias carries the `systemone`
 * protocol and the connection facts plus the credential resolve; the pin row is
 * optional (an absent row runs the registry defaults) but a PRESENT row with an
 * invalid field resolves to unconfigured, exactly like the host service.
 */
function resolveConfig(): { ok: true; config: EvalConfig } | { ok: false; reason: string } {
  let route: EvalConfig['route'] | undefined
  let routes: unknown
  let connection: ConnectionRow | undefined
  let section: RecallDecisionSection | undefined
  try {
    route = envJson<EvalConfig['route']>('DSH_RECALL_SYSTEMONE_ROUTE')
    routes = envJson<unknown>('DSH_RECALL_SYSTEMONE_ROUTES')
    connection = envJson<ConnectionRow>('DSH_RECALL_SYSTEMONE_CONNECTION')
    section = envJson<RecallDecisionSection>('DSH_RECALL_SYSTEMONE_SETTINGS')
  } catch {
    return { ok: false, reason: 'a DSH_RECALL_SYSTEMONE_* variable is not valid JSON' }
  }
  if (route === undefined || connection === undefined) {
    return { ok: false, reason: 'no real decision route configured (set DSH_RECALL_SYSTEMONE_ROUTE/_CONNECTION)' }
  }
  if (route.protocol !== 'systemone') {
    return { ok: false, reason: 'the configured alias is not a protocol:"systemone" route' }
  }
  if (!isNonEmptyString(route.provider) || !isNonEmptyString(route.model)) {
    return { ok: false, reason: 'the configured route needs a non-empty provider and model' }
  }
  const row = laneRow(routes)
  if (row === undefined) {
    return { ok: false, reason: 'DSH_RECALL_SYSTEMONE_ROUTES must be a routes dict keyed by alias' }
  }
  const pin = pinOf(row, route.model)
  if (pin === undefined) {
    return { ok: false, reason: `the ${DECISION_LANE_ALIAS} pin row is present but invalid` }
  }
  if (!isNonEmptyString(connection.baseURL)) {
    return { ok: false, reason: 'the provider connection record has no baseURL' }
  }
  const apiKey = connection.apiKeyEnv === undefined ? undefined : process.env[connection.apiKeyEnv]
  if (connection.apiKeyEnv !== undefined && (apiKey === undefined || apiKey.length === 0)) {
    return { ok: false, reason: `credential ${connection.apiKeyEnv} of the configured route is unset` }
  }
  // `mode` is forced: this arm IS the decision path, so the live snapshot's
  // `off` default (or an operator's `shadow`) must not silently skip it.
  const settings: RecallDecisionSettings = { ...recallDecisionSettings(section), mode: 'active' }
  return {
    ok: true,
    config: {
      settings,
      route,
      pin,
      connection,
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
  }
}

const gate = process.env.DSH_RECALL_EVAL
const resolved = resolveConfig()
const skipReason = gate !== '1'
  ? 'set DSH_RECALL_EVAL=1 to run the recall quality eval'
  : resolved.ok ? undefined : resolved.reason

/** The arm's per-query record: outcome, delivered selection, usage, latency. */
interface QueryRecord {
  class: string
  query: string
  candidates: number
  batches: number
  latencyMs: number
  status: 'selected' | 'fallback' | 'cancelled'
  /** The fixed fallback reason (enum, never a path or a query fragment). */
  reason?: string
  /** Delivered fixture filenames (the design's "delivered recall"). */
  delivered: string[]
  /** Per-candidate probability of the delivered pool, keyed by fixture filename. */
  probabilities: Record<string, number>
  /** How many judged rows fell inside the grey band (0 when no selection ran). */
  greyDropped: number
  score: { precision: number; recall: number; f1: number }
  usage: SystemOneUsage
  /** Batches whose decision answer arrived (the wire answered, not a mock). */
  answeredBatches: number
  /** Runner-level unavailability reasons observed per batch (never a body). */
  runReasons: string[]
}

/** One runner call's recorded outcome (the report's usage source). */
interface RunRecord {
  status: DecisionRun['status']
  reason?: string
  usage?: SystemOneUsage
}

/** An unbounded permit source: quota accounting belongs to the host service. */
const UNBOUNDED_BUDGET: DecisionBudgetPermitProvider = {
  reserve: async () => ({ settle: async () => {} }),
}

/** The eval's host-plane facts: one fixed agent/session/project triple. */
const HOST = { projectKey: 'systemone-recall-eval', sessionId: 'recall-eval-session', agentId: 'recall-eval-agent' }

/**
 * Build the bound runner the coordinator consumes. Route resolution, the wire
 * call, the S1-01 response validation and the strict usage check are all the
 * production implementation (`createDecisionRunner`); only the ledger append
 * and the quota reservation are eval seams, because the production
 * `@dsh-cc/decision-usage` service is not a dependency of this package.
 * @param ctx - the context carrying the real `ccModelRoutes` resolution.
 * @param config - the resolved eval configuration (secrets stay here).
 * @param recorded - receives one entry per `run` call.
 * @returns the binding plus the facts the report needs.
 */
function bindRunner(ctx: Context, config: EvalConfig, recorded: RunRecord[]): RecallDecisionBinding {
  const resolution = (alias: string): DecisionRouteResolution | undefined => {
    // Production semantics: the ONE lane alias must resolve to a concrete
    // protocol:"systemone" route — the eval's configured alias route — and its
    // optional pin row narrows that route. Anything less is unconfigured, never
    // a guess.
    if (alias !== DECISION_LANE_ALIAS) return undefined
    const detailed = resolveDetailedAlias(ctx, alias).route
    if (detailed === undefined || detailed.protocol !== 'systemone') return undefined
    if (detailed.provider !== config.route.provider || detailed.model !== config.route.model) return undefined
    const pin = config.pin
    const route: DecisionRouteResolution = {
      provider: config.route.provider,
      model: config.route.model,
      ...(pin.actualModelId !== undefined ? { actualModelId: pin.actualModelId } : {}),
      baseURL: config.connection.baseURL,
      revision: pin.revision,
      perRequestTokens: pin.perRequestTokens,
      perQuestionTokens: pin.perQuestionTokens,
      maxOutputTokens: pin.maxOutputTokens,
      maxQuestions: pin.maxQuestions,
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    }
    return route
  }
  const runner = createDecisionRunner({
    // The scope is minted by this eval standing in for the host service; the
    // memory consumer itself never assembles one.
    validateScope: (scope: DecisionScope) =>
      scope.projectKey === HOST.projectKey
      && scope.sessionId === HOST.sessionId
      && scope.agentId === HOST.agentId
      && Number.isSafeInteger(scope.originSeq)
      && scope.originSeq >= 0,
    resolveRoute: (alias: string) => resolution(alias),
    reserveGlobal: UNBOUNDED_BUDGET,
    append: () => {},
    now: () => Date.now(),
    uuid: () => randomUUID(),
    fetchImpl: (input, init) => fetch(input, init),
  })
  return {
    identifyRoute: (alias, scope) => runner.identifyRoute(alias, scope),
    run: async request => {
      const run = await runner.run(request)
      recorded.push(run.status === 'answered'
        ? { status: run.status, usage: run.usage }
        : { status: run.status, reason: run.reason })
      return run
    },
    scope: (originSeq = 0) => ({ ...HOST, originSeq }),
  }
}

/** Nearest-rank percentile over a non-empty sample. */
function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]!
}

/** Score every record against the golden required/tolerated sets (shared math). */
function scoreRecords(records: readonly QueryRecord[], golden: readonly GoldenQuery[]): {
  overall: { precision: number; recall: number; f1: number }
  perClass: Record<string, { precision: number; recall: number; f1: number }>
} {
  const byQuery = new Map(records.map(record => [record.query, record]))
  const scored = golden.map(query => byQuery.get(query.query)?.score ?? { precision: 0, recall: 0, f1: 0 })
  const perClass: Record<string, { precision: number; recall: number; f1: number }> = {}
  for (const cls of CLASSES) {
    perClass[cls] = macroAverage(golden.flatMap((query, index) => (query.class === cls ? [scored[index]!] : [])))
  }
  return { overall: macroAverage(scored), perClass }
}

describe('W4 recall-selection eval — SystemOne arm', () => {
  it.skipIf(skipReason !== undefined)(`runs the SystemOne arm over the golden set${skipReason ? ` — SKIPPED: ${skipReason}` : ''}`, async () => {
    const parsed = resolveConfig()
    if (!parsed.ok) throw new Error(parsed.reason)
    const config = parsed.config
    const golden = JSON.parse(readFileSync(join(PKG, 'eval', GOLDEN_NAME), 'utf8')) as { queries: GoldenQuery[] }

    // The real route layer (ccModelRoutes) and a real local filesystem over the
    // SAME fixture tree the baseline arms select from.
    const ctx = new Context()
    await ctx.plugin(applyRoutes, {
      modelAliases: { [DECISION_LANE_ALIAS]: config.route },
    })
    await ctx.plugin(LocalFileSystem, { cwd: FIXTURES })
    // The global layer is an empty temp dir: the arm's pool is exactly the
    // fixture set, so every arm scores the same candidate universe.
    const globalHome = mkdtempSync(join(tmpdir(), 'dsh-recall-eval-global-'))
    try {
      const recorded: RunRecord[] = []
      const binding = bindRunner(ctx, config, recorded)
      const selector = new SystemOneRecallDecisionSelector(binding, config.settings)
      const records: QueryRecord[] = []
      for (const [index, query] of golden.queries.entries()) {
        const signal = new AbortController().signal
        const { seeds } = await scanRecallLayers(ctx.fs, FIXTURES, globalHome, signal)
        const topics: RecallTopic[] = assignRecallTopicIds(seeds)
        const filenameById = new Map(topics.map(topic => [topic.id, topic.filename]))
        const input: RecallDecisionInput = { query: query.query, recentTools: [], topics }
        recorded.length = 0
        const startedAt = Date.now()
        const selection = await selector.select(input, binding.scope(index + 1), signal)
        // Duration of the WHOLE selection (every batch), not one batch.
        const latencyMs = Date.now() - startedAt
        const usage = recorded.reduce(
          (sum, run) => ({
            input_tokens: sum.input_tokens + (run.usage?.input_tokens ?? 0),
            output_tokens: sum.output_tokens + (run.usage?.output_tokens ?? 0),
          }),
          { input_tokens: 0, output_tokens: 0 },
        )
        const delivered = selection.kind === 'selected'
          ? selection.ids.flatMap(id => {
            const filename = filenameById.get(id)
            return filename === undefined ? [] : [filename]
          })
          : []
        const probabilities = selection.kind === 'selected'
          ? Object.fromEntries(Object.entries(selection.probabilities).flatMap(([id, probability]) => {
            const filename = filenameById.get(id)
            return filename === undefined ? [] : [[filename, probability] as [string, number]]
          }))
          : {}
        records.push({
          class: query.class,
          query: query.query,
          candidates: topics.length,
          batches: recorded.length,
          latencyMs,
          status: selection.kind,
          ...(selection.kind === 'fallback' ? { reason: selection.reason } : {}),
          delivered,
          probabilities,
          greyDropped: selection.kind === 'selected' ? selection.greyDropped : 0,
          score: perQueryScore(delivered, query.required, query.tolerated),
          usage,
          answeredBatches: recorded.filter(run => run.status === 'answered').length,
          runReasons: recorded.flatMap(run => (run.reason === undefined ? [] : [run.reason])),
        })
      }

      const latencies = records.map(record => record.latencyMs)
      const fallbackReasons: Record<string, number> = {}
      for (const record of records) {
        if (record.reason === undefined) continue
        fallbackReasons[record.reason] = (fallbackReasons[record.reason] ?? 0) + 1
      }
      // Credentials never reach the report: provider/model/revision identify
      // the route, baseURL and the apiKey stay in this process.
      const report = {
        generatedAt: new Date().toISOString(),
        arm: 'systemone',
        route: {
          alias: DECISION_LANE_ALIAS,
          provider: config.route.provider,
          model: config.route.model,
          revision: config.pin.revision,
        },
        settings: config.settings,
        queries: records,
        metrics: scoreRecords(records, golden.queries),
        latency: {
          meanMs: latencies.reduce((sum, value) => sum + value, 0) / records.length,
          p50Ms: percentile(latencies, 0.5),
          p95Ms: percentile(latencies, 0.95),
          maxMs: Math.max(...latencies),
        },
        deliveredRecall: scoreRecords(records, golden.queries).overall.recall,
        usage: records.reduce(
          (sum, record) => ({
            input_tokens: sum.input_tokens + record.usage.input_tokens,
            output_tokens: sum.output_tokens + record.usage.output_tokens,
          }),
          { input_tokens: 0, output_tokens: 0 },
        ),
        fallbackReasons,
        // A run without a single decision answer is not release evidence.
        answeredBatches: records.reduce((sum, record) => sum + record.answeredBatches, 0),
      }
      const out = join(PKG, 'eval', `report-systemone-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      writeFileSync(out, JSON.stringify(report, null, 2))
      console.warn(`W4 SystemOne eval report written: ${out}`)

      // Sanity only — the gate itself is judged from the report (see
      // eval/README.md). Nothing here can pass on a mocked model.
      expect(records).toHaveLength(golden.queries.length)
      expect(records.every(record => ['selected', 'fallback', 'cancelled'].includes(record.status))).toBe(true)
      expect(records.every(record => Number.isFinite(record.latencyMs) && record.latencyMs >= 0)).toBe(true)
      expect(records.every(record => Number.isSafeInteger(record.usage.input_tokens))).toBe(true)
      expect(report.usage.input_tokens).toBeGreaterThanOrEqual(0)
    } finally {
      rmSync(globalHome, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })
})
