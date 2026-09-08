/**
 * The resume-pins cordis plugin (plan §4.6-§4.10): one `PinStore`, the
 * `subagents-resume` settings namespace, the `tools/pre-execute` resume gate,
 * the `tools/post-execute` notice/annotation listeners, and the
 * `agent/request` runtime overlay.
 *
 * Zero-op when unmounted: pins are simply unread and behavior is today's
 * legacy behavior. When mounted, only pinned children are affected — a
 * missing pin is a legacy/foreign child (pass-through), and a same-epoch
 * steer delivery to a live Activation is untouched.
 *
 * Durability ordering: every deny persists `resume.state='blocked'` (reason)
 * through the shared store — an atomic disk rewrite plus synchronous cache
 * publication — BEFORE the deny decision returns, so the overlay listener
 * fails any unmonitored resume of that child visibly. An all-passing gate
 * clears the stored blocked state. Gate and overlay share the ONE store
 * exposed as the `resumePinStore` service (spawn capture prefers it too).
 *
 * @module @dsh-cc/subagent-resume-pins/plugin
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only augmentation pulls: the harness packages declare their Context
// members (`tools`, `sessionPersistence`, `agents`) and the tools Events on
// `@deepseek-ai/cordis` — imported for side effect so the listeners typecheck.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-agent'
import { loadAgentsDir, discoverBundledAgents, type AgentDefinition } from '@dsh-cc/claude-code-agents'
import { resolveDetailedAlias } from '@dsh-cc/model-aliases'
import { evaluateGate, type GateDecision, type GateEnv, type GateResolvedConfig } from './gate.ts'
import { PinBlockedError, applyPinOverlay } from './overlay.ts'
import { definitionFingerprint } from './fingerprint.ts'
import {
  RESUME_POLICY_NAMESPACE,
  readResumePolicy,
  type ResumePolicy,
} from './policy.ts'
import { serializePerKey, ExecutionNoticeBus } from './serialize.ts'
import { PinStore, type CorruptPin } from './store.ts'
import type { ResumePin } from './pin.ts'

/** Plugin configuration. */
export interface ResumePinsPluginConfig {
  /** Directory holding one `<childId>.json` pin file per child. */
  readonly pinsRoot: string
  /** Test seam / shared-store injection: use this store instead of a new one. */
  readonly store?: PinStore
}

/**
 * The settings section schema (plan §4.9): one constrained enum field per
 * knob with explicit defaults, mirroring how `cc-model-aliases` registers its
 * schema — invalid spellings are rejected at write time by the settings
 * service; `readResumePolicy` keeps tolerating hand-edited documents.
 */
export const ResumePolicySchema = z.object({
  onUnavailableModel: z.union([z.const('block'), z.const('route-current')]).default('block'),
  onDefinitionChanged: z.union([z.const('resume-with-notice'), z.const('block')]).default('resume-with-notice'),
  onWorkspaceChanged: z.union([z.const('resume-with-notice'), z.const('block')]).default('resume-with-notice'),
})

/** Cordis plugin id. */
export const name = 'cc-subagent-resume-pins'

/** The service key the spawn capture resolves to share the store. */
export const RESUME_PIN_STORE = 'resumePinStore'

/** The spawn-time git identity probe timeout (matches the capture probe). */
const GIT_PROBE_TIMEOUT_MS = 2_000

/** Delegation-discipline advisory suffixed to delegator-direction send_message results. */
const DELEGATION_DISCIPLINE_ADVISORY =
  'Delegation discipline: `send_message` continues this agent’s current assignment only; '
  + 'a NEW task needs a fresh `subagent_fork` spawn (a plain spawn, not `subagent_type: "fork"`).'

/**
 * Normalize one `git rev-parse` output to a cwd-anchored absolute path (git
 * prints repository-relative values like `.git`), realpath'ed when cheap so
 * the same repo reached through different paths compares equal. The `'unknown'`
 * sentinel passes through. Residual limit: two DIFFERENT repos initialized
 * sequentially at the same path normalize to the same path string — the
 * worktree↔standalone and cwd-move cases ARE detected; same-path replacement
 * of a standalone repo by another standalone repo is not.
 */
function normalizeGitPath(cwd: string, value: string): string {
  if (value === 'unknown' || value.length === 0) return 'unknown'
  const absolute = isAbsolute(value) ? value : join(cwd, value)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Best-effort current git identity of one cwd ('unknown' sentinels on failure). */
function gitIdentity(cwd: string): { gitDir: string; gitCommonDir: string; branch: string } {
  try {
    const result = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'],
      { timeout: GIT_PROBE_TIMEOUT_MS, encoding: 'utf8' },
    )
    const [gitDir, gitCommonDir, branch] = (result.stdout ?? '').trim().split('\n')
    if (result.status !== 0 || gitDir === undefined || gitCommonDir === undefined || branch === undefined) {
      return { gitDir: 'unknown', gitCommonDir: 'unknown', branch: 'unknown' }
    }
    return {
      gitDir: normalizeGitPath(cwd, gitDir),
      gitCommonDir: normalizeGitPath(cwd, gitCommonDir),
      branch,
    }
  } catch {
    return { gitDir: 'unknown', gitCommonDir: 'unknown', branch: 'unknown' }
  }
}

/**
 * Re-fingerprint a named definition OUTSIDE the registry cache (§4.4).
 * Bundled pins re-fingerprint from the CURRENT in-package bundled registry.
 * Project/user pins re-read the EXACT recorded `baseDir`+`filename`, falling
 * back to an `agentType` lookup only when the recorded file is gone (that is
 * the changed-by-replacement class). `'missing'` for a gone/unreadable
 * definition; `null` when no current information exists (a pin without a
 * file location).
 */
export async function refingerprintDefinition(pin: ResumePin): Promise<string | 'missing' | null> {
  const definition = pin.definition
  if (definition.kind !== 'named') return null
  if (definition.source === 'bundled') {
    try {
      const found = discoverBundledAgents().find(def => def.agentType === definition.agentType)
      return found === undefined ? 'missing' : definitionFingerprint(found)
    } catch {
      return 'missing'
    }
  }
  if (definition.baseDir === undefined || definition.filename === undefined) return null
  try {
    const defs: AgentDefinition[] = await loadAgentsDir(definition.baseDir, definition.source)
    const found = defs.find(def => def.filename === definition.filename)
      ?? defs.find(def => def.agentType === definition.agentType)
    return found === undefined ? 'missing' : definitionFingerprint(found)
  } catch {
    return 'missing'
  }
}

/** The text of one tool result's content blocks (for annotation matching). */
function resultText(result: { content: readonly ContentBlock[] }): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Mount the resume-pin gate, overlay, notices, and policy namespace.
 * @param ctx - the plug context.
 * @param config - pins root (or an injected store).
 */
export function apply(ctx: Context, config: ResumePinsPluginConfig): void {
  const store = config.store ?? new PinStore(config.pinsRoot)
  ctx.provide(RESUME_PIN_STORE, store)

  // §4.9: register the policy namespace when a settings provider is mounted;
  // read LIVE on every gate evaluation (a flip is authoritative immediately).
  const settings = ctx.get('settings') as
    | { register: (ns: unknown, schema: unknown) => { get?: () => unknown } | undefined }
    | undefined
  const scope = settings?.register?.(RESUME_POLICY_NAMESPACE, ResumePolicySchema)
  const policy = (): ResumePolicy => readResumePolicy(scope?.get?.())

  // Pre→post communication: gate-computed notices for a child's NEXT
  // send_message result, keyed by the tool execution identity (`exec.token`,
  // the registry-assigned opaque call identity present on BOTH the pre- and
  // post-execute payloads) so a failing send can never leak its notice into a
  // later call. Per-child promise chains serialize gate evaluation +
  // persistence + delivery admission, so concurrent sends to one cold child
  // cannot interleave their decisions or cross-deliver notices.
  const pendingNotices = new ExecutionNoticeBus()
  const childLocks = new Map<string, Promise<unknown>>()

  /**
   * Lookup-level read: an unsafe childId (harness session ids are
   * unconstrained branded strings) is a validation failure at LOOKUP level →
   * passthrough `undefined`, exactly like an absent pin. Only WRITE paths
   * reject unsafe ids.
   */
  const safeRead = (childId: string): ResumePin | CorruptPin | undefined => {
    try {
      return store.read(childId)
    } catch {
      return undefined
    }
  }

  const readPin = safeRead

  /**
   * Persist a deny to the pin BEFORE the decision returns (§4.6 ordering).
   * Propagates write failure: the caller keeps denying with a reason that
   * names the persistence failure — a pending deny is never downgraded to a
   * delivery just because the durable marker could not be written.
   */
  const persistBlocked = (pin: ResumePin, decision: GateDecision): void => {
    if (decision.action !== 'deny') return
    store.update(pin.childId, draft => {
      draft.resume = { state: 'blocked', reason: decision.reason }
      draft.lastNotice = decision.reason
    })
  }

  /**
   * Persist a passing evaluation: clear blocked state, cache overlay/notices.
   * Propagates write failure — a pending PASS/route-current must not deliver
   * until the required durable state is published; the caller denies with
   * `STORE_WRITE_FAILURE` instead.
   */
  const persistPass = (pin: ResumePin, decision: Extract<GateDecision, { action: 'pass' }>): void => {
    store.update(pin.childId, draft => {
      draft.resume = {
        state: 'ok',
        ...(decision.overlay !== undefined ? { overlay: decision.overlay } : {}),
      }
      draft.lastNotice = decision.notices.length > 0 ? decision.notices.join('\n') : undefined
    })
  }

  const gateEnv = async (pin: ResumePin, callingAgent: unknown): Promise<GateEnv> => {
    let sessionExists = false
    try {
      const persistence = (ctx as unknown as { sessionPersistence?: { readStoredRevision: (id: ReturnType<typeof SessionId>, signal?: AbortSignal) => Promise<unknown> } }).sessionPersistence
      if (persistence?.readStoredRevision !== undefined) {
        sessionExists = (await persistence.readStoredRevision(SessionId(pin.childId))) !== undefined
      }
    } catch {
      sessionExists = false
    }
    let restrictableNames: ReadonlySet<string> = new Set()
    try {
      const view = (ctx.tools as unknown as { view?: (agent: unknown) => { restrictableNames?: ReadonlySet<string> } | undefined })
        .view?.(callingAgent)
      restrictableNames = view?.restrictableNames ?? new Set()
    } catch {
      restrictableNames = new Set()
    }
    // The calling parent's CURRENT route (AgentOptions) — the route-current
    // fallback overlays onto this, never onto the pinned tuple.
    const currentRoute = (callingAgent as { options?: GateEnv['currentRoute'] } | undefined)?.options
    const llm = ctx.get('llm') as
      | { resolveCallConfig?: (config: { provider: string; model: string; maxTokens?: number; reasoningEffort?: string }) => Promise<GateResolvedConfig> }
      | undefined
    return {
      sessionExists,
      cwdExists: existsSync(pin.workspace.cwd),
      currentGit: gitIdentity(pin.workspace.cwd),
      currentDefinitionFingerprint: await refingerprintDefinition(pin),
      restrictableNames,
      resolveCallConfig: config => {
        if (llm?.resolveCallConfig === undefined) return Promise.reject(new Error('no llm service for the availability preflight'))
        return llm.resolveCallConfig(config)
      },
      resolveDetailed: selector => resolveDetailedAlias(ctx, selector) as unknown as ReturnType<GateEnv['resolveDetailed']>,
      ...(currentRoute !== undefined ? { currentRoute } : {}),
    }
  }

  // §4.6: the resume gate. Fires on every tool call; acts only on
  // `send_message` to a PINNED child with no live Activation. Gate
  // evaluation + persistence + delivery admission are serialized per child.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'send_message') return next()
    const target = (exec.arguments as { agent_id?: unknown } | null)?.agent_id
    if (typeof target !== 'string' || target.length === 0) return next()
    return serializePerKey(childLocks, target, async () => {
      const found = readPin(target)
      if (found === undefined) return next() // legacy/foreign child: pass through
      if ('kind' in found) {
        return { kind: 'deny' as const, reason: `[PIN_UNREADABLE] resume pin for ${target} is unreadable (${found.reason}); refusing to resume` }
      }
      // Same-epoch steer to a live agent: untouched.
      if (ctx.agents.get(SessionId(target)) !== undefined) return next()
      const decision = await evaluateGate(found, await gateEnv(found, exec.agent), policy())
      if (decision.action === 'deny') {
        try {
          persistBlocked(found, decision)
        } catch (error) {
          // Fail closed: the deny stands even when the durable marker could
          // not be written; the reason names the persistence failure.
          return {
            kind: 'deny' as const,
            reason: `${decision.reason} (resume pin persistence failed: ${(error as Error).message})`,
          }
        }
        return { kind: 'deny' as const, reason: decision.reason }
      }
      // Durability ordering: the pass result (cleared state, overlay cache,
      // notices) is published synchronously BEFORE the delivery happens —
      // a store-write failure denies with a store-write-failure code and the
      // delivery never happens.
      try {
        persistPass(found, decision)
      } catch (error) {
        return {
          kind: 'deny' as const,
          reason: `[STORE_WRITE_FAILURE] resume pin could not publish the gate result for ${target} (${(error as Error).message}); refusing to resume until the durable state is written`,
        }
      }
      if (decision.notices.length > 0) {
        pendingNotices.publish(exec.token, decision.notices)
      }
      return next()
    })
  })

  // §4.7: prefix the gate's notices onto the send_message result; annotate
  // list_agents for pinned children.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const out = await next()
    if (out.kind !== 'accept') return out
    if (exec.name === 'send_message') {
      const notices = pendingNotices.take(exec.token)
      const target = (exec.arguments as { subagent_id?: unknown } | null)?.subagent_id
      const callerParent = (exec.agent as { session?: { header?: { parentSession?: unknown } } } | undefined)
        ?.session?.header?.parentSession
      // Child→parent result reports (explicitly instructed by the harness continuable initial
      // prompt) are same-conversation sends: never annotate them. exec.agent === undefined or a
      // non-matching parentSession is the delegator direction → the advisory fires.
      const delegatorDirection = typeof target === 'string' && target.length > 0 && String(callerParent) !== target
      if (notices.length > 0 || delegatorDirection) {
        return {
          kind: 'accept',
          content: [
            ...notices.map(text => ({ type: 'text' as const, text })),
            ...(out.content ?? []),
            ...(delegatorDirection ? [{ type: 'text' as const, text: DELEGATION_DISCIPLINE_ADVISORY }] : []),
          ],
        }
      }
      return out
    }
    if (exec.name === 'list_agents') {
      const annotations: string[] = []
      const text = resultText(result)
      for (const childId of store.ids()) {
        if (!text.includes(childId)) continue
        const pin = readPin(childId)
        if (pin === undefined) continue
        if ('kind' in pin) {
          annotations.push(`[resume-pin] ${childId}: state blocked (pin unreadable)`)
          continue
        }
        const current = await refingerprintDefinition(pin)
        const pinnedFingerprint = pin.definition.kind === 'named' ? pin.definition.fingerprint : undefined
        const definitionChanged = current !== null && (pinnedFingerprint === undefined || current !== pinnedFingerprint)
        const parts = [`state ${pin.resume.state}`]
        if (definitionChanged) parts.push('definition changed')
        if (pin.lastNotice !== undefined) parts.push(pin.lastNotice)
        annotations.push(`[resume-pin] ${childId}: ${parts.join('; ')}`)
      }
      if (annotations.length > 0) {
        annotations.push(
          'Delegation discipline: an idle/ready child stays continuable for its CURRENT assignment only'
          + ' — a new task needs a fresh `subagent_fork` spawn (plain spawn, not `subagent_type: "fork"`).',
        )
        return { kind: 'accept', content: [...(out.content ?? []), { type: 'text' as const, text: annotations.join('\n') }] }
      }
    }
    return out
  })

  // §4.8: the request-time overlay — every turn of a pinned child, whatever
  // resumed it. Miss → passthrough; blocked or corrupt → visible failure
  // (fail-closed: the corrupt pin file IS the durable blocked marker). The
  // read is read-through: a file deleted or corrupted out-of-band is never
  // served from the cache.
  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    if (agent === undefined) return resolved
    const pin = safeRead(String(agent.id))
    if (pin === undefined) return resolved
    if ('kind' in pin) {
      throw new PinBlockedError(`resume pin for ${String(agent.id)} is unreadable (${pin.reason}); refusing the request`)
    }
    try {
      return applyPinOverlay(resolved as unknown as Record<string, unknown>, pin) as unknown as typeof resolved
    } catch (error) {
      if (error instanceof PinBlockedError) throw error
      return resolved
    }
  })
}
