/**
 * The async LLM-classifier stage for `auto` mode: owns arming (per call, from
 * the live `permissions.autoMode` settings slice), the memoized
 * `createLlmClassifier` instance, and the `permission/classifier` session
 * audit event. The plugin's `tools/pre-execute` listener (index.ts) only
 * wires this stage — the escalate-only decision flow lives here.
 *
 * Arming predicate (§4.4): `autoMode.classifier.enabled === true` AND an llm
 * stream capability is wired AND the alias route resolves. Enabled but
 * unarmable ⇒ disarm with ONE warning per process (plus an `unarmed` audit
 * event when a session is available) and the legacy decision path runs.
 *
 * @module @dsh-cc/permission-rules/auto-stage
 */

// The audit-event surface moved to ./classifier-audit.ts (size budget);
// re-exported here for the historical import sites.
export {
  CLASSIFIER_EVENT,
  appendSessionClassifier,
  foldClassifiers,
  foldDenyBackstop,
  sanitizeReason,
  REASON_CAP,
  DENY_STREAK_THRESHOLD,
  DENY_TOTAL_THRESHOLD,
  TRIP_NOTICE,
  type ClassifierAuditEventData,
} from './classifier-audit.ts'
import {
  DenyBackstop,
  foldClassifiers,
  sanitizeReason,
  DENY_STREAK_THRESHOLD,
  DENY_TOTAL_THRESHOLD,
  TRIP_NOTICE,
  type ClassifierAuditEventData,
} from './classifier-audit.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@dsh-cc/tools'
import { createLlmClassifier, expandSoftDeny, type ClassifierRoute, type LlmClassifier } from './llm-classifier.ts'
import { DEFAULT_GAUGE_ALLOW_THRESHOLD } from './gauge-adapter.ts'
import { createSystemOneLane, systemOneEscalate, type SystemOneLane } from './gauge-stage.ts'
import type { ClassifierBackendRoute } from './gauge-backend.ts'
import type { AutoModeSettings } from './settings-schema.ts'
import { DEFAULT_ALLOW_EXCEPTIONS, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY, expandSlot } from './slots.ts'
import { createContextBundler } from './context-bundle.ts'
import type { DecidedCall } from './decide.ts'
import type { PermissionMode, PermissionRule } from './types.ts'
import {
  BREAKER_FAILURE_TAGS,
  CLASSIFIER_BREAKER_THRESHOLD,
  RouteBreaker,
} from './classifier-breaker.ts'

// W1: the breaker machinery moved to ./classifier-breaker.ts (shared with the
// S7 PI probe); re-exported here for the historical import sites.
export { CLASSIFIER_BREAKER_THRESHOLD, BREAKER_FAILURE_TAGS, trailingRouteFailureStreak } from './classifier-breaker.ts'

// The autoMode settings hand-mirrors moved to ./settings-schema.ts (size budget);
// re-exported here for the historical import sites.
export type { AutoModeClassifierSettings, AutoModeProbeSettings, AutoModeSettings } from './settings-schema.ts'

/**
 * Structural dependency face the service supplies. `stream` is the llm
 * adapter (undefined when the llm service is not mounted); `resolveRoute`
 * resolves the configured alias route per call (undefined when unresolvable).
 */
export type AutoStageDeps = {
  /** The live `permissions` settings section (re-read on every call). */
  settingsRead(): { autoMode?: AutoModeSettings }
  /**
   * One-shot text completion over the auxiliary lane; `undefined` when no llm
   * service is mounted (the stage then disarms).
   */
  stream: ((opts: { provider: string; model: string; system: string; prompt: string; maxTokens: number; reasoningEffort?: string; signal?: AbortSignal }) => Promise<string>) | undefined
  /**
   * Resolve the configured classifier backend for this call's session
   * (§4.5): a chat route (`{backend:'chat'}`), the System One gauge lane
   * (`{backend:'systemone'}`), or `undefined` when unresolvable. May be
   * async (the gauge credential-ref chain resolves asynchronously); the
   * chat lane keeps returning the plain value as today.
   */
  resolveRoute(exec: ToolExecution): ClassifierBackendRoute | undefined | Promise<ClassifierBackendRoute | undefined>
  /** Process logger for the one-time disarm warning. */
  warn(message: string): void
  /** Durable audit sink (session append face, listener-owned). */
  audit(session: Session, event: ClassifierAuditEventData): void
  /**
   * Optional env-gated process-log sink for raw classifier output (R5) —
   * never session events; wired only when DSH_PERMISSION_CLASSIFIER_DEBUG=1.
   */
  debug?: (message: string) => void
  /**
   * The effective permission mode for one call (A8/A16): MUST resolve the
   * fold INCLUDING the `defaultMode` fallback (the stage itself has no
   * defaultMode). Wired from decide.ts's `effectiveMode`.
   */
  modeOf(exec: ToolExecution): PermissionMode
  /**
   * Fix B: the merged allow rules (pre-filtered view for the gauge evidence
   * fold — `decideDeps.rules().allow`; optional so older wirings omit it).
   */
  allowEvidenceRules?(): readonly PermissionRule[]
  /** Read-only tool names (same set DecideDeps uses) — filters the tool-history fold. */
  readOnlyTools: ReadonlySet<string>
  /**
   * S4/D5 trip action: pause auto mode for this call's session — inject the
   * notice (parameterized provenance) and switch the mode to `default`.
   * Wired in index.ts over `setMode(agent, 'default', notice)`.
   */
  pauseAuto(exec: ToolExecution, notice: string): void
  /**
   * One shell runner for the S3 enrichment snapshot (`undefined` ⇒ enrichment
   * skipped). `cwd` is the session cwd; `timeoutMs` bounds the child.
   */
  runCommand?: (cmd: string, opts: { cwd?: string; timeoutMs: number }) => Promise<string>
  /**
   * Optional fetch override for the System One gauge lane (test seam; the
   * production wiring leaves it unset and the global fetch is used).
   */
  fetchImpl?: typeof fetch
}

/**
 * The stage's contribution to one pre-execute decision: allow, an escalated
 * ask, a hard deny (S4/D4 — rides the existing deny→error-tool-result
 * delivery), or nothing (legacy path).
 */
export type StageOutcome = 'allow' | { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string; rule: string }

export type AutoStage = {
  /** Drop the memoized classifier so the next armed call rebuilds it (settings onChange). */
  rebuild(): void
  /**
   * Maybe escalate one verbose decision. Returns a final decision only for
   * the armed + `auto` + LOW-or-MEDIUM + `passthrough` slice (S3/A13 —
   * rule-derived asks are never arbitrated by the LLM); every other
   * shape returns undefined and the listener applies the shared post-waterfall
   * mapping unchanged — the LLM is then never invoked (I1–I3, I5). Within the
   * eligible slice, enabled-but-unavailable ⇒ `ask` with an availability
   * reason (D11 fail-to-prompt); a mid-flight mode change away from `auto`
   * discards the verdict (A8, audit `stale-mode`, never breaker-counted).
   */
  maybeEscalate(decided: DecidedCall, exec: ToolExecution): Promise<StageOutcome | undefined>
}

/** The autoMode settings slice, normalized for comparison and consumption. */
interface AutoModeSlice {
  softDeny: string[]
  hardDeny: string[]
  allowExceptions: string[]
  environment: string[]
  timeoutMs: number
  cacheMaxEntries: number
  /** Backend selection for unset `route` (default `'haiku'` at consumption). */
  backend: 'haiku' | 'auto'
  /** Raw configured gauge allow-gate threshold (no default here). */
  gaugeAllowThreshold: number | undefined
  /** Fix B opt-out (absence-preserving; the gauge stage consumes default ON). */
  gaugeAllowEvidence: boolean | undefined
  secondPass: boolean
  /** S5/D10: audit the raw classifier input when this flag is on. */
  auditFullText: boolean
  enabled: boolean
  raw: string
}

function readSlice(settings: { autoMode?: AutoModeSettings }): AutoModeSlice {
  const autoMode = settings.autoMode
  const classifier = autoMode?.classifier
  const softDeny = expandSoftDeny(autoMode?.soft_deny ?? ['$defaults'])
  const hardDeny = expandSlot(autoMode?.hard_deny ?? ['$defaults'], DEFAULT_HARD_DENY)
  const allowExceptions = expandSlot(autoMode?.allow ?? ['$defaults'], DEFAULT_ALLOW_EXCEPTIONS)
  const environment = expandSlot(autoMode?.environment ?? ['$defaults'], DEFAULT_ENVIRONMENT)
  return {
    softDeny,
    hardDeny,
    allowExceptions,
    environment,
    timeoutMs: classifier?.timeoutMs ?? 8000,
    cacheMaxEntries: classifier?.cacheMaxEntries ?? 256,
    backend: classifier?.backend ?? 'haiku',
    gaugeAllowThreshold: classifier?.gaugeAllowThreshold,
    gaugeAllowEvidence: classifier?.gaugeAllowEvidence,
    secondPass: classifier?.secondPass === true,
    auditFullText: classifier?.auditFullText === true,
    enabled: classifier?.enabled === true,
    raw: JSON.stringify([autoMode?.soft_deny, autoMode?.hard_deny, autoMode?.allow, autoMode?.environment, classifier]),
  }
}

/**
 * Build the stage. The classifier instance is memoized per autoMode slice:
 * `rebuild()` (wired to the plugin's settings onChange/reload) drops it, and
 * the next armed call rebuilds from the fresh slice — never per call.
 */
export function createAutoStage(deps: AutoStageDeps): AutoStage {
  let slice = readSlice(deps.settingsRead())
  /** The raw autoMode slice the memoized classifier was built from. */
  let builtRaw = slice.raw
  let classifier: LlmClassifier | undefined
  /** Warned-once flag for enabled-but-unarmable (per process). */
  let warnedUnarmed = false
  /**
   * W1: the shared per-route breaker (state + log seeding moved verbatim to
   * ./classifier-breaker.ts). `ctx` carries this call's exec + route for the
   * breaker audit payload.
   */
  const breaker = new RouteBreaker<{ exec: ToolExecution; route: ClassifierRoute }>({
    threshold: CLASSIFIER_BREAKER_THRESHOLD,
    failureTags: BREAKER_FAILURE_TAGS,
    label: 'permission classifier',
    outcomeNote: 'auto mode uses the legacy path',
    warn: deps.warn,
    auditBreakerOnce: ({ exec, route }, routeKey) => {
      const session = exec.agent?.session
      if (session === undefined) return
      deps.audit(session, {
        tool: exec.name,
        verdict: 'ask',
        failure: 'breaker',
        route: routeKey,
        provider: route.provider,
        model: route.model,
        latencyMs: 0,
        cacheHit: false,
      })
    },
  })
  /** S3/D7 context-bundle assembly (./context-bundle.ts, extracted for size). */
  const bundler = createContextBundler({
    readOnlyTools: deps.readOnlyTools,
    ...(deps.runCommand === undefined ? {} : { runCommand: deps.runCommand }),
  })
  /** S4/D5 per-session deny backstop (seed-once fold idiom). */
  const backstop = new DenyBackstop()

  const ensureClassifier = (): LlmClassifier => {
    if (classifier !== undefined && builtRaw === slice.raw) return classifier
    classifier = createLlmClassifier({
      // The route for each call is passed as data to classify() (per-call
      // argument, never ambient state) and the caller audits from the returned
      // classification — no session/route fields live on this stage, so
      // concurrent calls cannot cross-contaminate audit attribution.
      stream: (opts) => {
        const stream = deps.stream
        if (stream === undefined) throw new Error('llm service unmounted')
        return stream(opts)
      },
      softDeny: slice.softDeny,
      hardDeny: slice.hardDeny,
      allowExceptions: slice.allowExceptions,
      environment: slice.environment,
      timeoutMs: slice.timeoutMs,
      cacheMaxEntries: slice.cacheMaxEntries,
      ...(slice.secondPass ? { secondPass: true } : {}),
      ...(deps.debug === undefined ? {} : { debug: deps.debug }),
    })
    builtRaw = slice.raw
    return classifier
  }

  /** The gauge lane (verdict LRU + wire call), memoized like the chat classifier. */
  let gaugeLane: SystemOneLane | undefined
  const ensureGaugeLane = (): SystemOneLane => {
    if (gaugeLane !== undefined && builtRaw === slice.raw) return gaugeLane
    gaugeLane = createSystemOneLane(slice.cacheMaxEntries, {
      ...(deps.debug === undefined ? {} : { debug: deps.debug }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
    builtRaw = slice.raw
    return gaugeLane
  }

  const disarmUnarmed = (exec: ToolExecution): string => {
    if (!warnedUnarmed) {
      warnedUnarmed = true
      deps.warn('permission classifier: enabled but unarmable (llm service or model route unavailable); stage disarmed, auto mode uses the legacy path')
    }
    const session = exec.agent?.session
    if (session !== undefined) {
      deps.audit(session, {
        tool: exec.name,
        verdict: 'ask',
        failure: 'unarmed',
        latencyMs: 0,
        cacheHit: false,
      })
    }
    return 'auto-mode classifier unavailable: llm service or model route not armed'
  }

  /**
   * Seed the per-route breaker from the session's durable log (R3) via the
   * shared W1 machinery — lazily, once per session, on its first
   * breaker-eligible call.
   */
  function seedBreakerFromLog(exec: ToolExecution, routeKey: string, route: ClassifierRoute): void {
    const session = exec.agent?.session
    if (session === undefined) return
    breaker.seed(String(session.header.id), () => foldClassifiers(session.snapshotEvents()), routeKey, { exec, route })
  }

  return {
    rebuild(): void {
      // Drop the memoized classifier only when the autoMode slice actually
      // changed — an onChange for unrelated keys keeps the instance.
      const current = readSlice(deps.settingsRead())
      if (current.raw !== builtRaw) {
        slice = current
        classifier = undefined
        gaugeLane = undefined
      }
      // A settings change is the operator's "I fixed the lane": reset ALL
      // breaker state (the shared W1 machinery) plus the per-cwd
      // project-instruction cache (a rebuild picks up instruction edits).
      bundler.reset()
      breaker.reset()
    },

    async maybeEscalate(decided: DecidedCall, exec: ToolExecution): Promise<StageOutcome | undefined> {
      slice = readSlice(deps.settingsRead())
      if (!slice.enabled) return undefined
      // Eligibility (S3/A13): passthrough-only at LOW or MEDIUM risk in
      // `auto` mode, never read-only, and NEVER a waterfall `ask` — every
      // post-S1 ask is rule-derived and the stage never arbitrates those.
      if (decided.mode !== 'auto') return undefined
      if (decided.decision.kind !== 'passthrough') return undefined
      if (decided.risk.level !== 'LOW' && decided.risk.level !== 'MEDIUM') return undefined
      if (decided.isReadOnly) return undefined
      // D11: enabled-but-unavailable (unarmable / route-missing / breaker
      // open) ⇒ a stage-ELIGIBLE call fails to PROMPT with an availability
      // reason — never a silent fall-through to the downstream allow.
      const unavailable = (reason: string): StageOutcome => ({ kind: 'ask', reason })
      if (deps.stream === undefined) return unavailable(disarmUnarmed(exec))
      // The backend for this call is passed as data; the audit event is
      // appended from this call's own exec session — no ambient fields.
      const backendInfo = await deps.resolveRoute(exec)
      if (backendInfo === undefined) return unavailable(disarmUnarmed(exec))
      if (backendInfo.backend === 'systemone') {
        // D13: secondPass is skipped on the System One backend (no
        // reconsider prompt exists for typed decisions).
        return systemOneEscalate(exec, backendInfo, ensureGaugeLane(), {
          breaker,
          seed: seedBreakerFromLog,
          modeOf: (e) => deps.modeOf(e),
          audit: (session, event) => deps.audit(session, event),
          pauseAuto: (e, notice) => deps.pauseAuto(e, notice),
        }, {
          slots: {
            softDeny: slice.softDeny,
            hardDeny: slice.hardDeny,
            allowExceptions: slice.allowExceptions,
            environment: slice.environment,
          },
          gaugeAllowThreshold: slice.gaugeAllowThreshold ?? DEFAULT_GAUGE_ALLOW_THRESHOLD,
          gaugeAllowEvidence: slice.gaugeAllowEvidence,
          ...(deps.allowEvidenceRules === undefined ? {} : { allowEvidenceRules: deps.allowEvidenceRules() }),
          timeoutMs: slice.timeoutMs,
          auditFullText: slice.auditFullText,
        })
      }
      const route: ClassifierRoute | undefined = backendInfo.route
      if (route === undefined) return unavailable(disarmUnarmed(exec))
      const routeKey = `${route.provider}/${route.model}`
      seedBreakerFromLog(exec, routeKey, route)
      if (breaker.isOpen(routeKey)) {
        breaker.auditOnce(sessionIdOf(exec), routeKey, { exec, route })
        return unavailable(`auto-mode classifier unavailable: route ${routeKey} breaker open`)
      }
      // S3 context bundle (D7): transcript fold + project instructions +
      // work-discarding git-status enrichment (./context-bundle.ts).
      const session = exec.agent?.session
      const context = await bundler.build(exec)
      // A8 stale-mode epoch: capture the effective mode BEFORE the classify
      // await; re-fold after. If it left `auto`, the verdict is discarded and
      // audited `stale-mode` (never breaker-counted).
      const modeBefore = deps.modeOf(exec)
      const verdict = await ensureClassifier().classify(exec, { route, context })
      if (deps.modeOf(exec) !== modeBefore) {
        if (session !== undefined) {
          deps.audit(session, {
            tool: verdict.tool,
            ...(verdict.digest === undefined ? {} : { digest: verdict.digest }),
            verdict: 'ask',
            failure: 'stale-mode',
            latencyMs: verdict.latencyMs,
            cacheHit: false,
          })
        }
        return undefined
      }
      // F4 per-route breaker bookkeeping via the shared W1 machinery,
      // attributed to THIS call's route: any success (parsed verdict, cache
      // hit included) resets the streak; malformed/error/timeout increment
      // it; `cancelled` is caller noise and `unarmed` is a disarm outcome —
      // neither is counted (nor resets), and neither is `stale-mode`
      // (returned above before this fold).
      breaker.record(sessionIdOf(exec), routeKey, verdict.failure, { exec, route })
      const sessionId = sessionIdOf(exec)
      if (session !== undefined) {
        const audit: ClassifierAuditEventData = {
          tool: verdict.tool,
          digest: verdict.digest,
          // S5/D10: the raw input is audited only when the flag is on — read
          // fresh from the slice every call, so a settings toggle takes
          // effect on the very next event (no restart, no rebuild needed).
          ...(slice.auditFullText === true ? { input: verdict.input } : {}),
          verdict: verdict.verdict,
          ...(verdict.verdict === 'deny' ? { rule: verdict.rule } : {}),
          ...(exec.callId === undefined ? {} : { callId: exec.callId }),
          ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
          ...(verdict.routeAlias === undefined ? {} : { route: verdict.routeAlias, provider: verdict.provider, model: verdict.model }),
          reason: sanitizeReason(verdict.reason),
          ...(verdict.secondPass === true ? { secondPass: true } : {}),
          latencyMs: verdict.latencyMs,
          cacheHit: verdict.cacheHit,
        }
        if (verdict.verdict === 'deny') {
          // Seed BEFORE appending this call's audit event: the durable log is
          // folded once (without it) and the current verdict folds in via
          // record() — never double-counted.
          backstop.seed(sessionId, () => foldClassifiers(session.snapshotEvents()))
        }
        deps.audit(session, audit)
        // S4/D5 backstop: fold every audited verdict in-process. Crossing a
        // threshold trips exactly once per window — the appended `trip` marker
        // re-windows the fold to zero, so re-entry into auto restarts from a
        // fresh 3/20 and a duplicate notice/marker needs a fresh crossing.
        if (verdict.verdict === 'deny') {
          backstop.record(sessionId, audit)
          const { consecutive, total } = backstop.state(sessionId)
          if (consecutive >= DENY_STREAK_THRESHOLD || total >= DENY_TOTAL_THRESHOLD) {
            const marker: ClassifierAuditEventData = {
              tool: exec.name,
              verdict: 'ask',
              failure: 'trip',
              ...(exec.callId === undefined ? {} : { callId: exec.callId }),
              latencyMs: 0,
              cacheHit: false,
            }
            deps.audit(session, marker)
            backstop.record(sessionId, marker)
            deps.pauseAuto(exec, TRIP_NOTICE)
          }
        } else {
          backstop.record(sessionId, audit)
        }
      }
      if (verdict.verdict === 'deny') return { kind: 'deny', reason: verdict.reason, rule: verdict.rule }
      return verdict.verdict === 'allow' ? 'allow' : { kind: 'ask', reason: verdict.reason }
    },
  }
}

/** '' when the call carries no session (the breaker audit then no-ops). */
function sessionIdOf(exec: ToolExecution): string {
  const session = exec.agent?.session
  return session === undefined ? '' : String(session.header.id)
}
