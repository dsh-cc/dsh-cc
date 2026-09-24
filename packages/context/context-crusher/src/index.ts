/**
 * CCR (Compress-Cache-Retrieve) reversible tool-output compression.
 *
 * A `tools/post-execute` listener (registered `{ prepend: true }`, composed
 * post-`next()`) compresses large grep/log-shaped tool results, persists the
 * original in a content-addressed store, and appends a `ccr://<hash>` marker;
 * the `context_retrieve({ hash })` agent tool restores the original. Defaults
 * are `enabled: false, mode: 'dry-run'` — nothing replaces until opted in.
 *
 * Fail-closed everywhere: a missing `dshHomePath` force-disables the crusher,
 * and every store/ledger/sweep I/O error degrades to passthrough — a throw in
 * this waterfall would turn the user's tool result into an error (data loss).
 *
 * @module @dsh-cc/context-crusher
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import type { PostToolDecision, ToolExecution, ToolExecutionResult, ToolRunContext } from '@dsh-cc/tools'
import { defineTool } from '@dsh-cc/tools'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import { resolveConfig, overlaySettings, Config } from './config.ts'
import { registerSettings } from './settings.ts'
import { readSecretsSettings, redact, type SecretsSettings } from '@dsh-cc/transcript-secrets'
import { route } from './router.ts'
import { reduceToolOutput } from './reducer.ts'
import { CrusherStore, shortHash } from './store.ts'
import { SavingsLedger } from './ledger.ts'
import { buildMarker, CCR_HASH_RE } from './marker.ts'
import { joinTextBlocks } from './defer/counter.ts'
import { Deferral } from './defer/pass.ts'
import type { CrusherConfig, LedgerRow, RetrieveError, ResolvedConfig } from './types.ts'

export { resolveConfig, overlaySettings, DEFAULTS, DEFAULT_PROTECTED_TOOLS, Config } from './config.ts'
export { SETTINGS_NAMESPACE } from './settings.ts'
export { route } from './router.ts'
export { REDUCER_COMMAND_TOOLS, invocationCommand, isReducerEligible, reduceToolOutput, truncateView } from './reducer.ts'
export { parseReceipt, renderReceipt, ReceiptSchema } from './receipt.ts'
export { verifyReceipt } from './verifier.ts'
export { CrusherStore, shortHash, STORE_MAX_ENTRIES, STORE_TTL_MS } from './store.ts'
export { SavingsLedger } from './ledger.ts'
export { buildMarker, parseMarker } from './marker.ts'
export { foldCounters } from './fold-counters.ts'
export type { FoldCounterMaterials } from './fold-counters.ts'
export { Deferral } from './defer/pass.ts'
export { evaluateDeferGate } from './defer/gate.ts'
export { attemptSwap } from './defer/swap.ts'
export {
  DeferLedger,
  ResidentTable,
  foldDeferRows,
  parseTodoCounts,
  readDeferLedger,
  rebuildResidents,
} from './defer/residents.ts'
export type { DeferLedgerRow, ResidentEntry } from './defer/residents.ts'
export type { CrusherConfig, CrusherMode, ResolvedConfig, LedgerRow, RetrieveError } from './types.ts'

export const RETRIEVE_TOOL_NAME = 'context_retrieve'

/** The pinned marker contract, mirrored verbatim in the retrieve tool's description. */
export const RETRIEVE_TOOL_DESCRIPTION =
  'Retrieve the ORIGINAL text of a tool result that dsh-cc compressed. When a tool result '
  + 'ends with a marker like `[dsh-cc compressed 41230→6180 tokens. Original: ccr://a1b2c3d4e5f60708]`, '
  + 'call this tool with the 16-hex hash from the `ccr://` handle to read the full uncompressed '
  + 'output. Use it whenever the compressed form is not enough (you need a specific elided line, '
  + 'a full stack trace, or untruncated rows). The original is retained for 1 hour.'

/** dshHomePath seam, read defensively (a providerless host must not crash the plugin). */
type HomeFn = (...segments: string[]) => string

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/**
 * Read a dsh-home path without throwing when the boot-provided `dshHomePath`
 * resolver is absent — cordis throws on the property access itself (not a
 * plain `undefined`), so the read must be guarded.
 */
function dshHomeFn(ctx: Context): HomeFn | undefined {
  try {
    return ctx.dshHomePath
  } catch {
    return undefined
  }
}

/** Join text blocks; returns undefined when any block is non-text. */
const allTextBlocks = joinTextBlocks

/**
 * The context-crusher service: registers the post-execute tripwire listener
 * and the `context_retrieve` agent tool.
 */
export class ContextCrusher extends Service {
  // `llm` backs the reducer's cheap-lane side query (runSideQuery reads it
  // through the context; cordis requires a declared injection to read it).
  static inject = ['tokenMeter', 'llm']

  static Config = Config

  /** Resolved config-layer defaults; the settings overlay re-reads per use. */
  private readonly base: ResolvedConfig
  private readonly readSettings: () => CrusherConfig | undefined
  private readonly store: CrusherStore | undefined
  private readonly ledger: SavingsLedger | undefined
  private readonly home: HomeFn | undefined
  /** Live `cc-secrets` reader (C2); used by store redaction and the retrieve note rule. */
  private readonly readSecrets: () => SecretsSettings = () => ({ extraPatterns: [], redactCrusherStore: true })
  /** Deferred-mode orchestration (counting, swap pass, resume, ledger). */
  private readonly deferral: Deferral

  constructor(ctx: Context, config: CrusherConfig = {}) {
    super(ctx, 'contextCrusher')
    this.base = resolveConfig(config)
    this.readSettings = registerSettings(ctx, this.base)
    const home = dshHomeFn(ctx)
    this.home = home
    if (home === undefined) {
      // D6 fail-closed: without a durable home the store/ledger cannot exist.
      ctx.logger.warn('context-crusher: no dshHomePath on the host context; force-disabled')
    } else {
      // C2: store redaction via constructor injection — redact-before-hash at
      // every put path (deterministic route + reducer callback). The toggle is
      // read live from `cc-secrets` settings on each put.
      const readSecrets = readSecretsSettings(ctx)
      this.readSecrets = readSecrets
      this.store = new CrusherStore(home('ccr'), Date.now, (text) => {
        const secrets = readSecrets()
        return secrets.redactCrusherStore
          ? redact(text, { extraPatterns: secrets.extraPatterns }).text
          : text
      })
      this.ledger = new SavingsLedger(home('ccr', 'savings.jsonl'))
    }
    this.deferral = new Deferral({
      ctx,
      store: () => this.store,
      home: () => this.home,
      effectiveConfig: () => this.effectiveConfig(),
    })
    this.registerListener()
    this.deferral.registerListeners()
    this.registerRetrieveTool()
  }

  /** Live `cc-secrets` settings for the retrieve note rule (C2). */
  readSecretsLive(): SecretsSettings {
    return this.readSecrets()
  }

  /** Effective configuration for one use: config defaults overlaid by live settings. */
  effectiveConfig(): ResolvedConfig {
    return overlaySettings(this.base, this.readSettings())
  }

  private registerListener(): void {
    this.ctx.on('tools/post-execute', async (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next,
    ): Promise<PostToolDecision> => {
      const d = await next()
      if (d.kind !== 'accept') return d
      try {
        return await this.crush(exec, result, d)
      } catch (error: unknown) {
        // D6: degrade to passthrough. NEVER throw into the waterfall — a throw
        // turns the user's tool result into an error result (data loss).
        this.ctx.logger.warn(`context-crusher: degraded to passthrough: ${String(error)}`)
        return d
      }
    }, { prepend: true })
  }

  private async crush(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    d: Extract<PostToolDecision, { kind: 'accept' }>,
  ): Promise<PostToolDecision> {
    const cfg = this.effectiveConfig()
    const sessionId = exec.agent === undefined ? '' : String(exec.agent.session.id)
    const ledgerRow = async (row: Omit<LedgerRow, 'ts' | 'sessionId' | 'tool'>): Promise<void> => {
      await this.ledger?.append({
        ts: new Date().toISOString(),
        sessionId,
        tool: exec.name,
        ...row,
      })
    }
    if (!cfg.enabled || this.store === undefined) return d
    // Observe-only todo snapshot for the defer gate's remaining-requests
    // estimate (compaction cost-gate doc); the decision is untouched.
    if (exec.name === 'todo_write' && cfg.deferRequests > 0) this.deferral.observeTodoSnapshot(exec)
    // D7: protected tools REPLACE the default list when explicitly set.
    if ((cfg.protectedTools as readonly string[]).includes(exec.name)) return d
    // Never crush the retrieval tool's own output: it would recurse (the
    // retrieved original is large and grep-shaped) and destroy the round-trip.
    if (exec.name === RETRIEVE_TOOL_NAME) return d

    // A value-only accept decision carries no content to crush.
    if (Object.hasOwn(d, 'value')) return d
    const blocks = d.content ?? result.content
    if (blocks === undefined) return d
    const originalText = allTextBlocks(blocks)
    if (originalText === undefined) return d // D2: any non-text block → skip

    const tokensBefore = this.estimate(originalText)
    if (result.isError && tokensBefore < 2 * cfg.minBytes) return d
    if (tokensBefore < cfg.minBytes) return d

    const candidate = route(originalText)
    if (candidate === null) return this.reduceOrPassthrough(exec, result, d, originalText, tokensBefore, cfg, ledgerRow)

    const compressedBody = candidate.text
    const tokensAfter = this.estimate(compressedBody)
    const savings = 1 - tokensAfter / tokensBefore
    if (savings < cfg.minSavingsRatio) {
      // Escalation (§3.1): sub-threshold deterministic savings go to the
      // reducer, never mixing partial compressions.
      return this.reduceOrPassthrough(exec, result, d, originalText, tokensBefore, cfg, ledgerRow)
    }

    if (cfg.mode !== 'on' && cfg.deferRequests <= 0) {
      // Dry-run: measure only; the committed result stays original.
      await ledgerRow({ kind: candidate.kind, charsBefore: originalText.length, charsAfter: compressedBody.length, tokensBefore, tokensAfter, applied: false })
      return d
    }

    const projectKey = this.projectKey(exec)
    if (projectKey === undefined) {
      // Preserve the dry-run ledger row even when deferral wanted a store.
      if (cfg.mode !== 'on') {
        await ledgerRow({ kind: candidate.kind, charsBefore: originalText.length, charsAfter: compressedBody.length, tokensBefore, tokensAfter, applied: false })
      }
      return d
    }
    const hash = await this.store.put(projectKey, originalText)

    if (cfg.deferRequests > 0) {
      // Deferred mode (§3.1): the store put happened (evidence is durable),
      // the resident entry is recorded, and the downstream decision returns
      // UNMODIFIED — the full text enters the session. §3.6: this applies to
      // dry-run too (deferred dry-run writes store files and ledger rows; it
      // only never appends to the session).
      await this.deferral.recordResident(exec, hash, tokensBefore - tokensAfter)
      await ledgerRow({ kind: candidate.kind, charsBefore: originalText.length, charsAfter: compressedBody.length, tokensBefore, tokensAfter, applied: false, hash })
      void this.store.sweep()
      return d
    }

    const replacement: ContentBlock = {
      type: 'text',
      text: `${compressedBody}\n${buildMarker(tokensBefore, tokensAfter, hash)}`,
    }
    await ledgerRow({ kind: candidate.kind, charsBefore: originalText.length, charsAfter: replacement.text.length, tokensBefore, tokensAfter, applied: true, hash })
    // D11: spread the downstream decision so its additionalContexts survive.
    // Fire-and-forget sweep AFTER the decision is formed (D6).
    void this.store.sweep()
    // D11: spread the downstream decision so its additionalContexts survive.
    // `content` is fresh (D2); the downstream decision cannot be value-carrying
    // here (checked above), so this is the content-carrying accept variant.
    return { kind: 'accept', ...('additionalContexts' in d && d.additionalContexts !== undefined ? { additionalContexts: d.additionalContexts } : {}), content: [replacement] }
  }

  /**
   * Reducer escalation stage (§3.1): after the deterministic route declined
   * (null) or its savings fell below `minSavingsRatio`. Any reducer failure —
   * eligibility, lane, timeout, verification — passes the ORIGINAL bytes
   * through (fail-soft inside `reduceToolOutput` too).
   */
  private async reduceOrPassthrough(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    d: Extract<PostToolDecision, { kind: 'accept' }>,
    originalText: string,
    tokensBefore: number,
    cfg: ResolvedConfig,
    ledgerRow: (row: Omit<LedgerRow, 'ts' | 'sessionId' | 'tool'>) => Promise<void>,
  ): Promise<PostToolDecision> {
    const replacementText = await reduceToolOutput({
      ctx: this.ctx,
      cfg,
      exec,
      originalText,
      tokensBefore,
      isError: result.isError,
      estimate: (text) => this.estimate(text),
      projectKey: this.projectKey(exec),
      mode: cfg.mode,
      put: (projectKey, text) => {
        // The `store === undefined` gate above guarantees the store exists.
        return this.store!.put(projectKey, text)
      },
      ledgerRow,
    })
    if (replacementText === undefined) return d
    const replacement: ContentBlock = { type: 'text', text: replacementText }
    // Fire-and-forget sweep AFTER the decision is formed (D6), matching the
    // deterministic replacement path.
    void this.store?.sweep()
    // D11: spread the downstream decision so its additionalContexts survive.
    return { kind: 'accept', ...('additionalContexts' in d && d.additionalContexts !== undefined ? { additionalContexts: d.additionalContexts } : {}), content: [replacement] }
  }

  /** Token-based sizing (D3): the same estimator gates, markers, and ledger rows. */
  private estimate(text: string): number {
    return this.ctx.tokenMeter.estimateMessage({
      role: 'tool',
      content: [{ type: 'text', text }],
    } as unknown as Message)
  }

  /** `sha256(sessionCwd)` first 16 hex — the store's project bucket. */
  private projectKey(exec: ToolExecution): string | undefined {
    if (exec.agent === undefined) return undefined
    try {
      // Worktree-path divergence from the TUI project-root convention is
      // accepted here: the store is self-consistent (writer and retriever
      // both key off the session cwd).
      return shortHash(getSessionCwd(exec.agent))
    } catch {
      return undefined
    }
  }

  /** Typed retrieval through the store; fails closed (used by the tool body). */
  async retrieve(exec: ToolRunContext, hash: string): Promise<
    { ok: true; text: string; redacted: boolean } | { ok: false; error: RetrieveError | 'unavailable' | 'invalid_hash' }
  > {
    if (this.store === undefined) return { ok: false, error: 'unavailable' }
    if (!CCR_HASH_RE.test(hash)) return { ok: false, error: 'invalid_hash' }
    const agent = exec.agent
    if (agent === undefined) return { ok: false, error: 'unavailable' }
    let projectKey: string
    try {
      projectKey = shortHash(getSessionCwd(agent))
    } catch {
      return { ok: false, error: 'unavailable' }
    }
    return await this.store.get(projectKey, hash)
  }

  private registerRetrieveTool(): void {
    const tools = this.ctx.get('tools') as { register(def: unknown): () => void } | undefined
    if (tools === undefined) return
    tools.register(defineRetrieveTool(this))
  }
}

function defineRetrieveTool(crusher: ContextCrusher) {
  return defineTool({
    name: RETRIEVE_TOOL_NAME,
    description: RETRIEVE_TOOL_DESCRIPTION,
    parameters: {
      hash: {
        type: 'string',
        required: true,
        description: 'The 16-hex content handle from a `ccr://<hash>` marker.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: { hash: string }, exec: ToolRunContext) {
      const outcome = await crusher.retrieve(exec, args.hash)
      if (!outcome.ok) {
        throw new Error(`context_retrieve failed: ${outcome.error}`)
      }
      // C2 note rule: label content that was scrubbed at store-write time,
      // only while the store-redaction setting stays on.
      const note = outcome.redacted && crusher.readSecretsLive().redactCrusherStore
        ? '\n[secrets redacted before store write]'
        : ''
      return { text: `${outcome.text}${note}` }
    },
  })
}

export default ContextCrusher
