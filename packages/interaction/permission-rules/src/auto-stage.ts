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

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@dsh-cc/tools'
import { createLlmClassifier, expandSoftDeny, type ClassifierRoute, type LlmClassifier } from './llm-classifier.ts'
import { DEFAULT_ALLOW_EXCEPTIONS, DEFAULT_ENVIRONMENT, expandSlot } from './slots.ts'
import { createContextBundler } from './context-bundle.ts'
import type { DecidedCall } from './decide.ts'
import type { PermissionMode } from './types.ts'
import {
  BREAKER_FAILURE_TAGS,
  CLASSIFIER_BREAKER_THRESHOLD,
  RouteBreaker,
} from './classifier-breaker.ts'

// W1: the breaker machinery moved to ./classifier-breaker.ts (shared with the
// S7 PI probe); re-exported here for the historical import sites.
export { CLASSIFIER_BREAKER_THRESHOLD, BREAKER_FAILURE_TAGS, trailingRouteFailureStreak } from './classifier-breaker.ts'

/** `permissions.autoMode.classifier` — the plugin-local hand-mirror of the shared AutoModeClassifierSchema. */
export interface AutoModeClassifierSettings {
  /** Master switch for the LLM risk classifier stage (default `false`). */
  enabled?: boolean
  /** Model route used for classification (default `'haiku'`). */
  route?: string
  /** Per-call timeout in milliseconds (default `8000`). */
  timeoutMs?: number
  /** Verdict cache size in entries (default `256`). */
  cacheMaxEntries?: number
  /**
   * D13 reconsider pass (default FALSE, absence-preserving): a non-failure
   * `ask` verdict earns ONE reconsider call; only ask→allow is possible.
   */
  secondPass?: boolean
}

/** `permissions.autoMode.probe` — the plugin-local hand-mirror of the shared AutoModeProbe schema (S7/W3). */
export interface AutoModeProbeSettings {
  /** Master switch for the input-layer PI probe (default `true`). */
  enabled?: boolean
  /** Model route used for the probe (default `'haiku'`). */
  route?: string
  /** Per-call timeout in milliseconds (default `5000`). */
  timeoutMs?: number
  /** Scan-set override (exact tool names or trailing-`*` prefix patterns); replaces the default set entirely. */
  toolPatterns?: string[]
}

/** `permissions.autoMode` — the plugin-local hand-mirror of the shared AutoModeSchema. */
export interface AutoModeSettings {
  /**
   * Soft-deny hints evaluated by the classifier, in CC's snake_case spelling.
   * `$defaults` expansion happens at consumption time — the schema never
   * expands it.
   */
  soft_deny?: string[]
  /**
   * Allow-exception prose evaluated after the soft-deny rules (S2), in CC's
   * snake_case spelling. `$defaults` expansion happens at consumption time —
   * the schema never expands it.
   */
  allow?: string[]
  /**
   * Environment trust-boundary prose (S2): what the classifier treats as
   * in-scope. `$defaults` expansion happens at consumption time.
   */
  environment?: string[]
  /**
   * Suspend EVERY bash and PowerShell allow rule (whole-tool and content)
   * in `auto` mode — the hard override on the otherwise best-effort
   * suspension list (design doc D1/R5). Absent ⇒ `false`.
   */
  classifyAllShell?: boolean
  /** LLM risk classifier configuration; absent when the section omits it. */
  classifier?: AutoModeClassifierSettings
  /** Input-layer PI-probe configuration (S7); absent when the section omits it. */
  probe?: AutoModeProbeSettings
}

/** The session event type carrying one classifier verdict audit record. */
export const CLASSIFIER_EVENT = 'permission/classifier'

// Cross-repo event registration: postdates the upstream session catalog
// (same pattern as `permission/mode` / `permission/session-allow`).
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(CLASSIFIER_EVENT)

/** The `permission/classifier` payload. The raw classifier input NEVER appears — only its digest. */
export interface ClassifierAuditEventData {
  /** The tool the verdict is about. */
  tool: string
  /** sha256 of the rendered classifier input (absent on the arming `unarmed` record). */
  digest?: string
  verdict: 'allow' | 'ask'
  failure?: 'timeout' | 'error' | 'malformed' | 'unarmed' | 'breaker' | 'cancelled' | 'stale-mode'
  /** Short model/availability reason (D10): ≤120 chars, control chars stripped at write. */
  reason?: string
  /** Present (true) when the D13 reconsider pass ran for this verdict. */
  secondPass?: boolean
  route?: string
  provider?: string
  model?: string
  latencyMs: number
  cacheHit: boolean
}

/** D10: audit `reason` cap. */
export const REASON_CAP = 120

/**
 * Strip control characters and cap an audit reason at {@link REASON_CAP}
 * chars. Shared with the S7 PI probe (same package — D10).
 */
export function sanitizeReason(reason: string): string {
  return reason.replace(/[\x00-\x1f\x7f]/g, '').slice(0, REASON_CAP)
}

/** Wire face of one log event that may or may not be a `permission/classifier`. */
interface ClassifierWire {
  readonly type: string
  readonly data: ClassifierAuditEventData
}

/**
 * Append one `permission/classifier` audit record through the widened session
 * append face (same cross-pin strategy as `./mode.ts` and
 * `./session-allowlist.ts`).
 */
export function appendSessionClassifier(session: Session, data: ClassifierAuditEventData): void {
  type AppendFace = { append(type: string, data: ClassifierAuditEventData): unknown }
  ;(session as unknown as AppendFace).append(CLASSIFIER_EVENT, data)
}

/**
 * Fold a session log into the classifier verdict records it carries, in log
 * order. Foreign event types are skipped; resume/replay reconstructs why a
 * call did or did not prompt.
 */
export function foldClassifiers(events: readonly SessionEvent[]): ClassifierAuditEventData[] {
  const out: ClassifierAuditEventData[] = []
  for (const event of events) {
    const wire = event as unknown as ClassifierWire
    if (wire.type !== CLASSIFIER_EVENT || typeof wire.data !== 'object' || wire.data === null) continue
    out.push(wire.data)
  }
  return out
}

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
  /** Resolve the configured classifier route for this call's session. */
  resolveRoute(exec: ToolExecution): { provider: string; model: string; reasoningEffort?: string } | undefined
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
  /** Read-only tool names (same set DecideDeps uses) — filters the tool-history fold. */
  readOnlyTools: ReadonlySet<string>
  /**
   * One shell runner for the S3 enrichment snapshot (`undefined` ⇒ enrichment
   * skipped). `cwd` is the session cwd; `timeoutMs` bounds the child.
   */
  runCommand?: (cmd: string, opts: { cwd?: string; timeoutMs: number }) => Promise<string>
}

/** The stage's contribution to one pre-execute decision: allow, an escalated ask, or nothing (legacy path). */
export type StageOutcome = 'allow' | { kind: 'ask'; reason: string }

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
  allowExceptions: string[]
  environment: string[]
  route: string
  timeoutMs: number
  cacheMaxEntries: number
  secondPass: boolean
  enabled: boolean
  raw: string
}

function readSlice(settings: { autoMode?: AutoModeSettings }): AutoModeSlice {
  const autoMode = settings.autoMode
  const classifier = autoMode?.classifier
  const softDeny = expandSoftDeny(autoMode?.soft_deny ?? ['$defaults'])
  const allowExceptions = expandSlot(autoMode?.allow ?? ['$defaults'], DEFAULT_ALLOW_EXCEPTIONS)
  const environment = expandSlot(autoMode?.environment ?? ['$defaults'], DEFAULT_ENVIRONMENT)
  return {
    softDeny,
    allowExceptions,
    environment,
    route: classifier?.route ?? 'haiku',
    timeoutMs: classifier?.timeoutMs ?? 8000,
    cacheMaxEntries: classifier?.cacheMaxEntries ?? 256,
    secondPass: classifier?.secondPass === true,
    enabled: classifier?.enabled === true,
    raw: JSON.stringify([autoMode?.soft_deny, autoMode?.allow, autoMode?.environment, classifier]),
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
      // The route for this call is passed to classify as data; the audit event
      // is appended from this call's own exec session — no ambient fields.
      const route: ClassifierRoute | undefined = deps.resolveRoute(exec)
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
      if (session !== undefined) {
        deps.audit(session, {
          tool: verdict.tool,
          digest: verdict.digest,
          verdict: verdict.verdict,
          ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
          ...(verdict.routeAlias === undefined ? {} : { route: verdict.routeAlias, provider: verdict.provider, model: verdict.model }),
          reason: sanitizeReason(verdict.reason),
          ...(verdict.secondPass === true ? { secondPass: true } : {}),
          latencyMs: verdict.latencyMs,
          cacheHit: verdict.cacheHit,
        })
      }
      return verdict.verdict === 'allow' ? 'allow' : { kind: 'ask', reason: verdict.reason }
    },
  }
}

/** '' when the call carries no session (the breaker audit then no-ops). */
function sessionIdOf(exec: ToolExecution): string {
  const session = exec.agent?.session
  return session === undefined ? '' : String(session.header.id)
}
