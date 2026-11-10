/**
 * The optional `ctx.systemoneDecisions` host service (design §"Public
 * interface", §"Architecture and files"): `forAgent(agent)` returns a
 * BoundDecisionRunner wiring the pure createDecisionRunner to real deps —
 * trusted settings, alias + pin-row route resolution, the durable quota provider
 * and the locked ledger append. The service itself NEVER triggers a request;
 * mounting it enables no business.
 *
 * Scope binding (design contract): a process-wide UUID agentId per Agent via
 * WeakMap; projectKey pinned to `projectKeyOf(path.resolve(header.cwd))`;
 * sessionId from the live `agent.session.id`; `scope(originSeq?)` captures
 * `Number(agent.session.seq)` synchronously; `validateScope` re-checks
 * project/session/agent/originSeq against the LIVE agent before route
 * resolution, before every reserve, and before answered. Missing cwd or an
 * invalid seq degrades to unconfigured — never a `process.cwd()` guess.
 * Agent dispose permanently invalidates the binder.
 *
 * @module @dsh-cc/decision-usage/service
 */

import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { projectKeyOf } from '@dsh-cc/sidecar-io'
import { createDecisionRunner } from '@dsh-cc/systemone'
import type {
  BoundDecisionRunner,
  DecisionBudgetPermitProvider,
  DecisionLedgerRow,
  DecisionRequest,
  DecisionRouteIdentity,
  DecisionRouteResolution,
  DecisionRun,
  DecisionScope,
} from '@dsh-cc/systemone'
import { decisionUsageDir } from './ledger.ts'
import { createDecisionQuota, DecisionQuotaError } from './quota.ts'
import type { DecisionQuota } from './quota.ts'
import { createWarnOnce, resolveDecisionRoute } from './route.ts'
import { decisionMaxRetries, decisionSessionLimits, decisionSettingsOf, parseDecisionSettings } from './settings.ts'
import type { DecisionSettingsParseResult } from './settings.ts'

/** The service face mounted at `ctx.systemoneDecisions`. */
export interface SystemOneDecisionsService {
  /** Bind the decision runner to one Agent. Never throws; never dispatches. */
  forAgent(agent: Agent): BoundDecisionRunner
}

/** Provider record face read by the index plugin (llm-pi-ai trusted section). */
export interface DecisionProviderRecord {
  baseURL?: unknown
  apiKeyEnv?: unknown
}

/**
 * The settings-service face the plugin reads provider records through: the
 * provenance-preserving trusted view (`SettingsCascadeProvider.trustedSection`,
 * duck-typed). The merged `describe()` read is provenance-lossy — it carries
 * project/local (repo-carried) overrides — so it is NEVER consulted here.
 */
export interface DecisionTrustedSettingsReader {
  trustedSection?(key: string): unknown
}

/** The `llm-pi-ai` settings namespace the trusted provider records live under. */
export const PROVIDER_RECORD_NAMESPACE = 'llm-pi-ai'

/**
 * Read one provider record from the TRUSTED view of `llm-pi-ai`.
 *
 * Fail-closed by design: when the settings service exposes no callable
 * `trustedSection`, the record is unresolvable (undefined ⇒ the route stays
 * unconfigured). There is deliberately no fallback to the merged
 * `readUserSection` read — that document mixes the project and local layers
 * in, so a repo-carried `providers.*` row could supply a decision endpoint or
 * credential reference (endpoint exfiltration into decisions adopted into
 * memory). No route is better than a repo-controlled one.
 * @param settings - the host settings service (possibly absent).
 * @param provider - the provider key to look up.
 * @returns the raw record, or undefined when unresolvable.
 */
export function readProviderRecord(
  settings: DecisionTrustedSettingsReader | undefined,
  provider: string,
): DecisionProviderRecord | undefined {
  try {
    if (typeof settings?.trustedSection !== 'function') return undefined
    const raw = settings.trustedSection(PROVIDER_RECORD_NAMESPACE)
    const providers = (raw as { providers?: unknown } | undefined)?.providers
    if (typeof providers !== 'object' || providers === null) return undefined
    const record = (providers as Record<string, unknown>)[provider]
    return typeof record === 'object' && record !== null
      ? (record as DecisionProviderRecord)
      : undefined
  } catch {
    return undefined
  }
}

/** Injectable seams: every host dependency is explicit for testability. */
export interface DecisionUsageServiceDeps {
  /** Live reader of the merged trusted `systemone-decisions` section. */
  readSettings(): unknown
  /** dshHome resolver; absent ⇒ the service degrades (reserves fail closed). */
  home?(): string
  /** Concrete route for one alias (resolveDetailedAlias(...).route). */
  resolveAlias(alias: string): { provider?: string | undefined; model?: string | undefined; protocol?: string | undefined } | undefined
  /** The trusted llm-pi-ai provider record for one provider key. */
  readProviderRecord(provider: string): DecisionProviderRecord | undefined
  /** Credential chain (credentials service); env spelling is the built-in fallback. */
  resolveCredential?(ref: string): Promise<string | undefined>
  /** Warn sink for route-configuration faults (collisions); deduped here. */
  warn?(message: string): void
  now?(): number
  uuid?(): string
  fetchImpl?: typeof fetch
}

interface BoundAgent {
  agentId: string
  invalidated: boolean
}

/**
 * Minted into scopes whose host facts are missing: shape-valid yet impossible
 * to validate (a real projectKey is a sha256 hex; a real session id that
 * collided would still fail the projectKey or agentId comparison).
 */
const INVALID_SCOPE_SENTINEL = 'invalid:decision-usage'

/** Sequence read: a non-safe or negative seq is an invalid marker (−1), never a guess. */
function currentSeq(agent: Agent): number {
  try {
    const seq = Number(agent.session.seq)
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : -1
  } catch {
    return -1
  }
}

/** Project key from the session header cwd; '' when cwd is missing/unusable. */
function currentProjectKey(agent: Agent): string {
  try {
    const cwd = agent.session.header.cwd as string | undefined
    if (typeof cwd !== 'string' || cwd.length === 0) return ''
    return projectKeyOf(resolvePath(cwd))
  } catch {
    return ''
  }
}

/** Live session id; '' when unreadable. */
function currentSessionId(agent: Agent): string {
  try {
    const id = agent.session.id as unknown
    return typeof id === 'string' && id.length > 0 ? id : ''
  } catch {
    return ''
  }
}

/** Create the service. All reads are live; the service never dispatches. */
export function createSystemOneDecisionsService(deps: DecisionUsageServiceDeps): SystemOneDecisionsService {
  const now = deps.now ?? (() => Date.now())
  const uuid = deps.uuid ?? (() => randomUUID())
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const boundByAgent = new WeakMap<Agent, BoundAgent>()
  const quotaByDir = new Map<string, DecisionQuota>()
  /** apiKey cache per provider key, warmed asynchronously before each run. */
  const apiKeyByProvider = new Map<string, string>()
  /** Warn-once route-configuration sink (folded-key collisions). */
  const warnRoute = createWarnOnce((message) => deps.warn?.(message))
  /** Warn-once invalid-section sink (issue #373): a silently disarmed
   *  decision route must be diagnosable from logs, not just from zero ledger. */
  const warnInvalidSection = createWarnOnce((message) => deps.warn?.(message))

  const readParsed = (): DecisionSettingsParseResult => {
    try {
      const parsed = parseDecisionSettings(deps.readSettings())
      if (parsed.status === 'invalid') {
        warnInvalidSection(`systemone-decisions: section invalid (${parsed.reason}) — no decision route is usable`)
      }
      return parsed
    } catch {
      // A reader fault is indistinguishable from a parse fault downstream; the
      // stable reason keeps the warn line greppable either way.
      warnInvalidSection('systemone-decisions: section invalid (schema-throw) — no decision route is usable')
      return { status: 'invalid', reason: 'schema-throw' }
    }
  }

  const envFallback = (ref: string | undefined): string | undefined => {
    if (ref === undefined || ref.length === 0) return undefined
    const value = process.env[ref]
    return value !== undefined && value.length > 0 ? value : undefined
  }

  const recordRef = (provider: string): { baseURL?: string; apiKeyEnv?: string } | undefined => {
    try {
      const record = deps.readProviderRecord(provider)
      if (record === undefined) return undefined
      const baseURL = typeof record.baseURL === 'string' && record.baseURL.length > 0 ? record.baseURL : undefined
      const apiKeyEnv = typeof record.apiKeyEnv === 'string' && record.apiKeyEnv.length > 0 ? record.apiKeyEnv : undefined
      if (baseURL === undefined) return undefined
      return { baseURL, ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}) }
    } catch {
      return undefined
    }
  }

  /**
   * Populate the apiKey cache for the alias's provider before a run: the
   * credentials chain is async while the runner's resolveRoute is sync, so
   * secrets are pre-resolved per run (rotation-friendly) and read back
   * synchronously at resolution. A miss is NOT an error — the gateway may
   * serve unauthenticated (upstream llm-pi-ai precedent).
   */
  async function warmCredentials(alias: string): Promise<void> {
    try {
      const provider = deps.resolveAlias(alias)?.provider
      if (provider === undefined || provider.length === 0 || apiKeyByProvider.has(provider)) return
      const ref = recordRef(provider)?.apiKeyEnv
      if (ref === undefined) return
      const key = deps.resolveCredential === undefined
        ? envFallback(ref)
        : (await deps.resolveCredential(ref)) ?? envFallback(ref)
      if (key !== undefined) apiKeyByProvider.set(provider, key)
    } catch {
      // Best-effort: resolution faults fold into `unconfigured` downstream.
    }
  }

  function quotaFor(scope: DecisionScope): DecisionQuota | undefined {
    try {
      const home = deps.home?.()
      if (home === undefined || home.length === 0) return undefined
      const dir = decisionUsageDir(home, scope.projectKey, scope.sessionId)
      let quota = quotaByDir.get(dir)
      if (quota === undefined) {
        quota = createDecisionQuota({
          dir,
          // An absent or invalid section degrades to ship defaults here: quota
          // admission may compute defaults, but nothing dispatches without a
          // usable route (see resolveRouteFor).
          limits: () => decisionSessionLimits(decisionSettingsOf(readParsed())),
          now,
          uuid,
        })
        quotaByDir.set(dir, quota)
      }
      return quota
    } catch {
      return undefined
    }
  }

  const reserveGlobal: DecisionBudgetPermitProvider = {
    reserve(input) {
      const quota = quotaFor(input.scope)
      if (quota === undefined) return Promise.resolve(undefined)
      return quota.reserve(input)
    },
  }

  async function appendRow(row: DecisionLedgerRow): Promise<void> {
    const quota = quotaFor(row.scope)
    if (quota === undefined) {
      throw new DecisionQuotaError('unwritable', 'decision-usage: no dsh home for the decision ledger')
    }
    await quota.append(row)
  }

  function resolveRouteFor(alias: string): DecisionRouteResolution | undefined {
    const parsed = readParsed()
    // Fail closed: a present-but-invalid section makes NO route usable, so a
    // malformed quota key can never be accompanied by a live route.
    if (parsed.status === 'invalid') return undefined
    const routes = parsed.status === 'valid' ? parsed.settings.routes : undefined
    return resolveDecisionRoute(alias, routes, {
      resolveAlias: (name) => deps.resolveAlias(name),
      connection(provider) {
        const record = recordRef(provider)
        if (record?.baseURL === undefined) return undefined
        const apiKey = apiKeyByProvider.get(provider) ?? envFallback(record.apiKeyEnv)
        return { baseURL: record.baseURL, ...(apiKey !== undefined ? { apiKey } : {}) }
      },
      ...(deps.warn !== undefined ? { warn: warnRoute } : {}),
    })
  }

  return {
    forAgent(agent) {
      let state = boundByAgent.get(agent)
      if (state === undefined) {
        state = { agentId: uuid(), invalidated: false }
        boundByAgent.set(agent, state)
        const bound = state
        try {
          // Agent dispose invalidates the binder permanently (agent-scoped ctx
          // unwinds its effects on disposal).
          agent.ctx.effect(() => () => {
            bound.invalidated = true
          }, 'decision-usage: forAgent')
        } catch {
          // A host without an effect-capable agent ctx keeps the binder live.
        }
      }
      const bound = state

      const validateScope = (scope: DecisionScope): boolean => {
        try {
          if (bound.invalidated) return false
          if (typeof scope !== 'object' || scope === null) return false
          if (scope.agentId !== bound.agentId) return false
          const projectKey = currentProjectKey(agent)
          if (projectKey === '' || scope.projectKey !== projectKey) return false
          const sessionId = currentSessionId(agent)
          if (sessionId === '' || scope.sessionId !== sessionId) return false
          const seq = currentSeq(agent)
          if (seq < 0) return false
          return Number.isSafeInteger(scope.originSeq) && scope.originSeq >= 0 && scope.originSeq <= seq
        } catch {
          return false
        }
      }

      /**
       * The scope mint. Missing host facts (cwd, session id, a broken seq)
       * are stamped with a sentinel so the runner's shape check passes and
       * validateScope rejects the run as UNCONFIGURED — the design's outcome
       * for missing configuration/routes, never a process.cwd guess.
       */
      const scope = (originSeq?: number): DecisionScope => {
        const seq = currentSeq(agent)
        return {
          projectKey: currentProjectKey(agent) || INVALID_SCOPE_SENTINEL,
          sessionId: currentSessionId(agent) || INVALID_SCOPE_SENTINEL,
          agentId: bound.agentId,
          originSeq: originSeq ?? (seq >= 0 ? seq : 0),
        }
      }

      const makeRunner = (): ReturnType<typeof createDecisionRunner> =>
        createDecisionRunner({
          validateScope,
          resolveRoute: (alias) => resolveRouteFor(alias),
          reserveGlobal,
          append: appendRow,
          now,
          uuid,
          fetchImpl,
          maxRetries: decisionMaxRetries(decisionSettingsOf(readParsed())),
        })

      return {
        scope,
        identifyRoute(alias: string, forScope: DecisionScope): DecisionRouteIdentity | undefined {
          try {
            return makeRunner().identifyRoute(alias, forScope)
          } catch {
            return undefined
          }
        },
        async run(request: DecisionRequest, options): Promise<DecisionRun> {
          // Secrets ride only through warmCredentials → resolveRoute; the run
          // re-reads settings, route pins, credentials and quota limits live.
          await warmCredentials(request.routeAlias)
          try {
            return await makeRunner().run(request, options)
          } catch {
            let decisionId: string
            try {
              decisionId = uuid()
            } catch {
              decisionId = 'unavailable'
            }
            return { status: 'unavailable', reason: 'error', decisionId }
          }
        },
      }
    },
  }
}
