# Code intelligence parity: Serena as the production path, hooks for behavior shaping, diagnostics, and health detection

Status: **Implemented** — PR #85 (merged 2026-09-03).

Research synthesis turned into an execution plan. Incorporates two adversarial Staff-Engineer cold reviews. Their fatal findings are fixed by construction: (1) hook config is never discovered from `.claude/settings.json` → Phase 0; (2) serena-hooks' PostToolUse `reset` is structurally dead here → cut; (3) a `*`-matcher PostToolUse hook taxes every tool call in the process → narrowed matcher + hard timeout + exit-0 discipline; (4) stale/empty Serena results are invisible to hooks → carried by prompt rules, not the watchdog. Do not re-introduce any of these.

## Agreed facts (research basis, do not re-litigate)

1. **Claude Code's surface**: one built-in `LSP` tool with 9 operations (`goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls` — `tools/LSPTool/schemas.ts`), push diagnostics after edits (`FileEditTool` sends `didChange`/`didSave`; `services/lsp/passiveFeedback.ts` listens on `publishDiagnostics` and injects new diagnostics into context), and plugin-declared servers via `.lsp.json` / `plugin.json lspServers`.
2. **dsh-cc's native LSP family exists but is unmounted in production**: `@deepseek-ai/dsh-lsp` (seam, exactly 4 read-only operations: goToDefinition/findReferences/goToImplementation/hover), `dsh-lsp-stdio`, `dsh-tool-lsp`. No shipped composition mounts them — `packages/bundle/cc-shell/cordis.patch.yml` and `packages/preset/cc/agent.cordis.yml` contain no lsp rows; only `packages/bundle/cc-shell/tests/lsp-bundle.spec.ts` mounts them. `docs/cc-parity-matrix.md:76` claims ✅ mounted — it overstates reality (now tracked as #cap-engine.ide-lsp).
3. **Serena is the production code-intelligence path**: `~/.claude.json` (user scope) pins `uvx --from git+https://github.com/oraios/serena@v1.7.0 serena start-mcp-server --context claude-code --project-from-cwd`, discovered by cc-shell's `defaultMcpFiles()` (`packages/bundle/cc-shell/src/index.ts:46-54`). Serena v1.7.0 covers 6 of CC's 9 LSP operations with richer symbol-level semantics (`find_declaration` ≈ goToDefinition, `find_referencing_symbols` ≈ findReferences, `find_implementations` ≈ goToImplementation, `get_symbols_overview` ≈ documentSymbol, `find_symbol` ≈ workspaceSymbol), adds symbol-level editing CC lacks (`replace_symbol_body`, `rename_symbol`, `safe_delete_symbol`, `insert_before/after_symbol`, `replace_content`, `replace_in_files`), and offers pull diagnostics (`get_diagnostics_for_file`). True gaps: no direct hover tool, no call hierarchy, no push diagnostics. The pinned v1.7.0 already carries the v1.6.0 Svelte↔TypeScript diagnostics/documentSymbol misrouting fixes (upstream CHANGELOG), but per-language maturity still varies (Deno, Erlang, LaTeX, Nextflow, Wolfram are documented as experimental).
4. **Hook bridge contract** (`packages/hooks/hooks-claude-code`): PostToolUse supports `additionalContext` (attached after the tool result — `tests/bridge.spec.ts:205`); PreToolUse supports deny/ask with verbatim reason passthrough but **ignores `additionalContext`** (README.md:115). Matcher subject is the tool name; payload `tool_name` is the CC canonical name (`read`/`read_image` → `Read`, `grep` → `Grep`; `packages/core/tools/src/cc-names.ts:59-82`); `tool_input` is the raw harness arguments; `tool_response` is **flattened to text** (`src/payloads.ts:70`). `session_id` is in every base payload (`src/payloads.ts:35`). `${CLAUDE_PROJECT_DIR}` is exported to hook processes (`src/index.ts:92-97`).
5. **Hook config discovery is the gap**: the bridge reads exactly one file — `config.configPath`, else `$DSH_HOME/hooks.json` (`src/index.ts:147-154`); per-session project-local discovery is `TODO(per-session-hook-config)`. No shipped composition passes `configPath`. Relative `configPath` resolves against the process launch cwd — the worktree root when `dsh cc-tui` starts there — so a **tracked** `hooks.json` loads in worktree sessions by construction.
6. **serena-hooks v1.7.0** (`src/serena/hooks.py`): the PreToolUse `remind` subcommand requires `session_id`, `tool_name`, `tool_input`; it **lowercases `tool_name` on ingest** (so the CC-canonical `Read`/`Grep` payload classifies correctly), classifies grep calls by tool name alone and read calls by name plus `tool_input.file_path` extension (dsh's Read/Edit/Write tools use `file_path` — compatible). On a burst (3 reads / 3 greps / 4 combined, 120 s deny rate-limit, per-session pickled counters) it emits `permissionDecision: deny` + reason. Its own counter reset on Serena symbolic tool calls fires **only if the PreToolUse matcher covers `mcp__serena__*`**. The PostToolUse `reset` subcommand requires `tool_response` as a dict with `isError` — dsh-cc flattens it to text, so `reset` is a permanent no-op here; do not wire it.
7. **Hook dispatch realities** (second review, source-verified): PostToolUseFailure **does** dispatch `command` hooks through the same `runPoint` machinery (`src/index.ts:282`), but its outcome is discarded, it has zero bridge-level test coverage, and its invocations are not persisted to the session log — a crashed recorder surfaces only as `logger.warn`. PostToolUse fires even on failed tool calls (`src/index.ts:285`, no isError gate — the "mutually exclusive" README claim is wrong). PostToolUse hooks are **awaited inline** before the tool result reaches the model, run **serially**, and fire for **every agent including parallel subagents**. A hook exiting 2 rewrites the tool result to isError (`bridge.spec.ts:184-203`). The default hook timeout is 600 000 ms (`src/index.ts:99`). A malformed matcher regex rejects the **entire** hooks config, warn-only (`src/config.ts:183` → `src/index.ts:172-175`) — hooks.json is a shared blast radius. MCP `isError: true` propagates to harness isError results (mcp-client.spec.ts:554-566). The `~/.claude.json` discovery path defaults `failOnStartupError: true` — a failed Serena startup rejects plugin activation loudly in logs, but **the model is not told the tools are missing** (mcp-config README:71).

## Phase 0 — Wire a tracked hook config (precondition for Phases 2-4)

Without this, every hook configured in this plan registers nowhere and fails silently.

**Files**
- `hooks.json` (new, tracked, repo root) — CC-shaped hook config: `{ "hooks": { ... } }`. Tracked, so it ships to worktrees.
- `packages/preset/cc/agent.cordis.yml` — the `hooks-claude-code` row (line ~351) gains `config: { configPath: hooks.json }`. Sits in the cc-rows section the drift gate already exempts.
- `packages/preset/cc/tests/composition.spec.ts` — assert the `hooks-claude-code` row carries `configPath: hooks.json` and that the file exists at the repo root, parses as JSON, and every matcher compiles (guard against the warn-only whole-config rejection, fact 7).

**Verification**: composition test green; then (after merge, since worktrees see HEAD only) start a worktree session, configure one trivial `UserPromptSubmit` echo hook, and observe its `additionalContext` in the first model turn. Remove the probe before continuing — it proves discovery, nothing else.

## Phase 1 — Correct the parity matrix (docs only)

**File**: `docs/cc-parity-matrix.md`, row "IDE integration / LSP" (line 76) (now tracked as #cap-engine.ide-lsp).

Rewrite as two paths:
- **Production**: Serena MCP (user-scope `~/.claude.json`, v1.7.0 pin, `--context claude-code --project-from-cwd`), symbol-level retrieval + editing + pull diagnostics; ~30 tools deferred through ToolSearch (per-server threshold 8). Coverage and gaps per fact 3.
- **Native**: `dsh-lsp` family present as packages, unmounted in shipped compositions, 4-operation read-only navigation only.
- Record the cc-plugin-loader gap: `lspServers` / `.lsp.json` manifests are not parsed (no lsp handling in `packages/compat/cc-plugin-loader/src/`), so CC code-intelligence plugins have no effect.
- One line noting the PreToolUse `additionalContext` degradation (fact 4), since it bounds what hook-based shaping can inject pre-tool.

**Verification**: wording review against facts 2-3; `rg -n lsp packages/preset/cc/agent.cordis.yml packages/bundle/cc-shell/cordis.patch.yml` stays empty (regression guard only).

## Phase 2 — serena-hooks `remind` (PreToolUse behavior shaping)

Wire **only** the PreToolUse remind hook. The PostToolUse reset hook is cut (fact 6: dead by payload shape). The remind hook's own counter reset on Serena symbolic calls is reachable because the matcher below covers `mcp__serena__*`.

**Files**
- `hooks.json` (from Phase 0):
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(read|grep)$|^mcp__serena__",
        "hooks": [
          { "type": "command", "command": "uvx --from git+https://github.com/oraios/serena@v1.7.0 serena-hooks remind --client claude-code" }
        ]
      }
    ]
  }
}
```
Matcher notes: a pattern outside `^[A-Za-z0-9_|]+$` compiles as an **unanchored** regex (`packages/hooks/hook-protocol/src/matcher.ts:56-64`), so it must be anchored — a bare `read` would substring-match any future tool name containing "read". Harness-form tokens (`read`, `grep`) fire via the bridge's dual name query (`run-point.ts:82-90`).

**Pre-flight (before writing config)**
1. `uvx --from git+https://github.com/oraios/serena@v1.7.0 serena-hooks --help` — confirm the subcommand is exactly `remind` and the flag is `--client claude-code`.
2. Capture one real PreToolUse payload (temporary echo-to-file hook via Phase 0's probe) and confirm `session_id`, `tool_name` (`Read`/`Grep`), `tool_input.file_path` — the three fields serena-hooks requires.
3. Time one warm `uvx` invocation; this process spawns synchronously on every read/grep. If warm cost exceeds ~500 ms, prefer `uv tool install` once and reference the bare `serena-hooks` binary instead (record the choice in the commit message).

**Behavior verification (real session, after merge — config is prompt)**
- Three consecutive `Read` calls on code files → the third is denied, with Serena's "Too many consecutive read calls" reason visible verbatim.
- Falsifiable reset check: `Read` × 2 → `mcp__serena__find_symbol` × 1 → `Read` × 2 → **no deny** (the Serena call reset the burst counters; without reset, 4 combined non-symbolic calls would have tripped).
- Editing a `.md` file repeatedly never trips the read counter (extension filter).

Commit message states the expected observable behavior change (deny on the 3rd consecutive code-file read).

## Phase 3 — Post-edit diagnostics nudge (approximates CC's push diagnostics)

Serena's `get_diagnostics_for_file` is pull-based and hooks cannot call MCP tools, so a PostToolUse hook injects an `additionalContext` nudge after code edits — the channel fact 4 proves works.

**Files**
- `scripts/hooks/post-edit-diagnostics-nudge.mjs` (new; plain Node, stdin→stdout hook protocol, same conventions as `scripts/check-subagent-paste.mjs`):
  - Parse the hook JSON; act only on edit-like tools: harness `edit`/`write` and Serena's `mcp__serena__replace_symbol_body`, `replace_content`, `replace_in_files`, `insert_before_symbol`, `insert_after_symbol`, `rename_symbol`, `safe_delete_symbol`.
  - Extract the target path: `tool_input.file_path` (harness edit/write — confirmed key) with `tool_input.path` as fallback, else serena's `tool_input.relative_path`.
  - Skip non-code extensions (reuse the serena-hooks extension set).
  - Debounce per file+session (60 s; state under `$CLAUDE_PROJECT_DIR/.serena/hook_data/` — the env var is documented as exported to hook processes, fact 4).
  - Emit `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Diagnostics: run mcp__serena__get_diagnostics_for_file on <path> before the next edit; fix new errors in the same turn."}}`.
  - **Exit-0 discipline**: unconditional top-level try/catch → exit 0 on malformed stdin, missing dirs, anything (fact 7: a PostToolUse hook exiting 2 rewrites the tool result to isError; this script must never break edits). Declare `timeout: 5000` in the hooks.json entry (default is 600 s — fact 7).
- `hooks.json` — PostToolUse entry with anchored matcher covering the edit-like tools above.
- `scripts/hooks/post-edit-diagnostics-nudge.test.mjs` — node:test, fixtures built from the **captured real payload** (Phase 2 pre-flight step 2), covering: tool-name filter, path extraction across the three key variants, extension filter, debounce, exact output JSON shape, and exit-0-on-garbage.

**Verification (real session, after merge)**
- Mechanism first: introduce a TypeScript error via `edit` in a `.ts` file → the nudge string appears in the transcript's post-tool context (proves plumbing independent of model compliance).
- Then compliance: the next assistant step calls `mcp__serena__get_diagnostics_for_file` on that file and fixes the error in the same turn.
- Counter-case: editing a `.md` file injects nothing.

## Phase 4 — Serena health detection and fallback

Serena delegates to per-language language servers of varying maturity. Its failure classes: (a) MCP startup failure (loud in logs via `failOnStartupError`, invisible to the model — fact 7), (b) mid-session LS crash surfacing as tool errors, (c) **stale/empty/misrouted results from indexing races or per-language routing bugs — these return as successful tool results and are structurally invisible to hooks**, (d) other tool-level errors. Class (c) is the one that motivated this phase; it is carried by Item 1 (prompt rules), because no hook can see it.

### Item 1 — Prompt-level fallback rules (tracked CLAUDE.md edit, no code)

- An **empty** `find_symbol`/`get_symbols_overview` is not ground truth. Confirm with one cheap probe — a `grep` for an obvious token in that file, or `get_diagnostics_for_file` — before concluding "no symbols". (The "visibly contains symbols" formulation is unevaluable under serena-first discipline; the probe makes it evaluable.)
- After **2 Serena tool errors within 5 minutes**: stop retrying Serena, use built-in Read/Grep/Edit, and note the degradation to the user. (Windowed, aligned with Item 3's watchdog — do not use "consecutive", which diverges from the hook.)
- Recovery ladder before falling back: `get_diagnostics_for_file` → `get_current_config` (LS status, v1.7.0) → `mcp__serena__restart_language_server` if available → built-ins.
- Per-language maturity: experimental languages (Deno, Erlang, LaTeX, Nextflow, Wolfram) degrade to built-ins by default.
- **Precedence sentence**: where these rules conflict with Serena's own injected initial_instructions (which mandate serena-first and carry their own fallback guidance), these rules win — state it explicitly so resolution is deterministic.
- Note the pinned v1.7.0 already carries the Svelte/TS routing fixes; the rules target the general class.

**Pass criterion (pin before implementation — behavioral verification is probabilistic)**: in the verification transcript, every empty `find_symbol` on a file later confirmed non-empty is followed by a probe, and no third Serena call occurs within 5 minutes of two Serena errors.

### Item 2 — Health runbook (docs only)

Document: `uvx --from git+https://github.com/oraios/serena@v1.7.0 serena project health-check` (exit 1 on failure since v1.7.0; a zero-match `find_symbol` counts as failure) — with the caveat that it spawns a **separate uvx instance with its own language server**, so it validates project config, not the live session's server; `serena project index` for index pre-warming (per-worktree cache: fresh worktrees start cold — note whether pre-warming is worth it in worktrees); and the `failOnStartupError: true` default on the `~/.claude.json` path (startup failure is loud in logs, not silent).

### Item 3 — Failure watchdog (`scripts/hooks/serena-failure-watchdog.mjs`, new plain-Node script)

Two halves, deliberately asymmetric:

- **Recorder** — PostToolUseFailure, matcher `^mcp__serena__` (fires only on actual Serena errors; near-zero steady-state cost): append `{ts, tool, errorHead}` to `$CLAUDE_PROJECT_DIR/.serena/hook_data/failures-<session_id>.jsonl`, `mkdir -p` first (fresh worktrees lack `.serena/`). **Bridge-level gap to close first**: PostToolUseFailure's command-hook dispatch is untested (fact 7) — add a test to `packages/hooks/hooks-claude-code/tests/bridge.spec.ts` proving a PostToolUseFailure command hook runs on an isError result, before relying on it.
- **Advisory** — PostToolUse, matcher `Read|Grep|Glob` (literal tokens, alias-resolved by the bridge — **not** `*`; after a Serena failure the model's next action is almost certainly one of these, and Bash/Task-heavy orchestrator sessions must not pay the per-call spawn tax, fact 7): if the session's failure file shows ≥2 entries within the last 5 minutes AND no advisory in the last 10 minutes, emit exactly one `additionalContext`: "Serena MCP has failed N times recently (last: \<tool\>). Use built-in Read/Grep/Edit for now; `mcp__serena__restart_language_server` may recover it if the server is still connected." Silent no-op otherwise. Same exit-0 discipline and `timeout: 5000` as Phase 3.
- GC: the recorder truncates its own session file at 100 lines; stale `failures-*.jsonl` older than 7 days are swept on write.

Unit tests (node:test, real-shape fixtures): recorder append + mkdir-p in a fresh dir, threshold+window logic, advisory one-shot + cooldown, silent-when-clean, exit-0-on-garbage, GC.

**Verification (real session)**: induce Serena errors **deterministically** — point the project at a broken language-server entry in `.serena` config — not by `pkill` (Serena v1.7.0 auto-restarts crashed LS processes; pkill races it). Assert in ≥2 of 3 trials: the JSONL appears, and the next Read/Grep result carries the advisory. Also record (as a finding, not a blocker): whether calls to Serena tools after full server death emit `tools/post-execute` at all — if the reconnect budget exhausts and tools are removed (mcp-client README:109-111), the watchdog may see nothing in the most severe scenario.

### Item 4 — Instability escalation (prose, not mechanism)

Per-session failure files evaporate with the worktree, so there is deliberately no telemetry aggregator. Instead: when a specific language's instability keeps surfacing in practice, that observation is the recorded trigger for evaluating the Phase 5 gate (native dsh-lsp mount) or a Serena version bump. Demoting this to prose is a review decision — do not rebuild it as infrastructure.

## Phase 5 — Decision gate: mount the native dsh-lsp tool?

**Default: do not mount.** Trigger conditions (recorded in the Phase 1 matrix edit): a concrete task where Serena cannot answer a hover/type-info or call-hierarchy question, OR the Phase 4 Item 4 instability signal for a core language. If triggered:
- add rows `lsp` (`@deepseek-ai/dsh-lsp`), `lsp-stdio` (`@deepseek-ai/dsh-lsp-stdio`, typescript-language-server entry), `tool-lsp` (`@deepseek-ai/dsh-tool-lsp`) to the cc-rows section of `packages/preset/cc/agent.cordis.yml`;
- extend the composition test so the shipped composition provably mounts them (today only `lsp-bundle.spec.ts` mounts them, in tests);
- add prompt guidance disambiguating the `lsp` tool from Serena tools (two navigation surfaces);
- flip the Phase 1 matrix row accordingly — it was written for the unmounted state.
Call hierarchy stays out of scope: it requires extending the seam's closed 4-operation set, a harness-side decision.

## Phase 6 — Defer: `.lsp.json` / `lspServers` in cc-plugin-loader

Explicitly deferred. Parse CC plugins' LSP declarations into `dsh-lsp-stdio` providers only when a real CC code-intelligence plugin must run unmodified. Phase 1 documents the gap so the deferral is visible.

## Sequencing and process notes

- Phase 0 → Phases 1/2/3/4 may then proceed in parallel; Phases 5-6 are gates, not work. Phase 4 Item 3's bridge test lands with Phase 0's test work.
- Per the worktree policy, **all composition and config changes must be committed (and merged to main) before cutting the verification worktree** — uncommitted state is invisible there.
- Every config change follows the config-is-prompt rule: the commit message states the expected observable behavior change, verified in a later real session.

## Out of scope

- PyPI pin switch for Serena (`uvx --from serena-agent==1.7.0`) — explicitly declined.
- JetBrains backend (`type_hierarchy` and friends) — a separate backend decision.
- Serena memory tools vs dsh-cc memory — separate topic.
- PreToolUse `additionalContext` support in the bridge — worth doing eventually (it would un-degrade serena-hooks), but it is a bridge feature with its own design (see the pre-tool-input-rewrite Agent Note), not a prerequisite here.
