# Alias-carried reasoningEffort for CC subagent spawn

Status: **Implemented** — PR #72 (merged 2026-09-02). Approved at Staff review (2026-09-02; M1/M2/S1 folded in). Constraint: **dsh-cc only** — do not modify deepseek-harness.

## Goal

A `model-aliases` object route may declare `reasoningEffort`. Named CC subagents
(`deep-reasoner` → `opus`, `fast-worker` → `sonnet`) spawn with that effort on
the resolved model. Changing the alias target (e.g. opus `glm-5.3`/`max` →
`grok-4.6`/`xhigh`) is a single-settings edit; agent markdown is untouched.

Example settings (`model-aliases` namespace):

```jsonc
{
  "opus":   { "provider": "orchestrix", "model": "glm-5.3",       "reasoningEffort": "max" },
  "sonnet": { "provider": "orchestrix", "model": "glm-5.3-flash", "reasoningEffort": "max" }
}
```

Later, the same `opus` entry becomes `{ provider: …, model: "grok-4.6", reasoningEffort: "xhigh" }`.

## Why alias, not agent frontmatter `effort:`

The loader already parses `effort:` into `AgentDefinition.effort`, but Task
never reads it. Even if it did, effort would be glued to the *agent* while the
legal values belong to the *target model*. `opus: max` in
`deep-reasoner.md` would break the moment opus points at grok-4.6.

Effort is a property of the alias target. String-form aliases (`sonnet: glm-5.3-flash`)
cannot carry it — object form is required. `inherit` / unconfigured builtin
still mean "no override" (no stamp).

## Why harness source stays frozen

- `resolveChildAgentOptions` spreads `request.agentOptions` onto `child.options`.
  Extra keys survive at runtime even though `AgentOptions` has no
  `reasoningEffort` field.
- `agent/request` is a public waterfall (compaction / retry already use it).
  A host listener can overlay `LlmCallConfig.reasoningEffort` after `next()`.
- `prepareCall` already rejects an unsupported effort
  (`UNSUPPORTED_REASONING_EFFORT`). Wrong alias values fail loud; we do not
  catalog-validate at settings-write time (that would couple aliases to adapters).

## Non-goals

- Do not wire `AgentDefinition.effort`.
- Do not change `.claude/agents/*.md`.
- Do not ship default glm/grok aliases in repo config.
- Do not alter main-session `/effort` / `installModelSelection`.
- Do not add a deepseek-harness peer just to type `AgentOptions`.

## Design

### 1. Alias vocabulary (`@dsh-cc/model-aliases`)

`AliasTarget` object form becomes `{ provider, model, reasoningEffort? }`.
`reasoningEffort` is an opaque non-empty string (not an enum: `max` / `xhigh` /
`high` are adapter-owned spellings). Empty string is schema-rejected.

`ResolvedRoute` gains optional `reasoningEffort`. Resolver copies it only from
object-form hits:

| hit | resolve() |
|---|---|
| string form | `{ model }` — never effort |
| object form, no effort | `{ provider, model }` |
| object form, with effort | `{ provider, model, reasoningEffort }` |
| inherit / unconfigured builtin / blank | `undefined` (no stamp) |

Settings overlay stays **entry-shallow**: a settings string-form `opus: glm-x`
wipes a config object that had effort. Document that object form must be
written whole (existing cascade warning; effort is one more blendable field).

Object form: `{ provider?: non-empty, model: non-empty, reasoningEffort?: non-empty }`.
`provider` is optional so `sonnet` can inherit the parent provider while still
stamping effort (Staff S1). Write-time validate still rejects a present-but-blank
provider. String form still cannot carry effort.

### 2. Stamp at spawn (Task + plugin-loader)

Both consumers already turn a resolved route into `agentOptions` and drop
`undefined` fields. They must also copy `reasoningEffort` when present.

- `packages/subagent/task/src/tool.ts` — `RoutesLike` + `stripUndefined`.
- `packages/compat/cc-plugin-loader/src/agents.ts` — `ResolveModel` structural
  type + `resolveModelOverride()`. Do **not** add a package dependency on
  model-aliases; keep the structural type.

Plain / `general-purpose` Task forks still omit `agentOptions` (no stamp).

A grandchild general-purpose fork does not copy `parent.options.reasoningEffort`
(`resolveChildAgentOptions` only copies provider/model/maxTokens). Nested
named types re-resolve and re-stamp. Nested general-purpose may still pick up
effort via fork `request/header` seed when provider/model match — accepted,
not in scope to perfect.

### 3. Apply at request time (host `agent/request`)

In `cc-model-aliases` `apply()`, register a host listener:

```
const resolved = await next()
const stamped = agent.options.reasoningEffort  // runtime extra key
if (typeof stamped !== 'string' || stamped.length === 0) return resolved
return { ...resolved, reasoningEffort: stamped }
```

Must run **after** `next()` so it wins over fork-seed header restoration
(explicit parent `/effort` must not beat the alias contract).

`buildRequest` deep-freezes the seed config. Overlay **must return a shallow
copy** (`{ ...resolved, reasoningEffort: stamped }`); in-place assignment throws
or is invisible (Staff M2a).

Stamp is an undeclared runtime key on `child.options`. Two write sites (Task,
plugin-loader) use a local `Record<string, string>` — already how `agentOptions`
is typed. One read site (`overlayStampedEffort` + a tiny extractor that treats
`agent.options` as `unknown`) pulls the string. **Forbidden: `declare module
'@deepseek-ai/dsh-agent'` to add `reasoningEffort` to `AgentOptions`** (Staff
M2b) — that is a type-surface change of an external library.

Root TUI agents are created with `{ provider, model }` only; `/effort` lives on
`selection.current`, not `options`. The listener is a no-op for them because
they have no stamp.

Do not reverse-lookup the alias table from the child's live model: inherit
children can share a model with `opus` and must not pick up opus's effort.

Out of scope (do not "complete"): memory recall / consolidation / hooks
executor / coordinator do not go through aliases and must not stamp. Nested
`general-purpose` forks do not copy `parent.options.reasoningEffort`
(`resolveChildAgentOptions` only copies provider/model/maxTokens); they may
still restore effort from the fork `request/header` seed when the route
matches — pin this with a grandchild test, do not invent a new copy path.

### 4. Fail-loud

Unsupported effort is `prepareCall`'s job. Alias write accepts any non-empty
string. No adapter catalog check at settings time.

## Files (implementation worktree: `worktree-alias-effort`)

| File | Change |
|---|---|
| `packages/compat/cc-model-aliases/src/types.ts` | object `AliasTarget` + `ResolvedRoute.reasoningEffort?` |
| `packages/compat/cc-model-aliases/src/schema.ts` | optional `reasoningEffort: z.string().min(1)` on `EXPLICIT_ROUTE` |
| `packages/compat/cc-model-aliases/src/resolver.ts` | copy effort from object hits |
| `packages/compat/cc-model-aliases/src/effort.ts` | **new** — `overlayStampedEffort` |
| `packages/compat/cc-model-aliases/src/service.ts` | host `agent/request` listener |
| `packages/compat/cc-model-aliases/src/index.ts` | export helper if tests/README need it |
| `packages/compat/cc-model-aliases/tests/*.spec.ts` | schema/resolver/overlay/service |
| `packages/compat/cc-model-aliases/README.md` + `README.zh.md` + `README.i18n.yaml` | config example + table row |
| `packages/compat/cc-plugin-loader/src/agents.ts` | `ResolveModel` + override copy |
| `packages/compat/cc-plugin-loader/tests/model-resolution.spec.ts` | effort overlay case |
| `packages/subagent/task/src/tool.ts` | `stripUndefined` copies effort |
| `packages/subagent/task/tests/tool.spec.ts` | named type stamps effort; inherit still omits agentOptions |
| `packages/bundle/cc-shell/tests/model-provisioning.spec.ts` | add an effort case if aliases are asserted; existing matchObject stays green |
| `docs/cc-parity-matrix.md` | one-line note on optional alias effort |

## TDD order (fast-worker)

Red tests first in each slice; do not implement a slice before its tests fail
for the right reason.

1. **Vocabulary** — `resolver.spec.ts` / schema describe:
   - object `{ provider, model, reasoningEffort: 'max' }` accepted and resolves
     to all three fields;
   - empty `reasoningEffort: ''` rejected;
   - string form still `{ model }` with no effort key;
   - inherit / builtin unconfigured still `undefined`;
   - settings string-form wholesale replace drops config effort.
2. Implement types / schema / resolver until those tests pass.
3. **Overlay helper** — new `effort.spec.ts`:
   - stamped `'max'` overwrites seed `'high'`;
   - `undefined` / `''` leave seed untouched (including seed with no effort);
   - does not mutate the input object.
4. Implement `overlayStampedEffort`; wire `apply()` listener. **Required
   integration test (no skip clause, Staff M1):** real cordis context, mount
   cc-model-aliases, mock llm adapter, drive one child agent whose
   `agentOptions` include a stamped effort through one request; assert the
   adapter saw `config.reasoningEffort`. This is the contract canary if
   harness later strips unknown `AgentOptions` keys or changes scope
   admission. See `packages/subagent/coordinator/tests/coordinator.spec.ts`
   for the existing "real harness, in-process spawn" pattern. Also pin:
   a grandchild general-purpose fork does not copy the stamp via
   `resolveChildAgentOptions`, but a same-route fork seed may restore the
   explicit header effort (accepted, not a new copy path).
5. **Task** — extend `tool.spec.ts` dispatch case: opus route with
   `reasoningEffort: 'max'` → `agentOptions` equals
   `{ provider, model, reasoningEffort: 'max' }`; inherit still omits
   `agentOptions` entirely (even if some other alias has effort).
6. Implement Task `stripUndefined` / `RoutesLike`.
7. **plugin-loader** — `model-resolution.spec.ts`: resolver returns
   `{ provider, model, reasoningEffort: 'xhigh' }` → forwarded `agentOptions`
   contains all three; inherit still `{ provider: 'parent' }` only.
8. Implement `resolveModelOverride`.
9. Docs (README pair + i18n hash via `pnpm run verify-translation-pairing --write`,
   parity-matrix one liner).
10. Verify: `pnpm exec vitest run` on the three packages' test files, then
    `node scripts/check-file-size.mjs`. Do not add harness files. Do not commit
    unless asked after review of the diff.

## Acceptance

- Configuring the settings example above makes `Task(subagent_type=deep-reasoner)`
  stamp `reasoningEffort: max` on the child; the host listener writes it onto
  every `agent/request` for that child, beating any forked parent header.
- Switching the opus alias to grok-4.6/`xhigh` changes the next spawn with no
  agent-file edit.
- Unconfigured `model: opus` still inherits the parent (no stamp, no listener
  overlay).
- Main session `/effort` unchanged.
- `pnpm test` green; no deepseek-harness edits.
