/**
 * Ticket and dispatch-key hashing for the active recall coordinator (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Query generations and
 * when shown takes effect", §"Privacy, caching and logging").
 *
 * Two keys exist and they answer different questions:
 * - the LOCAL key identifies one turn's query — `(memoryDir, sessionId,
 *   originSeq, queryHash)`. It dedupes tickets within one agent.
 * - the DISPATCH key identifies the complete input of one selection: the local
 *   key plus the manifest hash (scope, paths, content hashes), the hash of the
 *   sorted recent tool names, the route identity and a hash of the effective
 *   settings. `completed` is consulted only once the full key exists.
 *
 * Only digests leave this module: a key never carries a query, a path or a
 * filename in cleartext, and the hashed path is host-only.
 *
 * @module @dsh-cc/memory/recall-dispatch-key
 */

import { createHash } from 'node:crypto'
import type { DecisionRouteIdentity } from '@dsh-cc/systemone'
import type { RecallScope } from './recall-decision.ts'
import type { RecallDecisionSettings } from './recall-decision-settings.ts'

/** SHA-256 hex digest of `text` encoded as UTF-8. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Hash of one turn's query text (the query itself never leaves the host). */
export function recallQueryHash(query: string): string {
  return sha256Hex(query)
}

/**
 * The local ticket key: `(memoryDir, sessionId, originSeq, queryHash)`.
 * @param memoryDir - the canonical memory directory (never the budget projectKey).
 * @param sessionId - the live session id.
 * @param originSeq - the seq of this turn's real user message.
 * @param queryHash - {@link recallQueryHash} of the query text.
 * @returns the local key digest.
 */
export function recallLocalKey(
  memoryDir: string,
  sessionId: string,
  originSeq: number,
  queryHash: string,
): string {
  return sha256Hex(JSON.stringify(['memory-recall/local-v1', memoryDir, sessionId, originSeq, queryHash]))
}

/** One manifest row: a scanned candidate's layer, canonical path and content hash. */
export interface RecallManifestRow {
  scope: RecallScope
  /** Host-only canonical path — hashed here, never sent to the runner. */
  path: string
  contentHash: string
}

/**
 * The manifest hash over the COMPLETE scanned pool: layer, canonical path and
 * content hash of every candidate, in canonical order (workspace first, then
 * UTF-8 path order) so the digest does not depend on scan order.
 * @param rows - the complete scanned pool.
 * @param indexed - the per-layer memory-index membership the pre-selection
 *   consumed. An index-only edit (identical topic bytes, changed MEMORY.md)
 *   changes the judged pool, so the membership joins the dispatch identity:
 *   canonicalized layer-sorted and basename-sorted, insertion-order
 *   independent. Absent keeps the shipped digest.
 * @returns the manifest digest.
 */
export function recallManifestHash(
  rows: readonly RecallManifestRow[],
  indexed?: Readonly<Partial<Record<'workspace' | 'global', ReadonlySet<string>>>>,
): string {
  const canonical = rows
    .map(row => [row.scope, row.path, row.contentHash] as const)
    .sort((a, b) =>
      (a[0] === b[0] ? 0 : a[0] === 'workspace' ? -1 : 1)
      || Buffer.compare(Buffer.from(a[1], 'utf8'), Buffer.from(b[1], 'utf8')))
  const membership = indexed === undefined
    ? undefined
    : (['global', 'workspace'] as const)
      .map(scope => [scope, [...(indexed[scope] ?? [])].sort()] as const)
  return sha256Hex(JSON.stringify(membership === undefined ? canonical : [canonical, membership]))
}

/**
 * Hash of the SORTED recent tool names: the same tool set in any insertion order
 * yields the same dispatch key.
 * @param tools - the agent's recent tool names.
 * @returns the tools digest.
 */
export function recallToolsHash(tools: readonly string[]): string {
  return sha256Hex(JSON.stringify([...tools].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))))
}

/**
 * Hash of the complete effective settings snapshot, so any threshold or budget
 * change invalidates a cached dispatch key. The route is a fixed lane alias
 * (`DECISION_LANE_ALIAS`) and pins through `recallRouteId`, not through settings.
 * @param settings - the current internal settings.
 * @returns the settings digest.
 */
export function recallSettingsHash(settings: RecallDecisionSettings): string {
  return sha256Hex(JSON.stringify(Object.entries(settings)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))))
}

/** The route identity components a dispatch key pins (`none` when unidentified). */
function recallRouteId(route: DecisionRouteIdentity | undefined): string {
  if (route === undefined) return 'none'
  return `${route.provider}\u0000${route.model}\u0000${route.revision}`
}

/** Injected collaborators of {@link recallDispatchKey}. */
export interface RecallDispatchKeyInput {
  /** The local ticket key. */
  localKey: string
  /** The manifest hash over the complete scanned pool. */
  manifestHash: string
  /** The sorted-recent-tools hash. */
  toolsHash: string
  /** The route identity observed before dispatch, when one resolved. */
  route: DecisionRouteIdentity | undefined
  /** The effective-settings hash. */
  settingsHash: string
}

/**
 * The complete dispatch key. Layout changes must bump the version tag: an old
 * in-session `completed` entry must never collide with a new key scheme.
 * @param input - the key components.
 * @returns the dispatch key digest.
 */
export function recallDispatchKey(input: RecallDispatchKeyInput): string {
  return sha256Hex(JSON.stringify([
    'memory-recall/dispatch-v1',
    input.localKey,
    input.manifestHash,
    input.toolsHash,
    recallRouteId(input.route),
    input.settingsHash,
  ]))
}
