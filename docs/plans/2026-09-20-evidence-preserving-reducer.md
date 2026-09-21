# Evidence-Preserving Reducer: cheap-lane receipts for noisy build/test output

Date: 2026-09-20. Status: **Implemented** — PR #91 (merged 2026-09-21); Phase 2 dogfooding is a follow-up. Review provenance: critic cold review passed with amendments (12 findings:
marker-contract violation fixed per §3.5, lane-inheritance gap closed via `onUnrouted: 'skip'`,
exit-consistency reduced to decidable rules, route-null escalation added, input-size cap
added; all baked in below). Implementation-gate re-review against HEAD a110b99 (same date):
GO-WITH-AMENDMENTS, findings F1-F8 baked in below.

Origin: borrowed from SoL-Pi (arXiv:2609.20519), whose Evidence-Preserving Reducer was one of
four mechanisms to survive a ~150-direction auto-research funnel. The paper's finding we are
importing: predefined noisy commands (build/test) produce the largest, lowest-density tool
outputs; a low-tier model can extract the decision-relevant evidence into a compact receipt,
and a **deterministic verifier** that checks schema, source hash, exit status, and exact
quotes makes the compression safe — any failure falls back to the original bytes. On both
GPT-5.6 Sol and Opus 5 the full stack retained 93.7–94.3% of the Pi capability score while
cutting token traffic 44.7–49.0%.

## 1. Problem

The context-crusher (PR #34) compresses search results and logs with deterministic,
no-model heuristics (`router.ts`), then externalizes oversized tool output into the ccr
store. Two gaps remain:

1. **Deterministic routing gives up on real build/test logs.** A failing `vitest run` log
   is mostly progress noise and stack frames; what the agent needs is the FAIL list, the
   assertion messages, and the exit status. Heuristic routing keeps head/tail and still
   wastes thousands of tokens; or yields less than `minSavingsRatio` (0.4) and passes the
   whole blob through; or returns `null` outright for logs that do not match its shape
   heuristics — often exactly the noisiest ones (heredoc-heavy, unusual reporters).
2. **No LLM lane exists in the compression stack.** The cheap-lane infrastructure
   (`ccModelRoutes.resolve('haiku')`, TUS side queries) is already deployed elsewhere in
   the repo but nothing applies it to tool *output* reduction.

The Reducer closes both gaps as an escalation stage inside the existing crusher pipeline:
deterministic route first, cheap-lane receipt second, original bytes last.

## 2. Ground facts (verified 2026-09-20 against this checkout; line anchors re-verified in review)

Harness-repo anchors are read-only per the harness-repo-readonly directive.

- Post-execute rewrite seam: `ctx.on('tools/post-execute', handler, { prepend: true })` in
  `packages/context/context-crusher/src/index.ts:116-136`; the handler awaits `next()`,
  skips non-`accept` decisions, and on any internal failure catches and returns the
  downstream decision unchanged — fail-soft is a hard invariant of this seam (a throw
  would turn a user tool result into an error and lose data).
- Passthrough gate list: `index.ts:155-176` (savings gate at :175, projectKey at :184) (`!cfg.enabled`, protected tools,
  self-retrieve, decision with `value`, no content blocks, non-text blocks, error results
  under `2*minBytes`, under `minBytes`, `route()` null, savings under `minSavingsRatio`,
  missing projectKey). **`minBytes` default 8192 is compared against the tokenMeter token
  estimate** (`config.ts:24`) despite the name — all sizing in this doc is in tokenMeter
  tokens.
- Deterministic compression: `route(text)` in `context-crusher/src/router.ts:134` — pure,
  no I/O; may return `null`.
- Store and marker: content-addressed store `<dshHome>/ccr/<projectKey>/<hash16>` with
  atomic temp+rename writes (`src/store.ts:60-75`; put at :60, temp/rename at :71-74). **`buildMarker` output is a PINNED
  CONTRACT** — exact grammar
  `^\[dsh-cc compressed (\d+)→(\d+) tokens\. Original: ccr:\/\/([0-9a-f]{16})\]$`
  (`src/marker.ts`, pinned by test). The microcompact substitution guard
  (`compaction-micro/src/index.ts:255`) calls `isCrusherStub` imported from
  tool-use-summary, which parses via its OWN mirrored grammar
  (`tool-use-summary/src/crusher-marker.ts`) — neither downstream consumer calls the
  crusher's `parseMarker` directly, but the verbatim `buildMarker(...)` line as the last
  line of the replacement body remains sufficient for both guards (framing.ts:36-39 tests
  any line, not only the last), so any replacement body MUST end
  with the verbatim `buildMarker(...)` line or downstream stub protection silently fails
  and a later pass would destroy the retrieve locator.
- Cheap-lane access: `runSideQuery(ctx, { alias, system, prompt, ... })`
  (`packages/compaction/tool-use-summary/src/index.ts:139`; implementation
  `packages/llm-tuning/side-query/src/index.ts:72`). **Default behavior inherits the caller's route when the
  alias is unrouted** — the known dsh-cc-shunt pitfall. The mitigation exists in the same
  API: `opts.onUnrouted: 'skip'` returns `{ ok: false, reason: 'unrouted' }` instead of
  inheriting, and successful results expose route provenance. Using the default here would
  bill every reducer attempt to the expensive parent route and break this feature's cost
  invariant, so §3.3 mandates `skip`.
- The CCR settings namespace is `cc-context-compression`
  (`packages/context/context-crusher/src/settings.ts:15`); every read goes through the live
  scope per the settings-ns idempotence rules.
- tokenMeter injection: `static inject = ['tokenMeter']` (`index.ts:89`); estimation via
  `ctx.tokenMeter.estimateMessage({ role: 'tool', content: [{ type: 'text', text }] })`
  (`index.ts:209-214`).
- Existing crusher dry-run returns **before** `store.put` — see §3.6 for the reducer's
  matching rule.
- Line numbers drift; implementation must re-verify anchors.

## 3. Design

### 3.1 Placement: a stage inside the crusher, not a new listener

One seam, one listener, one ordering to reason about. The escalation lives inside the
existing crush path in `packages/context/context-crusher` between the deterministic route
and the passthrough decision:

```
accept decision with text content
  → existing gates (index.ts:155-173, incl. minBytes floor — unchanged)
  → candidate = route(text)
      │ candidate && savings >= minSavingsRatio  → deterministic replacement (unchanged)
      │ (candidate === null || savings < minSavingsRatio)
      │   AND reducer-eligible (3.2)             → reducer attempt (3.3)
      │     │ receipt valid + smaller            → receipt replacement (3.4)
      │     │ any failure                        → ORIGINAL bytes passthrough
      │ else                                     → original passthrough (unchanged)
```

Only the middle branch is new. Notably the reducer also fires when `route()` returns
`null` — the noisiest real-world logs are exactly the ones shape heuristics miss. All
existing behaviors, thresholds, dry-run mode, and the ledger stay bit-identical when the
reducer is disabled.

### 3.2 Eligibility

A tool result is a reducer candidate only when all hold:

- `reducer-enabled` is true;
- the tool name is in the command surface (default `['bash']` — there is no runtime
  `shell` tool; runtime names per `packages/core/tools/src/cc-names.ts` HARNESS_TOOLS,
  where `Bash` is only the CC-facing alias);
- the **invocation command line** (from `exec.arguments` — `ToolExecutionInput.arguments:
  unknown`, `packages/core/tools/src/tool-types.ts:124`; the bash tool's argument key is
  `command`, read as `(exec.arguments as Record<string, unknown>).command` when it is a
  string) matches one of the configured command patterns (default set below);
- the result already passed the crusher's existing size gates (no separate reducer floor
  knob — the `minBytes`/`2*minBytes` gates in tokenMeter tokens apply, so the reducer only
  ever sees results the crusher itself considered big enough);
- the deterministic route declined (returned `null`) or its savings fell below
  `minSavingsRatio` (escalation, not replacement of the heuristic layer).

Default command patterns (regex, matched against the normalized command string):

```
pnpm .* (build|test|vitest|tsc|lint)   npm (run )?(build|test)   yarn (build|test)
npx (vitest|jest|tsc|eslint)           vitest|jest|mocha|pytest|go test|cargo test|make\b
```

(`make\b` also matches `cmake` — accepted as an eligibility-only over-trigger.)

File reads and search results never enter the reducer — the paper routes them around it,
and ccr already handles them deterministically. User-supplied patterns are compiled at
resolve time inside try/catch; an invalid pattern is dropped with a debug log (arbitrary
user regexes are never compiled per-result on the hot path, and no pattern may run against
more than the invocation line).

### 3.3 Receipt extraction (cheap lane)

One side query per candidate. `SideQueryOptions` provides alias, agent, system, prompt,
maxTokens, timeoutMs, onUnrouted, rejectToolCalls, signal
(`packages/llm-tuning/side-query/src/index.ts:26-59`); fail-mode and purpose labeling are
conventions this stage honors internally, not API options:

- lane: `runSideQuery(ctx, { alias: reducer-alias, onUnrouted: 'skip', ... })` —
  **mandatory `onUnrouted: 'skip'`** so an unconfigured `haiku` alias never bills the
  parent route; `unrouted` maps to a ledger row `applied:false, reason:'lane-missing'`
  (never an error). Lane-provenance rejection must cover TWO cases: (i) the result
  reports `inheritedRoute === true`; (ii) a model-only (string-form) alias hole —
  `toOneShotRoute` (`packages/compat/cc-model-aliases/src/agentOptions.ts:41-52`) fills a
  missing provider from the parent request header while side-query reports
  `inheritedRoute: false`. The implementation must additionally resolve the reducer alias
  and reject when the resolved route has no explicitly configured provider (ledger reason
  `lane-inherited`); even through the hole, spend stays model-bound to the cheap alias
  model.
- budget: `reducer-timeout-ms` default **10 000** (the post-execute waterfall blocks the
  agent loop for the duration; the latency budget is stated, not hidden), hard ceiling
  `reducer-max-tokens` default 1024 for receipt output.
- **input cap:** the source is first tokenMeter-estimated; if above
  `reducer-max-input-tokens` (default 30 000) the source is truncated to a head/tail view
  (first ~20% + last ~80% of lines; build/test failures concentrate at the tail). The
  extraction prompt receives only this view, and the verifier checks quotes against the
  same view — the two are trivially consistent. The full text still goes to the store.
- system prompt instructs: pure extraction, no inference, no advice; output strict JSON;
- output schema (the receipt):

```jsonc
{
  "v": 1,
  "cmd": "string, first line of the invocation",
  "exit": { "ok": true, "code": 0 },          // code only when the source states it (3.4.3)
  "failures": [                                // empty on success
    { "name": "test/file identifier", "evidence": "exact quote from the visible source" }
  ],
  "key_output": ["exact quote", "..."],        // ≤ 8 entries
  "counts": { "pass": 0, "fail": 0, "skip": 0 } // omitted when unknowable
}
```

Every `evidence`/`key_output` string must be a verbatim substring of the (possibly
truncated) source view.

### 3.4 Deterministic verifier (the mechanism that makes this safe)

Pure function `verifyReceipt(view, receipt, isError, estimate) -> { ok, reason? }` —
`isError` is the tool result's own error flag, passed in from the decision context; it is
the only exit signal we fully trust. `estimate: (text: string) => number` is injected
(token estimation needs the tokenMeter service, which would break the stated purity; the
call site binds `ctx.tokenMeter.estimateMessage`; Phase 0 tests inject a deterministic
stub). A receipt is rejected when any check fails:

1. **schema** — parse against the receipt shape with `@deepseek-ai/schemastery` (see
   `packages/context/context-crusher/src/config.ts:6`), not zod; schemastery `z.object`
   STRIPS unknown keys by default, so "unknown keys rejected" requires an explicit
   exact-key-set mechanism, pinned by a test.
2. **exact quotes** — every `evidence` and `key_output` string satisfies
   `view.includes(q)` after NFC normalization of both sides; quotes shorter than 8 chars
   rejected outright (stops vacuous matches like `"FAIL"`).
3. **exit consistency**, exactly two decidable rules:
   (a) `exit.ok === !isError` — disagreeing with the tool result rejects the receipt;
   (b) `exit.code` may be present **only** when the view's tail (last 64 lines) literally
   matches one of the enumerated patterns carrying that code —
   `/exit(?:ed with)? code (\d+)/i`, `/make.*Error (\d+)/` — and the captured number
   equals the claim; otherwise the field must be absent. A claimed-but-unverifiable code
   rejects the receipt.
4. **size gain** — `estimate(receipt text)` < `reducer-min-savings-ratio` (default 0.5) ×
   `estimate(source text)`. No gain, no receipt.
5. **count consistency** — when `counts` present, `fail` must equal `failures.length`.

On rejection the stage returns the **original text untouched** (not the deterministic
route output: when route produced a sub-threshold candidate we do not mix partial
compressions — one failure story per blob). The ledger records
`applied:false, reason:'verify:<check>'` for every rejection — rejection patterns are
instrumentation, not noise.

Type note: `LedgerRow.kind` is currently typed `'search' | 'log'`
(`packages/context/context-crusher/src/types.ts:50`) and rows carry no `reason` field;
the reducer extends the type additively with `kind: 'receipt'` plus a `reason` field
(values like `verify:<check>`, `lane-missing`, `lane-inherited`). savings.jsonl is
append-only with no in-repo consumer; extend, never overload the existing kinds.

### 3.5 Replacement body and downstream interplay

The replacement content is the receipt body plus the **verbatim pinned marker line** — no
custom trailer:

```
<canonical receipt rendering, few lines>
[dsh-cc compressed 12480→310 tokens. Original: ccr://9f2c1ab44d01e7aa]
```

(the second line is `buildMarker(tokensBefore, tokensAfter, hash)` output, unchanged.)

- The original bytes go through the existing `CrusherStore.put` path unchanged, so
  `context_retrieve` restores the full log; evidence is preserved by construction.
- Because the trailer is the pinned marker contract (§2), `parseMarker` — and therefore
  both `isCrusherStub` and the microcompact substitution guard — recognize the receipt
  with **zero changes** to TUS or microcompact. A property test pins the round-trip:
  `parseMarker(trailingLine(receiptBody))` succeeds and recovers the hash.
- Deferred externalization (2026-09-20-ccr-deferred-externalization.md) never re-defers a
  receipt: receipts are already compressed, and the deferral gate checks savings against
  the original.

### 3.6 Config (all under the existing `cc-context-compression` section)

| key | default | note |
|---|---|---|
| `reducer-enabled` | `false` | feature flag; ship dark |
| `reducer-commands` | (3.2 default set) | regexes, validated at resolve time |
| `reducer-max-input-tokens` | `30_000` | head/tail truncation threshold, §3.3 |
| `reducer-min-savings-ratio` | `0.5` | verifier check 4 |
| `reducer-max-tokens` | `1024` | side-query output cap |
| `reducer-timeout-ms` | `10_000` | hard timeout; waterfall latency budget |
| `reducer-alias` | `'haiku'` | lane alias (with mandatory `onUnrouted: 'skip'`) |

Overlay semantics follow the existing REPLACE convention (`config.ts:73-85`). Dry-run mode
covers the reducer: receipts are produced and verified (the whole point of dry-run is
measuring the lane), but **no `store.put` and no substitution happen** — matching the
existing dry-run ordering — and ledger rows carry `applied:false`.

### 3.7 Side-query safety red lines (carried over from the memory-recall incident)

- The extraction prompt never embeds the user's task or any conversation history — only
  the single tool output being reduced.
- The side query is `llm.stream`-class (TUS precedent), not a fork: no tools, no seeds.
- Fail-mode is declared `passthrough`: timeout, malformed JSON, unrouted lane, lane error,
  and abort all return the original bytes and record the reason.

## 4. Phases

- **Phase 0 — verifier + golden fixtures (no model).** `receipt.ts` (schema),
  `verifier.ts` (pure), fixtures from this repo's real failing `vitest` output: receipt by
  hand, assert the verifier accepts it and rejects perturbed variants (quote not in view,
  quote shortened under 8 chars, vacuous match, `exit.ok` disagreeing with `isError`,
  unverifiable `exit.code`, missing size gain, `counts.fail ≠ failures.length`); property
  test pinning the receipt trailer through `parseMarker`.
- **Phase 1 — lane + integration.** Side-query wiring with `onUnrouted: 'skip'`, input
  truncation, ledger columns, dry-run default; composition spec through
  `mountAgentLoopTestDependencies` with a ReplayAdapter serving a scripted receipt (TUS
  `producer.spec.ts` assembly pattern: fake `ccModelRoutes`, fake settings scope).
  Explicit tests: unrouted-alias path ledgered `lane-missing` with no model call;
  oversized source degrades through truncation and still verifies; marker round-trip;
  a composition test pinning that a real bash tool execution surfaces its command line
  under `exec.arguments.command` (the eligibility input source); the manifest/parity
  obligation — amend the `engine.context-compression` entry in
  docs/claude-code-capabilities.yaml (currently :227-245) to describe the reducer stage
  and the new `reducer-*` keys, regenerate with `pnpm docs:parity`, and commit the
  regenerated docs in the same commit (house rule per AGENTS.md;
  check:capabilities/check:parity run in pre-commit/presubmit).
- **Phase 2 — dogfood.** Enable for this repo's own test/build commands on one worktree
  for a week; read the ledger: trigger rate, verify-failure rate by check, median savings
  ratio, side-query latency percentiles (the 10 s waterfall budget must hold in
  practice). Gate for leaving dry-run: verify-failure < 2%, median savings ratio ≥ 0.6,
  p95 side-query latency < timeout.

## 5. Verification

- **Unit (from repo root, `node_modules/.bin/vitest run packages/context/context-crusher` —
  package-cwd vitest is a false green):** verifier property tests as enumerated in Phase 0,
  eligibility matrix incl. the route-null branch, REPLACE-overlay on the new keys, invalid-
  regex drop behavior.
- **Composition:** real preset + MockAdapter main loop + ReplayAdapter cheap lane; assert a
  failing-test log becomes a receipt + pinned marker, the store holds the original, and
  `context_retrieve` round-trips bytes; assert downstream TUS/microcompact treat the
  receipt as a stub (no double compression).
- **Observable behavior claim for the commit message:** with `reducer-enabled` on, a
  failing `vitest run` whose log passes the crusher's size gates is shown to the model as a
  receipt of failing tests + verbatim evidence, and the full log stays retrievable; when
  the cheap lane is unrouted the feature is byte-identical to off.

File-size house rule: 500-line hard cap per non-test .ts file
(scripts/check-file-size.mjs; the baseline file currently lists zero baselined files and
must stay that way). index.ts is at 273 lines (227 headroom); eligibility + escalation +
dry-run edits are expected at roughly +100-160 lines, so if index.ts approaches the cap
the reducer stage logic must live in its own module (e.g. reducer.ts, alongside the
planned receipt.ts/verifier.ts) — never ratchet the baseline.

## 6. Risks and explicit non-goals

- **Sequencing with deferred externalization.**
  docs/plans/2026-09-20-ccr-deferred-externalization.md references this plan and edits
  the same index.ts insertion path (:189, :242 in that doc); land the reducer first, or
  rebase the externalization doc's anchors after whichever lands second.

- **Cheap-lane quality variance.** The verifier bounds the blast radius to "wasted side
  query, original bytes shown" — the verifier's failure costs a bounded side query, never
  correctness. With `onUnrouted: 'skip'` the failure mode is *no* spend, not parent-route
  spend.
- **Quote brittleness across locales.** Normalization is NFC-only; no case folding, no
  whitespace collapse (any fuzziness recreates the misinformation risk).
- **Route-null escalation raises trigger volume.** Mitigated by the same verifier and the
  savings gate — nothing leaves the pipeline smaller-but-wrong; Phase 2 reports the
  incremental trigger rate separately.
- **Not a summarizer.** The receipt never paraphrases, diagnoses, or suggests fixes; the
  agent keeps full diagnostic responsibility (the paper's division of labor, and the only
  stance compatible with exact-quote verification).
- Non-goal: applying the reducer to file reads, search results, or MCP outputs.
- Non-goal: changing the deterministic router thresholds.

## 7. Review outcomes and residual risks

Critic cold review (2026-09-20): GO-WITH-AMENDMENTS, 12 findings; all blocking/major baked
in above:

1. [blocking→fixed §3.5] Custom trailer violated the pinned marker contract and would have
   defeated microcompact/TUS stub protection — now the verbatim `buildMarker(...)` line,
   pinned by a round-trip property test.
2. [major→fixed §3.3] Unrouted alias would silently bill the parent route — now
   `onUnrouted: 'skip'` plus inherited-route rejection, ledgered `lane-missing`.
3. [major→fixed §3.4] Exit-consistency was unimplementable — now two decidable rules over
   `isError` and an enumerated tail-regex set.
4. [major→fixed §3.2] 4 KiB floor was unreachable below the crusher's `minBytes` gate —
   reducer floor knob removed; the existing gates (in tokenMeter tokens) apply.
5. [major→fixed §3.1] Route-null candidates never reached the reducer — escalation branch
   now covers both decline modes.
6. [major→fixed §3.3] Unbounded side-query input — head/tail truncation with
   verifier-on-the-same-view consistency.
7-12. [minor→fixed] 10 s waterfall latency budget stated, resolve-time regex validation,
   dry-run store.put exclusion, lane-unrouted/oversize/marker-round-trip tests added to
   §4-§5.

Residual risk handed to the executor: the enumerated exit-code regexes (§3.4.3b) start
conservative on purpose; extend only with a fixture proving the new pattern appears in
real tool output.
