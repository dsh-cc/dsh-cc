/**
 * Passive prompt-cache health observer. A `llm/stream` waterfall listener
 * tracks which part of each outbound request's prefix (system → tools →
 * messages) is volatile across calls within a session, and a `/cache-health`
 * slash command joins the observation ledger with provider-metered cache
 * usage from session events.
 *
 * Detector-only by design: the observer never rewrites options, never calls
 * providers, and never touches the harness. Every observation failure is
 * logged and swallowed — a bug here must never break a model call.
 *
 * @module @dsh-cc/cache-health
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { helpable } from '@dsh-cc/command-usage'
import { CacheHealthLedger, type LedgerRow } from './ledger.ts'
import { buildReport, renderReport } from './report.ts'
import { PrefixTracker, shortHash } from './tracker.ts'

export { CacheHealthLedger, LEDGER_MAX_ROWS, type LedgerRow } from './ledger.ts'
export {
  buildReport,
  CACHE_METER_DISCLAIMER,
  foldUsage,
  renderReport,
  TAIL_APPEND_NOTE,
  type CacheHealthReport,
  type UsageFold,
} from './report.ts'
export { canonicalJson, excerpt, PrefixTracker, sha256Hex, type PrefixObservation } from './tracker.ts'

export const name = 'cache-health'
export const inject = ['commands', 'sessions']

/** `/cache-health` configuration: a single on/off switch (default on). */
export interface Config {
  /** Set to false to disable both the llm/stream listener and the command. */
  readonly enabled: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
})

/** dshHomePath seam, read defensively (copied from context-crusher: cordis throws on property access of a missing service). */
type HomeFn = (...segments: string[]) => string

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

function dshHomeFn(ctx: Context): HomeFn | undefined {
  try {
    return ctx.dshHomePath
  } catch {
    return undefined
  }
}

/**
 * The minimal session surface the observer needs (structural subset of the
 * dsh-session Session, so tests can pass real sessions or stubs).
 */
interface ObservedSession {
  readonly id: SessionId
  readonly header: { readonly cwd?: string }
  snapshotEvents(): readonly SessionEvent[]
}

/** Dependencies for the testable observe path. */
export interface CacheHealthDeps {
  /** Session store lookup; a miss skips the observation. */
  readonly sessions?: { get(id: SessionId): ObservedSession | undefined }
  readonly ledger: CacheHealthLedger
  readonly tracker: PrefixTracker
  /** Warning sink for swallowed observer failures. */
  readonly warn: (message: string) => void
}

/** projectKey = shortHash of the session cwd (context-crusher idiom). */
function projectKeyOf(session: ObservedSession): string {
  return shortHash(session.header.cwd ?? process.cwd())
}

/**
 * Observe one model request. Read-only on `options`; all failures — including
 * throws from session lookup or hashing — are caught, warned, and swallowed.
 * Skips: auxiliary calls (`compaction`, `session-title`), requests without a
 * sessionId, and unknown sessions.
 */
export function observeRequest(deps: CacheHealthDeps, options: GenerateOptions): void {
  try {
    if (options.purpose === 'compaction' || options.purpose === 'session-title') return
    if (options.sessionId === undefined) return
    const session = deps.sessions?.get(options.sessionId)
    if (session === undefined) return
    const observation = deps.tracker.observe(String(session.id), options)
    const events = session.snapshotEvents()
    const row: LedgerRow = {
      ts: new Date().toISOString(),
      seq: events.length > 0 ? (events[events.length - 1]!.seq as number) : 0,
      provider: options.provider,
      model: options.model,
      stableSegments: observation.stableSegments,
      stablePrefixHash: observation.stablePrefixHash,
      stablePrefixTokensEst: observation.stablePrefixTokensEst,
      prefixChanged: observation.prefixChanged,
      ...(observation.driftSegmentIndex !== undefined
        ? { driftSegmentIndex: observation.driftSegmentIndex }
        : {}),
      ...(observation.driftExcerpt !== undefined
        ? { driftExcerpt: observation.driftExcerpt }
        : {}),
    }
    deps.ledger.append(projectKeyOf(session), String(session.id), row)
  } catch (error) {
    try {
      deps.warn(`cache-health: observation failed: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // never propagate
    }
  }
}

/** Execute `/cache-health` against the invocation's own session ledger. */
async function execute(invocation: CommandInvocation, ledger: CacheHealthLedger): Promise<CommandResult> {
  const session = invocation.agent.session
  const projectKey = shortHash(session.header.cwd ?? process.cwd())
  const rows = await ledger.read(projectKey, String(session.id))
  const report = buildReport(rows, session.snapshotEvents())
  return { kind: 'success', text: renderReport(report) }
}

/**
 * Register the cache-health observer: the `llm/stream` listener and the
 * `/cache-health` command.
 * @param ctx - context carrying the command registry and session store.
 * @param config - plugin config (enabled flag).
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const home = dshHomeFn(ctx)
  if (home === undefined) {
    ctx.logger.warn('cache-health: no dshHomePath on the host context; force-disabled')
    return
  }
  const ledger = new CacheHealthLedger(home('cache-health'), (error) => {
    ctx.logger.warn(`cache-health: ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  const tracker = new PrefixTracker()
  const sessions = ctx.sessions
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    observeRequest(
      { sessions, ledger, tracker, warn: (message) => ctx.logger.warn(message) },
      options,
    )
    return next()
  }, { global: true, prepend: true })
  ctx.commands.register(helpable({
    name: 'cache-health',
    description: 'show prompt-cache prefix stability and provider-metered cache usage for this session',
    handler: invocation => execute(invocation, ledger),
  }))
}
