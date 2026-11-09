/**
 * Public contract types of the SystemOne decision runner (design doc
 * 2026-11-02-systemone-02-decision-runtime-metering.md §"Public interface",
 * §"Ledger, privacy and reporting"). Pure type surface shared by the runner,
 * the host service and business consumers — no runtime code, no I/O.
 *
 * @module @dsh-cc/systemone/decision-types
 */

import type { SystemOneAnswer, SystemOneQuestion, SystemOneUsage } from './client.ts'

/** The closed kebab-case feature union for this design set (doc-verbatim). */
export type DecisionFeature =
  | 'memory-recall'
  | 'memory-extraction'
  | 'tool-discovery'
  | 'skill-recommendation'
  | 'support-triage'
  | 'audit-shortlist'
  | 'moa-context-routing'
  | 'moa-acceptance'
  | 'summary-gate'
  | 'reducer-gate'

/** Metering scope: quota is keyed on (projectKey, sessionId). */
export interface DecisionScope {
  projectKey: string
  sessionId: string
  agentId: string
  originSeq: number
}

export interface DecisionRequest {
  feature: DecisionFeature
  mode: 'shadow' | 'active'
  routeAlias: string
  questionVersion: string
  policyVersion: string
  scope: DecisionScope
  state: unknown
  questions: Record<string, SystemOneQuestion>
  timeoutMs: number
  maxInputTokens: number
  signal: AbortSignal
}

/** The unavailable reasons of a run; ledger reasonCodes never appear here. */
export type DecisionUnavailableReason = 'unconfigured' | 'budget' | 'timeout' | 'cancelled' | 'malformed' | 'error'

export type DecisionRun =
  | {
      status: 'answered'
      answers: Record<string, SystemOneAnswer>
      model: string
      usage: SystemOneUsage
      decisionId: string
      inputHash: string
    }
  | { status: 'unavailable'; reason: DecisionUnavailableReason; decisionId: string }

/** Keyless route identity for callers (no API key, baseURL or actualModelId). */
export interface DecisionRouteIdentity {
  provider: string
  model: string
  revision: string
  perRequestTokens: number
  perQuestionTokens: number
  maxQuestions: number
  maxOutputTokens: number
}

/** Full route resolution; the runner consumes the secrets but never records them. */
export interface DecisionRouteResolution {
  provider: string
  model: string
  actualModelId: string
  baseURL: string
  apiKey?: string
  revision: string
  perRequestTokens: number
  perQuestionTokens: number
  maxOutputTokens: number
  maxQuestions: number
}

export interface DecisionRunner {
  identifyRoute(alias: string, scope: DecisionScope): DecisionRouteIdentity | undefined
  run(request: DecisionRequest, options?: { budgetPermit?: DecisionBudgetPermitProvider }): Promise<DecisionRun>
}

/** The host service adds a bound scope source on top of the pure interface. */
export interface BoundDecisionRunner extends DecisionRunner {
  scope(originSeq?: number): DecisionScope
}

export interface DecisionBudgetPermitProvider {
  reserve(input: {
    decisionId: string
    scope: DecisionScope
    feature: DecisionFeature
    attempt: number
    inputTokens: number
    outputTokens: number
    signal: AbortSignal
  }): Promise<DecisionBudgetPermit | undefined>
}

/** The terminal outcomes a permit settles with (doc-verbatim shapes). */
export type DecisionPermitOutcome =
  | { kind: 'actual'; usage: SystemOneUsage }
  | { kind: 'unknown' }
  | { kind: 'not-dispatched' }

export interface DecisionBudgetPermit {
  settle(outcome: DecisionPermitOutcome): Promise<void>
}

/** Ledger phases; a row phase is reserve / dispatch / settle / outcome. */
export type DecisionLedgerPhase = 'reserve' | 'dispatch' | 'settle' | 'outcome'

/** The closed ledger reasonCode set (ledger-only, never DecisionRun reasons). */
export type DecisionLedgerReasonCode =
  | 'model-version-mismatch'
  | 'accounting-overrun'
  | 'quota-frozen'
  | 'quota-lock-unavailable'
  | 'torn-tail'

/** Fixed outcome vocabulary per phase. */
export type DecisionLedgerOutcome =
  | 'reserved'
  | 'dispatched'
  | 'actual'
  | 'unknown'
  | 'not-dispatched'
  | 'answered'
  | DecisionUnavailableReason

/**
 * One schemaVersion=1 ledger record. Carries identifiers, versions and token
 * counts only: no API key, baseURL, state or question body text, no paths,
 * no raw error bodies and no model answers.
 */
export interface DecisionLedgerRow {
  schemaVersion: 1
  eventId: string
  decisionId: string
  attempt: number
  phase: DecisionLedgerPhase
  time: number
  scope: DecisionScope
  feature: DecisionFeature
  mode: 'shadow' | 'active'
  provider: string
  requestedModel: string
  /** null while an attempt has no response yet. */
  actualModel: string | null
  routeRevision: string
  questionVersion: string
  policyVersion: string
  inputHash: string
  reservedInputTokens?: number
  reservedOutputTokens?: number
  actualInputTokens?: number
  actualOutputTokens?: number
  latencyMs: number
  outcome: DecisionLedgerOutcome
  reasonCode?: DecisionLedgerReasonCode
}

/** Constructor deps of the pure runner; all injected, so tests need no I/O. */
export interface DecisionRunnerDeps {
  /** Re-checked before route resolution, before every reserve and before answered. */
  validateScope(scope: DecisionScope): boolean
  resolveRoute(alias: string, scope: DecisionScope): DecisionRouteResolution | undefined
  reserveGlobal: DecisionBudgetPermitProvider
  /** Ledger append; a rejection folds into the run as error, never escapes. */
  append(row: DecisionLedgerRow): void | Promise<void>
  now(): number
  uuid(): string
  fetchImpl: typeof fetch
  /**
   * 429 retries after the first attempt, clamped into 0..2 by the client;
   * the new runner defaults to 0 (the legacy client keeps its own default).
   */
  maxRetries?: number
}
