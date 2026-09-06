/**
 * `/provider` read paths (design doc docs/plans/2026-09-05-provider-
 * management.md §4.1–§4.2): settings reads, credential-state snapshots, the
 * configurable-provider directory, argument parsing, and the chat-output list
 * renderer. Split out of provider-command.ts purely for line budget.
 * @module @dsh-cc/tui/provider-command-read
 */
import {
  type CredentialState,
  type CredentialsLike,
  type DirectoryEntry,
  type LlmManageLike,
  type ProviderList,
} from './provider-flow.ts'

/** Settings namespace carrying the provider profiles (doc D1/D2). */
export const PROVIDER_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** Usage line for unknown/unsupported subcommands (§4.1 — never silent). */
export const PROVIDER_USAGE = 'Usage: /provider [list | add <preset-id> | remove <route>]'

/**
 * Duck-typed seam for the settings provider. Only `describe` is needed on the
 * read path: descriptors carry `{ns, user, revision}` (the pattern
 * driver-approvals.writeAllowRule consumes).
 */
export type SettingsDescribeLike = {
  describe?: () => ReadonlyArray<{ ns?: unknown; user?: unknown; revision?: unknown }>
}

/**
 * Read the `llm-pi-ai` section's user-layer `providers` dict (§4.2). The
 * service may be absent, the namespace unregistered, or the stored shape
 * junk — every degradation returns `{}` so the overlay renders honestly.
 */
export function readConfiguredProviders(settings: SettingsDescribeLike | undefined): Record<string, unknown> {
  if (settings === undefined || typeof settings.describe !== 'function') return {}
  let descriptors: ReadonlyArray<unknown>
  try {
    descriptors = settings.describe() ?? []
  } catch {
    return {}
  }
  const descriptor = descriptors.find(
    (entry): entry is { ns?: unknown; user?: unknown } =>
      entry !== null && typeof entry === 'object' && String((entry as { ns?: unknown }).ns) === PROVIDER_SETTINGS_NAMESPACE,
  )
  const user = descriptor?.user
  const providers = user !== null && typeof user === 'object' ? (user as { providers?: unknown }).providers : undefined
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return {}
  const out: Record<string, unknown> = {}
  for (const [route, profile] of Object.entries(providers as Record<string, unknown>)) {
    // Coerce junk entries away: only object profiles are provider shapes.
    if (profile !== null && typeof profile === 'object') out[route] = profile
  }
  return out
}

/**
 * Credential-state snapshots for each ref (§4.2 badges). Tolerant of an
 * absent service and a throwing `describe` — a failed describe is an unknown
 * state, rendered as unconfigured, never an overlay crash.
 */
export async function credentialStates(
  credentials: CredentialsLike | undefined,
  refs: readonly string[],
): Promise<Record<string, CredentialState>> {
  const out: Record<string, CredentialState> = {}
  if (credentials === undefined) return out
  for (const ref of refs) {
    try {
      if (typeof credentials.describe !== 'function') return out
      const state = await credentials.describe(ref)
      if (state !== undefined && state !== null && typeof state === 'object') out[ref] = state
    } catch {
      // Unknown state: omit — badgeFor renders missing.
    }
  }
  return out
}

/**
 * Configurable-provider directory (C8). Absent service or junk entries
 * degrade to `[]`; throwing discovery degrades to `[]` too.
 */
export function loadDirectory(llm: LlmManageLike | undefined): DirectoryEntry[] {
  try {
    const entries = llm?.listConfigurableProviders?.()
    if (!Array.isArray(entries)) return []
    return entries.filter(
      (entry): entry is DirectoryEntry => entry !== null && typeof entry === 'object' && typeof (entry as { provider?: unknown }).provider === 'string',
    )
  } catch {
    return []
  }
}

/** Parsed `/provider …` invocation (§4.1). */
export type ParsedProviderArgs =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'add'; route: string }
  | { kind: 'remove'; route: string }
  | { kind: 'invalid' }

/** Subcommand table per §4.1: bare, list, add/remove with a required id. */
export function parseProviderArgs(rest: string): ParsedProviderArgs {
  const trimmed = rest.trim()
  if (trimmed === '') return { kind: 'open' }
  if (trimmed === 'list') return { kind: 'list' }
  for (const kind of ['add', 'remove'] as const) {
    if (trimmed === kind || trimmed.startsWith(`${kind} `)) {
      const route = trimmed.slice(kind.length).trim()
      if (route === '') return { kind: 'invalid' }
      return { kind, route }
    }
  }
  return { kind: 'invalid' }
}

/** Badge text for one row (`✓ (managed)` / `✓ (env)` / `✗ missing`). */
function credentialBadgeText(row: ProviderList['configured'][number]): string {
  const credential = row.credential
  if (credential === undefined || credential.badge === 'missing') return 'key ✗ missing'
  return `key ✓ (${credential.badge})`
}

/**
 * §4.1 `/provider list` — plain-text rendering of the same two-section data
 * the overlay shows (script-friendly chat output).
 */
export function renderProviderList(list: ProviderList): string {
  const lines: string[] = ['Providers', '  Configured']
  for (const row of list.configured) {
    const marker = row.isCurrent ? '●' : '○'
    const models = row.modelCount > 0 ? `   ${row.modelCount} models` : ''
    lines.push(`  ${marker} ${row.route}   ${row.displayName}   ${credentialBadgeText(row)}${models}${row.credential?.warning === true ? '  ⚠' : ''}`)
  }
  lines.push('  Available')
  for (const row of list.available) {
    lines.push(`  ○ ${row.route}   ${row.displayName}`)
  }
  if (list.more.length > 0) {
    lines.push(`  … More providers (${list.more.map(m => m.provider).join(', ')})`)
  }
  return lines.join('\n')
}
