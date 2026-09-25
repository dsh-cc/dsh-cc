/**
 * Claude Code model-alias merge and resolution.
 *
 * `mergeAliasMaps` folds the deployment `config` defaults and the live
 * `settings` overlay into one effective alias map — entry-shallow, so a
 * settings value replaces a same-named config value wholesale rather than
 * field-merging `{provider, model}` objects, with a settings `null` deleting
 * the config entry. `createModelResolver` turns a per-invocation alias source
 * into the `resolveModel` closure an agent provider calls at spawn time, so
 * live settings edits take effect on the next spawn without re-registering
 * anything.
 *
 * Builtin alias names (Claude Code family plus the dsh-cc lane names) have a
 * fallback when they are unconfigured — they resolve to "inherit the parent
 * route" (`undefined`), matching the deployment decision that a zero-config
 * `model: sonnet` / `model: draft` agent silently uses the parent's current
 * model. A custom (open-set) alias that is unconfigured has no fallback: it
 * passes through verbatim as a literal model id, with a warning when it looks
 * like an intended alias.
 *
 * @module @dsh-cc/model-aliases/resolver
 */

import type { AliasInspection, AliasTarget, DetailedRoute, ResolvedRoute } from './types.ts'

/**
 * Claude Code family aliases. Unconfigured → inherit the parent route.
 * Case-insensitive; a configured value still wins over this fallback.
 */
export const CC_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku']

/**
 * dsh-cc lane aliases. Unconfigured, a lane follows its CC peer
 * ({@link LANE_PEERS}) so `model: sketch` shares a configured `haiku`
 * route without a second settings entry. `architect` has no peer and
 * inherits the parent (main-thread) route. A configured string-form
 * target that names another alias is followed one hop.
 *
 * | lane | role | CC peer when unconfigured |
 * |---|---|---|
 * | `sketch` | fast, lightweight execution | haiku |
 * | `draft` | balanced everyday coding | sonnet |
 * | `blueprint` | deep reasoning | opus |
 * | `masterplan` | maximum reasoning | fable |
 * | `architect` | planning / orchestration | inherit (main thread) |
 * | `gauge` | typed-decision cheap lane (System One models; not generative) | haiku |
 *
 * `gauge` must never be used as agent frontmatter `model:` — it is a
 * typed-decision lane selected by decision consumers, not a generative alias.
 */
export const LANE_ALIASES: readonly string[] = ['sketch', 'draft', 'blueprint', 'masterplan', 'architect', 'gauge']

/** Unconfigured lane → CC family alias it shares a route with. */
export const LANE_PEERS: Readonly<Record<string, string>> = {
  sketch: 'haiku',
  draft: 'sonnet',
  blueprint: 'opus',
  masterplan: 'fable',
  gauge: 'haiku',
}

/**
 * The builtin alias names that fall back to "inherit the parent route" when
 * unconfigured. Case-insensitive; a configured value still wins over this
 * fallback.
 */
export const BUILTIN_ALIASES: readonly string[] = [...CC_ALIASES, ...LANE_ALIASES]

/** The set of builtin names, lowercased, for O(1) membership checks. */
const BUILTIN_SET = new Set(BUILTIN_ALIASES)

/**
 * Once-per-alias ledger for the cheap-lane inherit warning (plan §8 W5):
 * an unconfigured builtin alias resolving to "inherit the parent route"
 * warns once per alias per process lifetime. Module-level so both the
 * service path and the `resolveAlias` no-service fallback share it.
 */
const inheritWarned = new Set<string>()

/** Test seam: clear the once-per-alias inherit-warning ledger. */
export function resetInheritWarned(): void {
  inheritWarned.clear()
}

/**
 * Merge the deployment `config` defaults and the settings overlay into one
 * effective alias map (aliases keyed by lowercased name). Entry-shallow:
 * a settings value replaces a config value wholesale and never field-merges a
 * `{provider, model}` object; a settings `null` deletes the config entry.
 * @param config - deployment config `modelAliases` (values never `null` at the
 *   schema level), or `undefined`.
 * @param settings - live settings `model-aliases` section (values may be `null`
 *   to delete), or `undefined`.
 * @returns a fresh map of only the configured aliases, keyed lowercased.
 */
export function mergeAliasMaps(
  config: Readonly<Record<string, AliasTarget>> | undefined,
  settings: Readonly<Record<string, AliasTarget | null>> | undefined,
): ReadonlyMap<string, AliasTarget> {
  const merged = new Map<string, AliasTarget>()
  for (const [key, value] of foldKeys(config)) {
    // Config never carries `null` at the schema level, but schemastery dicts are
    // lenient about stored values; silently treat a stray config `null` as
    // absent so it can never reach the resolver as a route.
    if (value !== null) merged.set(key, value)
  }
  for (const [key, value] of foldKeys(settings)) {
    // Settings control keys (e.g. `warnOnInherit`) are booleans, not aliases;
    // never let them enter the alias map.
    if (typeof value === 'boolean') continue
    if (value === null) merged.delete(key)
    else merged.set(key, value)
  }
  return merged
}

/**
 * Build a `resolveModel` closure for an agent provider. The alias source is a
 * thunk evaluated on every invocation, so the closure reads the live settings
 * and merges fresh each spawn (see the plan's liveness requirement).
 * @param getAliases - returns the effective alias map for this invocation (the
 *   caller composes config + live settings via {@link mergeAliasMaps}).
 * @param options - optional warning hook for unsigned custom aliases; the
 *   message is emitted (defaulting to `console.warn`) when a model that is not
 *   a configured alias and not a builtin looks like an intended alias (a bare
 *   lowercase alphabetic word) and is passed through verbatim.
 * @returns the resolution function mapping a frontmatter `model` to a route, or
 *   `undefined` for no override. The returned function also carries
 *   `resolveDetailed`, the atomic provenance-carrying form it is derived from.
 */
export interface ModelResolver {
  (model: string | undefined): ResolvedRoute | undefined
  /** Atomic detailed resolution — one settings snapshot classifies AND routes. */
  resolveDetailed(model: string | undefined): DetailedRoute
}

export function createModelResolver(
  getAliases: () => ReadonlyMap<string, AliasTarget>,
  options?: { warn?: (message: string) => void; warnOnInherit?: boolean },
): ModelResolver {
  const inspect = createModelInspector(getAliases, options)
  const warn = options?.warn ?? ((message: string) => console.warn(message))
  // W5 cheap-lane inherit observability: warn once per alias when an
  // unconfigured builtin (or a lane falling through to a builtin peer)
  // inherits the parent route. Default on; `warnOnInherit: false` suppresses.
  const warnOnInherit = options?.warnOnInherit !== false
  const resolveDetailed = (model: string | undefined): DetailedRoute => {
    const verdict: AliasInspection = inspect(model)
    if (verdict.kind === 'inherit') {
      const folded = model?.trim().toLowerCase()
      const peerInherit = verdict.via === 'peer' && BUILTIN_SET.has(verdict.hop ?? '')
      if (warnOnInherit && folded && (verdict.via === 'builtin' || peerInherit) && !inheritWarned.has(folded)) {
        inheritWarned.add(folded)
        warn(`cc-model-aliases: alias "${folded}" is unconfigured; route inherited from parent — cheap-lane savings are zero for this session`)
      }
      return { selector: model === undefined || model.trim().length === 0 ? undefined : model.trim(), via: 'inherit', route: undefined }
    }
    const selector = model?.trim()
    if (verdict.kind === 'route') {
      return { selector, via: 'alias', route: verdict.route }
    }
    // Upstream's inspector reports the literal passthrough for BOTH a custom
    // alias name and a followed string-form target; our `DetailedRoute` keeps
    // the finer split: when the literal route's model differs from the
    // selector, the selector was a CONFIGURED alias followed to its target,
    // so the provenance is `alias`, not `literal`.
    const followed = verdict.route !== undefined && verdict.route.model !== undefined && verdict.route.model !== selector
    return { selector: followed ? selector : verdict.route?.model, via: followed ? 'alias' : 'literal', route: verdict.route }
  }
  // `resolve` is derived from `resolveDetailed` so the classification and the
  // route always come from the SAME merged map — no double lookup, and the
  // legacy route behavior stays byte-identical by construction.
  const resolve = (model: string | undefined) => resolveDetailed(model).route
  return Object.assign(resolve, { resolveDetailed })
}

/** Legal `$level` suffix spelling after the `$`. */
const LEVEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

/**
 * Split an optional `$<level>` reasoning-effort suffix off a model reference
 * (`opus$high`, `glm-5.3$xhigh`). The suffix must sit on the trailing path
 * segment — a `$` inside a provider segment (`open$high/glm`) is NOT treated.
 * Malformed forms (trailing `$`, empty level, bad charset, `$` outside the
 * trailing segment) pass the whole ref through verbatim, so existing ids that
 * contain no `$` resolve byte-identically.
 * @param ref - the model reference as authored.
 * @returns the bare reference and the level when a format-valid suffix was
 *   present. Format validity only: unknown level spellings are rejected at
 *   the harness boundary, never here.
 */
export function splitLevelSuffix(ref: string): { bare: string; level: string | undefined } {
  const i = ref.lastIndexOf('$')
  if (i <= 0 || i === ref.length - 1) return { bare: ref, level: undefined }
  // A `$` before the last `/` lives in a non-trailing segment — literal.
  const slash = ref.lastIndexOf('/')
  if (slash !== -1 && slash > i) return { bare: ref, level: undefined }
  const level = ref.slice(i + 1)
  if (!LEVEL_PATTERN.test(level)) return { bare: ref, level: undefined }
  // Leading `$` on the model segment (`pkg/$high`) leaves an empty model
  // segment — malformed, literal passthrough.
  if (ref.slice(0, i).endsWith('/')) return { bare: ref, level: undefined }
  return { bare: ref.slice(0, i), level }
}

/**
 * Build an inspector that classifies one frontmatter `model` the same way
 * {@link createModelResolver} resolves it, additionally reporting provenance
 * (kind / via / hop) for tooling like `/doctor`. The `route` field is exactly
 * what `resolve()` returns for the same input.
 * @param getAliases - returns the effective alias map for this invocation.
 * @param options - same warning hook as {@link createModelResolver}.
 * @returns the inspection function mapping a frontmatter `model` to an
 *   {@link AliasInspection}.
 */
export function createModelInspector(
  getAliases: () => ReadonlyMap<string, AliasTarget>,
  options?: { warn?: (message: string) => void },
): (model: string | undefined) => AliasInspection {
  const warn = options?.warn ?? ((message: string) => console.warn(message))
  const inspectBare = (model: string): AliasInspection => {
    const trimmed = model.trim()
    const folded = trimmed.toLowerCase()
    if (folded === 'inherit') return { kind: 'inherit' }

    const aliases = getAliases()
    const hit = aliases.get(folded)
    if (hit !== undefined && hit !== null) {
      if (typeof hit === 'string') {
        const followed = followStringTarget(hit, aliases, folded)
        const foldedTarget = hit.trim().toLowerCase()
        if (followed.kind === 'route') return { kind: 'route', via: 'one-hop', hop: foldedTarget, route: followed.route }
        if (followed.kind === 'inherit') return { kind: 'inherit', via: 'one-hop', hop: foldedTarget }
        return { kind: 'literal', route: { model: hit } }
      }
      // Object form: forward the route fields that are present. `provider` and
      // `reasoningEffort` are optional (absent = inherit / no stamp); `model`
      // is always set on a schema-valid object entry. Object targets are
      // concrete routes — they are not followed as alias names.
      return {
        kind: 'route',
        via: 'configured',
        route: {
          ...(hit.provider === undefined ? {} : { provider: hit.provider }),
          ...(hit.model === undefined ? {} : { model: hit.model }),
          ...(hit.reasoningEffort === undefined ? {} : { reasoningEffort: hit.reasoningEffort }),
        },
      }
    }

    // Unconfigured lane → follow its CC peer (`sketch` → `haiku`, …).
    // `architect` has no peer and falls through to inherit. Choice: when the
    // peer resolves to a configured route we report `via: 'alias'` (the lane
    // shares the peer alias's route); when the peer is itself unconfigured the
    // lane inherits, so `via: 'inherit'` — matching today's `resolve()`.
    const peer = LANE_PEERS[folded]
    if (peer !== undefined) {
      const followed = followStringTarget(peer, aliases, folded)
      if (followed.kind === 'route') return { kind: 'route', via: 'peer', hop: peer, route: followed.route }
      return { kind: 'inherit', via: 'peer', hop: peer }
    }

    // Unconfigured builtin alias → inherit the parent route ("current model").
    if (BUILTIN_SET.has(folded)) return { kind: 'inherit', via: 'builtin' }

    // Custom alias that is unconfigured: warn when it looks like an intended
    // alias, then pass through verbatim as a literal model id (no regression
    // for literal ids such as `deepseek-chat`).
    if (/^[a-z]+$/.test(folded)) {
      warn(`cc-model-aliases: model "${trimmed}" is not a configured alias and is not builtin; passing through verbatim as a literal model id`)
    }
    return { kind: 'literal', route: { model: trimmed } }
  }
  return (model) => {
    if (model === undefined || model.trim().length === 0) return { kind: 'inherit' }
    // `$level` suffix parsing happens here so BOTH `resolve()` and
    // `resolveDetailed()` see the same strip-before-emit route: a format-valid
    // suffix is carried as `reasoningEffort` (overriding an alias-target
    // effort — the two provenances are only co-visible here) and the emitted
    // provider/model ids never contain `$`. Unknown level spellings are NOT
    // stripped or validated here: they ride `reasoningEffort` to the harness
    // boundary (`resolveCallWithInfo` throws UNSUPPORTED_REASONING_EFFORT).
    const { bare, level } = splitLevelSuffix(model.trim())
    const verdict = inspectBare(bare)
    if (level !== undefined && verdict.route !== undefined) {
      return {
        ...verdict,
        route: { ...verdict.route, reasoningEffort: level },
      }
    }
    return verdict
  }
}

type FollowedTarget
  = | { kind: 'route'; route: ResolvedRoute }
    | { kind: 'inherit' }
    | { kind: 'literal' }

/**
 * Follow a string-form target one hop when it names another alias.
 *
 * - `sketch: haiku` with haiku configured → haiku's route
 * - `sketch: haiku` with haiku unconfigured (builtin) → inherit
 * - `sketch: inherit` → inherit
 * - `sketch: deepseek-chat` (not an alias) → literal, caller keeps the string
 *
 * A second hop is not followed (`sketch: draft` + `draft: haiku` stops at
 * the literal `"haiku"`), which keeps cycles from looping. Object-form
 * targets are never followed as names.
 */
function followStringTarget(
  target: string,
  aliases: ReadonlyMap<string, AliasTarget>,
  from: string,
): FollowedTarget {
  const folded = target.trim().toLowerCase()
  if (folded.length === 0 || folded === from || folded === 'inherit') return { kind: 'inherit' }
  const next = aliases.get(folded)
  if (next !== undefined && next !== null) {
    if (typeof next === 'string') return { kind: 'route', route: { model: next } }
    return {
      kind: 'route',
      route: {
        ...(next.provider === undefined ? {} : { provider: next.provider }),
        ...(next.model === undefined ? {} : { model: next.model }),
        ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }),
      },
    }
  }
  if (BUILTIN_SET.has(folded)) return { kind: 'inherit' }
  return { kind: 'literal' }
}

/** Compact-fill a record's own string keys, folding each to lowercase. */
function foldKeys(record: Readonly<Record<string, AliasTarget | null>> | undefined): Map<string, AliasTarget | null> {
  const out = new Map<string, AliasTarget | null>()
  if (record === undefined) return out
  for (const [key, value] of Object.entries(record)) {
    out.set(key.toLowerCase(), value)
  }
  return out
}
