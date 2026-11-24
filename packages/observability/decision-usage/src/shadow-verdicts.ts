/**
 * The shadow-verdict ledger (design docs/plans/2026-11-25-systemone-shadow-verdict-ledger.md).
 *
 * One evaluation-grain row per shadow/active decision evaluation for the three
 * SystemOne consumer features (memory-extraction, tool-discovery,
 * skill-recommendation), written to `shadow-verdicts.jsonl` in the same
 * decision-usage session directory as `usage.jsonl`, joined on `decisionId`.
 *
 * Privacy discipline: payloads are validated against CLOSED per-feature
 * schemas — unknown keys or wrong-typed fields drop the row (plus one warn),
 * never persist a surprise. Size caps (serialized ≤ 4096 bytes, strings
 * ≤ 256 chars, arrays ≤ 128 items) are a second bound on catalog-name fields.
 * No user text, no state or question bodies, no credentials.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The verdict file name inside one decision-usage directory. */
export const SHADOW_VERDICTS_FILE_NAME = 'shadow-verdicts.jsonl'
/** The rotated generation the writer keeps (the report reads both). */
export const SHADOW_VERDICTS_ROTATED_NAME = `${SHADOW_VERDICTS_FILE_NAME}.1`
/** Rotation threshold in bytes. */
export const SHADOW_VERDICTS_MAX_BYTES = 8 * 1024 * 1024
/** Serialized payload byte cap (the second, size-class privacy bound). */
export const SHADOW_VERDICTS_PAYLOAD_MAX_BYTES = 4096
/** Per-string character cap inside a payload. */
export const SHADOW_VERDICTS_STRING_MAX_CHARS = 256
/** Per-array item cap inside a payload. */
export const SHADOW_VERDICTS_ARRAY_MAX_ITEMS = 128
/** Schema version of a verdict row. */
export const SHADOW_VERDICTS_SCHEMA_VERSION = 1

/** The three features this ledger records. */
export type ShadowVerdictFeature = 'memory-extraction' | 'tool-discovery' | 'skill-recommendation'

/** The input the recorder service accepts (feature-agnostic envelope). */
export interface ShadowVerdictInput {
  feature: ShadowVerdictFeature
  /** Wire-decision uuids the evaluation consumed; [] for pre-dispatch terminals. */
  decisionIds: readonly string[]
  mode: 'shadow' | 'active'
  /** Validated against the feature's closed schema. */
  payload: Record<string, unknown>
}

/** One persisted verdict row. */
export interface ShadowVerdictRow {
  schemaVersion: 1
  /** Row identity and the labeling key; deduplicated across rotations. */
  eventId: string
  /** Epoch milliseconds, service-minted. */
  time: number
  feature: ShadowVerdictFeature
  mode: 'shadow' | 'active'
  decisionIds: readonly string[]
  payload: Record<string, unknown>
}

/**
 * Why a payload was rejected: the report and tests never see these rows, so
 * the reason is only for the one warn line the writer emits.
 */
export type ShadowVerdictRejection =
  | 'unknown-key'
  | 'wrong-type'
  | 'string-too-long'
  | 'array-too-long'
  | 'payload-too-large'

/** The closed schema of one payload field. */
interface FieldSpec {
  kind: 'number' | 'boolean' | 'string' | 'seq' | 'string-array' | 'enum'
  required: boolean
  /** For `enum` and `string-array` fields. */
  values?: readonly string[]
}

const EXTRACTION_VERDICTS = ['would-skip', 'extract-positive', 'extract-uncertain'] as const
const SKILLREC_STATUSES = ['shadow', 'recommended', 'unavailable', 'cancelled'] as const

/** Type the literal field specs so `kind` does not widen to `string`. */
const schemaOf = (spec: Record<string, FieldSpec>): Readonly<Record<string, FieldSpec>> => Object.freeze(spec)

/**
 * The closed per-feature payload schemas. Exported so tests (and the report)
 * import the production constants — never an inline copy.
 */
export const SHADOW_VERDICT_SCHEMAS: Readonly<Record<ShadowVerdictFeature, Readonly<Record<string, FieldSpec>>>> = Object.freeze({
  'memory-extraction': schemaOf({
    verdict: { kind: 'enum', values: EXTRACTION_VERDICTS, required: true },
    probability: { kind: 'number', required: true },
    skipThreshold: { kind: 'number', required: true },
    fromExclusive: { kind: 'seq', required: true },
    throughInclusive: { kind: 'seq', required: true },
    surfaceEvents: { kind: 'number', required: true },
    stateBytes: { kind: 'number', required: true },
  }),
  'tool-discovery': schemaOf({
    queryHash8: { kind: 'string', required: true },
    suggested: { kind: 'string-array', required: true },
    lexical: { kind: 'string-array', required: true },
    differing: { kind: 'boolean', required: true },
    suggestedOnly: { kind: 'number', required: true },
    lexicalOnly: { kind: 'number', required: true },
    candidatesJudged: { kind: 'number', required: true },
    originSeq: { kind: 'number', required: true },
  }),
  'skill-recommendation': schemaOf({
    status: { kind: 'enum', values: SKILLREC_STATUSES, required: true },
    eligible: { kind: 'number', required: false },
    judged: { kind: 'number', required: false },
    recommended: { kind: 'string-array', required: false },
    failureClass: { kind: 'string', required: false },
    requestLatencyMs: { kind: 'number', required: true },
    requestTimeoutMs: { kind: 'number', required: true },
  }),
})

/** Validate one payload against its feature's closed schema. */
export function validateShadowVerdictPayload(
  feature: ShadowVerdictFeature,
  payload: unknown,
): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: ShadowVerdictRejection; key?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'wrong-type' }
  }
  const schema = SHADOW_VERDICT_SCHEMAS[feature]
  const source = payload as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const spec = schema[key]
    if (spec === undefined) return { ok: false, reason: 'unknown-key', key }
    switch (spec.kind) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'wrong-type', key }
        break
      case 'boolean':
        if (typeof value !== 'boolean') return { ok: false, reason: 'wrong-type', key }
        break
      case 'seq':
        // The host's own seq type: a safe integer or a decimal-string.
        if (typeof value === 'number') {
          if (!Number.isSafeInteger(value)) return { ok: false, reason: 'wrong-type', key }
        } else if (typeof value === 'string') {
          if (!/^[0-9]+$/.test(value) || value.length > 32) return { ok: false, reason: 'wrong-type', key }
        } else {
          return { ok: false, reason: 'wrong-type', key }
        }
        break
      case 'string':
        if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'wrong-type', key }
        if (value.length > SHADOW_VERDICTS_STRING_MAX_CHARS) return { ok: false, reason: 'string-too-long', key }
        break
      case 'enum':
        if (typeof value !== 'string' || !spec.values!.includes(value)) return { ok: false, reason: 'wrong-type', key }
        break
      case 'string-array': {
        if (!Array.isArray(value)) return { ok: false, reason: 'wrong-type', key }
        if (value.length > SHADOW_VERDICTS_ARRAY_MAX_ITEMS) return { ok: false, reason: 'array-too-long', key }
        for (const item of value) {
          if (typeof item !== 'string' || item.length === 0 || item.length > SHADOW_VERDICTS_STRING_MAX_CHARS) {
            return { ok: false, reason: 'wrong-type', key }
          }
        }
        break
      }
    }
    out[key] = value
  }
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.required && !(key in out)) return { ok: false, reason: 'wrong-type', key }
  }
  const serialized = JSON.stringify(out)
  if (serialized.length > SHADOW_VERDICTS_PAYLOAD_MAX_BYTES) return { ok: false, reason: 'payload-too-large' }
  return { ok: true, payload: out }
}

/** Validate the full input envelope (decisionIds included). */
export function validateShadowVerdictInput(
  input: ShadowVerdictInput,
): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: ShadowVerdictRejection; key?: string } {
  if (input.mode !== 'shadow' && input.mode !== 'active') return { ok: false, reason: 'wrong-type', key: 'mode' }
  if (!Array.isArray(input.decisionIds)) return { ok: false, reason: 'wrong-type', key: 'decisionIds' }
  if (input.decisionIds.length > SHADOW_VERDICTS_ARRAY_MAX_ITEMS) return { ok: false, reason: 'array-too-long', key: 'decisionIds' }
  for (const id of input.decisionIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > SHADOW_VERDICTS_STRING_MAX_CHARS) {
      return { ok: false, reason: 'wrong-type', key: 'decisionIds' }
    }
  }
  return validateShadowVerdictPayload(input.feature, input.payload)
}

/** Hash a discovery query for the verdict row (first 16 hex of sha256). */
export function shadowVerdictQueryHash(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16)
}

/** In-process serialization of all verdict writes per directory (the design's no-quota.lock chain). */
const verdictQueues = new Map<string, Promise<unknown>>()

function enqueueVerdict<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const previous = verdictQueues.get(dir) ?? Promise.resolve()
  const run = previous.then(task, task)
  verdictQueues.set(dir, run)
  void run.catch(() => undefined).then(() => {
    if (verdictQueues.get(dir) === run) verdictQueues.delete(dir)
  })
  return run
}

export interface ShadowVerdictWriteDeps {
  now(): number
  uuid(): string
  warn?(message: string): void
}

/**
 * Append one verdict row to `<dir>/shadow-verdicts.jsonl`. Serialized per
 * directory with an in-process promise chain; the file takes no `quota.lock`
 * so a verdict fault can never freeze the quota transaction. Rotation: when
 * the file exceeds the byte cap, it is renamed to the `.1` generation
 * (replacing any earlier rotation) before the append. A rejected payload
 * (or any I/O failure) resolves without throwing after one warn — the
 * recorder never rejects.
 */
export async function appendShadowVerdict(
  dir: string,
  input: ShadowVerdictInput,
  deps: ShadowVerdictWriteDeps,
): Promise<void> {
  await enqueueVerdict(dir, async () => {
    const validated = validateShadowVerdictInput(input)
    if (!validated.ok) {
      try {
        deps.warn?.(`decision-usage: shadow-verdict dropped (${validated.reason}${validated.key === undefined ? '' : `: ${validated.key}`})`)
      } catch {
        // A broken warn sink must not turn a dropped row into a failure.
      }
      return
    }
    const row: ShadowVerdictRow = {
      schemaVersion: SHADOW_VERDICTS_SCHEMA_VERSION,
      eventId: deps.uuid(),
      time: deps.now(),
      feature: input.feature,
      mode: input.mode,
      decisionIds: [...input.decisionIds],
      payload: validated.payload,
    }
    const file = join(dir, SHADOW_VERDICTS_FILE_NAME)
    try {
      await mkdir(dir, { recursive: true })
      let rotate = false
      try {
        const info = await stat(file)
        rotate = info.size > SHADOW_VERDICTS_MAX_BYTES
      } catch {
        rotate = false
      }
      if (rotate) await rename(file, join(dir, SHADOW_VERDICTS_ROTATED_NAME))
      const handle = await open(file, 'a+', 0o600)
      try {
        const line = `${JSON.stringify(row)}\n`
        let content = line
        const info = await handle.stat()
        if (info.size > 0) {
          // Torn-tail repair: terminate a crash-fragmented last line.
          const tail = Buffer.alloc(1)
          const read = await handle.read(tail, 0, 1, info.size - 1)
          if (read.bytesRead === 1 && tail[0] !== 0x0a) content = `\n${line}`
        }
        await handle.write(Buffer.from(content, 'utf8'))
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch {
      try {
        deps.warn?.('decision-usage: shadow-verdict append failed')
      } catch {
        // Never rejects, never throws into the feature path.
      }
    }
  })
}

/** Parse one line of a verdict file; blank lines read as undefined. */
export function parseShadowVerdictLine(line: string): ShadowVerdictRow | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>
    if (value.schemaVersion !== SHADOW_VERDICTS_SCHEMA_VERSION) return undefined
    if (typeof value.eventId !== 'string' || value.eventId.length === 0) return undefined
    if (typeof value.time !== 'number' || !Number.isFinite(value.time)) return undefined
    const feature = value.feature
    if (feature !== 'memory-extraction' && feature !== 'tool-discovery' && feature !== 'skill-recommendation') return undefined
    if (value.mode !== 'shadow' && value.mode !== 'active') return undefined
    if (!Array.isArray(value.decisionIds)) return undefined
    const payload = value.payload
    const validated = validateShadowVerdictPayload(feature, payload)
    if (!validated.ok) return undefined
    return {
      schemaVersion: SHADOW_VERDICTS_SCHEMA_VERSION,
      eventId: value.eventId,
      time: value.time,
      feature,
      mode: value.mode,
      decisionIds: value.decisionIds as readonly string[],
      payload: validated.payload,
    }
  } catch {
    return undefined
  }
}
