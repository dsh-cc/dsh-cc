/**
 * `models` checks for `/doctor`: peer-deduped alias routes, the last request,
 * and (verbose) the LLM catalog validation.
 * @module @dsh-cc/command-doctor/checks/models
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { lastModel } from '../last-model.ts'
import type { Check } from '../report.ts'

/** Duck-typed alias inspection, matching `ccModelRoutes.inspect`. */
export interface AliasInspection {
  readonly kind: string
  readonly route?: { provider?: string; model?: string; reasoningEffort?: string }
  readonly via?: string
  readonly hop?: string
}

/** Duck-typed ccModelRoutes face used here. */
export interface ModelRoutesSeam {
  inspect?(name: string): AliasInspection
}

/** One advertised reasoning effort: a string id, or `{ id }` from the TUI catalog. */
type EffortEntry = string | { id?: string }

/** Duck-typed llm catalog face used here. `listModels` / `resolveModelInfo` are async in the TUI. */
export interface LlmSeam {
  listProviders?(): { id: string }[] | Promise<{ id: string }[]>
  listModels?(provider: string): { id?: string; name?: string }[] | Promise<{ id?: string; name?: string }[]>
  resolveModelInfo?(provider: string, model: string):
    | { reasoning?: { efforts?: readonly EffortEntry[] } }
    | Promise<{ reasoning?: { efforts?: readonly EffortEntry[] } } | undefined>
}

/** Canonical peer lanes: `lane → peer alias` (copied from LANE_PEERS). */
const LANES: readonly { lane: string; peer: string }[] = [
  { lane: 'sketch', peer: 'haiku' },
  { lane: 'draft', peer: 'sonnet' },
  { lane: 'blueprint', peer: 'opus' },
  { lane: 'masterplan', peer: 'fable' },
]

/** Collect the models group checks. */
export async function modelChecks(
  ctx: Context,
  invocation: CommandInvocation,
  options: { verbose: boolean },
): Promise<Check[]> {
  const routes = ctx.get('ccModelRoutes') as ModelRoutesSeam | undefined
  if (routes?.inspect === undefined) {
    return [{
      id: 'models.routes',
      group: 'models',
      status: 'skip',
      summary: 'ccModelRoutes not mounted',
    }]
  }
  const inspect = routes.inspect.bind(routes)
  const checks: Check[] = []
  for (const { lane, peer } of LANES) {
    checks.push(aliasCheck(inspect, peer, `${peer} (+ ${lane})`))
  }
  checks.push(aliasCheck(inspect, 'architect', 'architect'))
  for (const { lane } of LANES) {
    const laneInspection = inspect(lane)
    if (laneInspection.via === 'configured' || laneInspection.via === 'one-hop') {
      checks.push(aliasCheck(inspect, lane, lane))
    }
  }
  checks.push(lastRequestCheck(invocation))
  if (options.verbose) {
    checks.push(...await catalogChecks(ctx, checks))
  }
  return checks
}

/** One peer-deduped alias row. */
function aliasCheck(
  inspect: (name: string) => AliasInspection,
  name: string,
  label: string,
): Check {
  const inspection = inspect(name)
  const via = inspection.via === undefined ? '' : ` (via ${inspection.via})`
  const hop = inspection.hop === undefined ? '' : ` -> ${inspection.hop}`
  const provenance = `${via}${hop}`
  if (inspection.kind === 'inherit') {
    return {
      id: `models.alias.${name}`,
      group: 'models',
      status: 'info',
      summary: `${label}: inherit${provenance}`,
      detail: inspection.route === undefined ? undefined : JSON.stringify(inspection.route),
      evidence: { via: inspection.via ?? null, hop: inspection.hop ?? null },
    }
  }
  const route = inspection.route
  const target = route?.model === undefined
    ? 'no route'
    : `${route.provider ?? '?'}/${route.model}`
  return {
    id: `models.alias.${name}`,
    group: 'models',
    status: 'ok',
    summary: `${label}: ${target}${provenance}`,
    detail: route?.reasoningEffort === undefined ? undefined : `effort ${route.reasoningEffort}`,
    evidence: {
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      via: inspection.via ?? null,
      hop: inspection.hop ?? null,
    },
  }
}

/** Fold the last `request/header` into `models.last-request`. */
function lastRequestCheck(invocation: CommandInvocation): Check {
  const modelRef = lastModel(invocation.agent.session.events)
  if (modelRef === undefined) {
    return {
      id: 'models.last-request',
      group: 'models',
      status: 'skip',
      summary: 'no request/header in this session',
    }
  }
  return {
    id: 'models.last-request',
    group: 'models',
    status: 'ok',
    summary: `Last request: ${modelRef.provider}/${modelRef.model}`,
    detail: modelRef.reasoningEffort === undefined ? undefined : `effort ${modelRef.reasoningEffort}`,
    evidence: {
      provider: modelRef.provider,
      model: modelRef.model,
      reasoningEffort: modelRef.reasoningEffort ?? null,
    },
  }
}

/** Verbose-only LLM catalog validation over the ok route rows. */
async function catalogChecks(ctx: Context, checks: readonly Check[]): Promise<Check[]> {
  const llm = ctx.get('llm') as LlmSeam | undefined
  if (llm?.listProviders === undefined) {
    return [{
      id: 'models.catalog',
      group: 'models',
      status: 'skip',
      summary: 'llm seam not mounted',
    }]
  }
  const providerIds = new Set((await Promise.resolve(llm.listProviders())).map(provider => provider.id))
  const modelCache = new Map<string, Set<string>>()
  const effortCache = new Map<string, readonly string[] | undefined>()
  const rows = checks.filter(check =>
    check.group === 'models'
    && check.id.startsWith('models.alias.')
    && check.status === 'ok'
    && typeof check.evidence?.provider === 'string'
    && typeof check.evidence?.model === 'string',
  )
  const results = await Promise.all(rows.map(async check => {
    const provider = check.evidence!.provider as string
    const model = check.evidence!.model as string
    if (!providerIds.has(provider)) {
      return { id: catalogId(check.id), status: 'fail', message: `provider ${provider} missing from listProviders` }
    }
    let modelIds = modelCache.get(provider)
    if (modelIds === undefined) {
      try {
        const listed = llm.listModels === undefined
          ? []
          : (await Promise.resolve(llm.listModels(provider))) ?? []
        modelIds = new Set(listed.map(entry => entry.id ?? entry.name ?? '').filter(id => id.length > 0))
      } catch (error) {
        return { id: catalogId(check.id), status: 'fail', message: `listModels(${provider}) threw: ${String(error)}` }
      }
      modelCache.set(provider, modelIds)
    }
    if (modelIds.size > 0 && !modelIds.has(model)) {
      return { id: catalogId(check.id), status: 'warn', message: `model ${model} missing from listModels(${provider}) (custom provider catalogs can be incomplete)` }
    }
    const cacheKey = `${provider}/${model}`
    if (!effortCache.has(cacheKey)) {
      try {
        const info = llm.resolveModelInfo === undefined
          ? undefined
          : await Promise.resolve(llm.resolveModelInfo(provider, model))
        effortCache.set(cacheKey, effortIds(info?.reasoning?.efforts))
      } catch {
        effortCache.set(cacheKey, undefined)
      }
    }
    const efforts = effortCache.get(cacheKey)
    if (efforts === undefined || efforts.length === 0) {
      return { id: catalogId(check.id), status: 'skip', message: 'effort list unavailable (cannot attribute)' }
    }
    const routeEffort = readRouteEffort(check)
    if (routeEffort !== undefined && !efforts.includes(routeEffort)) {
      return { id: catalogId(check.id), status: 'warn', message: `effort ${routeEffort} not in reasoning.efforts` }
    }
    return { id: catalogId(check.id), status: 'ok', message: `${provider}/${model} in catalog` }
  }))
  return results.map(result => ({
    id: result.id,
    group: 'models' as const,
    status: result.status as 'ok' | 'warn' | 'fail' | 'skip',
    summary: result.message,
  }))
}

/** Catalog check id: the cheap lane gets its own id; others suffix the alias row. */
function catalogId(aliasId: string): string {
  return aliasId === 'models.alias.haiku' ? 'models.catalog.haiku' : `${aliasId}.catalog`
}

/** Read the effort recorded on the alias row's detail, if any. */
function readRouteEffort(check: Check): string | undefined {
  const match = /^effort (.+)$/u.exec(check.detail ?? '')
  return match?.[1]
}

/** Normalize string ids and `{ id }` effort entries into a list of ids. */
function effortIds(efforts: readonly EffortEntry[] | undefined): readonly string[] | undefined {
  if (efforts === undefined) return undefined
  return efforts.flatMap(entry => {
    if (typeof entry === 'string') return entry.length > 0 ? [entry] : []
    return typeof entry.id === 'string' && entry.id.length > 0 ? [entry.id] : []
  })
}
