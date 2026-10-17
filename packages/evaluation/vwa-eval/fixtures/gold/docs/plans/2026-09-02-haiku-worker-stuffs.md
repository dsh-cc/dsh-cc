# Haiku-lane workers: Explore, dsh-cc-guide, session title/rename, WebFetch summarize

Status: **Implemented** — PR #79 (merged 2026-09-02). Staff-approved (nits folded; 2026-09-02 cold review). Constraint: **dsh-cc only** — do not modify deepseek-harness. This plan **supersedes** the Non-goals block in `docs/plans/2026-09-02-smallfast-lane.md` for the four items named above; the cheap lane remains `resolve('haiku')` with unconfigured-builtin → inherit. Three slices, three PRs (A then B then C).

## Goal

Give CC-mode the Claude Code *shape* of four cheap-lane features, using infrastructure that already exists:

| Feature | Claude Code | dsh-cc today | This plan |
|---|---|---|---|
| Explore agent | builtin, `model: haiku`, read-only search | no bundled agents; Task only sees `.claude/agents` | ship two bundled agents through the Task registry |
| claude-code-guide | builtin, Haiku, answers product questions | none | bundled `dsh-cc-guide` |
| Session title | Haiku one-shot on first prompt; `/rename` | harness `dsh-base` already mounts `session-title` + `session-title-first-prompt-llm` **inheriting the main route**; TUI/`/resume` already *display* titles; no `/rename` | overlay the first-prompt provider so a configured `haiku` alias is the title route; add `/rename` |
| WebFetch `prompt` | fetch then Haiku-extract against the prompt | `web_fetch` args = `{url}` only; raw markdown body | same tool name, optional `prompt`; LLM step only when `prompt` is set **and** `haiku` is configured |

## Hard constraints (from the small-fast lane PR)

1. The cheap lane **is** `ccModelRoutes.resolve('haiku')`. No second alias, no `ANTHROPIC_*`, no new settings namespace.
2. Unconfigured / settings-null `haiku` → inherit (titles inherit the logged main request; WebFetch summarizer does **not** run).
3. Configuring `haiku` for typed agents must not silently flip prefix-inheriting forks (recall stays behind `recallUseSmallFast`). Titles and WebFetch summarization are **independent** `ctx.llm.stream` one-shots (no parent prefix) — they MAY default-on the cheap lane whenever `haiku` is configured.
4. No new isolate keys on `cc-services`. The five-key `toEqual` in `packages/preset/cc/tests/composition.spec.ts` stays.
5. Do not edit deepseek-harness source.
6. Agent / command / README bodies in English. PR title/description in English.

## Why these seams (and not the rejected ones)

### Bundled agents go through `AgentRegistry`, not plugin-loader providers

`packages/subagent/task/src/tool.ts` resolves `subagent_type` **only** via `AgentRegistry` → `loadClaudeCodeAgents` (user + project `.claude/agents`). `cc-plugin-loader`'s `AgentProvider` registers a *named subagent backend* for `context: fork`; it never appears in Task's catalog or `subagent_type` list.

Therefore the skill-bundled pattern (inline markdown, `source: 'bundled'`, lowest rank, local same-name wins) is applied to **`packages/preset/claude-code-agents`**, and `discoverAgents` merges the bundled set first so user/project shadow it. No new preset row, no new isolate key.

Rejected: shipping as a CC plugin (`agents/*.md` under an installable plugin) — depends on `installed_plugins.json`. Rejected: putting files in this repo's `.claude/agents/` — those are *this workspace's* agents (`deep-reasoner`, `fast-worker`), not product builtins.

### Titles already generate; we only change the route and add `/rename`

`@deepseek-ai/dsh-bundle-base` (`packages/bundle/base/cordis.patch.yml:39-53` in the harness) already inserts:

- `session-title` (`@deepseek-ai/dsh-session-title`) with fallback limits
- `session-title-llm` (`@deepseek-ai/dsh-session-title-first-prompt-llm`) with numeric policy and **no** `provider`/`model` pair → inherit the logged main request

dsh-cc TUI (`driver-sessions.ts`) and `/resume` already fold `session/title`. api-proxy already exposes `sessionTitle.rename`. What CC-mode lacks is (a) cheap-lane routing and (b) a user-facing `/rename`.

The first-prompt plugin is **host-plane**. `ccModelRoutes` is isolated inside `cc-services`, so a host plugin cannot `ctx.get('ccModelRoutes')`. It CAN read the same `model-aliases` settings namespace (registered onto the host `settings` service by the isolated plugin) and run the same `createModelResolver`. Extract a helper so service.ts and the title plugin share one construction.

Do **not** invent a second title generator. Reuse `generateSessionTitleWithLlm` / `resolveSessionTitleLlmConfig` from `@deepseek-ai/dsh-session-title-llm`.

**Mount mechanism (Staff must-fix):** an id-addressed patch whose `name:` differs from the target is a *guard*, not a rename (`vendor/include/src/index.ts:78,116-124` destructures `name` and **skips** the whole patch on mismatch). Mirror cc-shell's `tools` swap:

```yaml
- id: session-title-llm
  disabled: true

- insert:
    - id: session-title-llm-cc
      name: '@dsh-cc/session-title-provider'
      config:
        targetWords: 5
        targetCjkCharacters: 10
        maxInputBytes: 4096
        maxOutputTokens: 64
        timeoutMs: 60000
```

A second `sessionTitle.register` throws (`session-title/src/index.ts:437-439`); disabling the stock row first is required. Do **not** try to change `name:` in place.

### WebFetch is a same-name replacement, not a wrap

Harness `tool-web` has an official `fetch: false` switch (`dsh-tool-web` Config). The CC preset already sets `fetch: true` (drift-gate whitelisted). Flipping it to `false` hides stock `web_fetch` and its `tool:web_fetch` guidance; our plugin re-registers both under the same tool name.

Wrap is wrong: two `web_fetch` registrations would collide, and the stock tool has no prompt field and no LLM hook.

The new plugin **must live in the `cc-services` group** so `ctx.get('ccModelRoutes')` resolves. `llm` and `web` are host services (not in the isolate map) and remain visible.

When `prompt` is omitted: byte-compatible with stock `web_fetch` (fetch via `ctx.web.fetch`, same output schema, same `WebFetchResultView`). When `prompt` is set and `haiku` is unconfigured: fetch, convert, append one model-visible line that the prompt was ignored. When both are set: convert the body with **`formatFetchOutput` imported from `@deepseek-ai/dsh-tool-web`** (mandatory — `ctx.web.fetch` returns raw `kind:'html'` HTML; turndown lives in that helper, `tool-web/src/fetch.ts:224-244`), then one-shot `ctx.llm.stream` on the haiku route **with `purpose` omitted** (`GenerateOptions.purpose` is the closed union `'compaction' | 'session-title'`, `llm/src/types.ts:376`; a third value does not compile and we cannot edit harness). Reject tool-call blocks; put the summary in `body.content`.

**Stock-deploy caveat:** dsh-cc currently mounts no fetch provider (`web-fetch-http` is unshipped through 0.1.1-rc.2; `ctx.web.fetch` throws `WEB_PROVIDER_UNAVAILABLE`). Slice C's value is the prompt/schema + cheap-lane path for deployments that *do* mount a provider. Manual verification is "after a fetch provider is mounted", not at merge. The parity-matrix WebFetch row's "mounted (web-fetch-http)" claim is wrong — the preset comment is the source of truth; fix that sentence while touching the row.

`fetch: false` also switches `web_search` system-prompt wording (`search.ts:319-320`) to drop the "Follow up with web_fetch" clause. **Accept this.** Our replacement `tool:web_fetch` section re-introduces fetch guidance; search no longer advertising a follow-up is slightly worse but cheaper than wrapping.

No shared `oneShot` package this PR (YAGNI). Title reuses harness helper; WebFetch keeps a 40-line local helper. Extract later if a third caller appears.

---

## Feature 1 — Bundled agents (`explore`, `dsh-cc-guide`)

### Schema change

`packages/preset/claude-code-agents/src/types.ts`:

```ts
export type AgentSource = 'user' | 'project' | 'bundled'
```

`source: 'bundled'` is stored on the definition; nothing else in the loader cares.

### Bundled markdown (inline TS, skill-bundled style)

New files:

- `packages/preset/claude-code-agents/src/bundled/explore.ts`
- `packages/preset/claude-code-agents/src/bundled/dsh-cc-guide.ts`
- `packages/preset/claude-code-agents/src/bundled/index.ts` — `discoverBundledAgents(): AgentDefinition[]`

Each `AGENT_MD` is a full markdown document parsed through `parseAgentMarkdown(virtualPath, md, 'bundled')`. Virtual path: `bundled:<name>/<name>.md` (gives `baseDir`/`filename` without touching disk). A document that fails to parse **throws at load** (same loudness as a broken project agent).

#### `explore`

Frontmatter:

```yaml
name: explore
description: Fast, read-only codebase scout. Use for "where is X?", "find files matching", "what calls this". Returns paths and line numbers, not implementations.
model: haiku
tools: [Read, Glob, Grep]
```

Body (English), sections matching `.claude/agents/fast-worker.md`:

- **Your strengths**: thorough file search; glob/grep before read; report locations.
- **How to work**: never edit, never bash, never spawn Task. Prefer `grep`/`glob`; `read` only to confirm. Cap excerpts.
- **Output contract**: a bullet list of `path:line` hits plus a 1-3 sentence synthesis. If nothing matches, say so and list what was searched.

This is the first in-repo exercise of the `tools:` allow-list path (`resolveToolRestriction` → Task `sanitizeToolFilter`).

#### `dsh-cc-guide`

Frontmatter:

```yaml
name: dsh-cc-guide
description: Answers questions about dsh-cc (the Claude Code compatibility layer on DeepSeek Harness) — commands, tools, settings, known limits. Not a coding agent.
model: haiku
tools: [Read, Glob, Grep]
```

Body:

- You are a product-docs assistant for **dsh-cc**, not Claude Code and not the user's application.
- Ground answers in `docs/cc-parity-matrix.md`, package READMEs, and `packages/preset/cc/agent.cordis.yml`. Do not invent features; if a row is 🔶/❌/🚫, say so.
- Read before answering. Quote the file path you used.
- Output contract: short factual answers; link to the doc path; "I don't know" when the tree has no evidence.

### Discovery merge

`discoverAgents` (`src/discovery.ts`):

```
bundled (lowest) → user → project (highest; existing shadow preserved)
```

`loadClaudeCodeAgents` stays the public entry; it already calls `discoverAgents`. No change to `AgentRegistry` besides picking up the extra source through the existing map.

Export `discoverBundledAgents` from `src/index.ts`.

### Tests (write first)

`packages/preset/claude-code-agents/tests/bundled.spec.ts` (new):

- `discoverBundledAgents()` returns exactly `{explore, dsh-cc-guide}`; both `source === 'bundled'`, `model === 'haiku'`.
- `explore.toolRestriction.allow` contains harness names `read`, `read_image`, `glob`, `grep` and does **not** contain `write`/`edit`/`bash` (Read→read+read_image is the existing translation).
- Each document parses (no throw).

`packages/preset/claude-code-agents/tests/discovery.spec.ts` (extend):

- A workspace with **no** `.claude/agents` still yields the two bundled names via `discoverAgents(emptyRoot, missingUserDir)`.
- A project-layer `explore.md` shadows the bundled one (`source === 'project'`, body from the file).
- A user-layer `dsh-cc-guide.md` shadows bundled; a project-layer of the same name shadows user (existing order, now with three layers).

`packages/subagent/task/tests/catalog.spec.ts` (extend):

- An empty workspace catalog text contains `explore` and `dsh-cc-guide` (the section is no longer empty-when-no-files).
- A project `explore.md` appears instead of the bundled description.

`packages/subagent/task/tests/tool.spec.ts` (extend, if a spawn-recording harness already exists; otherwise add the smallest fake-subagents case):

- `subagent_type: 'explore'` stamps `toAgentOptions(resolve('haiku'))` when haiku is configured; `toolFilter.allow` is the read-only set.
- `subagent_type: 'explore'` with haiku unconfigured omits `agentOptions` (inherit).
- Unknown type error still lists available names (now including bundled).

### Docs

- `packages/preset/claude-code-agents/README.md` + `README.zh.md`: bundled layer, shadowing, the two names.
- `docs/cc-parity-matrix.md` Subagents row: mention shipped `explore` / `dsh-cc-guide` (`model: haiku`).

---

## Feature 2 — Session title cheap-lane overlay + `/rename`

### 2a. Share the live resolver

`packages/compat/cc-model-aliases`:

- Export the `model-aliases` namespace token (today private in `service.ts`).
- Extract `createLiveResolver(ctx, configDefaults) → (alias) => ResolvedRoute | undefined` used by `apply()`. Construction stays: `createModelResolver(() => mergeAliasMaps(defaults, scope?.get?.()), { warn })`.
- New helper `resolveAlias(ctx, alias: string): ResolvedRoute | undefined`:
  1. `ctx.get('ccModelRoutes')` if present (preset-plane callers).
  2. Else `createLiveResolver` against `ctx.get('settings')` (host-plane callers).
  3. Else builtin fallback only (unconfigured haiku → `undefined` → inherit).

Unit tests (`tests/resolveAlias.spec.ts`):

- With a fake `ccModelRoutes`, that service wins.
- With only a fake `settings.get(namespace)` returning `{ haiku: { provider, model } }`, `resolveAlias(ctx, 'haiku')` equals that route.
- With neither, `resolveAlias(ctx, 'haiku')` is `undefined`.

Do **not** add `ModelRoutes.smallFast()` (same version-skew reason as the previous plan).

### 2b. Host-plane title provider overlay

New package `packages/compat/session-title-provider` (`@dsh-cc/session-title-provider`).

Copies the numeric schema of `@deepseek-ai/dsh-session-title-first-prompt-llm` (required `targetWords` / `targetCjkCharacters` / `maxInputBytes` / `maxOutputTokens` / `timeoutMs`; optional paired `provider`/`model` kept as an escape hatch). `inject = ['sessionTitle', 'llm', 'sessions']`.

`apply(ctx, config)`:

```ts
ctx.sessionTitle.register({
  id: SessionTitleProviderId(name),
  automatic: 'first-prompt',
  async generate(request) {
    const haiku = toAgentOptions(resolveAlias(ctx, 'haiku'))
    const stamped =
      config.provider !== undefined && config.model !== undefined
        ? { provider: config.provider, model: config.model } // explicit YAML wins
        : (haiku?.provider !== undefined && haiku?.model !== undefined
            ? { provider: haiku.provider, model: haiku.model }
            : {}) // inherit logged main request
    const first = request.messages[0]
    if (first === undefined) throw new Error('first-prompt title provider requires one human message')
    return generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig({ ...config, ...stamped }),
      request,
      [first],
      SessionTitleProviderId(name),
    )
  },
})
```

`packages/bundle/cc-shell/cordis.patch.yml` — disable the stock row, then insert ours (see mount mechanism above). The patch-string test asserts `disabled: true` on `session-title-llm` and an insert named `@dsh-cc/session-title-provider`.

Add `@dsh-cc/session-title-provider` to `cc-shell` `dependencies` (the host loader resolves patch `name:`s from the bundle). Peer/devDeps of the new package: `dsh-session-title`, `dsh-session-title-llm`, `dsh-llm`, `dsh-session`, `dsh-cc-model-aliases`, `cordis`, `schemastery`, `dsh-invariants` — follow `command-resume`'s peer+dev link pattern. Include `./invariant` stub (copy tool-sleep / command-resume).

Tests (`packages/compat/session-title-provider/tests/provider.spec.ts`):

Drive with a fake `sessionTitle.register` that captures the provider, plus a fake `ctx.llm.stream` (async iterable of text chunks, then stop). Do **not** boot the real SessionTitleService unless a focused fake cannot exercise `generate`.

- haiku configured via fake `ccModelRoutes` → `llm.stream` options have that `provider`/`model`, `purpose: 'session-title'`.
- haiku configured via fake settings namespace only (no `ccModelRoutes`) → same stamp (the host-plane path).
- haiku unconfigured → `llm.stream` options inherit `request.route` (the harness helper's documented fallback). Fixture: pass a `request.route`.
- explicit config `provider`+`model` wins over a configured haiku.
- tool-call chunk → generate throws (harness helper already does; one regression assertion).
- `packages/bundle/cc-shell` test: the patch YAML contains the `session-title-llm` override pointing at the new package (string/parse assertion; do not boot a full host).

### 2c. `/rename`

New package `packages/interaction/command-rename` (`@dsh-cc/command-rename`), copy `command-resume` layout (`src/index.ts`, `src/invariant.ts`, tests, README pair, `package.json` exports `.` + `./invariant`).

```ts
export const inject = ['commands']
// handler:
const raw = invocation.rawInput.trim()
const titles = ctx.get('sessionTitle') as { rename(session, title: string): { title: string } } | undefined
if (titles === undefined) return { kind: 'error', text: 'renaming is unavailable: this deployment mounts no session-title service' }
if (raw.length === 0) return { kind: 'error', text: 'Usage: /rename <title>' }
try {
  const accepted = titles.rename(invocation.agent.session, raw)
  return { kind: 'success', text: `Renamed to: ${accepted.title}` }
} catch (error) {
  return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
}
```

Confirm `rename`'s exact return against `@deepseek-ai/dsh-session-title` at implementation time; if it returns the snapshot, print `accepted.title`, if it returns void, print the normalized input. Do not swallow `SessionTitleInvalidError` — surface its message (harness already writes it for humans).

Mount in `packages/preset/cc/agent.cordis.yml` next to `command-resume` (top-level CC rows, **not** inside `cc-services` — it does not consume `ccModelRoutes`). Add the package to `packages/preset/cc/package.json` dependencies.

Tests (`packages/interaction/command-rename/tests/command-rename.spec.ts`): copy the command-resume harness (Context + SessionStore + CommandRuntime + AgentRegistry).

- Loader-safe exports (`name`, `inject`, `apply`).
- No service → the unavailable message, kind `error`.
- Empty input → usage, kind `error`.
- Happy path records `rename(session, raw)` and returns `Renamed to: …`.
- Thrown validation error → kind `error` with that message.
- Does **not** call rename when input is empty.

`packages/preset/cc/tests/composition.spec.ts`: no isolate-key change. The `'declares every @dsh-cc row name as a dependency'` test will pick up the new row automatically. Baseline-16 test is additive-safe.

TUI: no change. Titles already decorate; a user rename is a `session/title` event with `source.kind === 'user'` which pins against later automatic revisions (harness behavior).

### Docs

- `docs/cc-parity-matrix.md`: session persistence / command-surface rows — titles generate on first prompt via the cheap lane when `haiku` is configured, else inherit; `/rename <title>` is mounted.
- Command-surface count 20 → 21.
- `packages/compat/session-title-provider` README pair; `packages/interaction/command-rename` README pair.

---

## Feature 3 — WebFetch optional `prompt`

New package `packages/core/tool-web-fetch` (`@dsh-cc/tool-web-fetch`). Copy `tool-sleep` (plugin + render + invariant + tests).

`inject = ['tools', 'web', 'systemPrompt', 'llm']`. Lazy `ctx.get('ccModelRoutes')` — **row lives in `cc-services`** so the service is visible.

### Registration

`packages/preset/cc/agent.cordis.yml`:

1. `tool-web` config: `fetch: false` (keep `searchTimeoutMs: 60000`). Drift-gate already whitelists any `fetch:` line.
2. Inside `cc-services.config`, after `hooks-claude-code`:

```yaml
- id: tool-web-fetch
  name: '@dsh-cc/tool-web-fetch'
```

3. Add the package to `packages/preset/cc/package.json` dependencies.
4. Extend composition spec: `configIds` contains `'tool-web-fetch'`; `topIds` does not; isolate map still exactly the five keys. Rename the existing isolate test title if it still says "the two commands" only.

### Tool contract

Name: `web_fetch` (CC display `WebFetch` already maps here in `cc-names.ts`; do not change the table).

Parameters:

- `url` string required (same description as harness).
- `prompt` string optional — "If set, extract/summarize the page against this instruction. Omit to receive the raw page text."

Output schema: **identical** to harness `applyWebFetchTool` (`url`, `statusCode`, `body.kind` html|text, `body.content`, `truncated`) so `WebFetchResultView` / `presentFetchResult` keep working. Implement `presentCall`/`presentResult` by copying the harness shapes (`card:'web', kind:'fetch'`). Prefer importing `presentFetchCall` / `presentFetchResult` / `formatFetchOutput` from `@deepseek-ai/dsh-tool-web` if those exports are reachable as a peer; otherwise copy the 30-line view builders (do not copy turndown / HTML conversion — `ctx.web.fetch` already returns converted content).

System-prompt section `tool:web_fetch` (same name/order 111 as harness so we replace the missing guidance): mention the optional `prompt` and that it runs on the cheap lane.

`timeoutMs`: honor a config `fetchTimeoutMs` defaulting to 30_000, matching harness.

`isConcurrencySafe: () => true`.

### Execute

```
parse url (non-empty)
ctx.web.fetch({ url }, signal) → result
if prompt is absent or blank:
  return stock shape (url, statusCode, body, truncated)
const route = toAgentOptions(routes?.resolve('haiku'))
if route?.provider is missing or route?.model is missing:
  return stock shape with body.content prefixed by
  one line: "(prompt ignored: configure the haiku model alias to summarize WebFetch results)"
summarize:
  ctx.llm.stream({
    ...route,
    // purpose omitted: closed union, cannot add 'web-fetch-summarize'
    maxTokens: config.maxSummaryTokens ?? 2048,
    system: 'Extract/summarize the fetched document to answer the user prompt. Return only the extraction. Cite the URL as a markdown link.',
    messages: [user message containing prompt + truncated body],
    signal,
  })
  assemble text; if tool-call blocks or non-stop finish → throw a structured tool error
  return { url, statusCode, body: { kind: 'text', content: summary }, truncated: result.truncated }
```

Cap the body fed to the LLM at `min(result.body.content.length, config.maxSummaryInputChars ?? 32_000)` so a 200k page cannot blow the cheap-lane context. Truncation of the *model-facing summary input* is independent of `result.truncated`.

No fetch provider / `ctx.web.fetch` throws: let it fail as stock tool-web does (structured error at execution). Do not swallow.

Permission-rules: **no change**. `DEFAULT_READ_ONLY_TOOLS` already lists `web_fetch` by name.

`packages/bundle/cc-shell/tests/web-bundle.spec.ts`: keep as a seam test of stock `dsh-tool-web`. Add a sibling test file `web-fetch-summarize-bundle.spec.ts` **in the new package**, not in cc-shell, unless a bundle-level "name is registered" check is cheaper there.

### Tests (write first)

Pure:

- parse: blank url throws; prompt optional.
- `toSummaryMessages(prompt, body, cap)` truncates input and includes the prompt.

Plugin (Context + Tools + SystemPrompt + fake `web.fetch` + fake `llm.stream`):

- no prompt → `llm.stream` not called; output equals fetch result.
- prompt + haiku configured → `llm.stream` called **without** `purpose`, with the haiku route; the streamed user message contains `formatFetchOutput` text (not raw HTML); body.content is the assembled text.
- prompt + haiku unconfigured → `llm.stream` not called; content starts with the ignored-prompt line then the raw body.
- `llm.stream` yields a tool-call block → `execute` throws / isError.
- `web.fetch` throws → execute throws, no stream.
- `fetch: false` stock + our plugin: `ctx.tools.schemas()` contains exactly one `web_fetch` whose parameters list `prompt`.
- system-prompt assemble includes the new guidance mentioning `prompt`.

Composition: as above.

### Docs

- `docs/cc-parity-matrix.md` WebFetch row: optional `prompt` runs on `resolve('haiku')`; unconfigured → raw + notice. Keep the SSRF-allowlist caveat.
- `packages/core/tool-web-fetch` README pair.
- `packages/preset/cc/README.md` + zh: `tool-web` fetch disabled; replacement row inside `cc-services`.

---

## Non-goals (this PR)

- Bash / PowerShell prefix classifier.
- `statusline-setup` agent, `claude` catch-all agent, CC's capital-`Explore` name.
- `session-title-all-prompts-llm`.
- Shared `oneShot` helper package.
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL`.
- Skill `model:` frontmatter execution (still harness `dsh-tool-skill`).
- Memory consolidation / AutoDream route override.
- deepseek-harness source, including teaching `web_fetch` a prompt field upstream.
- New isolate keys; de-isolating `ccModelRoutes`.
- TUI chrome for `/rename` beyond the slash catalog (the command is enough).

---

## Files (ordered for TDD)

### Slice A — bundled agents

1. `packages/preset/claude-code-agents/tests/bundled.spec.ts` **new** (fails: no export)
2. `packages/preset/claude-code-agents/src/types.ts` (`AgentSource`)
3. `packages/preset/claude-code-agents/src/bundled/{explore,dsh-cc-guide,index}.ts` **new**
4. `packages/preset/claude-code-agents/src/discovery.ts` (merge order)
5. `packages/preset/claude-code-agents/src/index.ts` (re-export)
6. `packages/preset/claude-code-agents/tests/discovery.spec.ts` (shadow cases)
7. `packages/subagent/task/tests/catalog.spec.ts` + `tests/tool.spec.ts`
8. READMEs + parity-matrix Subagents clause

### Slice B — title overlay + `/rename`

9. `packages/compat/cc-model-aliases/tests/resolveAlias.spec.ts` **new**
10. `packages/compat/cc-model-aliases/src/{service,index}.ts` (extract + export)
11. `packages/compat/session-title-provider/**` **new package** (tests first)
12. `packages/bundle/cc-shell/cordis.patch.yml` + `package.json` + a patch-string test
13. `packages/interaction/command-rename/**` **new package** (tests first)
14. `packages/preset/cc/agent.cordis.yml` + `package.json` (command-rename row)
15. READMEs + parity-matrix command-surface clause

### Slice C — WebFetch prompt

16. `packages/core/tool-web-fetch/**` **new package** (tests first)
17. `packages/preset/cc/agent.cordis.yml` (`fetch: false` + cc-services row) + `package.json`
18. `packages/preset/cc/tests/composition.spec.ts`
19. READMEs + parity-matrix WebFetch clause

Each slice is independently mergeable. Prefer one PR per slice if review load demands it; otherwise one PR with three conventional-commit subjects is acceptable. Implementation is TDD within a slice: red tests, then code, then green, then the next file on the list.

---

## Verification (pass/fail)

Worktree: `bash scripts/link-worktree-deps.sh` before any pnpm. Prefer `./node_modules/.bin/vitest`.

```text
./node_modules/.bin/vitest run \
  packages/preset/claude-code-agents \
  packages/subagent/task \
  packages/compat/cc-model-aliases \
  packages/compat/session-title-provider \
  packages/bundle/cc-shell \
  packages/interaction/command-rename \
  packages/core/tool-web-fetch \
  packages/preset/cc
```

Pass = all green. Do not boot a full agent-loop when a fake `subagents.start` / `llm.stream` / `web.fetch` observes the stamp.

Manual (post-merge, later real session — do not claim at merge):

1. Empty workspace, Task catalog lists `explore` and `dsh-cc-guide`. `Task(subagent_type=explore)` on a configured haiku alias issues the child request on that target; the child cannot `write`.
2. First user prompt produces a `session/title` (and `session/title-llm-request` with the haiku route when configured). `/rename New Title` pins it; `/resume` shows it.
3. With a fetch provider mounted: `WebFetch` without `prompt` returns converted page text. With `prompt` and haiku configured, the tool result is the extraction, not the raw page. Skip on stock deploys (`WEB_PROVIDER_UNAVAILABLE`).

## Commit message (expected observable)

If squashed:

```
feat: haiku-lane Explore/guide agents, title overlay, WebFetch prompt

Ship bundled explore + dsh-cc-guide (model: haiku, read-only tools)
through AgentRegistry so Task can dispatch them. Overlay the host
session-title-llm row with a provider that stamps resolve('haiku')
when configured (else inherit) and add /rename. Replace stock
web_fetch (tool-web fetch:false) with a cc-services tool that
optionally summarizes against prompt on the cheap lane.
```

If split: one subject per slice, each stating the observable.

## Risks

- **Catalog never empty.** Workspaces that currently render no "Available subagents" section will always list two. That is the point; a user who hates them writes a same-name project agent or we add a later disable flag (not this PR).
- **Host-plane settings read.** `settingsNamespace` is a branded primitive (value-equal); export the singleton from `cc-model-aliases` anyway so both packages share one token. Gate: the `resolveAlias` unit test that fakes `settings.get(namespace)`.
- **Disable + insert.** A later bundle that re-enables `id: session-title-llm` without disabling `session-title-llm-cc` would make `register()` throw at mount (two providers). Document that cc-shell owns this swap.
- **Tool-schema cache bust.** Adding `prompt` to `web_fetch` changes the tool prefix for every CC-mode session. Accepted (one-time); do not alias a second tool name just to keep the old schema.
- **HTML conversion.** We must not reimplement turndown. `ctx.web.fetch` already returns `{kind, content}`. If a deployment has no fetch provider, execution errors — same as stock.
- **Prefix-inheriting forks stay opt-in.** This PR does not change `recallUseSmallFast` default. Titles/WebFetch are not forks.
- **`explore` allow-list is the first production `tools:`.** `sanitizeToolFilter` dropping unknown names must not empty the allow-list (that would deny-all). Test that the translated allow set is non-empty against a knownNames set containing `read`/`glob`/`grep`.
- **Invariant companions.** New packages need the `./invariant` stub or the invariants loader complains. Copy the no-op installer.

## Staff review (committed)

1. **discovery merge is correct** — sole merge point; a registry third argument would fork shadowing. Keep bundled lowest.
2. **Replacement is required**, but the mechanism is **disable + insert**, not id+name. Folded above.
3. **ignore + notice is correct** — visible degradation beats a hard error the model cannot recover from.
4. **Three PRs.** A independent; B after must-fix 1; C last and value-gated on a mounted fetch provider.
