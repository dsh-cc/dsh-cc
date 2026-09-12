/**
 * W4 recall-selection quality eval (env-gated). Run from the repo root:
 *   DSH_RECALL_EVAL=1 pnpm vitest run packages/memory/memory/tests/eval-recall-run.spec.ts
 *
 * Boots the REAL recall selector (`SubagentMemorySelector`) against
 * eval/fixture-memory in two arms — inherited model (recallUseSmallFast
 * false → no agentOptions stamp) vs the haiku alias (recallUseSmallFast
 * true → `toAgentOptions(resolveAlias(ctx, 'haiku'))`, the exact
 * `resolveRecallAgentOptions` priority). Writes
 * packages/memory/memory/eval/report-<ISO-timestamp>.json with per-arm
 * per-query selections, precision/recall/F1 over the required set, and
 * paired per-query agreement.
 *
 * Skips cleanly (never fails the suite) when DSH_RECALL_EVAL !== '1' or the
 * haiku alias is unresolvable. A REAL model adapter is required for a
 * meaningful run: point DSH_RECALL_EVAL_ADAPTER_MODULE at a module whose
 * default export is an adapter instance for the provider named by
 * DSH_RECALL_EVAL_PROVIDER (registered via ctx.llm.registerAdapter).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveAlias, toAgentOptions, type ModelRoutes } from '@dsh-cc/model-aliases'
import { SubagentMemorySelector, type RecallCandidate } from '../src/recall.ts'
import { macroAverage, perQueryScore, jaccardAgreement, fixtureFilenames } from '../eval/lib.ts'

const PKG = join(import.meta.dirname, '..')
const FIXTURES = join(PKG, 'eval', 'fixture-memory')
const env = process.env.DSH_RECALL_EVAL
const skipReason = env !== '1' ? 'set DSH_RECALL_EVAL=1 to run the recall quality eval' : undefined

/** Parse a fixture file's frontmatter description (the selector's manifest field). */
function candidateOf(dir: string, filename: string): RecallCandidate {
  const raw = readFileSync(join(dir, filename), 'utf8')
  const description = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? filename
  return { path: join(dir, filename), filename, description }
}

/** Routes service stub over DSH_RECALL_EVAL_ROUTES (the haiku alias source for a bare run). */
function routesFromEnv(): ModelRoutes | undefined {
  const raw = process.env.DSH_RECALL_EVAL_ROUTES
  if (raw === undefined) return undefined
  const route = JSON.parse(raw) as { provider: string; model: string }
  return { resolve: (alias: string | undefined) => (alias === 'haiku' ? route : undefined) } as unknown as ModelRoutes
}

/** Mount the real subagent seam the way the in-repo integration canary does. */
async function bootStack(): Promise<{ ctx: Context; parent: Agent }> {
  const [{ default: AgentLoop }, { default: JsonlPersistence }, { default: SubagentRuntime }, Spawn, Testkit] = await Promise.all([
    import('@deepseek-ai/dsh-agent-loop'),
    import('@deepseek-ai/dsh-session-persistence-jsonl'),
    import('@deepseek-ai/dsh-subagent'),
    import('@deepseek-ai/dsh-subagent-spawn-in-process'),
    import('@deepseek-ai/dsh-agent-loop-testkit'),
  ])
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const ctx = new Context()
  await Testkit.mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlPersistence, { root: mkdtempSync(join(tmpdir(), 'dsh-recall-eval-')) })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const provider = process.env.DSH_RECALL_EVAL_PROVIDER
  if (provider !== undefined) {
    const mod = (await import(/* @vite-ignore */ process.env.DSH_RECALL_EVAL_ADAPTER_MODULE!)) as {
      default: ConstructorParameters<Context['llm']['registerAdapter']> extends never ? never : any
    }
    ctx.llm.registerAdapter([provider], mod.default)
  }
  const parent = await (ctx as any).agentLoop.create(SessionId('recall-eval-parent'), { provider: provider ?? 'mock', model: process.env.DSH_RECALL_EVAL_MODEL ?? 'mock' })
  return { ctx, parent: parent as Agent }
}

interface ArmResult {
  arm: string
  queries: { class: string; query: string; selected: string[] }[]
  metrics: { overall: { precision: number; recall: number; f1: number }; perClass: Record<string, { precision: number; recall: number; f1: number }> }
}

describe('W4 recall-selection quality eval', () => {
  it.skipIf(skipReason !== undefined)(`runs both arms over the golden set${skipReason ? ` — SKIPPED: ${skipReason}` : ''}`, async () => {
    const ctx = new Context()
    const routes = routesFromEnv()
    if (routes !== undefined) ctx.provide('ccModelRoutes', routes)
    // The real host-plane alias read (same helper resolveRecallAgentOptions uses).
    const haikuRoute = resolveAlias(ctx, 'haiku')
    if (haikuRoute === undefined) {
      console.warn('SKIPPED: haiku alias not configured (no ccModelRoutes/settings route) — configure DSH_RECALL_EVAL_ROUTES.')
      return
    }
    const { ctx: stack, parent } = await bootStack()
    const files = fixtureFilenames(FIXTURES)
    const candidates = files.map(f => candidateOf(FIXTURES, f))
    const signal = new AbortController().signal
    const arms: Record<string, ArmResult> = {
      inherited: await runArm('inherited', new SubagentMemorySelector(stack, parent, 'spawn', undefined), candidates, files, signal),
      haiku: await runArm('haiku', new SubagentMemorySelector(stack, parent, 'spawn', toAgentOptions(haikuRoute)), candidates, files, signal),
    }
    const golden = JSON.parse(readFileSync(join(PKG, 'eval', 'golden.json'), 'utf8')) as {
      queries: { class: string; query: string; required: string[]; tolerated: string[] }[]
    }
    // Score each arm against the required set, then pair with the golden order.
    for (const arm of Object.values(arms)) {
      const byQuery = new Map(arm.queries.map(q => [q.query, q]))
      arm.metrics = score(golden.queries, q => byQuery.get(q.query)?.selected ?? [])
    }
    const paired = golden.queries.map((q, i) => ({
      query: q.query,
      class: q.class,
      agreement: jaccardAgreement(
        arms.inherited.queries[i]!.selected,
        arms.haiku.queries[i]!.selected,
      ),
    }))
    const report = {
      generatedAt: new Date().toISOString(),
      arms,
      pairedAgreement: {
        overall: macroAverage(paired.map(p => ({ precision: p.agreement, recall: p.agreement, f1: p.agreement }))).f1,
        perClass: Object.fromEntries(
          ['direct-topic', 'compositional', 'no-relevant-memory', 'ambiguous-phrasing'].map(cls => [
            cls,
            macroAverage(paired.filter(p => p.class === cls).map(p => ({ precision: p.agreement, recall: p.agreement, f1: p.agreement }))).f1,
          ]),
        ),
      },
      paired,
    }
    const out = join(PKG, 'eval', `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2))
    console.warn(`W4 eval report written: ${out}`)
    // Sanity only — the gate itself is judged from the report (see eval/README.md).
    expect(Object.keys(arms)).toEqual(['inherited', 'haiku'])
    expect(arms.inherited.queries).toHaveLength(40)
  })
})

/** Score one arm's selections against the golden required/tolerated sets. */
function score(
  queries: { class: string; query: string; required: string[]; tolerated: string[] }[],
  selectedOf: (q: { query: string }) => string[],
): ArmResult['metrics'] {
  const perClass: Record<string, ReturnType<typeof macroAverage>> = {}
  for (const cls of ['direct-topic', 'compositional', 'no-relevant-memory', 'ambiguous-phrasing']) {
    const subset = queries.filter(q => q.class === cls)
    perClass[cls] = macroAverage(subset.map(q => perQueryScore(selectedOf(q), q.required, q.tolerated)))
  }
  return { overall: macroAverage(queries.map(q => perQueryScore(selectedOf(q), q.required, q.tolerated))), perClass }
}

async function runArm(arm: string, selector: SubagentMemorySelector, candidates: RecallCandidate[], _files: string[], signal: AbortSignal): Promise<ArmResult> {
  void _files
  const golden = JSON.parse(readFileSync(join(PKG, 'eval', 'golden.json'), 'utf8')) as {
    queries: { class: string; query: string }[]
  }
  const queries: ArmResult['queries'] = []
  for (const q of golden.queries) {
    let selected: string[] = []
    try {
      selected = await selector.select(q.query, candidates, signal, [])
    } catch {
      selected = []
    }
    queries.push({ class: q.class, query: q.query, selected })
  }
  return { arm, queries, metrics: { overall: { precision: 0, recall: 0, f1: 0 }, perClass: {} } }
}
