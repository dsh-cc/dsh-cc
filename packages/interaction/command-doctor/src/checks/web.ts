/**
 * `web` checks for `/doctor`: seam presence, an execution probe for the fetch
 * provider (a mounted provider resolves URLs, so `WEB_PROVIDER_UNAVAILABLE`
 * from the harness runtime means missing), the literal SSRF gate, and the
 * haiku summarizer lane.
 * @module @dsh-cc/command-doctor/checks/web
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AliasInspection, ModelRoutesSeam } from './models.ts'
import type { Check } from '../report.ts'

/** Duck-typed `ctx.web` seam. */
interface WebSeam {
  fetch?: (req: { url: string }, signal?: AbortSignal) => Promise<unknown>
}

/**
 * Execute the seam with an invalid URL and no network: a missing provider is
 * `WEB_PROVIDER_UNAVAILABLE` (resolved before the URL is seen); a present
 * provider yields `WEB_INVALID_URL` / `WEB_BLOCKED_URL` / `WEB_ABORTED`.
 */
async function probeFetch(web: WebSeam & { fetch: NonNullable<WebSeam['fetch']> }): Promise<'missing' | 'present'> {
  try {
    await web.fetch({ url: 'not-a-url' }, AbortSignal.abort())
    return 'present' // unexpected success
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'WEB_PROVIDER_UNAVAILABLE') return 'missing'
    return 'present'
  }
}

/** Collect the web group checks. */
export async function webChecks(ctx: Context): Promise<Check[]> {
  const checks: Check[] = []
  const web = ctx.get('web') as WebSeam | undefined
  if (web === undefined) {
    checks.push({
      id: 'web.seam',
      group: 'web',
      status: 'skip',
      summary: 'web seam not mounted',
    })
  } else {
    checks.push({
      id: 'web.seam',
      group: 'web',
      status: 'ok',
      summary: 'web seam mounted',
    })
    if (typeof web.fetch !== 'function') {
      checks.push({
        id: 'web.fetch-provider',
        group: 'web',
        status: 'warn',
        summary: 'fetch method missing on the web seam',
      })
    } else {
      const probe = await probeFetch(web as WebSeam & { fetch: NonNullable<WebSeam['fetch']> })
      checks.push(probe === 'missing'
        ? {
            id: 'web.fetch-provider',
            group: 'web',
            status: 'warn',
            summary: 'fetch provider not mounted (WEB_PROVIDER_UNAVAILABLE at execute)',
          }
        : {
            id: 'web.fetch-provider',
            group: 'web',
            status: 'ok',
            summary: 'fetch provider mounted',
          })
      checks.push(await ssrfGateCheck(web as WebSeam & { fetch: NonNullable<WebSeam['fetch']> }, probe))
    }
  }
  checks.push(haikuSummarizerCheck(ctx))
  return checks
}

/** Probe the loopback literal with a short abort so `/doctor` cannot hang. */
async function ssrfGateCheck(
  web: WebSeam & { fetch: NonNullable<WebSeam['fetch']> },
  probe: 'missing' | 'present',
): Promise<Check> {
  if (probe === 'missing') {
    return { id: 'web.ssrf-gate', group: 'web', status: 'skip', summary: 'fetch provider not mounted' }
  }
  try {
    await web.fetch({ url: 'http://127.0.0.1/' }, AbortSignal.timeout(200))
    return {
      id: 'web.ssrf-gate',
      group: 'web',
      status: 'warn',
      summary: 'SSRF gate off or bypassed: loopback fetch was not blocked',
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'WEB_BLOCKED_URL') {
      return { id: 'web.ssrf-gate', group: 'web', status: 'ok', summary: 'loopback literal blocked before connect' }
    }
    return {
      id: 'web.ssrf-gate',
      group: 'web',
      status: 'warn',
      summary: 'SSRF gate off or bypassed',
    }
  }
}

/** The haiku cheap lane: a full route is ok, inherit is info. */
function haikuSummarizerCheck(ctx: Context): Check {
  const routes = ctx.get('ccModelRoutes') as ModelRoutesSeam | undefined
  if (routes?.inspect === undefined) {
    return {
      id: 'web.haiku-summarizer',
      group: 'web',
      status: 'skip',
      summary: 'ccModelRoutes not mounted',
    }
  }
  const inspection: AliasInspection = routes.inspect('haiku')
  const route = inspection.route
  if (inspection.kind !== 'inherit' && route?.provider !== undefined && route.model !== undefined) {
    return {
      id: 'web.haiku-summarizer',
      group: 'web',
      status: 'ok',
      summary: `haiku summarizer: ${route.provider}/${route.model}`,
      evidence: { provider: route.provider, model: route.model },
    }
  }
  return {
    id: 'web.haiku-summarizer',
    group: 'web',
    status: 'info',
    summary: 'raw WebFetch OK; prompt summarization unavailable',
  }
}
