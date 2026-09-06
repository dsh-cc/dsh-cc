# Serena-first prompt sections

Date: 2026-09-16. Status: reviewed (deep-reasoner cold review, 3 blocking findings folded in).

## Background

The CC preset mounts upstream `@deepseek-ai/dsh-tool-fs` and
`@deepseek-ai/dsh-tool-fs-search` (preset rows `tool-fs` /
`tool-fs-search` in `packages/preset/cc/agent.cordis.yml`). Each upstream
tool package registers a hardcoded system-prompt guidance section at mount
time via `ctx.systemPrompt.section(...)`:

| section | order | source (deepseek-harness checkout) |
| --- | --- | --- |
| `tool:read` | 100 | `packages/fs/tool-fs/src/read.ts` |
| `tool:write` | 101 | `packages/fs/tool-fs/src/write.ts` |
| `tool:edit` | 102 | `packages/fs/tool-fs/src/edit.ts` |
| `tool:glob` | 103 | `packages/fs/tool-fs-search/src/glob.ts` (text is caps-dynamic) |
| `tool:grep` | 104 | `packages/fs/tool-fs-search/src/grep.ts` |

These texts steer the model away from shell commands toward the built-in
tools, but say nothing about serena. When a serena MCP server is connected
(repo `.serena/project.yml`, user-scoped `~/.claude.json` entry per
`docs/code-intelligence-health.md`), the session has ~30
`mcp__serena__*` symbol tools that answer code questions without loading
whole files. The system prompt should say so.

Upstream facts that shape the design:

- Section names are unique per scope layer; registering the same name in the
  same layer throws (`core/system-prompt/src/index.ts`). Scoped layers shadow
  global ones, but a same-name re-registration from inside the cc preset
  group would throw at mount time and kill every session in the preset.
- The upstream texts are static constants; glob's is built from deployment
  caps. Overriding them wholesale would hardcode a stale variant and fight
  upstream wording updates.
- The `system-prompt/assemble` waterfall hands listeners a mutable
  `PromptAssembly { sections, contexts, tools, variables }` plus
  `AssembleContext { scope? }`; cordis waterfalls are outermost-first and the
  outermost return wins. Precedent: `packages/core/tool-append-order`
  registers with `{ prepend: true }`, awaits `next()`, and returns a
  transformed copy (`{ ...result, tools: ordered }`).
- In-repo precedent for rewriting an assembled section is
  replace-not-mutate:
  `memory/src/section.ts` maps sections into new objects. Nothing in the
  repo inserts a brand-new section into `assembly.sections` at assemble
  time, so this plan does not do that either (review finding 1): the new
  policy section is *registered* via `ctx.systemPrompt.section` with a
  dynamic text provider that renders empty while serena is unavailable, and
  the waterfall listener only rewrites the texts of existing sections.
- MCP tools register at startup (mcp-client blocks plugin activation on the
  initial connect + tool discovery), and mcp-client always provides the
  `mcpConnections` registry service
  (`packages/mcp/mcp-client/src/registry.ts`) with per-server
  `{ name, state: connecting|ready|error|disconnected, toolCount? }`
  entries. `command-doctor` already duck-types this seam
  (`packages/interaction/command-doctor/src/checks/mcp.ts`).
- In the cc preset, `mcpConnections` is an entry-local isolate of the
  `cc-services` group; consumers must mount inside that group and read it
  via `ctx.get('mcpConnections')` (precedent: `command-mcp`,
  `command-doctor`). `systemPrompt` resolves through the group via the
  prototype chain (precedent: `memory`, `tool-web-fetch` rows inside the
  group inject it).
- Serena's ~30 tools exceed the ToolSearch defer threshold (8), so they are
  ToolSearch-deferred: hidden from the tool schemas until activated by a
  `tool_search` call. The policy text must tell the model this.

## Design

New package `packages/compat/cc-serena-first`
(`@dsh-cc/serena-first`): a default cordis function plugin with
`inject = ['systemPrompt']`, mounted as a row inside the `cc-services`
group of `packages/preset/cc/agent.cordis.yml`.

Config:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch; `false` renders nothing |
| `serverName` | `'serena'` | MCP server name; drives both detection and every emitted `mcp__<serverName>__*` tool name (review finding 3) |

Detection (single helper, shared by both contributions):

```
active = enabled
  && registry entry `serverName` exists
  && entry.state === 'ready'
  && (entry.toolCount ?? 0) > 0
```

Registry-only detection is deliberate. mcp-client self-provides the
registry whenever it is mounted (`registry.spec.ts`), and when mcp-client
is not mounted there are no `mcp__*` tools at all — a
`assembly.tools` prefix fallback would be dead code in every deployment of
this preset. Re-evaluated live on every assembly, so a mid-session
disconnect stops the steering on the next turn (no sticky latch: churn is
rare, state is startup-pinned, and the serena-failure-watchdog hook covers
active failures out of band).

Contribution A — registered policy section:

- `ctx.systemPrompt.section({ name: 'serena-first', order: 105, text: provider })`
- The provider renders empty (`''`) while inactive (established
  contract: empty renders are dropped) and the policy paragraph below while
  active. All tool names are interpolated from `serverName`.

Contribution B — `system-prompt/assemble` waterfall listener,
`{ prepend: true }`, after `await next()`:

- `context.scope === undefined` → pass through (no per-scope keying
  possible; mirrors `tool-append-order`).
- Inactive → pass `result` through unchanged.
- Active → return `{ ...result, sections: result.sections.map(...) }`,
  mapping only these two sections to new objects (never in-place mutation):
  - `tool:read` += *" When serena tools are available, prefer
    mcp__serena__find_symbol and mcp__serena__get_symbols_overview for code
    questions — they navigate by symbol instead of loading whole files; use
    read when you need exact line-numbered content (verifying an edit site,
    non-code files, paths outside the serena project root)."*
  - `tool:grep` += *" For identifier lookups,
    mcp__serena__find_referencing_symbols is usually sharper than grepping
    raw text."*
  - `tool:write` / `tool:edit` / `tool:glob` unchanged: serena has no
    path-discovery equivalent, and edits keep the fs-observation-policy
    read-before-write gating (serena symbol-editing stays optional; the
    post-edit diagnostics hook in `hooks.json` already nudges it).
  - Missing target sections (deployments without the fs tools) are skipped
    silently.

The two contributions are disjoint from `tool-append-order`'s transform
(sections vs tools), so listener order between the two `prepend` listeners
does not matter. Delegated child scopes (CC Task subagents) also see the
steering; that is desirable — the bundled `explore` agent's allowlist
already includes the read-only serena trio.

Policy section text (interpolated with the configured prefix; approximately):

> A serena MCP server is connected. Prefer its symbol tools for code
> questions: `mcp__serena__find_symbol` to locate symbols,
> `mcp__serena__find_referencing_symbols` for reference lists,
> `mcp__serena__get_symbols_overview` for a file's outline, and
> `mcp__serena__search_for_pattern` for pattern search with symbol context.
> These tools may be deferred: if they are not in your tool set yet, call
> `tool_search` first (for example with the query `serena find_symbol`) to
> activate them. An empty serena result is not proof of absence — confirm
> with one cheap grep or read before concluding. After two serena tool
> errors in this session, stop retrying serena and use the built-in
> read/grep/edit tools. Serena only reaches files under its project root
> (the session launch directory); use the built-in tools for anything
> outside it.

Cache stability: both texts are constant for a fixed availability state;
the state is pinned at startup, so the assembled prompt stays byte-stable
across turns unless serena genuinely connects or disconnects.

## Files

New (`packages/compat/cc-serena-first/`):

- `package.json` — mirror sibling compat packages, explicitly including
  both `"@deepseek-ai/dsh-system-prompt": ">=0.1.1-rc.2"` (peerDependency)
  and the `link:../../../../deepseek-harness/packages/core/system-prompt`
  devDependency, plus `exports` / `files` fields per siblings (review
  finding 2)
- `tsconfig.json` — with project references matching siblings
- `src/index.ts` — plugin: config parsing, detection helper, section
  registration, assemble listener; structural (duck-typed) `mcpConnections`
  face like `command-doctor`
- `tests/serena-first.spec.ts` — TDD target below
- `README.md` + `README.zh.md` — repo convention: paired readmes

Edited:

- `packages/preset/cc/agent.cordis.yml` — one row inside the `cc-services`
  group (`id: serena-first`), after `command-mcp`; no new isolate key
  needed (the plugin publishes no Service). `tool-append-order` stays last;
  the cc-rows drift gate only slices the baseline above the `# ── cc rows
  ──` token, so a row inside cc-services does not trip it.
- `packages/preset/cc/package.json` — dependency on the new package
  (enforced by the composition test).
- `packages/preset/cc/tests/composition.spec.ts` — expect the new row.
- `docs/claude-code-capabilities.yaml` — new plan/behavioral surface row;
  regenerate with `pnpm docs:parity` and commit the regenerated
  `docs/cc-parity-matrix.md` + README parity block in the same commit
  (hard repo rule; `pnpm check:capabilities` and `pnpm check:parity` gate).
- Root `tsconfig` references if the repo layout requires it.

## TDD tests (vitest, real `@deepseek-ai/dsh-system-prompt` host plane like `packages/core/tool-search/tests`)

1. No `mcpConnections` service → assembly byte-identical to baseline, no
   `serena-first` section.
2. Registry entry `serena`/`ready`/`toolCount 30` → `tool:read` and
   `tool:grep` carry the appended sentences (prefix-templated),
   `serena-first` section renders the policy paragraph, `tool:glob` /
   `tool:write` / `tool:edit` are untouched, tool array untouched.
3. Entry `connecting` / `error` / `disconnected`, and `ready` with
   `toolCount` 0 or absent → identical to baseline.
4. `enabled: false` with a ready entry → identical to baseline.
5. `serverName: 'my-serena'` → detection follows the renamed entry and
   every emitted tool name uses `mcp__my-serena__*` (finding 3 guard).
6. Assembly without `context.scope` → pass-through.
7. Assembly lacking the fs sections → `serena-first` still renders, no
   throw, other sections untouched.
8. Two consecutive assemblies while active → identical output both times
   (no double-append, no provider state leak).
9. Ready entry flipping to `error` between two assemblies → second assembly
   identical to baseline (live re-evaluation, no sticky latch).

## Verification

- `pnpm vitest run` in the new package (all of the above, red first).
- `pnpm vitest run packages/preset/cc` (composition gate).
- `pnpm check:capabilities`, `pnpm check:parity`.
- Repo typecheck / presubmit as configured (`.husky/pre-commit` gates).
- Commit on `worktree-serena-first`, push, `gh pr create`.
- Observable behavior check (per "Config is prompt"): in a real session
  with serena connected, the assembled system prompt contains the
  `serena-first` policy text and the appended `tool:read` sentence; with
  serena absent it is byte-identical to today.

Worktree prerequisite: `pnpm install --frozen-lockfile` inside the worktree
(already done for this session).

## Non-goals

- No upstream (deepseek-harness) changes.
- No forced eager activation of serena tools; the policy text routes
  through `tool_search` instead.
- No runtime failure state machine beyond the text (the
  `serena-failure-watchdog` hook and `docs/code-intelligence-health.md`
  runbook own degraded-state behavior).
- No steering for `tool:write` / `tool:edit` (gating stays with
  fs-observation-policy).
