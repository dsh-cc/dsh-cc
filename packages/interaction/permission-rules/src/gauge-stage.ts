/**
 * System One gauge branch of the auto-stage classifier flow (design doc
 * §4.4, PR-B unit B2b): one typed-decision call through the gauge adapter,
 * LRU-cached over the rendered state, wrapped into the stage's
 * LlmClassification identity shape and folded through the shared per-route
 * breaker + audit assembly. Extracted from auto-stage.ts for the file-size
 * budget — the chat path there is untouched (byte-identical contract).
 *
 * The adapter NEVER audits directly; the stage-side identity/audit assembly
 * stays the single audit writer, exactly as for the chat lane.
 *
 * @module @dsh-cc/permission-rules/gauge-stage
 */

import { createHash } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@dsh-cc/tools'
import { classificationKey, type ClassifierFailure } from './llm-classifier.ts'
import type { RouteBreaker } from './classifier-breaker.ts'
import {
  sanitizeReason,
  type ClassifierAuditEventData,
} from './classifier-audit.ts'
import type { PermissionMode, PermissionRule } from './types.ts'
import {
  DEFAULT_GAUGE_ALLOW_THRESHOLD,
  createVerdictCache,
  prepareSystemOneInput,
  type GaugeSlots,
} from './gauge-adapter.ts'
import { classifyViaSystemOne } from './gauge-adapter.ts'
import { collectGaugeAllowEvidence } from './gauge-allow-evidence.ts'

/** The System One backend info the gauge-backend resolver assembled. */
export type SystemOneBackendInfo = {
  provider: string
  model: string
  baseURL: string
  apiKey?: string
  contextWindow?: number
}

/** One classification on the gauge lane: the chat identity shape + derived scalars. */
export type SystemOneClassification = {
  tool: string
  digest: string
  input: string
  verdict: 'allow' | 'ask' | 'deny'
  reason: string
  failure?: ClassifierFailure
  routeAlias: string
  provider: string
  model: string
  latencyMs: number
  cacheHit: boolean
  probabilities?: Record<string, number>
  confidence?: number
}

/** The stage-side faces the branch folds through (no session state held here). */
export type SystemOneStageFaces = {
  breaker: RouteBreaker<{ exec: ToolExecution; route: { provider: string; model: string } }>
  seed(exec: ToolExecution, routeKey: string, route: { provider: string; model: string }): void
  modeOf(exec: ToolExecution): PermissionMode
  audit(session: Session, event: ClassifierAuditEventData): void
  pauseAuto(exec: ToolExecution, notice: string): void
}

/** The consumed autoMode slice bits the branch needs (structural — the stage owns the slice). */
export type SystemOneSliceOpts = {
  slots: GaugeSlots
  gaugeAllowThreshold: number | undefined
  timeoutMs: number
  auditFullText: boolean
  /** Fix B opt-out (absence-preserving; consumption default ON). */
  gaugeAllowEvidence: boolean | undefined
  /** The merged allow rules the evidence collector pre-filters (waterfall's view). */
  allowEvidenceRules?: readonly PermissionRule[]
}

/** The gauge lane: memoized verdict LRU + wire call, per-stage (rebuild drops it). */
export type SystemOneLane = {
  classify(
    exec: ToolExecution,
    backend: SystemOneBackendInfo,
    opts: { slots: GaugeSlots; allowThreshold: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<SystemOneClassification>
}

export function createSystemOneLane(
  cacheMaxEntries: number,
  deps: { fetchImpl?: typeof fetch; debug?: (message: string) => void } = {},
): SystemOneLane {
  const cache = createVerdictCache(Math.max(0, cacheMaxEntries))
  return {
    async classify(exec, backend, opts): Promise<SystemOneClassification> {
      const startedAt = Date.now()
      const tool = exec.name
      // F1 single render site: prepareSystemOneInput IS the render — the
      // token-budgeted state doubles as this lane's classifier input and
      // the verdict-LRU key. Chat lanes can never collide with these keys.
      const prepared = prepareSystemOneInput(exec, opts.slots, backend.contextWindow)
      const input = prepared.state
      const digest = createHash('sha256').update(input).digest('hex')
      const key = classificationKey(
        tool,
        input,
        opts.slots.softDeny,
        opts.slots.allowExceptions,
        opts.slots.environment,
        undefined,
        opts.slots.hardDeny,
      )
      const cached = cache.get(key)
      if (cached !== undefined) {
        return {
          ...cached,
          tool,
          digest,
          input,
          routeAlias: `systemone/${backend.model}`,
          provider: backend.provider,
          model: backend.model,
          latencyMs: Date.now() - startedAt,
          cacheHit: true,
        }
      }
      const outcome = await classifyViaSystemOne(prepared, backend, {
        allowThreshold: opts.allowThreshold,
        timeoutMs: opts.timeoutMs,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      })
      deps.debug?.(`[dsh:classifier:raw] gauge ${backend.model} -> ${JSON.stringify(outcome).slice(0, 2048)}`)
      if (outcome.failure !== undefined) {
        return {
          verdict: outcome.verdict,
          reason: outcome.reason,
          tool,
          digest,
          input,
          failure: outcome.failure,
          routeAlias: `systemone/${backend.model}`,
          provider: backend.provider,
          model: backend.model,
          latencyMs: Date.now() - startedAt,
          cacheHit: false,
        }
      }
      cache.set(key, { verdict: outcome.verdict, reason: outcome.reason, ...(outcome.probabilities === undefined ? {} : { probabilities: outcome.probabilities }), ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }) })
      return {
        verdict: outcome.verdict,
        reason: outcome.reason,
        tool,
        digest,
        input,
        routeAlias: `systemone/${backend.model}`,
        provider: backend.provider,
        model: backend.model,
        latencyMs: Date.now() - startedAt,
        cacheHit: false,
        ...(outcome.probabilities === undefined ? {} : { probabilities: outcome.probabilities }),
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
      }
    },
  }
}

/** '' when the call carries no session (the breaker audit then no-ops). */
function sessionIdOf(exec: ToolExecution): string {
  const session = exec.agent?.session
  return session === undefined ? '' : String((session as { header: { id: unknown } }).header.id)
}

/**
 * The full systemone escalation for one eligible call: breaker seeding +
 * open check, the typed-decision call, stale-mode revalidation, failure-tag
 * breaker bookkeeping, and the ONE `permission/classifier` audit event with
 * the derived scalars (§4.4). D13: `secondPass` is skipped on the System One
 * backend — no reconsider prompt exists for typed decisions, so this branch
 * never runs a second pass. The post-gating verdict is never `deny` (the
 * adapter collapses deny to ask), so the D5 deny backstop is not consulted.
 */
export async function systemOneEscalate(
  exec: ToolExecution,
  backend: SystemOneBackendInfo,
  lane: SystemOneLane,
  faces: SystemOneStageFaces,
  opts: SystemOneSliceOpts,
): Promise<'allow' | { kind: 'ask'; reason: string } | undefined> {
  // Breaker key must match the durable-log attribution (`${provider}/${model}`,
  // classifier-breaker.ts) or a systemone failure streak never seeds after restart.
  const routeKey = `${backend.provider}/${backend.model}`
  const route = { provider: backend.provider, model: backend.model }
  faces.seed(exec, routeKey, route)
  if (faces.breaker.isOpen(routeKey)) {
    faces.breaker.auditOnce(sessionIdOf(exec), routeKey, { exec, route })
    return { kind: 'ask', reason: `auto-mode classifier unavailable: route ${routeKey} breaker open` }
  }
  const session = exec.agent?.session
  // Fix B: fold user-originated allow evidence into the slots BEFORE the
  // single render site — the evidence rides the state, so the verdict-LRU
  // keys (derived from it) rotate automatically when rules/grants change.
  const evidence = opts.gaugeAllowEvidence !== false
    ? collectGaugeAllowEvidence({ exec, rules: opts.allowEvidenceRules ?? [], session })
    : []
  const slots: GaugeSlots = evidence.length === 0
    ? opts.slots
    : { ...opts.slots, allowExceptions: [...opts.slots.allowExceptions, ...evidence] }
  // A8 stale-mode epoch, same as the chat path: capture before the await,
  // re-fold after; a mid-flight mode change discards the verdict.
  const modeBefore = faces.modeOf(exec)
  const verdict = await lane.classify(exec, backend, {
    slots,
    allowThreshold: opts.gaugeAllowThreshold ?? DEFAULT_GAUGE_ALLOW_THRESHOLD,
    timeoutMs: opts.timeoutMs,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  })
  if (faces.modeOf(exec) !== modeBefore) {
    if (session !== undefined) {
      faces.audit(session, {
        tool: verdict.tool,
        digest: verdict.digest,
        verdict: 'ask',
        failure: 'stale-mode',
        latencyMs: verdict.latencyMs,
        cacheHit: false,
      })
    }
    return undefined
  }
  faces.breaker.record(sessionIdOf(exec), routeKey, verdict.failure, { exec, route })
  if (session !== undefined) {
    const audit: ClassifierAuditEventData = {
      tool: verdict.tool,
      digest: verdict.digest,
      ...(opts.auditFullText === true ? { input: verdict.input } : {}),
      verdict: verdict.verdict,
      ...(exec.callId === undefined ? {} : { callId: exec.callId }),
      ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
      route: routeKey,
      provider: backend.provider,
      model: backend.model,
      reason: sanitizeReason(verdict.reason),
      ...(verdict.probabilities === undefined ? {} : { probabilities: verdict.probabilities }),
      ...(verdict.confidence === undefined ? {} : { confidence: verdict.confidence }),
      latencyMs: verdict.latencyMs,
      cacheHit: verdict.cacheHit,
    }
    faces.audit(session, audit)
  }
  return verdict.verdict === 'allow' ? 'allow' : { kind: 'ask', reason: verdict.reason }
}
