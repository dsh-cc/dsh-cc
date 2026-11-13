/**
 * The three row-emitting observers of the per-step input ledger (plan
 * docs/plans/2026-11-12-per-step-input-ledger.md §"Design"): assembly
 * observations, outgoing-request observations, and step attribution.
 *
 * Every observer is pure observation over the snapshot it is handed: it never
 * rewrites the waterfall value, never touches `options`, and never throws into
 * the waterfall — any exception yields zero rows for that call plus a debug
 * log. All measurements are UTF-8 bytes; the only strings a row can carry are
 * section names and source-kind strings, both hard-capped by
 * {@linkcode clampLabel} (privacy boundary, structural).
 *
 * Payload faces are declared here as local structural subsets rather than
 * harness imports (turn-rules `PreStepPayload` idiom): the observers only read
 * a handful of fields, and the merge-extensible harness types stay out of this
 * package's dependency graph.
 *
 * @module @dsh-cc/input-ledger/observe
 */

import { realpathSync } from 'node:fs'
import { projectKeyOf, shortHash } from '@dsh-cc/sidecar-io'
import type {
  AssembleRow,
  AssembleSection,
  LedgerRow,
  RequestMessageStats,
  RequestRow,
} from './rows.ts'
import { clampLabel, LEDGER_SCHEMA_VERSION } from './rows.ts'
import type { InputLedgerSettings } from './settings.ts'

/** Length of every truncated fingerprint in a row (eight hex chars). */
export const HASH_CHARS = 8

/** Structural face of one content block (byte accounting only). */
interface ContentBlockLike {
  readonly type?: unknown
  readonly text?: unknown
}

/** Structural face of one request message. */
interface MessageLike {
  readonly role?: unknown
  readonly content?: unknown
  readonly source?: { readonly kind?: unknown } | undefined
}

/** Structural face of the outgoing `GenerateOptions` the request observer reads. */
export interface GenerateOptionsLike {
  readonly provider?: unknown
  readonly model?: unknown
  readonly messages?: unknown
  readonly system?: unknown
  readonly tools?: unknown
  readonly sessionId?: unknown
  readonly purpose?: unknown
}

/** Structural face of the `system-prompt/assemble` context. */
export interface AssembleContextLike {
  /** Scope whose assembly this is; the agent loop assembles with `scope: agent`. */
  readonly scope?: unknown
}

/** Structural face of the `PromptPresentation` an assemble waterfall returns. */
export interface PromptPresentationLike {
  readonly sections?: unknown
}

/** Structural face of the `agent/pre-step` payload (turn-rules `PreStepPayload` idiom). */
export interface PreStepPayloadLike {
  readonly agent?: unknown
  readonly messages?: unknown
  readonly turn?: unknown
  readonly step?: unknown
  readonly signal?: unknown
  readonly modelSelection?: unknown
}

/** Attribution the pre-step observer records per session (Observer C). */
export interface SessionAttribution {
  turn: number | undefined
  step: number | undefined
  /** Project bucket from the session cwd; `undefined` skips the session's rows. */
  projectKey: string | undefined
  isSubagent: boolean
}

/** Collaborators of the observers; the mount wires these to the shared sink. */
export interface InputLedgerObserverDeps {
  /** Hot settings read — called once per observed event. */
  readSettings(): InputLedgerSettings
  /** Emit one row; the mount routes it to `<dshHome>/input-ledger/...`. */
  emit(row: LedgerRow, projectKey: string, settings: InputLedgerSettings): void
  /** Debug sink for swallowed observer failures (must not throw). */
  debug(message: string): void
  /** Process boot id stamped into every row (`gen`). */
  gen: string
}

/** The three listeners, ready to register on the event chain. */
export interface InputLedgerObservers {
  /** `system-prompt/assemble` — registered WITHOUT prepend. */
  assemble(
    assembly: unknown,
    context: AssembleContextLike | undefined,
    next: () => Promise<PromptPresentationLike>,
  ): Promise<PromptPresentationLike>
  /** `llm/stream` — synchronous observation before `next()`, never touches options. */
  request(options: GenerateOptionsLike, next: () => unknown): unknown
  /** `agent/pre-step` — delegate-first attribution, returns `next()` unchanged. */
  preStep(payload: PreStepPayloadLike, next: () => Promise<unknown>): Promise<unknown>
}

/** One section as measured for an assemble row. */
interface MeasuredSection {
  name: string
  bytes: number
  hash8: string
}

/** Previous assembly served under one `(sessionId, scopeKey)` cache key. */
interface AssemblyCacheEntry {
  totalBytes: number
  hashes: string[]
}

/** UTF-8 byte length of one string (the program's only unit). */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Truncated sha256 fingerprint over one string, local-only. */
function fingerprint(text: string): string {
  return shortHash(text, HASH_CHARS)
}

/** A string field of an untyped payload, or `''`. */
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A finite integer field of an untyped payload, or `undefined`. */
function intOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/** The object face of an untyped payload, or `undefined`. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** The content blocks of one message (missing content = no blocks). */
function blocksOf(message: MessageLike | undefined): readonly ContentBlockLike[] {
  const content = message?.content
  return Array.isArray(content) ? content as readonly ContentBlockLike[] : []
}

/** Concatenated text blocks of one message; non-text blocks contribute nothing. */
function textOf(message: MessageLike | undefined): string {
  let text = ''
  for (const block of blocksOf(message)) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/** Every request message as a structural face (non-array payload = none). */
function messagesOf(options: GenerateOptionsLike): readonly MessageLike[] {
  const messages = options.messages
  return Array.isArray(messages) ? messages as readonly MessageLike[] : []
}

/** Source-kind label of one message, `'user'` when the producer declared none. */
function sourceKindOf(message: MessageLike | undefined): string {
  const kind = message?.source?.kind
  return typeof kind === 'string' && kind.length > 0 ? kind : 'user'
}

/**
 * System prompt texts of one request, in wire order: the one-shot
 * `options.system` field first (adapters map it to the system slot ahead of
 * messages), then the leading system-role run, then any further message whose
 * producer declared `source.kind === 'system-prompt'` (each message counted
 * once). Empty texts are skipped so a blank prompt yields no fingerprint.
 */
function systemParts(options: GenerateOptionsLike): string[] {
  const parts: string[] = []
  const oneShot = options.system
  if (typeof oneShot === 'string' && oneShot.length > 0) parts.push(oneShot)
  const messages = messagesOf(options)
  const selected = new Set<number>()
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== 'system') break
    selected.add(index)
  }
  messages.forEach((message, index) => {
    if (message?.source?.kind === 'system-prompt') selected.add(index)
  })
  for (const index of [...selected].sort((a, b) => a - b)) {
    const text = textOf(messages[index])
    if (text.length > 0) parts.push(text)
  }
  return parts
}

/** Per-message-source composition of one request (bytes are UTF-8 text bytes). */
function measureMessages(messages: readonly MessageLike[]): RequestMessageStats {
  const bySourceKind: Record<string, { count: number; bytes: number }> = {}
  const toolResults = { count: 0, bytes: 0 }
  let bytesTotal = 0
  let assistantBytes = 0
  let nonTextBlocks = 0
  for (const message of messages) {
    let messageBytes = 0
    for (const block of blocksOf(message)) {
      if (block?.type === 'text') {
        if (typeof block.text === 'string') messageBytes += utf8Bytes(block.text)
      } else {
        nonTextBlocks += 1
      }
    }
    bytesTotal += messageBytes
    const kind = clampLabel(sourceKindOf(message))
    const bucket = bySourceKind[kind] ?? { count: 0, bytes: 0 }
    bucket.count += 1
    bucket.bytes += messageBytes
    bySourceKind[kind] = bucket
    if (message?.role === 'tool') {
      toolResults.count += 1
      toolResults.bytes += messageBytes
    }
    if (message?.role === 'assistant') assistantBytes += messageBytes
  }
  return {
    count: messages.length,
    bytesTotal,
    nonTextBlocks,
    bySourceKind,
    toolResults,
    assistantBytes,
  }
}

/** Tool declaration count and serialized byte size (`JSON.stringify` bytes). */
function measureTools(tools: unknown): { count: number; bytes: number } {
  if (!Array.isArray(tools)) return { count: 0, bytes: 0 }
  let bytes = 0
  for (const tool of tools) bytes += utf8Bytes(JSON.stringify(tool) ?? '')
  return { count: tools.length, bytes }
}

/** The assembling agent from an assemble scope (`ScopeKey` is opaque; the agent IS the scope). */
function agentOfScope(scope: unknown): Record<string, unknown> | undefined {
  const candidate = objectOf(scope)
  return candidate !== undefined && 'session' in candidate ? candidate : undefined
}

/** Durable session id of an agent face, or `undefined`. */
function sessionIdOf(agent: Record<string, unknown> | undefined): string | undefined {
  const session = objectOf(agent?.session)
  const id = session?.id
  if (typeof id === 'string') return id.length > 0 ? id : undefined
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return undefined
}

/** Header-derived cwd of an agent face, or `undefined`. */
function cwdOf(agent: Record<string, unknown> | undefined): string | undefined {
  const header = objectOf(objectOf(agent?.session)?.header)
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Canonicalize a cwd for keying (handoff-store `cwdProjectKey` convention):
 * `realpathSync` when it resolves, the raw spelling otherwise, so a parent
 * (raw spelling) and a child (canonicalized) of one physical directory land in
 * one bucket.
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The project bucket of one agent, per the `cwdProjectKey` convention; absent cwd skips rows. */
function projectKeyOfAgent(agent: Record<string, unknown> | undefined): string | undefined {
  const cwd = cwdOf(agent)
  return cwd === undefined ? undefined : projectKeyOf(canonicalize(cwd))
}

/**
 * Delegated-agent check (tool-use-summary `isTopLevel` precedent): the header's
 * `delegationDepth` and the agent's runtime `subagentDepth`, fail closed — any
 * read error treats the agent as a child.
 */
function isSubagentOf(agent: Record<string, unknown> | undefined): boolean {
  try {
    const header = objectOf(objectOf(agent?.session)?.header)
    const headerDepth = intOf(header?.delegationDepth) ?? 0
    const runtimeDepth = intOf(objectOf(agent?.options)?.subagentDepth)
    if (runtimeDepth !== undefined && runtimeDepth < 0) return true
    return Math.max(headerDepth, runtimeDepth ?? 0) > 0
  } catch {
    return true
  }
}

/** Stable cache key for one agent's assembly scope. */
function scopeKeyOf(agent: Record<string, unknown> | undefined, sessionId: string): string {
  const id = agent?.id
  return typeof id === 'string' && id.length > 0 ? id : sessionId
}

/** Compare the previous and current per-section fingerprints (order-sensitive). */
function sameHashes(previous: readonly string[], current: readonly string[]): boolean {
  if (previous.length !== current.length) return false
  return previous.every((hash, index) => hash === current[index])
}

/** Best-effort one-line description of a caught observer failure. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the three observers over one shared per-mount state: the session
 * attribution map (Observer C → A/B), the assembly cache keyed by
 * `(sessionId, scopeKey)` (Observer A), and the per-`(sessionId, gen)` request
 * sequence (Observer B).
 * @param deps - settings reader, row sink, debug sink, and process boot id.
 */
export function createObservers(deps: InputLedgerObserverDeps): InputLedgerObservers {
  const attributions = new Map<string, SessionAttribution>()
  const assemblies = new Map<string, AssemblyCacheEntry>()
  const sequences = new Map<string, number>()

  /** Run one observation body; any throw means zero rows plus a debug log. */
  const guarded = (label: string, body: () => void): void => {
    try {
      body()
    } catch (error) {
      try {
        deps.debug(`input-ledger: ${label} observation failed: ${describe(error)}`)
      } catch {
        // The debug sink is best-effort; a failure there must not escape either.
      }
    }
  }

  /** Hot-read settings for one event (a read failure skips the event, logged). */
  const settingsFor = (): InputLedgerSettings => deps.readSettings()

  /** Record one agent's `(turn, step)` attribution plus its routing facts. */
  const recordAttribution = (payload: PreStepPayloadLike): void => {
    const agent = objectOf(payload.agent)
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    attributions.set(sessionId, {
      turn: intOf(payload.turn),
      step: intOf(payload.step),
      projectKey: projectKeyOfAgent(agent),
      isSubagent: isSubagentOf(agent),
    })
  }

  /** Observe one completed assembly (Observer A). */
  const observeAssembly = (
    presentation: PromptPresentationLike,
    context: AssembleContextLike | undefined,
  ): void => {
    const settings = settingsFor()
    if (!settings.enabled) return
    const agent = agentOfScope(context?.scope)
    // Scope-less assemblies cannot be keyed or filed: skipped by convention.
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    const projectKey = projectKeyOfAgent(agent)
    if (projectKey === undefined) return
    const isSubagent = isSubagentOf(agent)
    if (isSubagent && !settings['include-subagents']) return

    const rawSections = Array.isArray(presentation?.sections)
      ? presentation.sections as readonly { readonly name?: unknown; readonly text?: unknown }[]
      : []
    const measured: MeasuredSection[] = rawSections.map((section) => {
      const text = typeof section?.text === 'string' ? section.text : ''
      return {
        name: clampLabel(stringOf(section?.name)),
        bytes: utf8Bytes(text),
        hash8: fingerprint(text),
      }
    })
    const totalBytes = measured.reduce((sum, section) => sum + section.bytes, 0)
    const hashes = measured.map(section => section.hash8)
    const cacheKey = `${sessionId}\u0000${scopeKeyOf(agent, sessionId)}`
    const previous = assemblies.get(cacheKey)
    const renderedFromCache = previous !== undefined
      && previous.totalBytes === totalBytes
      && sameHashes(previous.hashes, hashes)
    assemblies.set(cacheKey, { totalBytes, hashes })

    const sections: AssembleSection[] = measured
      .slice(0, settings['max-sections-per-row'])
      .map(section => ({ name: section.name, bytes: section.bytes, hash8: section.hash8 }))
    const attribution = attributions.get(sessionId)
    const row: AssembleRow = {
      v: LEDGER_SCHEMA_VERSION,
      ts: Date.now(),
      sessionId,
      gen: deps.gen,
      ...attributionFields(attribution),
      type: 'assemble',
      isSubagent,
      sections,
      totalBytes,
      renderedFromCache,
    }
    deps.emit(row, projectKey, settings)
  }

  /** Observe one outgoing request, synchronously and before `next()` (Observer B). */
  const observeRequest = (options: GenerateOptionsLike): void => {
    const settings = settingsFor()
    if (!settings.enabled) return
    const sessionId = stringOf(options.sessionId)
    if (sessionId.length === 0) return
    const attribution = attributions.get(sessionId)
    // No attribution means no project bucket for this session yet: row skipped.
    if (attribution === undefined || attribution.projectKey === undefined) return
    if (attribution.isSubagent && !settings['include-subagents']) return

    const purpose = typeof options.purpose === 'string' ? options.purpose : undefined
    const mainLoop = purpose === undefined
    const system = systemParts(options)
    const systemBytes = system.reduce((sum, part) => sum + utf8Bytes(part), 0)
    const systemHash8 = system.length === 0 ? '' : fingerprint(system.join('\n'))
    const tools = measureTools(options.tools)
    const seqKey = `${sessionId}\u0000${deps.gen}`
    const seqPerGen = (sequences.get(seqKey) ?? 0) + 1
    sequences.set(seqKey, seqPerGen)
    const row: RequestRow = {
      v: LEDGER_SCHEMA_VERSION,
      ts: Date.now(),
      sessionId,
      gen: deps.gen,
      // Auxiliary calls never inherit attribution (r1 fold).
      ...(mainLoop ? attributionFields(attribution) : {}),
      type: 'request',
      seqPerGen,
      provider: stringOf(options.provider),
      model: stringOf(options.model),
      ...(purpose === undefined ? {} : { purpose }),
      mainLoop,
      systemBytes,
      systemHash8,
      toolsCount: tools.count,
      toolsBytes: tools.bytes,
      messages: measureMessages(messagesOf(options)),
    }
    deps.emit(row, attribution.projectKey, settings)
  }

  return {
    async assemble(_assembly, context, next) {
      const presentation = await next()
      guarded('assemble', () => observeAssembly(presentation, context))
      return presentation
    },
    request(options, next) {
      guarded('request', () => observeRequest(options))
      return next()
    },
    async preStep(payload, next) {
      guarded('pre-step', () => recordAttribution(payload))
      return next()
    },
  }
}

/** `turn`/`step` row fields from a recorded attribution (omitted when unknown). */
function attributionFields(attribution: SessionAttribution | undefined): { turn?: number; step?: number } {
  if (attribution === undefined) return {}
  return {
    ...(attribution.turn === undefined ? {} : { turn: attribution.turn }),
    ...(attribution.step === undefined ? {} : { step: attribution.step }),
  }
}
