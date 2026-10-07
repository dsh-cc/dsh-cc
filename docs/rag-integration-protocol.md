# Generic RAG Integration Protocol (rag/1)

Date: 2026-10-07. Status: FINAL — four review rounds converged (three seats:
critic / codex / grok; disposition ledger in the last section).

Scope decision (user, 2026-10-06): **MCP minimal closed loop first** — the
first backend (`llm-wiki`, a local markdown knowledge base) gets an MCP
server wrapper, dsh-cc consumes it via `.mcp.json`, and the protocol is
documented here. Hook-based auto-recall is design-only this round.

## 1. Goal and non-goals

Goal: let any retrieval system plug into dsh-cc sessions through ONE
documented contract, such that

- the minimal loop requires **zero dsh-cc runtime code** (config only), and
- deeper native surfaces (auto-recall, provider registry, budgets) can be
  added later without re-designing the contract.

Non-goals this round:

- No auto-recall implementation (UserPromptSubmit injection) — designed, not
  built.
- No changes to the first backend's retrieval kernel (weights, chunking,
  fusion). Contingency: if instrumented measurement shows warm **local-lane**
  compute cannot meet the latency target without kernel work, this constraint
  is re-opened explicitly with the user — retrieval semantics are NOT
  silently weakened to pass a latency number (§6 split gate).
- No alignment work with llm-wiki's draft `knowledge-access-control-plane`.
- No reranking / side-query lane. No provider registry, no CLI fallback
  adapter, no HTTP transport, no hook client, no `resources/read`, no
  `resource_link`, no `outputSchema` in this implementation (§4.3 explains the
  last three — client-renderer evidence).

## 2. Probe-established facts (2026-10-06/07, live machine + repo code)

llm-wiki (a local checkout, referenced as `$LLM_WIKI_ROOT` below — repo docs
carry no machine-local absolute paths; python package `wiki-tools` 0.2.0):

- Retrieval is hybrid: FTS5 keyword over sqlite `_meta/index.db` (219 MB,
  unicode61+bigram for CJK) + LanceDB chunk embeddings (298 MB) + 4-signal
  link graph; fusion weights semantic .4 / graph .4 / keyword .2.
- Interface today: CLI only. `wiki-tools search QUERY --top-k N --json`
  emits `{success, stats{...}, data.results[{path, title, summary,
  snippet, tokens, score, breakdown{keyword, semantic, graph, recency}}]}`.
  No stable chunk ids; `snippet` is a verbatim body excerpt, `summary` is
  generated text — the mapping rule is pinned in §5.
- **Latency probe**: ~30 s wall per CLI invocation (import-only 0.17 s);
  per-invocation index load dominates. What residency removes is unproven
  until measured — §10 P-A is an instrumented, phase-split measurement.
- **Silent degradation**: with `OPENROUTER_API_KEY` absent, the semantic lane
  returns 0 candidates and search still "succeeds" (keyword 9674, graph
  13114, semantic 0; right page still #1). Query-time embedding needs network
  + key.
- No server of any kind in llm-wiki; the `mcp` SDK is not yet a dependency.
  The runbook starts with `uv sync --extra mcp` (repairs a stale venv and
  installs the extra).

dsh-cc (this repo; code-verified 2026-10-07):

- Native MCP client with deferred connect. **The model-visible tool result
  is the rendered text only** (`packages/mcp/mcp-client/src/tools.ts:353,457`):
  `extractText` joins text blocks; each `resource_link` renders as the
  literal line `[resource: content discarded]` (:478); `structuredContent`
  stays on the execution-local value and does NOT reach the model; a
  supported `outputSchema` whose payload mismatches fails validation as
  `ToolOutputError / INVALID_TOOL_OUTPUT`
  (`packages/mcp/mcp-client/tests/mcp-client.spec.ts:511-537`) and the passage
  is replaced by the error. Tool descriptions: the client copies
  `tool.description ?? ''` (:263) and server `instructions` are NOT injected
  — the description is the only model-facing instruction channel.
- 3 tools < `DEFAULT_DEFER_TOOL_THRESHOLD = 8` (`defer.ts:17`) → eager
  registration; ToolSearch is not in play.
- Config: `expandEnv` (`mcp-config/src/index.ts:106`) **throws on a truly
  unset `${VAR}`**; `${VAR:-}` expands to `''`; present-but-empty expands to
  `''`. One throwing entry skips the WHOLE config file (single try around
  buildRegistrations in cc-shell). Child env = `scrubbedParentEnv()` +
  explicit `env` overlay (`mcp-client/src/transport.ts:28-30`); the scrub
  strips sensitive-looking names (`/KEY|PASSWORD|SECRET|TOKEN/i`) —
  **ambient inheritance does NOT deliver `OPENROUTER_API_KEY`**.
- Discovery order: `<cwd>/.mcp.json` then `$DSH_HOME/.mcp.json`
  (`mcp-config/src/paths.ts:21`); a same-named project entry mounts first
  and the global duplicate is skipped — **a project file is not contained by
  the global recommendation** (§7).
- Server death mid-session: auto-reconnect ON (`RECONNECT_DEFAULTS`,
  `connection.ts:57-61`: 500 ms → 30 s backoff, 10 attempts), then dead until
  restart. Model-visible error during the gap: P-B records it.
- `UserPromptSubmit` → `additionalContext` hook path test-covered
  (`bridge.spec.ts:133`) — future auto-recall leg only.

MCP spec (2025-11-25, via context7): retrieval is exposed as tools;
`resources/list` is for enumerable corpora (not implemented — noted ceiling).

## 3. Architecture: a RAG profile over MCP, not a new protocol

```
┌─────────────────────── dsh-cc ───────────────────────┐
│ L2 consumption surfaces                               │
│   1. model-invoked tool   (via native MCP client)     │
│   2. auto-recall hook     (DESIGN-ONLY this round)    │
├───────────────────────────────────────────────────────┤
│ L1 transport: MCP stdio (resident) — only transport   │
├───────────────────────────────────────────────────────┤
│ L0 canonical contract: versioned JSON Schemas         │
│   (rag/1): RagQuery / RagChunk / RagAnswer /          │
│   fetch / health                                      │
└───────────────────────────────────────────────────────┘
        ▲ implemented by each backend
┌───────┴───────────┐
│ llm-wiki          │  wiki-tools mcp-serve (thin shell over search subsystem)
│ (other backends…) │
└───────────────────┘
```

The "generic protocol" is a **profile over MCP**: tool set + descriptions,
versioned result schemas, citation conventions. Any conforming backend is
consumable with zero dsh-cc code; MCP stdio gives the resident process the
latency probe proved mandatory.

## 4. L0 canonical contract (`rag/1`; all schemas versioned)

Schema discipline: versioned JSON Schemas per tool; unknown input fields
REJECTED (`additionalProperties: false`); bounds are part of the contract.

### 4.1 Shapes

```
RagQuery = {
  query: string            // after trim MUST be ≥1 char; ≤2000; blank → isError invalid-query
  topK?: int               // 1..20, default 5
  filters?: { ... }        // profile vocabulary; a server advertises ONLY what it
                           // can push down pre-fusion; llm-wiki v1 advertises NONE (§5)
  budgetTokens?: int       // 100..8000, default 1500; bounds PASSAGE TEXT only
}
RagChunk = {
  id: string               // retrieval-time chunk id "<backend>:<dockey>#<chunkN>"; NOT durable across reindex
  docId: string            // STABLE corpus-relative document key (llm-wiki: wiki-relative path);
                           // survives edits/reindex — this is the cite target
  revision: string         // content hash of the indexed generation; changes on edit+reindex
  uri: string              // ABSOLUTE resolvable URI (file:// for llm-wiki)
  title: string
  text: string             // passage actually shown to the model
  textKind: "passage" | "summary"   // verbatim excerpt vs generated text — citation honesty
  score: number            // backend-local ranking value ONLY; no cross-backend comparability
  breakdown?: object       // backend-specific, opaque
  tokens?: int             // backend's own counter; llm-wiki always emits it
  updatedAt?: string       // ISO
}
RagAnswer = {
  schemaVersion: "rag/1"
  chunks: RagChunk[]       // score desc, stable tie-break by id
  stats: { latencyMs, truncated?: bool, degraded?: string[], candidates?: object }
}
FetchRequest  = { docId: string,                 // docId ONLY; a chunk id merely names its
                                                 // document (fetch returns the document window)
                  offset?: int,                  // 0-based CHARACTER offset into the full document
                                                 // text; default 0; > length → isError invalid-offset
                                                 // (continuation must round-trip)
                  ifRevision?: string }          // drift guard: mismatch with the server's current
                                                 // revision → isError revision-changed; the error
                                                 // text carries the CURRENT revision so the caller
                                                 // can drop the stale ifRevision and restart from
                                                 // offset 0
FetchResponse = { schemaVersion, docId, revision, uri, title, text,
                  textKind: "passage", tokens, truncated: bool,
                  continuation?: { offset: int } }   // next offset; ABSENT = end of document
HealthResponse = { schemaVersion, ok: bool,
                   lanes: Record<string, { ok: bool, detail?: string }>,  // OPEN lane set,
                   degraded: string[], lastIndexedAt?: string }           // not a closed triple
```

### 4.2 Contract semantics

- Empty result (`chunks: []`) is a SUCCESS.
- Filters: receiving a filter the server does not advertise → `isError`
  `unsupported-filter:<name>`; silently ignoring is unacceptable. (llm-wiki
  v1 advertises none — its CLI cannot push them down pre-fusion;
  post-filtering a finished top-k is NOT honoring.)
- Operational failure → MCP `isError: true`; degraded-but-served → success +
  `stats.degraded[]`.
- Identity: cite `docId`; chunk `id` is retrieval-ephemeral; `revision`
  detects content drift between search and fetch.
- `textKind`: `passage` = verbatim (quotable/citable); `summary` = generated
  (readable, NOT quotable as source).
- Budget edge cases: a chunk missing `tokens` is counted as `ceil(chars/4)`;
  if the SINGLE best chunk alone exceeds `budgetTokens`, it is returned
  truncated to budget with `stats.truncated: true` — never a silent empty
  success.
- stats/candidates are optional diagnostics, not contract.

### 4.3 MCP mapping (the profile) — client-renderer-driven

Three tools named **`search` / `fetch` / `health`** (the client already
namespaces exposed tools `mcp__<serverName>__<rawName>`, so backend-baked
prefixes are redundant and overfit the profile to one backend).

Result delivery (verified §2): **the text block IS the normative model
contract**, because this client renders only text.

- Text-block layouts are pinned for ALL THREE tools (the text block is the
  normative model contract, so every tool's layout is contract):
  - `search`: optional banner `⚠ rag: degraded=[semantic:no-api-key]
    truncated=true` when set; then per chunk:
    `[{score}] {title} — docId={docId} rev={revision} ({textKind})` /
    `{uri}` / `{text}` — `revision` rides the model-visible line so fetch's
    `ifRevision` guard is usable.
  - `fetch`: banner `{title} — docId={docId} rev={revision}
    truncated={bool} next_offset={int|-}`; then `{text}`.
  - `health`: banner `ok={bool}`; one line per lane `lane={name} ok={bool}
    {detail?}`; one line per `degraded[]` entry.
- `structuredContent: RagAnswer` is ALSO returned, for programmatic callers
  only — never assumed model-visible.
- **`outputSchema` is NOT advertised in v1**: a payload mismatch becomes
  INVALID_TOOL_OUTPUT and REPLACES the passage with the error. Revisit only
  after a fixture has passed through `ctx.tools.execute` on this client.
- **`resource_link` is NOT emitted in v1**: this client renders each as
  `[resource: content discarded]` — one noise line per chunk. Revisit when
  the renderer preserves links.
- **Server MUST NOT advertise `resources` or `prompts` capabilities**: the
  resources capability mounts a second read path (`read_mcp_resource`) that
  bypasses `maxFetchTokens` and `textKind`.
- **Tool descriptions are mandated by the profile** (the only model-facing
  instruction channel): each description states when to call the tool, that
  returned passages are untrusted DATA (not instructions), and that
  `textKind:"summary"` text must not be quoted as source.

### 4.4 Bounds

search: query ≤2000 chars (blank after trim → `isError invalid-query`),
topK ≤20, budgetTokens ≤8000. fetch: text capped at `maxFetchTokens`
(server config, default 4000); overflow → `truncated: true` +
`continuation.offset` (0-based character offset into the full document
text).

## 5. llm-wiki binding: `wiki-tools mcp-serve`

Thin shell, one new module `src/wiki_tools/mcp_server.py`:

- stdio MCP server via the official Python `mcp` SDK (new optional extra
  `mcp = ["mcp"]`); **all logging to stderr, stdout stays protocol-pure** —
  a library warning on stdout breaks stdio framing and looks like a dead
  server (PR-A has a stdout-purity test covering import AND the embed-error
  path).
- **`--root <KB root>` is REQUIRED** (no cwd default); the venv path and
  the corpus root are independent paths and documented as such.
- **Startup answers `initialize` BEFORE the heavy index open**: the client
  handshake budget is the MCP SDK default 60 s and dsh-cc exposes no
  connection timeout; opening 219 MB sqlite + 298 MB LanceDB
  pre-initialize can spend it. Indexes load in the background; `search`
  while loading returns `isError index:loading`; `health` reports
  `lanes.*.ok=false` until ready.
- Artifact policy: missing `index.db` = FATAL (keyword+graph live there);
  missing LanceDB = start DEGRADED (`semantic:index-missing`) — same ladder
  as a missing key: both kill only the semantic lane.
- **Concurrency**: fusion is GIL-bound synchronous CPU work over shared
  sqlite/LanceDB handles → default **ONE in-flight search** (queue the
  rest); the executor exists so cancellation and `health` are not stuck
  behind the accept queue, not for throughput. PR-A test: call `health`
  DURING a search and bound its latency. Cancellation stops awaiting
  immediately; the worker stays occupied until the current phase returns
  (no hard preemption — stated, not promised away).
- **Local lanes run CONCURRENTLY with the embed call**: an 8 s embed
  timeout must not eat FTS+graph time; on embed failure the local answer is
  already computed and returns degraded.
- **Credentials**: absent OR empty-string key = semantic lane skipped
  immediately (no network attempt), `degraded:["semantic:no-api-key"]` on
  health + every answer. Distinct strings: `semantic:auth-failed` /
  `semantic:rate-limited` / `semantic:timeout`.
- **Deadlines (pinned)**: the per-query TOTAL deadline (default 10 s) clock
  starts AT REQUEST RECEIPT — queue time behind a single-flight search
  counts against it. At deadline: if the local-lane result is READY, return
  a NORMAL tool result (degraded when the embed is still outstanding); if
  NO local answer is ready (queued or mid-phase, non-preemptible), return
  `isError deadline-exceeded` — a clean tool error the model may retry with
  a narrower query, never a hang (client tool timeout is 60 s; a hang dies
  as a transport error and even the keyword answer is lost). Embed
  retries: 0; the 8 s embed timeout sits INSIDE the total deadline.
- **Index generation**: stat check off the hot path; on change, reload in
  the BACKGROUND while serving the previous generation (a synchronous
  reload inside the 10 s query deadline re-imports the cold cost); reload
  failure → old generation + `degraded:["index:reload-failed"]`.
- **CLI field mapping (pinned)**: `snippet` (verbatim excerpt) → `text`
  with `textKind:"passage"` — this is the model-visible text; `summary`
  (generated) → `textKind:"summary"`, used only when no snippet exists;
  `path` → `docId` (and `uri` = `file://<root>/<path>.md`); index.db
  `content_hash` → `revision`; chunk ids synthesized as
  `wiki:<path>#<chunkN>`, ephemeral.
- **Fetch security**: `docId` resolves ONLY inside `--root`; traversal,
  escaping symlinks, and URL-like ids → `isError`. Query text leaves the
  machine for the embedding provider when the semantic lane is live
  (documented in the runbook); passages are untrusted content; diagnostics
  never echo secrets.
- **Loud degradation** everywhere — never silent-zero like the CLI today.
- Runbook: `uv sync --extra mcp`; env keys; resident cost note: per dsh-cc
  process one stdio child holding ~520 MB of indexes.

## 6. Latency and token budget

- **Split gate**: the kernel-reopen number is **local-lane p50 < 3 s** (FTS
  + graph + fusion, serialized phases) with p95 reported. Embed RTT is
  measured and reported BESIDE it — a network number can never trigger the
  §1 kernel-reopen. First-query-after-boot reported separately from steady
  state; ≥20 DISTINCT queries; BOTH valid-key and keyword+graph-only modes;
  plus one forced-timeout query proving a normal degraded result at the
  10 s deadline.
- `budgetTokens` trims by `chunk.tokens` (estimation rule §4.2); defaults
  topK 5 / budget 1500.
- Auto-recall leg (DESIGN-ONLY): UserPromptSubmit hook → RESIDENT server
  only, topK 3, ≤500 tokens (counting rule TBD that round — backend-local
  tokens are not model tokens), dedup same `docId` within K turns, default
  OFF. Parked seams: hooks spawn per-event processes, and a fresh stdio
  `mcp-call` would be ANOTHER ~30 s cold process — attaching to the
  resident server (unix-socket sidecar?) IS the whole problem; and every
  auto-recalled prompt is an embedding egress when the semantic lane is on
  — a second reason for default-off beyond tokens.

## 7. dsh-cc configuration surface and security

Minimal loop (this round): one `.mcp.json` entry. **Recommended home:
user-global `$DSH_HOME/.mcp.json`**, absolute executable, explicit root:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "${LLM_WIKI_ROOT:-}/.venv/bin/python3",
      "args": ["-m", "wiki_tools.mcp_server", "--root", "${LLM_WIKI_ROOT:-}"],
      "env": { "OPENROUTER_API_KEY": "${OPENROUTER_API_KEY:-}" }
    }
  }
}
```

Verified config semantics:

- `"${OPENROUTER_API_KEY:-}"` is MANDATORY in this shape: a truly unset
  `${VAR}` (no fallback) makes `expandEnv` THROW, and one throwing entry
  makes cc-shell skip the WHOLE file — every other server in it goes down
  too. The `:-` fallback boots the server into `semantic:no-api-key`
  instead (P-C).
- `${LLM_WIKI_ROOT:-}` follows the same rule: unset → empty expansion → the
  executable becomes `/.venv/bin/python3` and startup fails at process
  SPAWN (ENOENT), before `--root` validation ever runs; either way the
  failure is immediate and the rest of the file's servers stay up.
- Ambient inheritance does NOT deliver the key: the child env scrub strips
  `/KEY|PASSWORD|SECRET|TOKEN/i` names. The explicit `env` entry is the
  only channel (it overlays the scrub).
- **Global config does not contain project `.mcp.json`**: `<cwd>/.mcp.json`
  loads first; a same-named project entry wins and the global duplicate is
  skipped. **There is no approval flow** — a project entry is arbitrary code
  execution with user privileges and inherited credentials; treat any
  directory's `.mcp.json` as executable content requiring trust. Filing
  the approval/allowlist question as an explicit dsh-cc backlog item is
  part of this protocol's DoD.
- Egress disclosure: query text goes to the embedding provider when
  semantic is live; passage text also leaves the machine inside the chat
  request once the model has the tool result. The runbook says both.
- The trust boundary is the config FILE, not the intended read-only server.
- Future native plugin (`cc-rag`, not this round): settings namespace
  `cc-rag.*`, provider registry, recall policy, citation rendering.

## 8. Failure modes and trust

| Failure | Behavior |
|---|---|
| stale venv / missing index.db | startup FATAL, actionable message; dsh-cc marks server `error`, session unaffected (deferred connect) |
| missing LanceDB | start degraded `semantic:index-missing` |
| key absent or empty-string | semantic skipped immediately; `semantic:no-api-key` on health + every answer |
| invalid key / rate limit / outage | `semantic:auth-failed` / `semantic:rate-limited` / `semantic:timeout` |
| indexes still loading at query time | `isError index:loading` (initialize already answered) |
| embed timeout (8 s, inside the total deadline) | normal result, local lanes only, `semantic:timeout` |
| 10 s total deadline (from request receipt; queue time counts) | local answer ready → normal (degraded) result; not ready → `isError deadline-exceeded`, never a hang (client tool timeout 60 s would lose even that) |
| cancellation | asyncio-layer stop + phase bounds; worker occupied till phase end; no hard preemption |
| reindex while resident | background reload, previous generation served; failure → `index:reload-failed` |
| server dies mid-session | client auto-reconnect 500 ms→30 s ×10 (verified), then dead until restart; P-B records the model-visible gap error |
| library writes to stdout | stdio framing broken — prevented by stderr-only logging + PR-A stdout-purity test |
| blank query | `isError invalid-query` |
| top-1 chunk alone > budget | returned truncated + `truncated:true`; never silent empty success |
| unsupported filter supplied | `isError unsupported-filter:<name>` |
| fetch outside corpus root | `isError` rejection (traversal/symlink/URL) |
| huge result sets | budgetTokens trims; `stats.truncated=true` |
| oversized fetch | maxFetchTokens cap + `truncated` + `continuation.offset` (char offset) |
| citation trust | cite `docId`; `revision` detects drift; `textKind` labels quotability |

## 9. Rollout slices

- **PR-A (llm-wiki repo)**: `wiki-tools mcp-serve` (--root required,
  deferred index load, single-flight search + queued health, concurrent
  local lanes, background index reload, corpus-root guard, bounded fetch,
  degradation ladder) + `mcp` extra + tests: schema conformance,
  degraded-flag matrix, fetch bounds + traversal rejection,
  **health-during-search latency bound**, **stdout purity (import +
  embed-error paths)**, config-fixture boot with no key (P-C shape) +
  README runbook (with resident-cost note).
- **PR-B (dsh-cc repo, docs-only)**: this protocol finalized under `docs/`,
  including the project-`.mcp.json` precedence / executable-content
  statement and an explicit DoD item: file the approval/allowlist backlog
  line. Capability-manifest impact: NONE — consuming an MCP server is an
  existing capability; `pnpm check:capabilities` confirms.
- No dsh-cc runtime code in the minimal loop.

## 10. DoD probes (acceptance)

- **P-A (instrumented latency)**: `mcp-serve` boots; `tools/list` shows
  `search`/`fetch`/`health`; phase timings logged (initialize-answer,
  index-load, embed, FTS, vector, graph, fusion, serialize); ≥20 DISTINCT
  queries, both valid-key and keyword+graph-only modes;
  first-query-after-boot separate; steady-state **local-lane p50 < 3 s** +
  p95; embed RTT reported separately; one forced-timeout query returns a
  normal degraded result at the deadline; **plus one queued not-ready case
  proving the `deadline-exceeded` branch** (with an 8 s embed cap inside a
  10 s deadline, the "embed still outstanding" case arises when queue time
  consumes the gap); health-during-search latency bound measured.
- **P-B (closed loop on THIS client)**: a dsh-cc session with the global
  `.mcp.json` entry mounts the server; the model sees `search`; one real
  query proves the model RECEIVES passage text **from the text block**
  (not assumed — observed), cites the matching `docId`, and a follow-up
  `fetch` retrieves that source. Checklist: unset-var expansion (`${VAR}`
  throws, `${VAR:-}` boots degraded); empty-string key = missing;
  invalid-key recovery; oversized fetch truncation + continuation;
  server-kill-mid-session → model-visible error during the reconnect gap
  and state after 10 attempts.
- **P-C (no silent zero)**: key absent → health `semantic:no-api-key`;
  search still returns keyword+graph with the degraded flag.

## 11. Open questions

- O4: hook-leg transport (attach to resident server via sidecar socket vs
  cold `mcp-call` — cold process reintroduces the 30 s problem) — parked
  for the auto-recall round, with per-prompt embedding egress noted.
- Scope questions intentionally left unresolved this round (not user
  decisions): recall-mode details; alignment with llm-wiki's draft
  control plane.
- Resolved: O1 fetch in-loop, bounded. O2 serve degraded (probe data). O3
  user-global config home recommended, with the project-precedence caveat
  stated.

## 12. Review ledger

Four rounds, three blind seats (critic on Opus; codex on gpt-6.1-sol;
grok on grok-4.6), all seats blind to each other. Findings degraded
architecture → client-mechanism → contract-text → wording across rounds.

- **r1 critic**: GO-WITH-CHANGES. F1 executor/concurrency → §5 (shape
  revised to single-flight); F2 instrumented DoD → §10; F3 empty-string
  key + expansion verification → §5/§7/P-B; F4 textKind → §4.1; F5 naming
  → §4.3 (superseded, see adjudication 2); F6 server-death → §8
  (RECONNECT_DEFAULTS verified — resolved); F7 resources/list ceiling +
  backlog line → §2/§7/§9; F8 O1/O2 resolved → §11.
- **r1 codex**: GO-WITH-CHANGES. X1 instrumented latency / no silent
  semantics-weakening → §1/§6/§10; X2 text-block evidence + absolute URI
  + fetch-as-read → §4.1/§4.3 (resource_link carrier superseded, see
  adjudication 1); X3 versioned schemas / bounds / filter errors / score
  semantics / identity / isError → §4.1/§4.2; X4 deadlines / retries /
  cancellation / concurrency / LanceDB policy / generation check /
  bounded fetch → §5/§8; X5 executable-config trust / global entry /
  corpus guard → §5/§7; X6 runbook correctness + P-B checks → §5/§10;
  X7/X8 → §5/§1.
- **r2 grok** ($0.54/25 turns): GO-WITH-CHANGES, 11B+7N, folded: G1
  text-block normative / omit outputSchema + resource_link → §4.3; G2
  plain tool names + open lane set → §4.1/§4.3; G3 push-down-only
  filters → §4.2/§5; G4 docId stable key + revision hash → §4.1; G5
  fetch grammar + char-offset continuation + chunk-id-selects-document →
  §4.1/§4.4; G6 snippet/summary mapping pin → §5; G7 `${VAR:-}`
  mandatory + whole-file skip + scrub strips KEY names → §7; G8
  project-file precedence + backlog DoD → §7/§9; G9 split latency gate /
  concurrent local lanes / deferred initialize / background reload →
  §5/§6/§10; G10 single-flight default + health-during-search test →
  §5/§9; G11 mandatory tool descriptions → §4.3; G12 stdout purity test
  → §5/§9; G13 no resources/prompts capabilities → §4.3; G14 reconnect
  defaults verified → §2/§8; G15 blank query / tokens estimation /
  oversized top-1 → §4.2; G16 --root required → §5; G17 egress
  disclosure + hook cold-process note → §6/§7; G18 resident-cost note →
  §5. (grok r1 interrupted by auth; re-authorized by user.)
- **r3 delta round** (all three seats, delta-only): codex
  GO-WITH-CHANGES (2B+1N), critic GO-WITH-CHANGES (1B), grok
  GO-WITH-CHANGES (1B+2N; deepest source pass incl. harness
  agent-loop/tool-calls.ts:277-281). Two independent double-hits (top
  confidence): codex D1 ≡ grok "continuation does not round-trip" →
  FetchRequest gains bounded `offset` + `ifRevision` guard (§4.1); codex
  D3 ≡ grok "pin fetch/health text-block layouts + revision on the
  search line" → §4.3. codex D2 deadline clock/semantics → §5/§8. critic
  F1 config self-consistency (`${LLM_WIKI_ROOT:-}`) → §7. grok anchor fix
  (mcp-client.spec.ts:511-537 is the schema-mismatch case) → §2. Both
  adjudications below ACCEPTED by codex and critic, each re-verified
  against source.
- **r4 convergence round**: all three seats zero blocking findings; three
  non-blocking nits folded (ifRevision error carries current revision →
  §4.1; queued not-ready deadline-exceeded case → §10 P-A; ENOENT
  spawn-failure note → §7).
- **Adjudications (cross-lane divergences)**:
  1. `resource_link` as citation carrier: codex r1 (spec-idiomatic: links
     + structured + text) vs grok r2 (client code: links render as
     `[resource: content discarded]`). Resolved FOR grok — mechanism claim
     with repo evidence beats spec idiom; codex's core requirement
     (evidence text must reach the model) is preserved and hardened as
     the normative text block; links return when the renderer preserves
     them.
  2. Tool naming: critic r1 (`wiki_*` prefix for collision safety) vs
     grok r2 (client already namespaces `mcp__<server>__<tool>`; baked
     prefixes overfit the generic profile). Resolved FOR grok — collision
     safety is delivered by client-side namespacing, which the critic
     fold predated knowing.
