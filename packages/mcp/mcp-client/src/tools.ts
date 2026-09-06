/**
 * Tool bridge: discovers MCP tools, registers them on the harness ToolRuntime
 * under deterministic server-qualified public names, and handles re-sync when
 * the server's tool list changes.
 *
 * Naming contract (see the mcp-client Agent Note "Naming invariants"): every MCP tool
 * has the stable identity `(serverName, rawName)`; the model-facing public name
 * is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
 * constraints. The raw name is only ever sent on the wire (`tools/call`); the
 * public name is never parsed to recover it.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@dsh-cc/tools'
import { assertSupportedJsonSchema } from '@dsh-cc/tools'
import type { JsonSchemaNode, JsonValue } from '@dsh-cc/tools'
import { DEFAULT_DEFER_TOOL_THRESHOLD, publishListedTool, toolSearchSeam } from './defer.ts'

export { DEFAULT_DEFER_TOOL_THRESHOLD } from './defer.ts'

/** Resolved options relevant to tool bridging. */
export interface ToolBridgeOptions {
  /** Whether a registry conflict is contained or rejects this synchronization. */
  registrationFailure: 'contain' | 'throw'
  serverName: string
  toolCallTimeoutMs: number
  /**
   * Listed-tool count above which this server's deferrable tools register
   * through `ctx.toolSearch` instead of eagerly. Counts the server's
   * `tools/list` length including alwaysLoad tools; a tool flagged
   * `_meta['anthropic/alwaysLoad']` is still eager even on a deferred server.
   * `0` defers whenever `toolSearch` is present. Default
   * {@link DEFAULT_DEFER_TOOL_THRESHOLD}.
   */
  deferToolThreshold?: number
  /**
   * Called before a single mid-session 401 retry. The SDK auto-refreshes an
   * expired token before a request; a mid-session `UnauthorizedError` means the
   * token was revoked, so the provider drops the stored state and re-runs the
   * token flow before the bridge retries the request once.
   */
  onUnauthorized?: () => Promise<void> | void
}

/** State for one sync generation: the current set of disposers keyed by public name. */
export type ToolDisposers = Map<string, () => void>

/**
 * One registered tool generation plus the identity data used to skip no-op
 * swaps. `fingerprintTools` fingerprints the raw server payload; when a
 * re-sync produces the same fingerprint on the same client generation, the
 * live registrations are kept as-is so request prefixes stay stable.
 */
export interface ToolGeneration {
  /** Live registrations owned by this generation, keyed by public name. */
  disposers: ToolDisposers
  /**
   * Fingerprint of the raw server payload that produced this generation.
   * `undefined` when nothing is registered (initial state or rolled-back
   * registration), which forces the next sync to attempt a real swap.
   */
  fingerprint: string | undefined
  /** The client generation the payload was fetched from; a new client forces a swap. */
  client: Client | undefined
  /** Listed tools registered eagerly (visible in the model-facing schema). */
  eagerCount: number
  /** Listed tools registered deferred (searchable, hidden until activated). */
  deferredCount: number
}

/** The generation representing "nothing registered yet" (or a rolled-back swap). */
export function emptyToolGeneration(): ToolGeneration {
  return { disposers: new Map(), fingerprint: undefined, client: undefined, eagerCount: 0, deferredCount: 0 }
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively while
 * array order is preserved, so semantically identical JSON payloads with
 * unstable key order serialize to identical bytes. Primitives go through
 * `JSON.stringify`; `undefined` (absent optional fields) serializes as `null`.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

/**
 * Fingerprint the raw tools/list payload for swap short-circuiting.
 *
 * Entries are ordered by public name, then stable-stringified (recursive key
 * sort, array order preserved) and hashed. The fingerprint covers every field
 * of the raw entries — including `execution.taskSupport`, which
 * `createExecutor` bakes into the executor's semantics, and `outputSchema`,
 * which shapes the registered output schema — so any server-side semantic
 * change forces a swap. Executor closures are not compared (functions are not
 * serializable); identical fingerprints on one client generation imply the
 * rebuilt executors would be behaviorally identical.
 *
 * @param serverName - Namespace used to derive each entry's public name for ordering.
 * @param tools - Raw entries exactly as returned by the server's `tools/list`.
 * @returns A hex digest that is equal precisely when the payload is semantically unchanged.
 */
export function fingerprintTools(serverName: string, tools: readonly unknown[]): string {
  const rawName = (entry: unknown): string => {
    const name = (entry as { name?: unknown } | null)?.name
    return typeof name === 'string' ? name : ''
  }
  const ordered = [...tools].sort((a, b) => {
    const nameA = publicToolName(serverName, rawName(a))
    const nameB = publicToolName(serverName, rawName(b))
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0
  })
  return createHash('sha256').update(stableStringify(ordered)).digest('hex')
}

/** Canonical MCP result exposed to Code Mode without discarding protocol blocks. */
export type McpResult<Structured extends JsonValue = JsonValue> = {
  content: JsonValue[]
  structuredContent?: Structured
}

/**
 * DeepSeek function-name contract: at most 64 characters. Wire-protocol
 * constant, not configuration.
 */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** Raw result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/** List without mutating the SDK's per-page output-validator cache. */
function listToolsUncached(client: Client, cursor?: string) {
  return client.request(
    { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
    ListToolsResultSchema,
  )
}

/** Call without the SDK pre-validating an output schema the bridge may not support. */
function callToolUncached(
  client: Client,
  rawName: string,
  args: Record<string, unknown>,
  exec: ToolExecution,
  opts: ToolBridgeOptions,
) {
  return client.request(
    { method: 'tools/call', params: { name: rawName, arguments: args } },
    RawCallToolResultSchema,
    {
      signal: exec.signal,
      timeout: opts.toolCallTimeoutMs,
    },
  )
}

/**
 * Derive the model-facing public name for one MCP tool.
 *
 * Deterministic pure function of `(serverName, rawName)`: the clean case is
 * `mcp__<serverName>__<rawName>` verbatim. When character replacement or
 * truncation to the DeepSeek function-name contract (64 chars,
 * `[A-Za-z0-9_-]`) changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into the
 * same public name.
 *
 * @param serverName - Stable local namespace from plugin config.
 * @param rawName - The MCP server's own tool name.
 * @returns The globally unique, model-facing ToolRuntime name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Sync the MCP server's tool list into the harness ToolRuntime.
 *
 * Two phases keep the swap safe:
 *
 * 1. Fetch: drain uncached `tools/list` pagination and build the full next
 *    generation of `ToolDefinition`s under public names. Any failure here
 *    (network error, duplicate raw name in the server's list) rejects and
 *    leaves the previous generation registered untouched.
 * 2. Swap: dispose the previous generation, publish the new one. A registry
 *    conflict here can only mean a foreign registration squats on this
 *    server's `mcp__<serverName>__` namespace — the partial generation is
 *    rolled back (zero tools from this server) and logged. Initial strict
 *    synchronization may propagate the conflict so its parent transaction
 *    rejects; ordinary clients and later re-syncs return an empty generation.
 *    Deferred publishing detects the same squat up front (`ctx.tools.get`)
 *    because `registerDeferred` only reserves the name.
 *
 * When the `ctx.toolSearch` seam is mounted and the server lists at least
 * `deferToolThreshold` tools (default {@link DEFAULT_DEFER_TOOL_THRESHOLD}),
 * each deferrable tool registers through `registerDeferred` instead: its
 * definition stays out of the model-visible schema until a ToolSearch hit
 * activates it. Tools flagged `_meta['anthropic/alwaysLoad']` register eagerly
 * even on a deferred server. Without the seam the swap is eager at any
 * threshold.
 *
 * Between the phases, a fingerprint of the raw payload decides whether the
 * swap is needed at all: when the payload is semantically unchanged (key
 * order may drift; content may not) AND `previous` was produced by the same
 * client generation, the live registrations are kept and `previous` is
 * returned unchanged — dispose+register churn (and the request-prefix churn
 * it risks) is skipped. A new client generation always forces a real swap,
 * so reconnects never reuse the previous generation's registrations.
 *
 * @param client - Connected MCP Client instance used to list and call tools.
 * @param ctx - Cordis context providing the `tools` service for registration.
 * @param opts - Bridge options: server namespace and per-call timeout.
 * @param previous - The prior sync generation; its registrations are disposed
 *   during the swap phase (only after the fetch phase succeeded and the
 *   fingerprint check found a real change).
 * @returns The live generation — `previous` itself on a fingerprint hit,
 *   otherwise the newly registered one.
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolGeneration,
): Promise<ToolGeneration> {
  // Phase 1: fetch and build the next generation without touching the registry.
  const definitions = new Map<string, { definition: ToolDefinition; rawName: string; alwaysLoad: boolean }>()
  const rawTools: unknown[] = []
  let cursor: string | undefined
  do {
    const response = await listToolsUncached(client, cursor)
    for (const tool of response.tools) {
      rawTools.push(tool)
      const publicName = publicToolName(opts.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(
          `mcp-client(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
        )
      }
      definitions.set(publicName, {
        rawName: tool.name,
        alwaysLoad: (tool as { _meta?: Record<string, unknown> })?._meta?.['anthropic/alwaysLoad'] === true,
        definition: {
          name: publicName,
          description: tool.description ?? '',
          parameters: tool.inputSchema,
          output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
          execute: createExecutor(client, tool.name, tool.execution?.taskSupport === 'required', opts),
        },
      })
    }
    cursor = response.nextCursor
  } while (cursor)

  // Semantically unchanged payload on the same client generation: keep the
  // live generation so the registered definitions (and any request prefix
  // built on them) stay byte-stable. A different client generation never
  // short-circuits — reconnects must rebuild against their own client.
  const fingerprint = fingerprintTools(opts.serverName, rawTools)
  if (previous.client === client && previous.fingerprint === fingerprint) {
    ctx.logger.debug(
      `mcp-client(${opts.serverName}): tool list unchanged (fingerprint ${fingerprint.slice(0, 12)}) — keeping ${previous.disposers.size} registered tools`,
    )
    return previous
  }

  const seam = toolSearchSeam(ctx)
  const deferServer = seam !== undefined
    && rawTools.length >= (opts.deferToolThreshold ?? DEFAULT_DEFER_TOOL_THRESHOLD)

  // Phase 2: swap generations.
  for (const dispose of previous.disposers.values()) dispose()
  const disposers: ToolDisposers = new Map()
  let eagerCount = 0
  let deferredCount = 0
  try {
    for (const [publicName, entry] of definitions) {
      disposers.set(publicName, publishListedTool(ctx, opts, publicName, entry, seam, deferServer))
      if (deferServer && !entry.alwaysLoad) deferredCount += 1
      else eagerCount += 1
    }
  } catch (error) {
    // A conflict on an `mcp__<serverName>__`-qualified name means a foreign
    // registration occupies this server's namespace. Roll back so the model
    // sees either the full generation or none of it — never a partial set.
    // Deferred disposers unwind both the reservation and any activated
    // registration, so one loop reclaims everything this sync published.
    for (const dispose of disposers.values()) dispose()
    ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
    if (opts.registrationFailure === 'throw') throw error
    // No fingerprint: nothing is registered, so the next sync must attempt a
    // real swap even if the payload is unchanged.
    return emptyToolGeneration()
  }
  return { disposers, fingerprint, client, eagerCount, deferredCount }
}

/**
 * The shape we read from each MCP content block. Intentionally looser than the
 * SDK's `ContentBlock` type: we're at a network trust boundary (data arrives
 * from an external MCP server process via JSON-RPC), so fields that the SDK
 * declares required may be absent at runtime if the server is buggy.
 */
interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
}

/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to JsonValue. */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** Build the canonical result schema and existing Native text projection. */
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      const result = value as unknown as McpResult
      return [{ type: 'text', text: extractText(result.content, rawName) }]
    },
  }
}

/**
 * Run an MCP request, retrying once on a mid-session `UnauthorizedError`.
 * Between the original attempt and the retry, `onUnauthorized` runs to drop
 * stale OAuth state and re-establish a token. Only a single retry is attempted
 * (the spec's "401 自动重试一次"); a second failure propagates to the caller.
 *
 * @param request - the MCP request to attempt.
 * @param onUnauthorized - re-auth hook run before the single retry.
 * @returns the request result.
 */
export async function retryUnauthorizedOnce<T>(request: () => Promise<T>, onUnauthorized?: () => Promise<void> | void): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (!isUnauthorized(error) || onUnauthorized === undefined) throw error
    await onUnauthorized()
    return request()
  }
}

/** Whether a thrown error signals an expired/revoked OAuth session. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedError
    || (error instanceof Error && /unauthorized/i.test(error.message))
}

/**
 * Create an execute function for one MCP tool. The executor closes over the
 * raw MCP tool name and sends an uncached `tools/call` request with it (never
 * the public name), with abort signal and timeout, then maps the result to
 * harness ContentBlocks. Owning the raw request prevents the SDK's internal
 * per-page schema cache from pre-validating a different contract.
 *
 * When the MCP server returns `isError: true`, the executor throws so that
 * the ToolRuntime's catch path produces an `isError` result for the model.
 */
function createExecutor(
  client: Client,
  rawName: string,
  taskRequired: boolean,
  opts: ToolBridgeOptions,
): ToolDefinition['execute'] {
  return async (args: unknown, exec: ToolExecution) => {
    if (taskRequired) {
      throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`)
    }
    // The agent loop passes `JSON.parse(model_arguments)` which is usually an
    // object, but can be any JSON value if the model misbehaves (outputs a bare
    // string/number/null). Fallback to {} lets the MCP server produce a
    // specific "missing required param" error the model can learn from.
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const result = await retryUnauthorizedOnce(
      () => callToolUncached(client, rawName, argsObj, exec, opts),
      opts.onUnauthorized,
    )

    // The SDK may return a legacy `toolResult` shape; normalize to content array.
    if (!Array.isArray(result.content)) {
      const rendered: unknown = 'toolResult' in result
        ? JSON.stringify(result.toolResult)
        : '(no output)'
      const text = typeof rendered === 'string' ? rendered : '(no output)'
      if (result.isError === true) throw new Error(text)
      return {
        content: [{ type: 'text', text }],
        ...result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent as JsonValue }
          : {},
      }
    }

    // Trust boundary: the SDK's return type erases to `any[]` due to the
    // union of CallToolResult | CompatibilityCallToolResult; extractText
    // validates each element.
    const content = result.content as unknown as JsonValue[]
    const text = extractText(content, rawName)

    // MCP isError → throw so ToolRuntime produces an isError result for the model.
    if (result.isError === true) {
      throw new Error(text)
    }

    return {
      content,
      ...result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent as JsonValue }
        : {},
    }
  }
}

/**
 * Extract text from an MCP content array into a single string.
 * - text blocks: join with '\n'
 * - image/audio/resource blocks: replaced with a placeholder
 *
 * Defensive: fields that the MCP spec declares required (mimeType, text) are
 * guarded with fallbacks because this is a network trust boundary.
 */
function extractText(mcpContent: JsonValue[], toolName: string): string {
  const parts: string[] = []

  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value as unknown as McpContentBlock
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${block.type}]`)
    }
  }

  return parts.join('\n') || `(${toolName} returned no text content)`
}
