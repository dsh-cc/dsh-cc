# @dsh-cc/model-aliases

English | [中文](README.zh.md)

Claude Code-compatible model alias resolution for the DeepSeek Harness. It maps Claude Code
frontmatter model aliases (`model: opus`, `model: sonnet`) onto dsh
`{provider, model, reasoningEffort?}` routes. The package now ships in two shapes:

- a **`ccModelRoutes` host service** (the cordis plugin entry) that owns the `model-aliases`
  settings namespace registration and exposes a spawn-time resolver, and
- the **pure helpers** (`mergeAliasMaps` / `createModelResolver`) for embedding the same
  resolution semantics without mounting the service.

## Why

Claude Code agent/CLAUDE.md frontmatter names models by alias. Without an alias
layer, `model: opus` was passed through verbatim as a provider model id, so an
adapter that does not know the id (e.g. `llm-pi-ai`) threw `UNKNOWN_MODEL`, and
`model: inherit` — a valid CC sentinel meaning "use my parent's model" — was
also handed to `prepareCall` as a literal id and errored.

This package adds that layer: an alias resolves to a `{provider, model, reasoningEffort?}` route,
the unresolvable cases fall back to *inheriting the parent route* (no override),
and literal ids like `deepseek-chat` keep passing through untouched.

## The `ccModelRoutes` service

The plugin entry (`name: 'cc-model-routes'`, `apply`) is what the CC preset mounts via the
`cc-model-routes` row. It:

- registers the `model-aliases` **settings namespace** — but **only when** a settings
  provider (`ctx.get('settings')`) is mounted, so a settings-less host degrades to the config
  defaults plus the builtin fallback (this namespace registration is the single owner of that
  name; the harness throws on a duplicate registration, see `dsh-settings`);
- registers the namespace with a **write-time `validate`** that rejects a half-written
  `{provider, model}` route (a non-empty cross-field check the dict schema itself cannot
  express);
- and provides the spawn-time resolver as the **`ccModelRoutes`** value (`ctx.provide`) whose
  `resolve(model)` reads the **live** settings scope on every invocation — a settings write
  applies to the next spawn with no re-registration.

Consumers `ctx.get('ccModelRoutes')` **lazily** on every spawn. Lazily means mount order does
not matter: before the provider's fiber is active, `ctx.get` returns `undefined`, which
resolves to "inherit the parent route" (the same no-override behavior as before).

## How the cc-shell bundle wires it

- `Config.modelAliases` provides **deployment defaults** (alias name → model id
  or `{provider, model}`).
- The `model-aliases` **settings namespace** registration now lives in the `ccModelRoutes`
  service, layered exactly like every other settings section (user/project/local/flags).
- cc-shell's `AgentProvider` gains its `resolveModel` as a **trampoline** over the service:
  `(model) => ctx.get('ccModelRoutes')?.resolve(model)` — queried **lazily on every spawn**,
  read fresh (no snapshot captured at apply time), and degrading to inherit when the service
  is not mounted (`undefined` resolution = inherit the parent route, byte-compatible with the
  old no-resolver fallback). cc-shell no longer registers the namespace itself.
- The Task tool (`@dsh-cc/subagent-task`) is the other consumer: it resolves a
  subagent definition's frontmatter `model` through the same `ccModelRoutes` resolver at
  spawn time.

## Configuration

```yaml
# ccModelRoutes service config (the preset's cc-model-routes row)
modelAliases:
  sonnet: deepseek-v4-flash                      # string form: model only, provider inherits
  opus:   { provider: deepseek-official, model: deepseek-v4-pro }  # explicit route
```

```jsonc
// settings namespace "model-aliases"
{
  "fable":  { "provider": "anthropic", "model": "claude-fable-5" },
  "sonnet": null     // null = delete the same-named config-default alias
}
```

## Resolution semantics

Lookup order for an alias: **settings overlay → config defaults → builtin
fallback**. Alias key matching is **case-insensitive** (keys are folded to
lowercase at merge and at lookup).

| `model` frontmatter | Result |
|---|---|
| `undefined` / blank | no override — child inherits the parent route |
| `inherit` (any case) | no override — child inherits the parent route (**fixes the old pass-through bug**) |
| configured alias (string form) | `{ model: <target> }` |
| configured alias (object form) | `{ provider?: <p>, model: <m>, reasoningEffort?: <effort> }` |
| builtin alias unconfigured (`fable`/`opus`/`sonnet`/`haiku`) | no override — child inherits the parent route ("current model") |
| dsh-cc lane unconfigured (`sketch`/`draft`/`blueprint`/`masterplan`) | follows the CC peer (`haiku`/`sonnet`/`opus`/`fable`); inherit if that peer is also unconfigured |
| `architect` unconfigured | no override — inherit the parent (main-thread) route |
| anything else | passed through **verbatim** as a literal model id; a bare-lowercase-word form (e.g. `turbo`) logs a warning that it looks like an unconfigured alias |

### `reasoningEffort` on object-form aliases

An object-form alias may declare an optional `reasoningEffort`: an opaque
non-empty string whose legal spellings belong to the **target model's adapter**
(`max`, `xhigh`, `high`, … — not validated against any adapter catalog here).
When present, the spawn (the Task tool and the plugin-loader's
`AgentProvider`) stamps it onto the child's options, and the routes service's
host `agent/request` listener applies it to **every** request of that child,
overriding any effort restored from a forked parent header. String-form
aliases cannot carry an effort; `inherit` / unconfigured builtins stamp
nothing. An effort the target model does not support fails the request with
`UNSUPPORTED_REASONING_EFFORT` — fail-loud, by design.

```jsonc
// settings namespace "model-aliases"
{
  "opus":   { "provider": "orchestrix", "model": "glm-5.3",       "reasoningEffort": "max" },
  "sonnet": { "provider": "orchestrix", "model": "glm-5.3-flash", "reasoningEffort": "max" }
}
```

Changing the opus target to a model with a different effort vocabulary is a
single settings edit (`"reasoningEffort": "xhigh"`); the agent markdown is
untouched.

### Null deletion

Only the **settings** layer may set an entry to `null`; that deletes a
same-named **config-default** entry (entry-shallow). Deleting a *builtin* alias
still falls through to the builtin fallback — `null` cannot turn `sonnet` into an
error, because the builtin fallback is **inherit the parent route**. Config may
never hold `null` (rejected by the config schema).

### Merge rules

- **Config vs settings is entry-shallow**: a settings entry replaces the config
  entry wholesale. It never field-merges `{provider, model}` objects — so
  `config { provider: A, model: X }` + `settings { model: Y }` yields
  `{ model: Y }`, never a blended `{ provider: A, model: Y }` that no single
  layer declared.
- **Within the settings 5-cascade the merge is recursively deep** (existing
  cascade behavior). Consequently an object-form alias must be written **whole
  or not at all** across settings layers, or the cascade will field-blend
  `{provider, model}` just as described above — this is a cascade-level
  behavior this package does not change. Prefer string-form aliases, or repeat
  the full route on every layer that mentions the alias.

### Builtin fallback

Fresh installs with **zero configuration** still work: `model: sonnet` /
`model: opus` / `model: draft` agents resolve to *inherit the parent's current
model* (an unconfigured lane follows a configured CC peer) instead of
erroring. Builtin names (CC family + dsh-cc lanes) get this fallback; a
custom alias (`turbo`, `gpt`, …) that is unconfigured has **no** fallback
and is passed through verbatim (with the warning above).

## `inherit` fix note

Prior to this package, `model: inherit` was forwarded as the literal model id
all the way to `prepareCall`, where it failed. In CC mode the spawn-time resolver
(from the `ccModelRoutes` service, consumed via the cc-shell trampoline and the
Task tool) maps `inherit` to "no override", so the child inherits the parent
route, matching CC semantics. When no resolver is mounted (non-cc consumers of
`@dsh-cc/plugin-loader` that do not set `resolveModel`), behavior stays
byte-identical to before — including the old `inherit` pass-through — because the
no-resolver fallback is preserved exactly. The CC preset unconditionally mounts
cc-shell (and the routes service), so in CC mode the fix is always active.

## API

- `apply(ctx, config?)` / `name` — **cordis plugin entry** (plugin id `cc-model-routes`,
  also re-exported as `applyRoutes` / `routesPluginName`). Mounts the service; config shape is
  `{ modelAliases?: Record<string, AliasTarget> }` (deployment defaults).
- `ModelRoutes` — the value type of `ctx.get('ccModelRoutes')` (`resolve(model):
  { provider?, model?, reasoningEffort? } | undefined`).
- `overlayStampedEffort(resolved, stamped)` / `stampedEffortOf(options)` — the
  host-side effort overlay used by the service's `agent/request` listener;
  exported for tests and host embeddings.
- `mergeAliasMaps(config, settings)` — entry-shallow merge with `null` deletion
  and case-insensitive key folding; returns an effective `ReadonlyMap` of only
  the configured aliases.
- `createModelResolver(getAliases, { warn })` — build a `resolveModel` closure.
  `getAliases` is a thunk evaluated **per invocation** (liveness). Optional
  `warn` replaces the default `console.warn` used for the unconfigured-custom-alias
  warning.
- `BUILTIN_ALIASES` — CC family (`fable`/`opus`/`sonnet`/`haiku`) plus dsh-cc lanes (`sketch`/`draft`/`blueprint`/`masterplan`/`architect`).
- `LANE_PEERS` — unconfigured-lane → CC-family map (`sketch→haiku`, `draft→sonnet`, `blueprint→opus`, `masterplan→fable`; `architect` has no peer).
- `toAgentOptions(route)` — drop `undefined` fields from a resolved route so
  per-field inheritance survives (never set a field to `undefined` on the child
  request); `undefined` in → `undefined` out, and an all-`undefined` route
  collapses to `undefined` ("no override"). Shared by Task, cc-plugin-loader,
  the hooks bridge, and memory recall.
- `toOneShotRoute(route, parent?)` — fill a resolved alias into a complete
  `{provider, model}` pair for an independent one-shot `ctx.llm.stream` call:
  alias fields win, missing fields inherit from the parent route, and an
  incomplete pair (no model after inherit) returns `undefined` so callers
  treat it as "unconfigured". Used by the session-title overlay and the
  WebFetch summarizer.
- `ConfigAliasesSchema` / `SettingsAliasesSchema` (and their record forms) —
  schemastery schemas for the config layer (no `null`) and settings layer
  (`null` allowed), plus `AliasTarget` / `ResolvedRoute` types.

## dsh-cc lanes

Five extra builtin names sit alongside the Claude Code family. They are
configuration, not a second settings namespace. Unconfigured, each lane
except `architect` follows its CC peer, so a deployment that already maps
`haiku` does not need a duplicate `sketch` entry:

| Lane | Role | Unconfigured peer |
|---|---|---|
| `sketch` | Fast, lightweight execution | `haiku` |
| `draft` | Balanced everyday coding | `sonnet` |
| `blueprint` | Deep reasoning | `opus` |
| `masterplan` | Maximum reasoning | `fable` |
| `architect` | Planning and orchestration | inherit (main thread) |

A configured string-form target that names another alias is followed **one
hop** (`sketch: haiku` shares haiku's object route, including
`reasoningEffort`). Object-form targets are concrete routes and are not
followed as names. A second hop is not followed, so `sketch: draft` +
`draft: haiku` stops at the literal `"haiku"` (cycle-safe).

Frontmatter can use either vocabulary (`model: opus` or `model: blueprint`).
The cheap background classifier lane stays `resolve('haiku')` — hooks and
recall do not switch to `sketch`.

## The cheap (small-fast) lane

There is no second alias name and no `ANTHROPIC_SMALL_FAST_MODEL`. The cheap
background lane **is** the configured `haiku` alias: consumers that need a
small, independent one-shot classifier model call `resolve('haiku')` — the
configured haiku route when set, inherit-the-parent when unconfigured (the
builtin fallback). Current consumers: the hooks bridge (`prompt`/`agent` hooks
without an authored `model:`), memory recall with `recallUseSmallFast: true`,
the session-title overlay, and the WebFetch summarizer.

## Non-goals (tracked in the parity matrix)

`/model` interactive command, `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`
env vars, and aliasing the main session's default model remain follow-ups.
