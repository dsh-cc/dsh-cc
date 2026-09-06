/**
 * Side-effect-free core for the `/provider` command (design doc
 * docs/plans/2026-09-05-provider-management.md §4.2–§4.6): list merge rule,
 * route normalization/collision, profile materialization, model-list parsing,
 * and the verify-probe request builder. All functions are pure — seams and
 * data arrive as plain values (D6 `*Like` pattern).
 * @module @dsh-cc/tui/provider-flow
 */
import type { LlmLike } from './state/driver-types.ts'
import { PRESETS, presetByRoute, deriveCredentialRef, type ProviderPreset } from './provider-presets.ts'

/**
 * Duck-typed seam for the llm service's management surface (§5). Extends the
 * existing {@link LlmLike} with directory discovery (C8) and draft-form model
 * listing (C5). Declared here rather than in state/driver-types.ts, which sits
 * at its 500-line cap.
 */
export type LlmManageLike = LlmLike & {
  listConfigurableProviders(): {
    provider: string
    displayName?: string
    settingsNs?: string
    settingsPath?: readonly string[]
  }[]
  discoverModels(
    ns: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string; signal?: AbortSignal },
  ): Promise<ReadonlyArray<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>>
}

/** Credential-state snapshot as returned by `credentials.describe(ref)` (§4.2 badges). Nullish-tolerant at the call site. */
export type CredentialState = {
  configured: boolean
  source?: 'env' | 'managed' | (string & {})
  writable?: boolean
}

/** Duck-typed credentials-store seam (C4): describe/set/unset one ref. */
export type CredentialsLike = {
  describe(ref: string): Promise<{ configured: boolean; source?: 'env' | 'managed' | (string & {}); writable?: boolean } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** One entry of the configurable-provider directory (C8 `listConfigurableProviders()`). */
export type DirectoryEntry = {
  provider: string
  displayName?: string
  settingsNs?: string
  settingsPath?: readonly string[]
}

export type CredentialBadge = 'managed' | 'env' | 'missing'

/** One presentation-ready row of the `/provider` list overlay (§4.2). */
export type ProviderRow = {
  route: string
  displayName: string
  section: 'configured' | 'available'
  isCurrent: boolean
  modelCount: number
  credential?: { badge: CredentialBadge; warning: boolean; writable?: boolean }
}

/** Directory tail collapsed under "More providers…" (§4.2 merge rule). */
export type MoreProviderRow = { provider: string; displayName: string; entry: DirectoryEntry }

/** The two-section list state for the overlay home screen. */
export type ProviderList = {
  configured: ProviderRow[]
  available: ProviderRow[]
  more: MoreProviderRow[]
}

export type BuildProviderRowsInput = {
  /** Live `llm-pi-ai.providers` dict, verbatim (document order preserved). */
  configured: Record<string, unknown>
  directory: readonly DirectoryEntry[]
  presets?: readonly ProviderPreset[]
  /** Credential-state snapshots keyed by credential ref. */
  credentialStates: Record<string, CredentialState>
  currentProvider?: string
}

function credentialRefFor(route: string): string {
  return presetByRoute(route)?.credentialRef ?? deriveCredentialRef(route)
}

function badgeFor(route: string, input: BuildProviderRowsInput): NonNullable<ProviderRow['credential']> {
  const ref = credentialRefFor(route)
  const state = input.credentialStates[ref]
  if (state === undefined || !state.configured) {
    return { badge: 'missing', warning: false }
  }
  const badge: CredentialBadge = state.source === 'env' ? 'env' : 'managed'
  const credential: NonNullable<ProviderRow['credential']> = { badge, warning: false }
  if (state.writable !== undefined) credential.writable = state.writable
  return credential
}

/**
 * §4.2 merge rule (review M2), stated exactly: Configured = the live providers
 * dict, verbatim, in document order. Available = presets whose route is not
 * configured ∪ directory entries that are neither configured nor preset-covered,
 * the latter collapsed into the `more` tail. A route never appears in both
 * sections; a configured route never appears in Available.
 */
export function buildProviderRows(input: BuildProviderRowsInput): ProviderList {
  const presets = input.presets ?? PRESETS
  const configuredRoutes = Object.keys(input.configured)
  const presetRoutes = new Set(presets.map((p) => p.route))

  const configured: ProviderRow[] = configuredRoutes.map((route) => {
    const section = input.configured[route] as { models?: unknown } | undefined
    const modelCount = Array.isArray(section?.models) ? section.models.length : 0
    const credential = badgeFor(route, input)
    const warning = modelCount > 0 && credential.badge === 'missing'
    return {
      route,
      displayName: presetByRoute(route)?.displayName ?? route,
      section: 'configured',
      isCurrent: input.currentProvider === route,
      modelCount,
      credential: { ...credential, warning },
    }
  })

  const configuredSet = new Set(configuredRoutes)
  const available: ProviderRow[] = presets
    .filter((p) => !configuredSet.has(p.route))
    .map((p) => ({
      route: p.route,
      displayName: p.displayName,
      section: 'available',
      isCurrent: false,
      modelCount: 0,
    }))

  const more: MoreProviderRow[] = input.directory
    .filter((entry) => !configuredSet.has(entry.provider) && !presetRoutes.has(entry.provider))
    .map((entry) => ({ provider: entry.provider, displayName: entry.displayName ?? entry.provider, entry }))

  return { configured, available, more }
}

/**
 * Normalize a user-typed route id to `^[a-z0-9][a-z0-9-]*$` (§4.6): lowercase,
 * invalid runs collapse to `-`, leading/trailing `-` stripped. Returns null
 * when nothing usable remains.
 */
export function normalizeRouteId(input: string): string | null {
  const id = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return id.length > 0 ? id : null
}

/** Which existing source already claims `routeId`, if any (§4.6 collision check). */
export function routeCollision(
  routeId: string,
  { configured, presets, directory }: { configured: Record<string, unknown>; presets: readonly ProviderPreset[]; directory: readonly DirectoryEntry[] },
): 'configured' | 'preset' | 'directory' | null {
  if (Object.hasOwn(configured, routeId)) return 'configured'
  if (presets.some((p) => p.route === routeId)) return 'preset'
  if (directory.some((d) => d.provider === routeId)) return 'directory'
  return null
}

/** JSON payload for `llm-pi-ai.providers.<route>` from a preset — the preset's deltas, deep-copied. */
export function materializeProfile(preset: ProviderPreset): { api?: string; baseURL?: string; models?: { id: string; name: string }[] } {
  const models = preset.profile.models?.map((m) => ({ ...m }))
  return {
    ...(preset.profile.api !== undefined ? { api: preset.profile.api } : {}),
    ...(preset.profile.baseURL !== undefined ? { baseURL: preset.profile.baseURL } : {}),
    ...(models !== undefined ? { models } : {}),
  }
}

export type CustomProfileInput = {
  routeId: string
  displayName: string
  baseURL: string
  api: string
  models?: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]
}

/** JSON payload for a fully custom route (§4.6); throws on a non-absolute http(s) baseURL. */
export function materializeCustomProfile(input: CustomProfileInput): { api: string; baseURL: string; models?: CustomProfileInput['models'] } {
  let parsed: URL
  try {
    parsed = new URL(input.baseURL)
  } catch {
    throw new Error(`route ${input.routeId}: baseURL must be an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`route ${input.routeId}: baseURL must be an absolute http(s) URL`)
  }
  return {
    api: input.api,
    baseURL: input.baseURL,
    ...(input.models !== undefined && input.models.length > 0 ? { models: input.models.map((m) => ({ ...m })) } : {}),
  }
}

export type ParsedModel = { id: string; name?: string; contextWindow?: number; maxTokens?: number }

/**
 * Compact wizard model entry (§4.6): entries separated by newlines or commas;
 * each entry `id` | `id|Display Name` | `id|Display Name|contextWindow|maxTokens`.
 * Returns per-entry errors so the wizard shows problems without inventing data.
 */
export function parseModelList(text: string): { models: ParsedModel[]; errors: string[] } {
  const models: ParsedModel[] = []
  const errors: string[] = []
  for (const raw of text.split(/\r?\n|,/)) {
    const entry = raw.trim()
    if (entry === '') continue
    const fields = entry.split('|').map((f) => f.trim())
    const id = fields[0] ?? ''
    const name = fields[1]
    const contextWindow = fields[2]
    const maxTokens = fields[3]
    const extra = fields.slice(4)
    if (id === '' || /\s/.test(id)) {
      errors.push(`"${entry}": model id is empty or contains whitespace`)
      continue
    }
    if (extra.length > 0) {
      errors.push(`"${entry}": too many fields (expected id|name|contextWindow|maxTokens)`)
      continue
    }
    const model: ParsedModel = { id }
    if (name !== undefined && name !== '') model.name = name
    if (contextWindow !== undefined && contextWindow !== '') {
      const n = Number(contextWindow)
      if (!Number.isInteger(n) || n <= 0) {
        errors.push(`"${entry}": contextWindow must be a positive integer`)
        continue
      }
      model.contextWindow = n
    }
    if (maxTokens !== undefined && maxTokens !== '') {
      const n = Number(maxTokens)
      if (!Number.isInteger(n) || n <= 0) {
        errors.push(`"${entry}": maxTokens must be a positive integer`)
        continue
      }
      model.maxTokens = n
    }
    models.push(model)
  }
  return { models, errors }
}

/** Protocols whose `/models` listing is supported by discovery (C5); everything else is DISCOVERY_UNSUPPORTED. */
const LISTABLE_APIS = new Set(['openai-completions', 'openai-responses'])

export type VerifyProbeAnswers = {
  baseURL?: string | undefined
  api?: string | undefined
  apiKey?: string | undefined
  provider?: string | undefined
}

/** Result of the detail-view refresh resolution: a draft probe, or why not. */
export type RefreshProbe = { ok: true; baseURL: string; api: string } | { ok: false; reason: string }

/**
 * §8-S2 "refresh list" resolution: the detail action probes the route's
 * effective endpoint — profile.baseURL/api, else the preset's probe endpoint
 * when the route is a preset with a non-null probe. Unresolved endpoints and
 * non-listable protocols (everything outside LISTABLE_APIS, doc §2/C5) return
 * an explanatory reason instead of a probe.
 */
export function refreshProbeFor(profile: Record<string, unknown>, preset: ProviderPreset | undefined): RefreshProbe {
  const profileBase = typeof profile.baseURL === 'string' && profile.baseURL !== '' ? profile.baseURL : undefined
  const profileApi = typeof profile.api === 'string' && profile.api !== '' ? profile.api : undefined
  const baseURL = profileBase ?? preset?.probe?.baseURL
  const api = profileApi ?? preset?.probe?.api
  if (baseURL === undefined || api === undefined) {
    return { ok: false, reason: 'No probeable endpoint is known for this route — set baseURL and api in the profile to enable a refresh.' }
  }
  if (!LISTABLE_APIS.has(api)) {
    return { ok: false, reason: `The ${api} protocol can't be listed programmatically — the first message is the test.` }
  }
  return { ok: true, baseURL, api }
}

/**
 * Build the §4.3 step-2 draft-form discovery probe request, or null when the
 * protocol is not listable or the baseURL is unknown. NEVER includes
 * `provider` — that form answers from the catalog without touching the network
 * (doc §2/C5, review Blocker B1).
 */
export function verifyProbeFor(presetOrAnswers: ProviderPreset | VerifyProbeAnswers): { baseURL: string; api: string; apiKey?: string } | null {
  const preset = presetOrAnswers as Partial<ProviderPreset>
  const source = 'probe' in presetOrAnswers && preset.probe !== undefined ? preset.probe : (presetOrAnswers as VerifyProbeAnswers)
  if (source === null || source.baseURL === undefined || source.api === undefined || !LISTABLE_APIS.has(source.api)) return null
  const apiKey = presetOrAnswers instanceof Object && 'apiKey' in presetOrAnswers ? (presetOrAnswers as VerifyProbeAnswers).apiKey : undefined
  return { baseURL: source.baseURL, api: source.api, ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}) }
}
