# Small-fast lane + alias-resolved hook/recall models

Status: implemented on `feat/smallfast-lane` (Staff-approved; nits folded). Constraint: **dsh-cc only** — do not modify deepseek-harness.

## Goal

Give dsh-cc the Claude Code *shape* of a cheap background model without copying Anthropic product behaviour.

1. The cheap background lane **is** the configured `haiku` alias (`resolve('haiku')`; unconfigured → inherit). No second alias name, no new settings namespace.
2. Independent one-shot classifiers (prompt/agent hooks with no `model:`, memory recall) use that lane instead of the parent route.
3. Any authored `model:` on those forks goes through `ccModelRoutes.resolve`, never as a literal id (`haiku` must not reach `prepareCall`).
4. Shared `toAgentOptions` so Task / plugin-loader / hooks / recall stamp the same shape.
5. Consumers that `ctx.get('ccModelRoutes')` must live **inside** the `cc-services` isolate group. Today `memory` and `hooks-claude-code` are sibling rows and cannot see the service.

Observable in a later real session (not claimed at merge): a prompt hook without `model:` and a configured `haiku` alias issues the child request on the haiku target, not the parent model; `model: opus` on a hook issues the opus route.

## Why this, not the rest of the CC matrix

From the CC auto-routing analysis (3/4/5/7) against this repo:

| CC behaviour | dsh-cc decision |
|---|---|
| Built-in Explore=haiku, guide=haiku, statusline=sonnet | **Skip.** Typed agents already pin aliases (`deep-reasoner`/`opus`, `fast-worker`/`sonnet`). Do not add CC's agent roster. |
| Background Haiku (`queryHaiku`, titles, prefix classifier, WebFetch apply) | **Partial.** No session-title generator exists here — do not invent one. Wire the lane into *existing* independent one-shots only. |
| `opusplan`, account-default Opus, teammate-default Opus, org allowlist swap | **Skip.** Subscription-product policy; conflicts with "unconfigured builtin → inherit". |
| Compact uses main loop model | **Already aligned** (microcompact is model-free). |
| Skill/command `model:` frontmatter | **Partial.** Loader already stores `metadata.model`. Inline skill execution lives in harness `dsh-tool-skill` (frozen). Do not wrap the skill tool this round. Fork-skill spawn does not consume `metadata.model` today (`activationFor` return is discarded). Follow-up, not this PR. |

Hard constraint from PR #59: dsh-cc forks **inherit the parent prefix**. Crossing models busts cache. Therefore the lane is only attached to short classifier forks whose parent-model cost dominates the cache miss (JSON yes/no, filename pick). Consolidation / dream / extractMemories stay inherit.

## User-visible behaviour

### Alias authors / deployers

No new settings namespace. `haiku` in `model-aliases` (config or settings) **is** the small-fast target.

```jsonc
// settings namespace "model-aliases"
{
  "haiku": { "provider": "orchestrix", "model": "deepseek-v4-flash-0731" }
}
```

- Configured `haiku` → small-fast children stamp that route (including object-form `reasoningEffort` if present).
- Unconfigured / settings-null `haiku` → builtin fallback = inherit parent (same as today for `model: haiku` on Task).
- No `ANTHROPIC_SMALL_FAST_MODEL`. No second alias name.

### Prompt / agent hooks (`enablePromptHooks` / `enableAgentHooks`)

Flags stay **off by default**. When enabled:

| Hook `model` field | Child `agentOptions` |
|---|---|
| omitted | `toAgentOptions(routes?.resolve('haiku'))` — haiku route, or omit (inherit) if unconfigured / no `ccModelRoutes` |
| `inherit` (any case) | omit (inherit parent). **Bugfix:** today this stamps `{ model: 'inherit' }` and the child request fails. |
| configured alias (`haiku`/`sonnet`/`opus`/custom) | resolved route |
| literal model id | `{ model: <id> }` (resolver passthrough) |
| no `ccModelRoutes` mounted | omit always (inherit). **Behaviour change:** today an explicit `model: claude-haiku` is stamped as a literal and 404s on pi-ai. After this, missing routes = inherit, matching Task. The cc preset always mounts `cc-model-routes`; this path is for unit tests and odd hosts. |

Agent hooks use the same default as prompt hooks (CC schema: both default to Haiku / small-fast). They remain prefix-inheriting forks — accepted cache miss, because the alternative is running a verifier on the parent (kimi-k3 / glm) for a JSON decision, and the feature is opt-in.

### Memory recall

`recallAgentOptions` is documented and schema-present but **never passed** into `MemoryRecall` (`memory/src/index.ts` apply). After this, recall stays **opt-in to the cheap lane** (recall itself remains default-on; only the *model* switch is gated):

| Config | Child `agentOptions` |
|---|---|
| `recallAgentOptions` set (non-null object) | that value, unchanged (escape hatch; host is responsible for resolving aliases) |
| `recallUseSmallFast: true` (new, default **false**) + `haiku` configured | `toAgentOptions(routes?.resolve('haiku'))` |
| `recallUseSmallFast: true` + haiku unconfigured / no routes | omit (inherit) |
| default (`recallUseSmallFast` unset/false, `recallAgentOptions` unset) | omit (inherit) — **today's accidental behaviour, preserved** |

Rationale: merely configuring `haiku` for Explore/typed-agent must not silently flip every turn's recall onto a cross-model, prefix-inheriting fork. Hooks are already behind `enablePromptHooks`; recall needs the same kind of flag.

`recallAgentOptions` remains `z.any()` and is **not** run through `ccModelRoutes` — it is a raw `agentOptions` overlay for tests and hosts that already have a resolved route. Do not pass `{ model: 'haiku' }` through it and expect alias resolution.

Consolidation / dream forks are untouched.

### Task / plugin agents

No user-visible change. They already resolve through `ccModelRoutes`. Implementation only switches to the shared `toAgentOptions` helper.

### Skills

No user-visible change this round. `SKILL.md` `model:` stays in metadata. A later PR wires it at the consumer that actually spawns (`dsh-tool-skill` or a dsh-cc wrapper) through the same resolver.

## Design

### 1. `toAgentOptions`

Package: `@dsh-cc/model-aliases`.

```ts
export interface ModelRoutes {
  resolve(model: string | undefined): ResolvedRoute | undefined
}

/** Drop undefined fields so per-field inheritance survives. `undefined` in → `undefined` out. */
export function toAgentOptions(
  route: ResolvedRoute | undefined,
): Record<string, string> | undefined
```

`toAgentOptions` is the body currently duplicated as `stripUndefined` in `packages/subagent/task/src/tool.ts` and the inline object in `packages/compat/cc-plugin-loader/src/agents.ts`. Empty object (route with every field undefined) returns `undefined`.

Export from `src/agentOptions.ts` and `src/index.ts`. Unit-test without mounting cordis.

Do **not** add `ModelRoutes.smallFast()`. It is a one-line wrapper around `resolve('haiku')` and would be a version-skew TypeError at every call site that structural-casts `ctx.get('ccModelRoutes')` against an older published service (independently versioned packages; the throw is *outside* the existing `subagents.start` try/catch in `dispatch.ts`). Every consumer in this PR calls `routes?.resolve('haiku')`.

### 2. Preset realm: move consumers into `cc-services`

`ccModelRoutes` is isolated inside the `cc-services` group (`packages/preset/cc/agent.cordis.yml` isolate map). A sibling fiber's `ctx.get('ccModelRoutes')` is invisible (`vendor/cordis` isolate walk). Existing consumers (`tool-task`, `cc-shell-glue`, `command-plugin`, `command-mcp`) already live in the group for this reason.

`memory` and `hooks-claude-code` currently sit in the "parallel rows" section. Neither publishes a cordis Service (`ctx.provide` is absent from both packages' `src/`), so group membership is mount-legal (the leakedServices gate only rejects root-realm *providers*).

**Change `packages/preset/cc/agent.cordis.yml`:**

- Move `- id: memory` and `- id: hooks-claude-code` into the `cc-services` group's `config:` list (after `tool-task` is fine).
- Leave `memory-consolidation` outside. Consolidation must keep inheriting; putting it in the group would make a future `ctx.get('ccModelRoutes')` accidentally easy. Do not "fix" it this PR.
- Update the group comment: commands *and* the two new consumers must live inside because they `ctx.get('ccModelRoutes')`.
- Update `packages/preset/cc/tests/composition.spec.ts`:
  - existing `'isolates exactly the five cc-services services, hosting the two commands'` stays (isolate keys unchanged).
  - add: `configIds` contains `'memory'` and `'hooks-claude-code'`; `topIds` does not.
- Do **not** add isolate keys. Do **not** de-isolate `ccModelRoutes`.

### 3. Hooks dispatch

File: `packages/hooks/hooks-claude-code/src/dispatch.ts`.

Replace:

```ts
...(hook.model !== undefined ? { agentOptions: { model: hook.model } } : {}),
```

with:

```ts
const routes = ctx.get('ccModelRoutes') as { resolve(model: string | undefined): ResolvedRoute | undefined } | undefined
const route = hook.model !== undefined ? routes?.resolve(hook.model) : routes?.resolve('haiku')
const agentOptions = toAgentOptions(route)
...(agentOptions !== undefined ? { agentOptions } : {}),
```

`hook.model === 'inherit'` is handled by the resolver (`folded === 'inherit' → undefined`), so the omitted/`inherit` rows of the table collapse to the same code path once `routes` exists.

**Dependencies (not peer):** add `@dsh-cc/model-aliases` to `dependencies` **and** `devDependencies` of `packages/hooks/hooks-claude-code/package.json`, matching Task (`packages/subagent/task/package.json` runtime `dependencies`, not peer). `toAgentOptions` is a runtime import.

Structural `ctx.get` stays lazy: missing service → inherit. In the cc preset, after the YAML move, the service is visible.

Keep `enablePromptHooks` / `enableAgentHooks` default false.

### 4. Memory recall wiring

File: `packages/memory/memory/src/index.ts` (`src/recall.ts` needs no edit: `MemoryRecall` already takes `createSelector`; the selector already forwards `agentOptions`).

`MemoryRecall` already accepts a `createSelector` factory; `SubagentMemorySelector` already takes optional `agentOptions` and forwards it. `apply()` currently ignores `config.recallAgentOptions`.

Add `recallUseSmallFast?: boolean` (schema default `false`) next to `recallAgentOptions`.

```ts
new MemoryRecall(ctx, home, {
  providerName: config.recallProviderName ?? 'fork',
  enabled: true,
  createSelector: (c, agent) => new SubagentMemorySelector(
    c,
    agent,
    config.recallProviderName ?? 'fork',
    resolveRecallAgentOptions(c, config),
  ),
})

function resolveRecallAgentOptions(c: Context, config: Config): unknown {
  if (config.recallAgentOptions !== undefined) return config.recallAgentOptions
  if (config.recallUseSmallFast !== true) return undefined
  const routes = c.get('ccModelRoutes') as { resolve(m: string | undefined): ResolvedRoute | undefined } | undefined
  return toAgentOptions(routes?.resolve('haiku'))
}
```

**Dependencies (not peer):** add `@dsh-cc/model-aliases` to `dependencies` **and** `devDependencies` of `packages/memory/memory/package.json`, same as Task. `z.any()` on `recallAgentOptions` stays.

### 5. Task + plugin-loader mechanical reuse

- `packages/subagent/task/src/tool.ts`: delete local `stripUndefined`; `toAgentOptions(routes?.resolve(definition.model))`.
- `packages/compat/cc-plugin-loader/src/agents.ts`: `resolveModelOverride` returns `toAgentOptions(resolver(model))` when a resolver is injected. **Keep the no-resolver branch** (`model !== undefined ? { model } : undefined`) — that is the documented historical fallback for a settings-less plugin-loader host, distinct from hooks (hooks never had a working literal-alias path; plugin-loader still has hosts that inject no resolver).
- `packages/compat/cc-plugin-loader/package.json`: add `@dsh-cc/model-aliases` to `dependencies` **and** `devDependencies` (Task pattern). Today this package has **zero** model-aliases dependency — the resolver is injected. `toAgentOptions` is a new runtime import, so the dep is required. Do not put it in `peerDependencies` (hooks' `@dsh-cc/hook-protocol` is a peer; that is a different relationship).

### 6. Docs

- `packages/compat/cc-model-aliases/README.md` + `README.zh.md`: document `toAgentOptions`; the cheap lane is `resolve('haiku')`.
- `packages/hooks/hooks-claude-code/README.md` + zh: hook `model` goes through aliases; omitted → `resolve('haiku')`; inherit/unconfigured → parent. Note the row now lives in `cc-services`.
- `packages/memory/memory/README.md` + zh: `recallUseSmallFast` (default false) stamps `resolve('haiku')`; `recallAgentOptions` wins and is not alias-resolved.
- `packages/preset/cc` comments + `docs/cc-parity-matrix.md`: one clause on the Model aliases / Hooks rows and the group membership.
- No new cordis row. `haiku` is already a builtin alias.

## Non-goals (do not implement in this PR)

- Session title / `/rename` / teleport Haiku generators.
- WebFetch secondary extraction model.
- Bash/PowerShell prefix classifier.
- New Explore / claude-code-guide agents.
- `opusplan`, permissionMode-based main-loop swap, teammate default Opus.
- Skill inline `model:` switching (harness `dsh-tool-skill`).
- Skill `context: fork` spawn consuming `metadata.model` (`activationFor` currently discarded — separate bug, do not piggy-back).
- Memory consolidation / AutoDream model override.
- `ANTHROPIC_*` env vars, a second `smallFast` alias name, or a new settings namespace.
- deepseek-harness source.

## Files (ordered for TDD)

1. `packages/compat/cc-model-aliases/src/agentOptions.ts` **new**
2. `packages/compat/cc-model-aliases/tests/agentOptions.spec.ts` **new**
3. `packages/compat/cc-model-aliases/src/index.ts` export (`toAgentOptions` only; do not extend `ModelRoutes`)
4. `packages/subagent/task/src/tool.ts` (reuse; existing tests must stay green)
5. `packages/compat/cc-plugin-loader/package.json` (`dependencies` + `devDependencies`) + `src/agents.ts` (reuse with resolver; keep no-resolver literal overlay)
6. `packages/hooks/hooks-claude-code/package.json` (`dependencies` + `devDependencies`) + `src/dispatch.ts`
7. `packages/hooks/hooks-claude-code/tests/executors.spec.ts` (extend `fakeSubagents` to record `agentOptions`)
8. `packages/memory/memory/package.json` (`dependencies` + `devDependencies`) + `src/index.ts` (`recallUseSmallFast`)
9. `packages/memory/memory/tests/recall.spec.ts` (selector already unit-tested; add apply-level or constructor-forwarding cases)
10. `packages/preset/cc/agent.cordis.yml` (move `memory` + `hooks-claude-code` into `cc-services`)
11. `packages/preset/cc/tests/composition.spec.ts` (assert those two ids live in the group, not at top level)
12. READMEs + `docs/cc-parity-matrix.md` + this plan's status line

## Tests (write first)

### `toAgentOptions` (pure)

- `undefined` → `undefined`
- `{ model: 'm' }` → `{ model: 'm' }`
- `{ provider: 'p', model: 'm', reasoningEffort: 'max' }` → all three keys
- `{ model: 'm', provider: undefined }` → `{ model: 'm' }` only
- `{}` → `undefined`

### Hooks (`enablePromptHooks: true`)

Extend `fakeSubagents` so `start` records the full request.

- no `model`, `resolve('haiku')` returns `{ provider, model }` → `agentOptions` equals that
- no `model`, no `ccModelRoutes` → `agentOptions` undefined
- `model: 'haiku'`, `resolve('haiku')` configured → resolved route, **not** `{ model: 'haiku' }`
- `model: 'inherit'` → `agentOptions` undefined
- `model: 'opus'`, opus configured → opus route
- `enablePromptHooks: false` still skips (existing test)
- agent hook, no `model`, haiku configured → same stamp as prompt (one test is enough)

### Memory

- `SubagentMemorySelector` with `agentOptions` forwards them on `start` (today there is no such assertion)
- `apply()` default (`recallUseSmallFast` unset) + configured haiku → selector child has **no** `agentOptions` (inherit preserved)
- `apply()` with `recallUseSmallFast: true` and `resolve('haiku')` configured → selector child gets that stamp
- `apply()` with `recallUseSmallFast: true` and no `ccModelRoutes` → no stamp
- `apply()` with explicit `recallAgentOptions` (even when `recallUseSmallFast: true`) → that value, haiku not consulted

### Preset composition

- `cc-services.config` ids include `memory` and `hooks-claude-code`
- those ids are absent from the top-level row list
- isolate map still exactly the five keys (no new isolate)
- rename the existing `'isolates exactly the five cc-services services, hosting the two commands'` test while touching it (group now hosts more than two extra rows)
- extend `'declares every @dsh-cc row name as a dependency'` to walk **group-nested** `@dsh-cc` rows, otherwise `memory` / `hooks-claude-code` drop out of the assertion at the moment memory gains a new runtime dep

Do **not** boot a full agent-loop for memory apply if a focused test of the `createSelector` closure is cheaper; prefer the smallest seam that observes `subagents.start`.

### Task / plugin-loader

Existing specs are the regression gate. No new cases required unless `toAgentOptions` changes a key name (it must not).

## Verification (pass/fail)

```text
./node_modules/.bin/vitest run \
  packages/compat/cc-model-aliases \
  packages/subagent/task \
  packages/compat/cc-plugin-loader \
  packages/hooks/hooks-claude-code \
  packages/memory/memory \
  packages/preset/cc
```

Pass = all green. Do not run `pnpm` in this worktree without `bash scripts/link-worktree-deps.sh` first; prefer the linked `./node_modules/.bin/vitest`.

Manual (post-merge, later session — do not claim at merge): enable `enablePromptHooks`, configure `haiku`, fire a UserPromptSubmit prompt hook, confirm the child `request/context` event is the haiku target.

## Commit message (expected observable)

```
feat(model-aliases): small-fast lane for classifier forks

Prompt/agent hooks without model: resolve through ccModelRoutes
(haiku when omitted; authored aliases/ids otherwise). Memory recall
gains recallUseSmallFast (default false) to opt the selector into
resolve('haiku'). memory + hooks-claude-code move into the cc-services
isolate group so they can see ccModelRoutes. Task/plugin-loader
behaviour unchanged (shared toAgentOptions helper).
```

## Risks

- Prefix-inheriting fork + haiku = cache miss. Accepted for opt-in hooks (`enablePromptHooks`) and opt-in recall (`recallUseSmallFast`); do not expand to consolidation. Do not default-on recall just because `haiku` is configured.
- Hook with explicit `model:` and no routes service no longer stamps a literal. Safer, but a host that relied on literal ids without mounting `cc-model-routes` silently inherits. Mitigate: cc preset always mounts `cc-model-routes`; after this PR the hooks row lives in the same isolate group.
- `recallAgentOptions: z.any()` is an unresolved overlay. Passing `{ model: 'haiku' }` through it will *not* alias-resolve. Document that. A truthy `{}` wins over `recallUseSmallFast` and stamps nothing useful — do not special-case; document that unset (not `{}`) is the default path.
- Moving `memory` / `hooks-claude-code` into `cc-services` changes their fiber parent. They publish no Service, so leakedServices stays quiet. Smoke via the composition spec. If a future change makes either package `ctx.provide`, it must add an isolate key or leave the group.
