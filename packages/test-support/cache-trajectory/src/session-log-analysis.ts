/**
 * Session-log cache forensics. Folds a durable session event log into
 * per-request cache usage attributed to the serving route, and classifies the
 * dominant cache pattern observed in production logs:
 *
 * - `healthy` — the prefix accumulates; steady read share climbs toward 1.
 * - `single-slot` — the provider caches only the freshly computed delta, so
 *   `read(N)` tracks `input(N-1)` and the read share pins near 0.5 while the
 *   prompt grows (observed on xai_oauth/grok-4.6 via a compat gateway).
 * - `no-cache-accounting` — a segment reports read=0 AND write=0 on a large
 *   prompt (observed on failover to a provider without cache metering).
 * - `insufficient-data` — fewer than three requests carried usage.
 *
 * Rate note: shares here use the FULL prompt (`read / (input+read+write)`) —
 * the diagnostic question is "how much of this request was served from cache",
 * unlike the benchmark口径 in `report.ts` (`read / (input+read)`).
 *
 * `compareForkPrefix` pins the fork byte-identity invariant: a plain fork
 * child's request head (system prompt + route) must equal its parent's, since
 * prefix reuse stops at the first differing byte.
 * @module @dsh-cc/cache-trajectory/session-log-analysis
 */

/** Minimal event shape the analysis consumes (subset of the canonical log). */
export interface SessionLogEvent {
  readonly type: string
  readonly time?: number
  readonly data?: Record<string, unknown> | undefined
}

/** The route a request was served on, taken from `request/context` events. */
export interface RequestRoute {
  readonly provider: string
  readonly model: string
}

/** One request's cache usage, attributed to its route. */
export interface AnalyzedRequest {
  /** Zero-based index among requests that carried usage. */
  readonly index: number
  readonly time?: number | undefined
  readonly route: RequestRoute | undefined
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** input + read + write. */
  readonly promptTotal: number
  /** cacheRead / promptTotal; undefined when the prompt is empty. */
  readonly readShare: number | undefined
  /** Gap since the previous request with usage; undefined for the first. */
  readonly gapMs: number | undefined
}

/** Dominant cache behavior classification for one session log. */
export type CachePattern = 'healthy' | 'single-slot' | 'no-cache-accounting' | 'mixed' | 'insufficient-data'

/** Read-share aggregate for one inter-request gap band. */
export interface GapBucket {
  readonly label: '<1m' | '1-5m' | '5-15m' | '>15m'
  readonly requests: number
  readonly readShare: number | undefined
}

/** Per-route usage totals. */
export interface RouteBreakdown {
  readonly provider: string
  readonly model: string
  readonly requests: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly readShare: number | undefined
}

/** One session's folded cache analysis. */
export interface SessionCacheAnalysis {
  readonly requestCount: number
  readonly pattern: CachePattern
  /** Read share over requests after the structural first request. */
  readonly steadyReadShare: number | undefined
  readonly firstRequestPromptTotal: number | undefined
  readonly gapBuckets: readonly GapBucket[]
  readonly routes: readonly RouteBreakdown[]
  readonly requests: readonly AnalyzedRequest[]
  /** Human-readable findings (route changes, zero-accounting spans, TTL loss). */
  readonly findings: readonly string[]
}

const GAP_BANDS = [
  { label: '<1m', maxMs: 60_000 },
  { label: '1-5m', maxMs: 300_000 },
  { label: '5-15m', maxMs: 900_000 },
  { label: '>15m', maxMs: Number.POSITIVE_INFINITY },
] as const

/** Tolerance for the single-slot match: read(N) ≈ input(N-1) within 15%. */
const SINGLE_SLOT_TOLERANCE = 0.15

function shareOf(read: number, total: number): number | undefined {
  return total > 0 ? read / total : undefined
}

function routeOf(data: Record<string, unknown> | undefined): RequestRoute | undefined {
  const provider = data?.['provider']
  const model = data?.['model']
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined
}

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Fold one session's events into a cache analysis. Events are consumed in log
 * order; `request/context` events attribute all following requests until the
 * next one. Assistant messages without usage are skipped.
 */
export function analyzeSessionCache(events: readonly SessionLogEvent[]): SessionCacheAnalysis {
  const requests: AnalyzedRequest[] = []
  const findings: string[] = []
  let route: RequestRoute | undefined
  let previous: AnalyzedRequest | undefined
  for (const event of events) {
    if (event.type === 'request/context') {
      const next = routeOf(event.data)
      if (next !== undefined) {
        if (route !== undefined && (route.provider !== next.provider || route.model !== next.model)) {
          findings.push(
            `route changed before request #${requests.length + 1}: `
            + `${route.provider}/${route.model} -> ${next.provider}/${next.model}`,
          )
        }
        route = next
      }
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.['usage'] as UsageLike | undefined
    if (usage === undefined) continue
    const inputTokens = usage.inputTokens ?? 0
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0
    const promptTotal = inputTokens + cacheReadTokens + cacheWriteTokens
    const analyzed: AnalyzedRequest = {
      index: requests.length,
      time: event.time,
      route,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      promptTotal,
      readShare: shareOf(cacheReadTokens, promptTotal),
      gapMs: previous?.time !== undefined && event.time !== undefined
        ? event.time - previous.time
        : undefined,
    }
    requests.push(analyzed)
    previous = analyzed
  }

  const steady = requests.slice(1)
  const steadyRead = steady.reduce((sum, r) => sum + r.cacheReadTokens, 0)
  const steadyTotal = steady.reduce((sum, r) => sum + r.promptTotal, 0)

  const gapBuckets: GapBucket[] = GAP_BANDS.map(band => {
    const inBand = requests.filter(r => r.gapMs !== undefined
      && r.gapMs >= lowerBound(band.label) && r.gapMs < band.maxMs)
    const read = inBand.reduce((sum, r) => sum + r.cacheReadTokens, 0)
    const total = inBand.reduce((sum, r) => sum + r.promptTotal, 0)
    return { label: band.label, requests: inBand.length, readShare: shareOf(read, total) }
  })

  const routes = foldRoutes(requests)
  const pattern = classify(requests)

  // Zero-accounting spans: consecutive read=0 & write=0 requests after the first.
  let spanStart = -1
  for (const r of [...steady, undefined]) {
    const zero = r !== undefined && r.cacheReadTokens === 0 && r.cacheWriteTokens === 0 && r.promptTotal > 0
    if (zero && spanStart < 0) spanStart = r.index
    if (!zero && spanStart >= 0) {
      const end = requests[(r?.index ?? requests.length) - 1]
      const spanRoute = requests[spanStart]?.route
      findings.push(
        `requests #${spanStart + 1}-#${(end?.index ?? spanStart) + 1} ran with zero cache accounting`
        + (spanRoute !== undefined ? ` (route ${spanRoute.provider}/${spanRoute.model})` : ''),
      )
      spanStart = -1
    }
  }
  if (pattern === 'single-slot') {
    findings.push(
      'single-slot caching: read(N) tracks input(N-1) — the provider caches only the freshly '
      + 'computed delta, capping the read share near 50% as the prompt grows',
    )
  }
  const longGap = gapBuckets.find(b => b.label === '>15m')
  if (longGap !== undefined && longGap.requests > 0
    && longGap.readShare !== undefined && longGap.readShare < 0.5) {
    findings.push(
      `long-gap (>15m) requests lose most of the cache: read share ${(longGap.readShare * 100).toFixed(1)}% `
      + `over ${longGap.requests} request(s) — provider TTL expiry`,
    )
  }

  return {
    requestCount: requests.length,
    pattern,
    steadyReadShare: steady.length > 0 ? shareOf(steadyRead, steadyTotal) : undefined,
    firstRequestPromptTotal: requests[0]?.promptTotal,
    gapBuckets,
    routes,
    requests,
    findings,
  }
}

function lowerBound(label: GapBucket['label']): number {
  switch (label) {
    case '<1m': return 0
    case '1-5m': return 60_000
    case '5-15m': return 300_000
    case '>15m': return 900_000
  }
}

function foldRoutes(requests: readonly AnalyzedRequest[]): RouteBreakdown[] {
  const byRoute = new Map<string, { route: RequestRoute; rows: AnalyzedRequest[] }>()
  for (const r of requests) {
    if (r.route === undefined) continue
    const key = `${r.route.provider}/${r.route.model}`
    const entry = byRoute.get(key) ?? { route: r.route, rows: [] }
    entry.rows.push(r)
    byRoute.set(key, entry)
  }
  return [...byRoute.values()].map(({ route, rows }) => {
    const inputTokens = rows.reduce((sum, r) => sum + r.inputTokens, 0)
    const cacheReadTokens = rows.reduce((sum, r) => sum + r.cacheReadTokens, 0)
    const cacheWriteTokens = rows.reduce((sum, r) => sum + r.cacheWriteTokens, 0)
    return {
      provider: route.provider,
      model: route.model,
      requests: rows.length,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      readShare: shareOf(cacheReadTokens, inputTokens + cacheReadTokens + cacheWriteTokens),
    }
  })
}

function classify(requests: readonly AnalyzedRequest[]): CachePattern {
  const steady = requests.slice(1)
  if (steady.length < 2) return 'insufficient-data'
  const zeroAccounting = steady.filter(r => r.cacheReadTokens === 0 && r.cacheWriteTokens === 0 && r.promptTotal > 0)
  if (zeroAccounting.length / steady.length >= 0.6) return 'no-cache-accounting'
  let eligible = 0
  let singleSlot = 0
  for (let i = 1; i < requests.length; i += 1) {
    const prev = requests[i - 1]
    const curr = requests[i]
    if (prev === undefined || curr === undefined) continue
    if (curr.cacheReadTokens === 0 || prev.inputTokens === 0) continue
    eligible += 1
    // Relative-only: an absolute floor would swallow small healthy reads
    // (read >> prev input there is the accumulating case, not single-slot).
    if (Math.abs(curr.cacheReadTokens - prev.inputTokens) <= prev.inputTokens * SINGLE_SLOT_TOLERANCE) singleSlot += 1
  }
  if (eligible >= 2 && singleSlot / eligible >= 0.5) return 'single-slot'
  // 'healthy' must be earned by accumulation; a middling steady share with no
  // dominant signature is 'mixed' — the findings carry the real story.
  const steadyRead = steady.reduce((sum, r) => sum + r.cacheReadTokens, 0)
  const steadyTotal = steady.reduce((sum, r) => sum + r.promptTotal, 0)
  const steadyShare = shareOf(steadyRead, steadyTotal)
  return steadyShare !== undefined && steadyShare >= 0.7 ? 'healthy' : 'mixed'
}

/** Route + system-prompt header of one recorded request. */
interface RequestHeader {
  readonly route: RequestRoute | undefined
  readonly system: string | undefined
}

function headerOf(events: readonly SessionLogEvent[], pick: 'first' | 'last'): RequestHeader | undefined {
  const headers = events.filter(e => e.type === 'request/header')
  const event = pick === 'first' ? headers[0] : headers[headers.length - 1]
  if (event === undefined) return undefined
  const header = event.data?.['header'] as Record<string, unknown> | undefined
  const config = header?.['config'] as Record<string, unknown> | undefined
  const provider = config?.['provider']
  const model = config?.['model']
  const system = header?.['system']
  return {
    route: typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined,
    system: typeof system === 'string' ? system : undefined,
  }
}

/** Byte-level fork head comparison between a parent and a child session log. */
export interface ForkPrefixComparison {
  readonly parentRoute: RequestRoute | undefined
  readonly childRoute: RequestRoute | undefined
  /** Same provider+model — the only case where prefix caches can share. */
  readonly sameRoute: boolean
  readonly systemIdentical: boolean
  /** First differing byte offset in the two system prompts, when divergent. */
  readonly divergenceByte: number | undefined
  /** Short excerpt of the child system prompt around the divergence. */
  readonly divergenceExcerpt: string | undefined
}

/**
 * Compare a fork child's request head against its parent's. The child head is
 * its FIRST request's header; the parent's is its LAST (the state the child
 * was forked from). Undefined when either side never recorded a header.
 */
export function compareForkPrefix(
  parentEvents: readonly SessionLogEvent[],
  childEvents: readonly SessionLogEvent[],
): ForkPrefixComparison | undefined {
  const parent = headerOf(parentEvents, 'last')
  const child = headerOf(childEvents, 'first')
  if (parent === undefined || child === undefined) return undefined
  const sameRoute = parent.route !== undefined && child.route !== undefined
    && parent.route.provider === child.route.provider && parent.route.model === child.route.model
  if (parent.system === undefined || child.system === undefined || parent.system === child.system) {
    return {
      parentRoute: parent.route,
      childRoute: child.route,
      sameRoute,
      systemIdentical: parent.system === child.system,
      divergenceByte: undefined,
      divergenceExcerpt: undefined,
    }
  }
  let divergenceByte = 0
  const bound = Math.min(parent.system.length, child.system.length)
  while (divergenceByte < bound && parent.system[divergenceByte] === child.system[divergenceByte]) {
    divergenceByte += 1
  }
  return {
    parentRoute: parent.route,
    childRoute: child.route,
    sameRoute,
    systemIdentical: false,
    divergenceByte,
    divergenceExcerpt: child.system.slice(Math.max(0, divergenceByte - 20), divergenceByte + 60),
  }
}
