/**
 * Resume-pin schema v1: the descriptor persisted per continuable background
 * child, plus a tolerant reader and a canonical writer.
 *
 * The pin lives outside the harness's closed descriptor schema and records
 * exactly what a cold resume must restore instead of re-guessing: definition
 * identity, the complete effective request tuple (with explicit `null`
 * presence semantics — a pinned `null` means ABSENT, and absence must be
 * preserved), the model selector provenance, workspace identity, and the
 * derived resume state.
 *
 * Reader contract: unknown fields are ignored (forward compatibility);
 * an unsupported `version`, malformed JSON, or a missing required field
 * throws {@link PinParseError} — callers treat that as fail-closed.
 *
 * @module @dsh-cc/subagent-resume-pins/pin
 */

/** The only pin schema version this reader accepts. */
export const PIN_VERSION = 1

/** Error thrown for a malformed, incomplete, or unsupported-version pin. */
export class PinParseError extends Error {
  constructor(message: string) {
    super(`resume pin parse error: ${message}`)
    this.name = 'PinParseError'
  }
}

/** The layer a named definition was discovered under. */
export type PinDefinitionSource = 'project' | 'user' | 'bundled'

/** How the spawn-time model selector was resolved. */
export type ModelSelectorVia = 'alias' | 'literal' | 'inherit'

/** Background mode of the pinned child; constant `continuable-background` today. */
export type PinMode = 'continuable-background'

/** Deriving, non-authoritative resume state persisted for the overlay listener. */
export interface PinResume {
  readonly state: 'ok' | 'blocked'
  readonly reason?: string | undefined
  /**
   * Gate-evaluated route-current tuple (§4.6 step 5): present only while the
   * latest gate evaluation routed the child to a current default route per
   * policy. A cache, never authoritative on its own — every gate evaluation
   * recomputes or clears it.
   */
  readonly overlay?: OverlayTuple | undefined
}

/** A complete resolved request tuple; `null` means explicitly ABSENT. */
export interface OverlayTuple {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | null
  readonly maxTokens: number | null
}

/** Discriminated definition identity: `plain` for general-purpose spawns. */
export type PinDefinition =
  | { readonly kind: 'plain' }
  | {
      readonly kind: 'named'
      readonly agentType: string
      readonly source: PinDefinitionSource
      /** Canonical fingerprint over parsed frontmatter + persona (§4.4). */
      readonly fingerprint: string
      /** sha256 of the persona string forwarded at spawn. */
      readonly personaHash: string
      /** Discovery location for gate-time re-fingerprinting, when file-backed. */
      readonly baseDir?: string | undefined
      readonly filename?: string | undefined
    }

/** Provenance of the spawn-time model selector, atomically resolved. */
export interface PinModelSelector {
  readonly raw: string
  readonly via: ModelSelectorVia
}

/**
 * The complete resolved request config. `null` means explicitly ABSENT and
 * absence must be preserved on resume; `complete: false` degrades the pin to
 * explicit-fields-only mode (spawn-time preflight could not resolve the route).
 */
export interface PinEffective {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | null
  readonly maxTokens: number | null
  readonly complete: boolean
}

/** Sanitized tool filter as forwarded at spawn. */
export interface PinToolFilter {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
}

/** Workspace/worktree identity captured at spawn. */
export interface PinWorkspace {
  readonly cwd: string
  readonly gitDir: string
  readonly gitCommonDir: string
  readonly branch: string
}

/** A persisted resume pin, schema version 1. */
export interface ResumePin {
  readonly version: typeof PIN_VERSION
  /** Preallocated child id; becomes the child's session id. */
  readonly childId: string
  readonly parentSessionId: string
  readonly label: string
  readonly mode: PinMode
  readonly createdAt: string
  readonly definition: PinDefinition
  readonly modelSelector: PinModelSelector
  readonly effective: PinEffective
  readonly toolFilter: PinToolFilter
  /** Audit metadata only — never enforced at spawn or resume. */
  readonly maxTurns?: number | undefined
  readonly workspace: PinWorkspace
  readonly resume: PinResume
  readonly lastNotice?: string | undefined
}

/** A structural clone of a pin draft mutable by {@link PinStore.update}. */
export type ResumePinDraft = {
  -readonly [K in keyof ResumePin]: ResumePin[K]
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PinParseError('expected an object')
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new PinParseError(`missing required string field "${field}"`)
  }
  return value
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PinParseError(`missing required number field "${field}"`)
  }
  return value
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new PinParseError(`field "${field}" must be a string`)
  return value
}

function requiredEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T {
  const value = record[field]
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new PinParseError(`field "${field}" must be one of ${values.join('|')}`)
  }
  return value as T
}

function stringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new PinParseError(`field "${field}" must be an array of strings`)
  }
  return value as string[]
}

function parseDefinition(value: unknown): PinDefinition {
  const record = asRecord(value)
  const kind = requiredEnum(record, 'kind', ['plain', 'named'] as const)
  if (kind === 'plain') return { kind: 'plain' }
  const source = requiredEnum(record, 'source', ['project', 'user', 'bundled'] as const)
  return {
    kind: 'named',
    agentType: requiredString(record, 'agentType'),
    source,
    fingerprint: requiredString(record, 'fingerprint'),
    personaHash: requiredString(record, 'personaHash'),
    baseDir: optionalString(record, 'baseDir'),
    filename: optionalString(record, 'filename'),
  }
}

function requiredBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field]
  if (typeof value !== 'boolean') {
    throw new PinParseError(`missing required boolean field "${field}"`)
  }
  return value
}

function parseEffective(value: unknown): PinEffective {
  const record = asRecord(value)
  // Presence is contractual (plan §4.2): a missing knob is a parse error,
  // only an explicit `null` records absence.
  if (!('reasoningEffort' in record)) throw new PinParseError('missing required field "reasoningEffort"')
  if (!('maxTokens' in record)) throw new PinParseError('missing required field "maxTokens"')
  return {
    provider: requiredString(record, 'provider'),
    model: requiredString(record, 'model'),
    reasoningEffort: record.reasoningEffort === null ? null : requiredString(record, 'reasoningEffort'),
    maxTokens: record.maxTokens === null ? null : requiredNumber(record, 'maxTokens'),
    complete: requiredBoolean(record, 'complete'),
  }
}

function parseModelSelector(value: unknown): PinModelSelector {
  const record = asRecord(value)
  return {
    raw: requiredString(record, 'raw'),
    via: requiredEnum(record, 'via', ['alias', 'literal', 'inherit'] as const),
  }
}

function parseToolFilter(value: unknown): PinToolFilter {
  const record = asRecord(value)
  return { allow: stringArray(record, 'allow'), deny: stringArray(record, 'deny') }
}

function parseWorkspace(value: unknown): PinWorkspace {
  const record = asRecord(value)
  return {
    cwd: requiredString(record, 'cwd'),
    gitDir: requiredString(record, 'gitDir'),
    gitCommonDir: requiredString(record, 'gitCommonDir'),
    branch: requiredString(record, 'branch'),
  }
}

function parseOverlayTuple(value: unknown): OverlayTuple | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value)
  if (!('reasoningEffort' in record)) throw new PinParseError('missing required field "reasoningEffort"')
  if (!('maxTokens' in record)) throw new PinParseError('missing required field "maxTokens"')
  return {
    provider: requiredString(record, 'provider'),
    model: requiredString(record, 'model'),
    reasoningEffort: record.reasoningEffort === null ? null : requiredString(record, 'reasoningEffort'),
    maxTokens: record.maxTokens === null ? null : requiredNumber(record, 'maxTokens'),
  }
}

function parseResume(value: unknown): PinResume {
  const record = asRecord(value)
  const state = requiredEnum(record, 'state', ['ok', 'blocked'] as const)
  const overlay = parseOverlayTuple(record['overlay'])
  if (state === 'blocked') {
    return { state, reason: requiredString(record, 'reason'), overlay }
  }
  return { state, overlay }
}

/**
 * Parse a pin from its JSON text. Tolerant of unknown fields on the pin and
 * its nested objects; throws {@link PinParseError} for malformed JSON, an
 * unsupported `version`, or a missing required field.
 */
export function parsePin(text: string): ResumePin {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    throw new PinParseError(`invalid JSON (${String(cause)})`)
  }
  const record = asRecord(raw)
  const version = record['version']
  if (version !== PIN_VERSION) {
    throw new PinParseError(`unsupported pin version ${JSON.stringify(version)}`)
  }
  const pin: ResumePin = {
    version: PIN_VERSION,
    childId: requiredString(record, 'childId'),
    parentSessionId: requiredString(record, 'parentSessionId'),
    label: requiredString(record, 'label'),
    mode: requiredEnum(record, 'mode', ['continuable-background'] as const),
    createdAt: requiredString(record, 'createdAt'),
    definition: parseDefinition(record['definition']),
    modelSelector: parseModelSelector(record['modelSelector']),
    effective: parseEffective(record['effective']),
    toolFilter: parseToolFilter(record['toolFilter']),
    maxTurns: record['maxTurns'] === undefined ? undefined : requiredNumber(record, 'maxTurns'),
    workspace: parseWorkspace(record['workspace']),
    resume: parseResume(record['resume']),
    lastNotice: optionalString(record, 'lastNotice'),
  }
  return pin
}

/** Stable JSON.stringify: object keys in sorted order, recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const body = keys
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')
    return `{${body}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Serialize a pin to its canonical JSON form (sorted keys), matching what the
 * store writes atomically to `<pinsRoot>/<childId>.json`.
 */
export function writePin(pin: ResumePin): string {
  return `${canonicalJson(pin)}\n`
}
