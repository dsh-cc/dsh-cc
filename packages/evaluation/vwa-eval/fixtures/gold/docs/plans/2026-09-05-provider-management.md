# LLM provider management (`/provider` command)

Status: **Implemented** — PR #129 (merged 2026-09-05). Approved post-review — cold Staff-Engineer review findings incorporated (verify-step Blocker fixed; Available-merge rule added; credential concurrency + removal semantics re-grounded)
Date: 2026-09-05
Scope: Give the dsh-cc TUI first-class LLM provider management: a `/provider` command that lists, adds, edits, and removes provider routes, manages their API keys through the credentials store, and ships curated one-tap presets for Kimi (API + Coding Plan), Zhipu/Z.AI (CN + international, API + Coding Plan), DeepSeek, plus fully custom providers — with every change taking effect live, without a session restart.

## 1. Problem and goals

Today a dsh-cc user configures an LLM provider by hand-editing `~/.dsh/settings.json` under the harness-owned `llm-pi-ai` namespace: a provider route with `apiKeyEnv`, `baseURL`, `api`, and a `models[]` list whose field shapes are undocumented from the user's side, and whose typos silently disable the route. There is no in-TUI surface to answer the three questions users actually ask: *which providers can I use* (the upstream pi-ai catalog ships 30+ installed providers, invisible without reading source), *what do I already have configured*, and *where does my API key live*. `/model` and `/effort` exist for switching among already-registered routes; nothing manages the route set itself.

Goals:

1. `/provider` opens a management overlay inside the TUI: configured routes with live status badges, available presets, and a custom-provider wizard.
2. Built-in presets cover, with zero user research: Kimi API (global + CN), Kimi Coding Plan, Z.AI Coding (global), Zhipu Coding (CN), Z.AI API (global), Zhipu API (CN), DeepSeek — plus every other installed catalog provider as a generic "more providers" list.
3. Secrets never enter settings files: API keys are written to the credential store via `ctx.credentials.set`; settings carry only the credential ref name (harness doctrine, §2/C4).
4. All changes are live: enabling a provider registers its route atomically in the running session (the harness adapter is settings-driven with dynamic re-registration, §2/C2), so `/model` lists its models the next time the picker opens — no restart.
5. Invalid configuration is refused at write time, not silently dropped (the namespace validator `assertServiceable`, §2/C3); write-time failures surface verbatim with the offending route/model named.
6. Removal is one action away, with confirmation, and also offers to drop the stored credential.

Non-goals (recorded, with owners):

- **N1 — OAuth sign-in flows** (e.g. "Sign in with Kimi Code"). The harness registers authorization flows per installed provider that ships one (`login.ts`), but driving the browser/code dance from the TUI is a separate surface. Presets must be usable with API keys alone; OAuth support is Slice 3 and only extends, never gates.
- **N2 — Project-shared provider config.** v1 writes only the user layer (`~/.dsh/settings.json`). Project-layer `llm-pi-ai` sections in shared `.claude/settings.json` files keep working (the merge already handles them); the command just never writes there — secrets hygiene argues against encouraging it.
- **N3 — Editing the main session's model selection.** `/model` already owns that. `/provider` manages plumbing and can *seed the default* (write `agent-default-model`) but never touches `selection.current`.
- **N4 — Per-request policy tuning** (timeouts, retry policy, image budgets, compat switches). These stay hand-editable advanced fields; the UI surfaces only `displayName`/`baseURL`/`api`/`models`/credential.
- **N5 — Migrating pre-existing hand-written routes.** They already are routes in the same namespace and appear in the list automatically; no import step.

## 2. Verified ground truth

### Harness (deepseek-harness checkout, read-only per 2026-09-10 directive; `packages/llm/llm-pi-ai`, `packages/llm/llm`, `packages/credentials/credentials`)

- **C1 — Settings schema.** The `llm-pi-ai` namespace validates against `PiAiProviderProfile` (`llm-pi-ai/lib/types/config.d.ts:54-142`, `src/config.ts`): per route — `apiKeyEnv?` (a `CredentialRef` branded string, `src/config.ts:308`), `displayName?`, `api?` (wire protocol), `baseURL?`, `models?` (`PiAiModelProfile[]`), `modelOverrides?`, `headers?`, `reasoning?`, plus timeouts/retry/cache fields. A route key matching an installed catalog provider inherits its endpoint/protocol/models field-by-field; a route the catalog does not ship must declare its own `api` and models (`config.d.ts:6-12,64-72`).
- **C2 — Dynamic registration, this is the load-bearing fact.** The pi-ai adapter mounts dormant with zero routes and registers them *the moment a settings section supplies profiles*; route sets swap atomically (never dispose-then-register), drop when the section empties, and re-register only when registration-relevant facts change (`src/index.ts:222-282`, comments at `:256-258`). `tests/dynamic-config.spec.ts` boots a bare adapter and asserts routes appear from settings alone. After each commit the llm runtime emits the payload-free `llm/adapters-updated` event; consumers re-read `listProviders()`/`listModels()`/`listConfigurableProviders()` (`llm/lib/types/types.d.ts:11-22`).
- **C3 — Write-time validation.** `assertServiceable` is registered as the namespace validator: an unserviceable profile is refused where it is written (`settings-rejected` naming route and model), and a refused update keeps the previously registered routes serving (`config.d.ts:187-198`, `src/index.ts:289-308`).
- **C4 — Credentials doctrine.** Configuration carries *references*, never secrets (`credentials/README.md`): a settings `apiKeyEnv` names a `CredentialRef`, resolved per request through `ctx.credentials` and never cached across operations — so a rotated key reaches the very next request. `dsh-credentials-local` layers process environment over the managed `$DSH_HOME/.credentials.yaml` (mode 0600) over `.env` files. Surface: `resolve`/`describe(ref) → {configured, source?, writable}` (never the value)/`set`/`unset`, plus `credentials/reference-updated (ref)` events after committed changes. Writes are rejected fail-loud when a read-only source (the live environment) shadows the ref — and `describe().writable` lets a UI render that read-only up front. `dsh-credentials-local` serializes every document mutation under a **cross-process writer lock** (`credentials-local/src/index.ts:24`, `:106`: "every writer of this document — reference writes …") — concurrent `set` from two TUI instances is safe at the store level (last writer wins per ref; badge state self-heals via `reference-updated`).
- **C5 — Discovery, with a sharp edge (review Blocker B1).** The llm runtime exposes `discoverModels(settingsNs, request)` (`llm/lib/types/index.d.ts:288`; request shape `LlmModelDiscoveryRequest{provider?, baseURL?, api?, apiKey?, signal?}`, `llm/lib/types/types.d.ts:178-197`). **When `request.provider` names a catalog route, the answer comes from the installed catalog — no network happens, and no key is validated** (`llm-pi-ai/src/discovery.ts:198-208`: "A catalog route already has its answer, and a better one"). Endpoint interrogation only occurs in *draft form*: omit `provider`, pass `baseURL` (+ optional `api`, default `openai-completions`) and the typed key as `apiKey` (which wins over any stored key, `discovery.ts:236-240`). Only `openai-completions` and `openai-responses` are listable protocols; anything else throws `DISCOVERY_UNSUPPORTED` (`discovery.ts:38-42,226`), and a listing-capable endpoint answering 401 reads as a credential problem by design. So preset verification must always use the draft form against the preset's known `baseURL`/`api`, and `anthropic-messages` presets (kimi-coding) never get a network test.
- **C6 — Authorization (OAuth).** `llm-pi-ai/src/login.ts` advertises login methods per installed provider that ships one (OAuth and/or api-key-with-login), registered into the `authorization` service only when that seam is mounted; mounting without it is legal (`tests/dynamic-config.spec.ts` "mounts without the seam"). `kimi-coding` ships an OAuth flow (`pi-ai/dist/providers/kimi-coding.js`, `auth/oauth/kimi-coding.js`).
- **C7 — Installed pi-ai catalog (relevant entries, verified in `pi-ai/dist/providers/*.js`).** `kimi-coding` → `https://api.kimi.com/coding`, `anthropic-messages`, env ref `KIMI_API_KEY`, OAuth "Sign in with Kimi Code". `moonshotai` → `https://api.moonshot.ai/v1`, `openai-completions`, `MOONSHOT_API_KEY`. `moonshotai-cn` → `https://api.moonshot.cn/v1`, `MOONSHOT_API_KEY`. `zai` → `https://api.z.ai/api/coding/paas/v4` (the coding-plan path), `openai-completions`, `ZAI_API_KEY`. `zai-coding-cn` → `https://open.bigmodel.cn/api/coding/paas/v4`, `ZAI_CODING_CN_API_KEY`. `deepseek` → `https://api.deepseek.com`, `openai-completions`, `DEEPSEEK_API_KEY`. Total installed catalog: 30+ providers (`dynamic-config.spec.ts` asserts `listConfigurableProviders().length > 30`).
- **C8 — Configurable-provider directory.** `listConfigurableProviders()` enumerates *every installable* route with `{provider, displayName, settingsNs: 'llm-pi-ai', settingsPath: ['providers', <route>]}` — "dormant ≠ invisible" (`dynamic-config.spec.ts:90-110`; `llm/lib/types/types.d.ts` merge guidance). `/provider` renders its "available" section from this, not from a hardcoded list, so catalog growth upgrades the UI for free.

### dsh-cc (this repo)

- **D1 — Settings write seam.** Writable settings facade consumed from the TUI driver: the canonical precedent is `writeAllowRule` — revision-guarded `settings.replace` with retry on conflict (`packages/ui/tui/src/harness/driver-approvals.ts:104-136`). Facade methods: `update`/`replace`/`mutate`/`register`/`describe` (`packages/interaction/command-config/src/index.ts:67`). Namespaces are kebab-case enforced by the settings layer; `llm-pi-ai` and `agent-default-model` are both valid namespaces and plain top-level keys in `~/.dsh/settings.json` (the cascade writes the user layer; verified live by both sections existing in the current user file).
- **D2 — Hot reload.** The settings cascade watches the file (chokidar) and re-publishes on external edits (`packages/settings/settings-cascade/src/index.ts:343-374`); in-process commits publish immediately through the same seam. Either path reaches the adapter's `onChange` → C2 re-registration. So `/provider` writes land live whether the TUI or an external editor commits them.
- **D3 — TUI command architecture.** TUI-local slash commands: name table `packages/ui/tui/src/slash.ts:8-44`, dispatch `packages/ui/tui/src/harness/driver-run-local.ts` (`/model` at `:187-201`, `/effort` at `:202-251`). Interactive overlays are hand-rolled modal boxes over a store reducer: `createModelPickerBox`/`createEffortPickerBox`/`createPermissionPickerBox` (`packages/ui/tui/src/components/overlays.ts:141-231`), state `packages/ui/tui/src/store/pickers.ts:9-78`, driver runtime `driver-pickers.ts` (the `/permissions` bypass double-confirm at `:236-252` is the confirmation precedent). The vendored pi-tui `SelectList` is deliberately avoided (`overlays.ts:133-139`).
- **D4 — No masked input.** pi-tui `Input` is single-line plaintext (`packages/ui/pi-tui/src/components/input.ts:19-46`). API-key entry needs a masked mode — small additive change with a `masked?: boolean` prop; recorded as a build task.
- **D5 — Model catalog is live.** `/model`'s `loadCatalog()` re-enumerates `llm.listProviders()` → `listModels()` *on every picker open* (`packages/ui/tui/src/harness/driver-agent.ts:349-360`, called from `driver-pickers.ts:61`). Providers added by `/provider` appear with zero extra wiring; the `llm/adapters-updated` event (C2) additionally lets us refresh badges in an open overlay.
- **D6 — Harness services are duck-typed.** dsh-cc never imports harness types directly at runtime seams; `packages/ui/tui/src/state/driver-types.ts` declares `*Like` interfaces (`LlmLike` at `:342-361`, `AgentDefaultModelLike` at `:338-340`). `/provider` extends this pattern with the methods it needs (`listConfigurableProviders`, `discoverModels`, `describe`-style credential service) — no new coupling.
- **D7 — Capability manifest rule.** Adding a user-visible command alters the compatible surface → `docs/claude-code-capabilities.yaml` row + `pnpm docs:parity` regeneration in the same PR; `pnpm check:capabilities` gates pre-commit (CLAUDE.md).
- **D8 — Confirm-in-slice (small unknowns for the implementer, never guessed).** (a) *resolved:* removal is `settings.mutate(ns, [{op:'unset', path:['providers', route]}], expectedRevision)` — path ops are `{op:'set'|'unset', path: string[]}`, revision-guarded, serialized per namespace (harness `settings/src/index.ts:562-575`). (b) *resolved:* the cc-tui composition demonstrably mounts the llm + credentials services (today's `/model` picker and settings-driven `llm-pi-ai` routes with `apiKeyEnv` refs work in production); Slice 1 still `ctx.get(...)`-guards every seam and renders "unavailable in this profile" rather than throwing. (c) whether the `agent-default-model` namespace accepts in-process writes through the cascade facade the same way `permission-rules` does; (d) whether disposal of the currently-selected route disturbs in-flight requests — the harness guarantees atomic same-adapter registration swaps (C2) but in-flight disposal semantics are unverified; the removal flow must therefore warn before unmounting the active route (§4.4) instead of promising call survival.

## 3. Command naming

Ship **`/provider`**. Alternatives considered: `/providers` (plural reads like a listing-only surface; the command mutates), `/connect` (implies network session semantics we don't have), `/llm` (too broad — effort/model/routing already have homes), `/api` (collides with the wire-protocol meaning of `api` in profiles). Precedent inside the product is singular nouns for management surfaces (`/model`, `/config`, `/status`, `/permissions` is the outlier and manages a plural domain). No alias in v1: one name is one name; adding `/providers` later is cheap, removing it is not.

Relationship to existing commands becomes: `/provider` owns the route set and credentials; `/model` picks among registered routes for the session; `/effort` tunes the picked model; `agent-default-model` settings pick the boot route. One sentence of help text in `/provider` points to `/model` for switching.

## 4. Product behavior

### 4.1 Invocation forms

- `/provider` — open the management overlay (§4.2).
- `/provider list` — render the configured/available summary as plain chat output (script-friendly, same data as the overlay).
- `/provider add <preset-id>` — jump straight into the add wizard at that preset.
- `/provider remove <route>` — remove with the same in-overlay confirmation as the UI path.
- Unknown subcommand → usage row, never a silent no-op.

### 4.2 Overlay: provider list (home screen)

Modal box (D3 patterns), two sections:

```
Providers
  Configured
  ● kimi-coding        Kimi For Coding        key ✓ (managed)   3 models   ← current
  ● deepseek           DeepSeek               key ✓ (env)       2 models
  ○ my-gateway         Custom                 key ✗ missing     5 models    ⚠
  Available
  ○ moonshotai         Moonshot AI (Kimi API, global)
  ○ moonshotai-cn      Moonshot AI CN (Kimi API)
  ○ zai                Z.AI Coding Plan (global)
  ○ zai-coding-cn      Zhipu Coding Plan (CN)
  ○ zai-api            Z.AI API (global, pay-as-you-go)
  ○ zhipu-api          Zhipu API (CN, pay-as-you-go)
  …  More providers (github-copilot, openrouter, …)   [expand]
  +  Add custom provider…
```

**Merge rule for the two sections (review M2 — stated once, exactly):** *Configured* is the live `llm-pi-ai.providers` dict, verbatim, in document order. *Available* = the eight curated presets whose route key is not configured, ∪ the configurable directory (C8) filtered as follows: drop entries whose `provider` is already a configured route, and drop entries whose `provider` any preset already covers — surviving directory entries render collapsed under "More providers…" with their directory `displayName`. `zai-api`/`zhipu-api` exist only in the preset table (the directory cannot invent them, C8), which is why presets win display ordering and the directory only contributes the tail. No other source participates; a route never appears in both sections, and a configured route never appears in "Available" even though the directory keeps advertising it as configurable.

- Configured rows come from the live `llm-pi-ai.providers` settings section (D1/D2), not from a cached snapshot; reopening after an external edit shows the new state.
- Badges: credential state from `credentials.describe(ref)` — `✓ (managed)` = stored in the credential store, `✓ (env)` = supplied by the process environment (C4 shadowing case), `✗ missing` = neither. `… (env)` rows render key actions read-only when `writable === false`.
- "current" marker: `provider === selection.current.provider`.
- ⚠ on any route whose models are configured but credential missing — the most common broken state.
- `llm/adapters-updated` (C2) re-renders the list while the overlay is open (covers the race with a second terminal writing settings).

### 4.3 Add flow (preset)

Preset entry → wizard with ≤3 steps, every step escapable:

1. **Credential.** Masked input (D4) for the API key. Placeholder names the ref (`KIMI_API_KEY`) and where it will live (`~/.dsh/.credentials.yaml`). Empty submit aborts with a note, never writes a blank (C4 empty-is-absent doctrine). If `describe(ref).source === 'env'`, the step is skipped with a one-line "already supplied by your environment".
2. **Verify (optional, default yes).** Persist ref + minimal profile, then run one draft-form discovery probe (C5): `discoverModels(NS, { baseURL, api, apiKey: <just-typed key> })` — **never** the `provider` form, which would answer from the catalog without touching the network and "verify" a garbage key (review Blocker B1). Success renders "N models reachable" (count from the listing). `DISCOVERY_UNSUPPORTED` protocols (everything but `openai-completions`/`openai-responses`; this covers kimi-coding's `anthropic-messages`) skip the probe with an explicit one-liner: "this endpoint can't be listed programmatically — the first message is the test." Any other failure keeps the configuration (the profile may still be right where a `/models` listing isn't served, and a 401 specifically reads as a wrong key) and reports the raw reason with a "keep / remove" choice. Rationale: writing-then-testing is what makes the test truthful; rollback is one keypress.
3. **Done.** Summary row + offer "set as default" (writes `agent-default-model`, seed for future boots; current session unaffected — `/model` for that).

What "minimal profile" means per preset: for catalog routes, `{ apiKeyEnv }` only (inherit endpoint/protocol/models, C1); the presets that deviate carry exactly their deltas (§4.5).

### 4.4 Manage flow (configured route)

Enter on a configured row → detail + actions:

- Show resolved endpoint, protocol, model count, credential state, and the raw JSON of the profile (read-only block; the "learn the config" moment).
- **Rotate/replace key** — masked input → `credentials.set`. Missing → same widget stores it.
- **Environment-supplied key** — shown read-only with the shadowing explanation (C4); offers "copy env value into managed store" is explicitly NOT offered (secrets never move silently; user exports/unsets themselves).
- **Edit endpoint/override models** — baseURL text input (validated as absolute http(s) URL), saved as profile override. Model list edit is disclaimed as advanced → points at the settings file; `modelOverrides` untouched by the UI.
- **Set as default** — as §4.3 step 3.
- **Remove** — double-confirm (D3 precedent), then unset the route via `settings.mutate(ns, [{op:'unset', path:['providers', route]}])` (D8a), then offer dropping the stored credential *only* if managed (never touches env). Removal of the currently-selected route is allowed but always carries the warning "the running session keeps its current model until you pick again; in-flight request behavior during route disposal is undefined" (D8d) — we make the hazard visible instead of promising a guarantee we haven't verified. Next `/model` pick moves the session.

### 4.5 Built-in presets (v1)

Presets are *data* (`packages/ui/tui/src/provider-presets.ts`), not code paths — each declares: `route` (the settings dict key), `displayName`, `group`, `credentialRef`, optional profile deltas, `docsUrl`.

| preset | route | profile written | credential ref | why this shape |
|---|---|---|---|---|
| Kimi Coding Plan | `kimi-coding` | `{}` (+key) | `KIMI_API_KEY` | catalog-complete (C7); OAuth exists but is N1 |
| Kimi API — global | `moonshotai` | `{}` (+key) | `MOONSHOT_API_KEY` | catalog-complete |
| Kimi API — CN | `moonshotai-cn` | `{}` (+key) | `MOONSHOT_API_KEY` | catalog-complete; same ref, same account family |
| Z.AI Coding Plan — global | `zai` | `{}` (+key) | `ZAI_API_KEY` | catalog endpoint is already the coding path (C7) |
| Zhipu Coding Plan — CN | `zai-coding-cn` | `{}` (+key) | `ZAI_CODING_CN_API_KEY` | catalog-complete |
| DeepSeek API | `deepseek` | `{}` (+key) | `DEEPSEEK_API_KEY` | catalog-complete |
| Z.AI API — global | `zai-api` | `{ api: 'openai-completions', baseURL: 'https://api.z.ai/api/paas/v4', models: curated GLM list }` | `ZAI_API_KEY` | catalog has no plain-API z.ai route; full custom declaration |
| Zhipu API — CN | `zhipu-api` | `{ api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: curated GLM list }` | `ZHIPU_API_KEY` | same reasoning for open.bigmodel.cn |

Design decisions embedded here:

- Route keys for the two non-catalog presets are deliberately *not* `zai`/`zhipu`: colliding with an installed id would silently downgrade a full declaration into a partial override (C1 merge rules) and confuse the "available" listing. Distinct keys keep both flavors simultaneously usable.
- The curated GLM model list is seeded from ids already proven against these very endpoints — the `llm-pi-ai.zai.models` block in a real user settings file (`glm-4.5-air` / `glm-4.7` / `glm-5-turbo` / `glm-5.1` / `glm-5.2` / `glm-5v-turbo` / `glm-5.3`) — with `contextWindow`/`maxTokens` left to adapter defaults (C1: custom routes default to 262,144/32,768, `config.d.ts:38-40`). The two plain-API base URLs (`/api/paas/v4` on both domains) are vendor-documented public endpoints recorded in each preset's `docsUrl`; Slice 1 re-verifies them against the vendor docs pages (docs.z.ai, open.bigmodel.cn) before the preset table ships, and the S2 "refresh list" probe (C5) is the drift canary thereafter.
- The Anthropic-dialect GLM endpoints (`api.z.ai/api/anthropic`, `open.bigmodel.cn/api/anthropic`) are *not* v1 presets: they exist for raw Claude Code's `ANTHROPIC_BASE_URL` contract; inside dsh-cc the OpenAI-dialect coding endpoints are the supported path. A user who truly needs the dialect can add it as a custom route with `api: 'anthropic-messages'`.

### 4.6 Custom providers

"Add custom provider…" → wizard: route id (normalized to `[a-z0-9][a-z0-9-]*`, collision-checked) → displayName → baseURL → protocol pick (`openai-completions` | `openai-responses` | `anthropic-messages`) → credential ref (default derived `DSH_PROVIDER_<ROUTE>_API_KEY` uppercased/underscored) + key → models: either "fetch" (C5 against baseURL+key) or comma list entry (`id` plus optional `name=contextWindow:maxTokens` compact syntax, documented inline). Then persist as a full profile and land on the done step (§4.3.3).

## 5. Architecture

- **Location:** TUI-local, because the interactive surface must drive driver overlays (D3 precedent: `/model`, `/permissions` pickers live in `packages/ui/tui`, not in `command-*` cordis packages). New files: `packages/ui/tui/src/provider-command.ts` (arg parsing + dispatch, mounted from `slash.ts` + `driver-run-local.ts` like `/model`), `provider-presets.ts` (data §4.5), `provider-flow.ts` (wizard reducers + service touchpoints, side-effect free apart from injected seams — the *Like pattern, D6), `store/provider-panel.ts` + `components/overlays.ts` additions (list/detail/wizard boxes). The 500-line driver cap stays honest: logic lives in the new modules, driver files receive single-line mounts.
- **Duck-typed seams (driver-types.ts extensions):** `LlmManageLike` = existing `LlmLike` + `listConfigurableProviders()` + `discoverModels(ns, req)`; `CredentialsLike` = `describe`/`set`/`unset`; `agentDefaultModel` already typed (D6). All `ctx.get(...)`-optional → the command degrades to a "not available in this profile" row instead of throwing when a seam is unmounted (C6's mounting-without-authorization precedent for OAuth; D8(b) for credentials).
- **Writes:** revision-guarded `settings.replace`/`mutate` with retry on conflict (D1 precedent); errors from `assertServiceable` (C3) are caught and rendered verbatim (route + reason), state unchanged.
- **Events:** subscribe to `llm/adapters-updated` and `credentials/reference-updated` while the overlay is open; unsubscribe on close.

## 6. Settings write semantics

- All writes target the **user layer** (`~/.dsh/settings.json`) through the cascade facade (§2/D1): route materialization under `llm-pi-ai.providers.<route>`, removal as an unset of that path (D8a), default-model seeding as `agent-default-model` replace (D8c).
- Cross-layer merge keeps working untouched: a project file's `llm-pi-ai` section still merges over the user layer at read time; the command simply never writes there (N2).
- Credential writes go exclusively through `ctx.credentials` (C4); nothing under `llm-pi-ai` ever receives a secret value — enforced by construction (the UI has no code path that serializes a key into settings) and by a doc-level contract test asserting the written profile JSON contains no key-shaped strings.

## 7. Errors and edges

- **Validator refusal (C3):** error banner naming route/model; previous registered routes keep serving (adapter doctrine); overlay stays open on the failing step.
- **Credential store read-only shadow (C4):** env-supplied refs render read-only with explanation; `set` rejection is rendered as the same explanation (never a stack).
- **Empty route set:** the command itself must work with zero configured routes — this *is* the first-run entry point; `listProviders()` empty + `listConfigurableProviders()` non-empty is the expected shape (C8).
- **Removed-current-route:** in-flight session keeps its already-seeded selection; warnings only. No automatic re-pick (that would silently change model mid-conversation).
- **Duplicate semantic routes** (user adds a custom route that duplicates an installed provider): allowed; routes are keyed config, not identity.
- **Key verification pessimism:** `discoverModels` failure ≠ broken config (some gateways don't serve `/models`); the wizard keeps the config and says exactly that (§4.3.2).

## 8. Slices

1. **S1 — core:** masked `Input` mode + presets data + `/provider` list/add/remove/rotate-key + detail view + user-layer writes + live reload + capability manifest row + README/provider docs. Custom-provider wizard included (it is the schema-completeness proof of the preset table).
2. **S2 — intelligence:** `discoverModels` verify/fetch steps, curated-list refresh, `agent-default-model` seeding ("set as default").
3. **S3 — OAuth:** sign-in surfaces for installed providers that ship a flow (kimi-coding first), gated on the `authorization` seam mounted.

Each slice ships documented and manifest-current; S1 alone must leave a coherent product.

## 9. Verification plan

- **Contract:** preset table validates against the harness namespace schema in a unit test importing `Config`/`assertServiceable` via the existing tsconfig-paths link (grounds S1's data against drift).
- **Driver specs:** wizard reducer transitions, masked-input rendering (the key never reaches the store, the transcript, or input-field history — a leaked key in a `.prompt-history`-style structure is a release blocker), badge matrices over fake `credentials`/`llm` seams (D6 pattern, mirroring `driver-approvals` fakes), remove double-confirm, empty-state rendering.
- **Write path:** file-level round trip against a tmp user settings file through the real cascade — materialize, observe publish, external-edit mid-session, remove (mirrors `dynamic-config.spec.ts` posture at the dsh-cc layer).
- **Live:** settings-cascade's existing chokidar path means no new watcher tests; assert subscription/unsubscription hygiene of the overlay instead.
- **Manifest:** `pnpm check:capabilities` + `pnpm docs:parity` in the same commit (D7).

## 10. Open questions / confirm-in-slice

D8's two open items — (c) `agent-default-model` write path, (d) in-flight semantics under route disposal — plus: whether `agent-default-model` seeding should also carry `reasoningEffort` per model family (deferred to S2, the service's own schema is the arbiter); whether the two plain-API presets' `/models` probes succeed (determines whether S2's "refresh list" works for them or stays manual); Slice-1 doc re-verification of the two plain-API base URLs (§4.5).
