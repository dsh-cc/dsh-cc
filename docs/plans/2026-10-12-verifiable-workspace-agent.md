# Verifiable Workspace Agent (VWA): deliverables with machine-checkable evidence receipts (design)

- Date: 2026-10-12
- Status: draft v4; three-seat blind review converged (internal critic GO, Codex GO, Grok GO). User sign-off pending. NOT yet implemented.
- Scope legend: `H/` prefixes paths in the sibling harness repo (`deepseek-harness`, pin 0.2.0-rc.2); unprefixed paths live in this repo. Harness packages are vendored inside this repo with different line numbers, so every anchor states its repo.

## 0. Decisions

| # | Decision | Status | Source |
|---|---|---|---|
| D1 | First lane = technical documentation writing | Decided 2026-10-10 | user pick |
| D2 | Carrier = new preset `vwa`, entered explicitly via `/preset` command | Decided 2026-10-12 | user instruction, verbatim "显式进入，走B，用/preset" (opt for explicit entry + new preset + /preset) |
| D3 | Artifact language self-declared (`lang:` frontmatter or per-turn instruction; ask when undeclared; run the declared primary language's ruleset for mixed docs) | Provisional | orchestrator + two review seats |
| D4 | Disposition of the incubation-repo science designs (dsh-incubation-plugins `docs/design/` items 14-23) | Deferred to lane-2 planning | orchestrator |

Honest log: the orchestrator initially recommended staying inside the existing cc preset (no second preset), on two grounds that were overturned by the user's pointer to the upstream repo. First, "a second preset doubles an 850-line composition": this repo's `preset/cc/agent.cordis.yml` is a 0.1.x-era monolith, while upstream `H/packages/bundle/web-app/presets/` carries `standard` (146 lines, 33 ids), `ptc` (152, 34), and `minimal` (61, 8) as coexisting presets. Second, "a new preset forces a new profile": the registry natively hosts multiple presets in one profile with per-session selection (`selectedDefault`) and resume re-mount from the session projection; only the selection UX is missing.

## 1. Position and thesis

dsh-cc today is a coding agent. VWA turns it into a verifiable workspace agent: every deliverable that leaves the workspace (code, technical docs, research summaries and papers, planning reports) ships with a machine-checkable evidence receipt.

Verifier strength ladder (descending): formal checker > executable machine check > learned judge > self-report. VWA defaults to the middle two. The formal tier is out of scope (no feasible basis for free text), but its "machine-checkable closing statement" shape is borrowed.

Two industry convergences make this a port, not an invention:

- Deterministic citation mapping. Anthropic's Citations API maps claims to source spans with cited_text plus character/page ranges (source hallucination 10% to 0% in the reported evaluation). Automatic evaluation families exist: ALCE (citation recall and precision), SAFE (per-fact search verification with F1@K to resist "say less, win precision" gaming), FActScore (atomic-fact decomposition).
- Deliverable receipts. This repo already landed runtime-verified completion (#217), verify-before-retry (#215), config snapshot (#218), and progress-rebuild (#216). That is a receipt culture for code deliverables; VWA extends it to documents and reports.

## 2. Architecture: three layers

1. Carrier layer: preset `vwa` (a second registry definition) plus the `/preset` command (selection UX).
2. Evidence substrate (preset-agnostic packages mountable by either preset): receipt schema and writer, claim-to-source mapping, document gates, provenance hash chain, evaluation harness.
3. Lanes: tech docs (first) → research writing → data-center planning. A lane is a combination of skills and gate configuration; no new subagent types (standing decision from the data-analysis skill work).

## 3. Carrier layer

### 3.1 preset/vwa composition

Mechanism baseline (corrected in review):

- Include rows are legal inside a preset's `plugins` list (element type `Omit<EntryOptions,'id'|'disabled'>` with optional id/disabled; `H/packages/preset/agent-preset-registry/src/definition.ts:5-10`, the plugins type sits on line 10).
- Same-id rows in a preset's plugins list do NOT throw. `EntryGroup.update` collapses duplicates via `Object.fromEntries` last-wins (`H/vendor/loader/src/config/group.ts:51-53`; `EntryTree.update` has no check either). An earlier scaffold claim of a thrown `duplicate loader entry id` was refuted in review: restated ids are silently swallowed. Hard rule for patches: a new row must never restate an existing id; in `packages/bundle/cc-tui/cordis.patch.yml` the registry rows (:94-98) and the preset-cc row (:99-110, path line :110) stay verbatim, and exactly one preset-vwa row is appended after preset-cc.
- Persona exception: a second persona row in the same scope fails section registration with `already registered in this scope` (`H/packages/core/system-prompt/src/index.ts:379-385`, confirmed by the probe's positive control). The shared body must therefore carry no persona.

Final shape (all three YAML files in one directory, `packages/preset/cc/`):

- `agent.shared.cordis.yml`: everything in the current `agent.cordis.yml` except the persona row (`:36-41`).
- `agent.cordis.yml` becomes a thin wrapper: `- id: cc-shared` include `./agent.shared.cordis.yml`, plus the persona row, plus the command-preset row (double-write, see 3.2).
- `agent.vwa.cordis.yml`: `- id: vwa-shared` include `./agent.shared.cordis.yml`, plus its own persona row (writing/research identity prefix; `{{model}}` and `{{cwd}}` template variables are legal), plus vwa-* feature rows, plus its own command-preset row.
- The composition files do NOT live in a new package (cross-package nested include paths were not probed and the probe's first run proved they misresolve). vwa-specific code (persona text, tests) may sit in a new `packages/preset/vwa/` package, but the YAML stays in the cc package directory.
- The cc-tui patch appends only: `- id: preset-vwa, name: '@deepseek-ai/dsh-agent-preset', config: {id: vwa, name: 'VWA mode', description: <one sentence>, order: <fixed integer>, plugins: [{id: vwa-composition, name: '@deepseek-ai/cordis-plugin-include', config: {path: node_modules/@dsh-cc/preset-cc/agent.vwa.cordis.yml}}]}`. `order` gets a concrete integer; name/description have a single source (this config), pinned by the composition spec.
- Registry lifecycle semantics (pinned in an earlier three-seat review of related work): mount ≠ select (mount binds the blank generation without writing an event; select appends `agent-preset/selected`), select is locked at turn boundaries (`agent-preset/locked` when a turn is open or any turn exists), resume re-mounts the recorded id via the registry projection, a recorded id missing from the roster yields `agent-preset/not-found`.
- Two composition constraints: the `system-prompt` row lives in the upstream base bundle (`H/packages/bundle/base/cordis.patch.yml:504-505`) and must never be disabled (persona has `inject=['systemPrompt']`; disabling starves the service and boot fails). The harness system-prompt plugin unconditionally registers the global `deployment:persona-prefix` section (`H/packages/core/system-prompt/src/index.ts:432-436`); a preset persona row is a scope-local shadow of it.
- Probe fact (load-bearing, 2026-10-12 live run): two presets in one profile, each including the same shared file plus its own persona row, both select cleanly; the positive control (a second persona row inside one tree) fails with the section error and the other preset stays clean. Probe artifacts live in the review ledger's session records; the rig is described in 3.1-b below.
- Probe mechanics implementers must know: (a) a nested include's `config.path` resolves relative to the including file's directory, so with all three files co-located the inner path is `./agent.shared.cordis.yml`; writing the production-style `node_modules/...` path doubles the prefix and fails (probe run 1). (b) Boot with stderr grep cannot verify preset composition: in a non-TUI floor a preset declaration does not activate (a bogus row inside a preset file is silent, the same row at bundle-patch level alarms loudly). Composition assertions need an agent mount, for example a joiner listening on `agent/created` and calling `agentPresets.select(agent, id)`.
- Composition-test and publish mechanics: `packages/preset/cc/package.json` `files` (currently four entries) gains `agent.shared.cordis.yml` and `agent.vwa.cordis.yml`. `packages/preset/cc/tests/composition.spec.ts` changes to expand the include closure of the three files into one row list and assert the cc surface is unchanged (existing BASE_IDS top-level assertions at :18/:163 and the `# END dsh-cc header` ... `# ── cc rows ──` drift segment at :599-600 migrate to the shared file's corresponding segment; the `order` pins at :731/:741 extend to the vwa row's order).

### 3.2 The `/preset` command (new package `interaction/command-preset`)

Template: `interaction/command-permissions`.

- Registration: `ctx.commands.register(helpable({name:'preset', description, input:{hint:'[id]'}, handler}, …))`; `inject=['commands']`.
- TUI: zero changes. The commands service merges into the catalog and refreshes on `commands/change`, so the command appears and tab-completes automatically.
- Bare invocation lists presets: no stock list component exists (repo search); the command returns presentation text naming each preset's id, name, order, description, and the current default.
- Mount point, final: the command-preset row is double-written into both `packages/preset/cc/agent.cordis.yml` and `agent.vwa.cordis.yml` (not into shared). This is a design choice, not a mechanism requirement: it keeps the existing capability gates passing with zero validator changes and gives vwa its own row so it can switch back. Codex's alternative (single row in shared) was overruled because the current literal contains check reads only the cc file, so shared placement would have forced a validator change for the command row alone.
- Capability manifest, final: (a) vwa-exclusive capabilities (rows that only exist in `agent.vwa.cordis.yml`) do NOT go into the manifest. The manifest is the CC-parity ledger and vwa has no CC counterpart; a note goes into the manifest README. (b) `/preset` gets an entry shaped like `commands.auto-mode`, evidence anchor `- id: command-preset` inside the cc file, passing I4 (`scripts/lib/capability-manifest.mjs:191-194` requires evidence path == `packages/preset/cc/agent.cordis.yml`) and I10 (:145; the literal anchor substring occurs in that file). (c) Existing anchors displaced by the shared split: extend the validator minimally so the text I10 reads is the include-closure expansion of PRESET_YML (only files explicitly referenced by its include rows, nested; no `preset/*` wildcard); the evidence path stays PRESET_YML and I4 is untouched. The composition spec expands the same closure as its regression pin.
- Settings namespace: new `vwa-preset` (schema-first via `registerNamespaceSafe`, absence-preserving idiom: `packages/settings/settings-cascade/src/auto-mode.ts:144,179,194-196`), key `selectedDefault`. We do NOT borrow `agent-preset-registry`: in this host nothing registers that namespace, the settings-provider's `configure` compatibility facade is a deliberate general no-op (its comment lists `agent-preset-registry` among the boot callers), and `update` on an unregistered namespace throws `settings namespace "…" is not registered` (`packages/settings/settings-provider/src/provider.ts:382`). The upstream `writeDefaultPreset` (`H/packages/client/ui-agent-preset/src/client/settings-store.ts:32`) is a client-plane `ctx.remote` API that agent-plane commands cannot reach; this was one of the review-adopted overrules.
- `/preset <id>` transaction order (pinned): (1) validate id against `registry.list()`, on failure report and list valid ids; (2) for a zero-turn session, try `agentPresets.select(agent, id)` first: `agent-preset/locked` downgrades to "change default only", not an error; (3) write `vwa-preset.selectedDefault` via the settings-provider update semantics; on failure, report the manual-fallback guidance and mark hot activation as NOT achieved; (4) inject the announcement (`source.kind='command-preset'`) strictly after the successful action, with two texts for "switched in this session" and "applies to new sessions". The partial-success tri-state texts are pinned in the implementation comments.
- New-package registration checklist: rows in both preset files; `package.json` (harness peers as peerDependencies, no `link:` in dependencies, exports/files whitelist); `tsconfig.base.json` paths; `tsconfig.packages.json` references; project reference in consumers' tsconfig; manifest entry; bilingual README trio; regenerate parity docs.

### 3.3 New-session resolution and hot activation

Current state (all verified): cc-tui patch `:117` pins `agentPreset: cc` (overrides every fallback); `packages/ui/tui/src/harness/driver.ts:96-119` computes the composition once at driver init and both create and resume closures reuse it; `preset.ts:10` `DEFAULT_PRESET = 'cc'` (default argument of composePreset, currently unconsumed).

- Resolution refactor: a single function `resolvePresetId` shared by create and resume (merged fix from two seats). Chain: resume → `stateOf(session, 'agentPreset')` from the session projection (first argument is the session object); fresh create → `vwa-preset.selectedDefault` (this repo's persisted selection) → `config.agentPreset` (deployment default, stays configurable) → `'cc'`. Recompose only when the resolved id differs from the cached composition's id.
- Timing pin for resume: `stateOf` is only callable inside setup after the transcript persistence load completes (registry session.ts precedent), so resume-side resolution runs at setup, before mount.
- Pre-existing gap this fixes (a real bug in a multi-preset world): resume currently re-mounts the boot preset. With the refactor, a recorded id missing or invalid (`agent-preset/not-found`) keeps the resume target and reports loudly instead of falling through to the "create a new session" path (today `driver.ts:144-155` turns any resume error into a fresh session). Transcripts without a recorded preset (legacy) resolve through the same create-side chain.
- Hot activation: the settings hot-reload chain exists (#127 publish → commit → onChange), so a written `vwa-preset.selectedDefault` takes effect on the next create/resume with no TUI reload. The upstream volatile bridge (`registry defaultId = selectedDefault.get() ?? config.default`) is NOT a P1 fact source; revisit if the bridge lands.

## 4. Evidence substrate

### 4.1 Receipt schema and write contract

Ledger `$DSH_HOME/vwa-receipts/<encodeSegment(sessionId)>.jsonl`. `encodeSegment` is copied (about 16 lines) from `packages/observability/config-snapshot/src/encode.ts:25` into the package (deep-importing it would trip `check:deep-imports`; config-snapshot itself copied it). Writes use sidecar-io `appendJsonl(file, row, {repairTail: true})` (swallows errors, tolerates torn tails); reads use `readJsonl` (skips any unparseable line).

Versioned row (v:1, all required except where marked optional):

```
{v:1, ts, sessionId, artifactId, artifactPath, artifactHash,
 claims:[{span:[s,e], text, status, sourceId?, sourceSpan?}],
 numbers:[{span, ref, paramsHash, rowCount, caliber, crossCheck?}],
 gates:[{gate:'link'|'style'|'exec', status:'pass'|'fail'|'abstained'|'missing', detail?}],
 provenance:{inputs:[{sourceId, revisionHash}], parentHash},
 overall:'pass'|'fail'|'abstained', nudge:{round:number}  // 0 = no nudge fired
}
```

- span unit: UTF-16 code-unit index (pinned). `claim.text` duplicates the first 200 chars of the source text. `claim.status` ∈ marked-ok | unmarked | invalid-marker | out-of-bounds.
- `artifactHash` = SHA-256 of the artifact's UTF-8 bytes. Same path with changed content makes the old receipt stale (evaluation and acceptance only trust an artifactHash matching the current file).
- overall = fail when any gate fails or any claim is out-of-bounds; abstained when no claims are detected and no gate fails; else pass.
- Canonical serialization = stable-key JSON (ordering pinned by package tests); single-writer serial append; write-then-read-back (the last line must parse and match artifactHash before "receipt present" is claimable, because append swallows errors); restart chain head = the last row with a complete parentHash chain.
- Nudge budget projection counts rows in this session's ledger with `nudge.round > 0` (restart recovery reads this field, see 4.5).
- Sole writer: the vwa-evidence turn-stopping evaluator (4.5): extract → gates → coverage → append → maybe sync nudge. Nothing else writes the ledger.

### 4.2 Claim-to-source mapping and deterministic verification

- Marker syntax: `〔src:<sourceId>#L<a>-L<b>〕` (full-width brackets; recognized only in prose, never in code spans or fences). v1 sourceId vocabulary: `ws:<posix path relative to workspace root>` only. External material has no legal marker in v1: snapshot it into the workspace as a `ws:` resource first, otherwise the claim counts as unmarked. Multiple sources join with `;`.
- Corpus whitelist (frozen): `docs/**` ∪ `**/*.md` ∪ `**/*.mdx` under realpath(workspace). A marker whose realpath escapes the workspace is out-of-bounds.
- Deterministic extraction: a markdown AST (a small dependency chosen at implementation time; this repo currently has none, so the new dependency follows the allowBuilds declaration discipline). Frozen claim-detection family of exactly four regex groups (the precise patterns are pinned in package tests): numbers with units/percentages; ISO dates; version strings (`v?\d+\.\d+` shape); API/identifier shapes (`xx()`, CamelCase, CONST_CASE, quoted config keys). Entity names are OUT of the verifiable-claim definition (no deterministic criterion).
- Sentence boundaries: newline and `.!?`。！？; span = UTF-16 index; a document with no detected claims evaluates as abstained; malformed markers count as unmarked.
- Read-back verification (mechanical): a marker is marked-ok when its sourceId is inside the whitelist, the file exists, and the line range exists. Semantic consistency checking belongs to the judge tier and does not enter the mechanical score (4.4).
- llm-wiki backend: optional enhancement, not a first-release dependency (its server is not built and its index.db is gone). It does not gate first-release acceptance.

### 4.3 Document gates (collected into vwa-evidence, not post-edit-verify)

Two seats independently hit this: post-edit-verify's matcher is first-match (`rules.ts:54-64`) so gates B and C would deadlock behind overlapping globs, the runner passes no edited-file path to the command (`runner.ts:104`), and failures only debug-log with no visible text (`:117-131`). We do not extend that package (it is CC-parity-adjacent). Both seats' alternative remedy (a single wrapper-script rule) is superseded by this form: gate implementations live in vwa-evidence and run at turn-stopping evaluation.

- Artifact set: files hit by editing tools inside the turn window (4.5) → realpath-dedup → whitelist glob (4.2) → exists inside the workspace.
- Gate A links/paths: relative links, anchors, in-repo paths exist (linkcheck semantics; pure in-repo file checks, zero external dependencies).
- Gate B style: fixed `abstained` at P2. No runnable ruleset exists in this repo (neither English vale-class rules nor a Chinese de-AI ruleset); the interface is reserved and only enters the "three gates pass" predicate after D3 language declaration lands with rulesets in-repo.
- Gate C executability: frozen fenced-block language table: bash: dry-parse; ts/js: `tsc --noEmit` class; anything else: abstained with detail. Execution surface is the harness ShellExecutor (`ctx.shell`, same seam post-edit-verify injects).
- Aggregation: per-gate timeout (default 30s, configurable) → that gate abstained (never silent); any fail ⇒ overall fail; `missing` means the gate did not run (detail required). Structured results go only into the receipt's `gates[]`; the session-visible surface is the sync nudge (4.5), not a tool-result text block (that is a different seam level).

### 4.4 Judge tier and settings shape

- SAFE-style per-fact sampled verification: NOT wired at P2. The interface contract (package, function, inputs, outputs) is specified in a later design first; no unverifiable promises in the first release.
- Settings: schema-first (skill-usage shape: `registerNamespaceSafe` + absence-preserving union) plus per-event hot-read (completion-gate's dual pattern). Namespace `vwa-evidence`. Default ON, mounted only in preset vwa (the cc preset lacks the row, so cc sessions stay untouched; `enabled:false` is only an off valve inside vwa). `nudge-budget` default 4.

### 4.5 The vwa-evidence package and the turn-end contract

New package `interaction/vwa-evidence`, mounted only in `agent.vwa.cordis.yml`, absent from the capability manifest (4.2 ruling). It borrows three shapes from completion-gate: the turn-stopping evaluation pipeline, the receipt jsonl habit, and evaluate-time settings hot-read. Anchor correction (from review): "no extension point" refers to claims.json's static table plus evaluate.ts's pipeline.

Pinned contract:

- Timing: evaluate when `agent/turn-stopping` dispatches (dispatched only when inbox.nextStep is empty, `H/packages/core/agent-loop/src/agent.ts:359-360`).
- Window anchoring (never by turn boundary): from the turn's last genuine user/message (source.kind = 'user' whitelist) through the assistant/message with `data.turn === payload.turn`. Reason: turn/start precedes the turn's own user/message (`H/.../agent.ts:305` vs `:419-422`), so turn boundaries would wrap the previous turn's events (a past blocker of the same class). completion-gate's evaluate.ts:98-105 holds the existing turn-guard precedent.
- Artifact set: as defined in 4.3.
- Pipeline: extract (4.2) → three gates (4.3) → coverage and overall → append receipt (write-then-read-back, 4.1).
- Nudge trigger: overall ≠ pass (any gate fail or out-of-bounds claim) OR (overall = pass ∧ coverage < threshold). Response: synchronous inject nudge (same-turn continuation; the sync-inject precedent is completion-gate's evaluate.ts:222-230) asking the model to self-repair once. Limits: per artifact per turn ≤ 1, per turn ≤ 2, per session `nudge-budget` (default 4). Re-evaluate once after self-repair; if it still does not verify, the receipt records overall = fail/abstained and the in-text abstain note stands. Gates v1 do NOT block delivery (observe + receipt + nudge only); "failing and handing to the user" is a valid delivery whose receipt is non-pass.
- Abort/error turns: the window guard prevents substituting an older turn's tail message; on abort during evaluation, discard the round without writing a receipt.
- Restart recovery: pending = paths replayed as "hit by EDITING_TOOLS with no receipt row matching their current artifactHash"; consumed nudge budget is recovered from the ledger projection (`nudge.round > 0` rows), so a restart does not reset the budget.
- Time correlation: mirrors config-snapshot v7's identity triple `(file, seq)` / `bootId` / `appendedAt` and the "largest appendedAt ≤ event time" selection rule, written into the package's implementation notes (not deferred to an external ledger).

## 5. Lane 1: technical documentation (first lane)

Artifacts: READMEs, design docs, tutorials, runbooks. Language per D3: self-declared (`lang:` frontmatter or per-turn instruction; ask when undeclared; for mixed documents run the declared primary language's gate rules).

Pipeline: clarify under-specifications → draft (baseline = Diátaxis four-layer + Google developer documentation style + controlled language; llms.txt as optional publication form) → turn-stopping gates (4.2 extraction + 4.3 gates) → receipt (4.1) → one backfill round on trigger → delivery.

Delivery state machine: draft → verified → delivered. verified = no gate fail ∧ overall = pass ∧ coverage ≥ threshold (all three at once); any edit flips artifactHash and returns to draft. delivered = verified ∧ the user actually received the artifact and its receipt digest. An artifact that does not verify may still be delivered but lands in `delivered-unverified` (including the "overall pass but below coverage threshold" case; the delivery note points at the receipt; this state is not verified and does not count as acceptance).

DoD (P2 acceptance, predicate identical to section 8): driver = a real README update in this repo for some package; observable = (1) receipt row present (passed write-then-read-back), (2) all three gate statuses populated in `gates[]`, (3) nudge behavior within budgets; pass = overall = pass ∧ zero out-of-bounds ∧ coverage ≥ 0.9. Human spot-check listed separately: sample = the latest 20 receipt claims, criterion = "the cited span supports the claim" (binary), final judge = the user.

DoD six cases, each with driver and pass:

1. Stale receipt: driver = edit one byte after verified; pass = re-evaluation produces a new receipt whose artifactHash matches, and the old row reads stale by hash.
2. Missing gate: driver = make gate C's runner unavailable; pass = `gates[exec].status = 'missing'` with detail, overall ≠ pass.
3. Out-of-bounds: driver = artifact contains `〔src:ws:../x.md#L1-L2〕`; pass = that claim's status = out-of-bounds and overall = fail.
4. Abort turn: driver = abort immediately after editing the doc; pass = no receipt written this round and the path enters the pending set.
5. Sync nudge: driver = first-round below-coverage artifact; pass = a nudge arrives in the same turn's continuation, the model backfills, and the second receipt is appended.
6. Restart recovery: driver = kill the process after a receipt lands; pass = pending set recovers by projection, last-line read-back matches, nudge budget recovers from `nudge.round`.

Standing evidence gap: official "LLM-assisted tech writing" best-practice literature is thin (recon note), while the docs-as-code gate side is the thick consensus.

## 6. Lane 2: research summaries and papers

Principle: evidence-first. Write around evidence (ScholarQA: quote extraction → outline → per-section attribution); post-write attribution backfill in the shape of a citation agent.

Citation gate: three layers (link resolves / content relevant / support holds). Form: port of incubation design 20; pointers (per review): dsh-incubation-plugins `docs/design/` items 15 literature-evidence, 17 run-provenance, 19 evidence-registry, 20 citation-verify.

Humility bounds (negative evidence pinned): AI Scientist v1 carried citation errors caught by human spot-checks, and v2 was voluntarily retracted per protocol after passing a workshop bar; Google's co-scientist lists factuality checking as an open improvement. Therefore the output is positioned as "reviewable draft plus machine receipt" (the Agent Laboratory posture), human sign-off is the default gate, and AI self-checks (SAFE sampling + critic cold review) only reduce risk. No automatic reviewer-scored publication loop.

Sign-off state machine: draft → reviewed (AI self-check and sampling complete) → signed; the signer is the user, and signing records `{artifactHash, signer, ts}` into receipt provenance. Any post-signing edit returns to draft.

Lane classification: a directional spec in this document. Before implementation, a dedicated design doc must fill the behavioral contract and DoD trio; D4 is one of its prerequisites.

## 7. Lane 3: data-center planning from data analysis

Artifact: an eight-chapter planning report (baseline → current four-dimension inventory (power/cooling/racks/network) → demand forecast → capacity plan (Tier redundancy / liquid cooling / PUE targets) → reference design → milestones → risk and compliance → cost), compiled from public planning-file samples (see recon note).

Data side: numeric receipts per the shipped data-analysis skill discipline (section 4.1 `numbers[]`).

Method corpus (bounded; snapshot into the workspace as `ws:` resources before citation): density and cooling baselines (Uptime Institute surveys, ASHRAE TC 9.9, OCP ORv3, Uptime Tier I-IV, industry PUE averages); methodology (APC/Schneider WP155 density-band planning, Schneider AI cluster eGuide, Vertiv × NVIDIA GB200 blueprint); slack-budgeting lineage (Uber UFA 2× to 1.3×, Meta PIMS 3% maintenance buffer, PowerSight RPB bands, Flux OSDI '23); big-operator practice (Borg, Autopilot, Microsoft Resource Central).

Negative claims stated as scoped findings: "in an off-repo web search on 2026-10-12 (22-source budget, two channels) we found no other public case of an agent auto-producing a DC planning report besides one Railway-assisted case"; "within the same budget, no systematic workload-forecasting survey beyond a weather-aware energy-consumption paper (1804.01754)". WUE is unverified: the report template prints a fixed "caliber pending verification" placeholder in that section and must never state a commitment value.

Lane classification: directional spec; before implementation, a dedicated contract (input data schema, unit/time calibers, forecast method choice, missing-data handling) is required.

## 8. Evaluation and DoD (all frozen)

- Coverage = claims with a legal marker that pass read-back ÷ detected claims (four-family detector). First-release threshold ≥ 0.9 (recalibrated after one dogfood week). Out-of-bounds citations = 0 (any single one fails the whole artifact).
- Frozen gold set of 30 documents: sampled from this repo's `docs/**` and package READMEs; the list plus each file's sha256 pins into the evaluation package at implementation. Annotation unit = sentence; protocol = dual annotation with user adjudication. Detector recall is measured too (detected vs human-annotated), so a silent under-detector cannot inflate coverage.
- Sampling: unit = receipt row; dogfood 20% with min 5 per batch (ceil), then 5% post-acceptance; K = expected atomic facts 20 (SAFE convention); labels = supported / partially / unsupported / irrelevant; F1@K is a metric, never a sampling ratio (per the SAFE paper, arXiv 2403.18802). Judge-lane cost caps go into the evaluation package's budget table.
- Every slice carries the DoD trio (driver / observable / pass); see section 9 for P1's.
- A pre-implementation code-truth pass stays: after review GO and before implementation, re-verify the mechanism claims about event ordering and sequencing in code (past lesson: review GO does not equal code truth).

## 9. Implementation phasing and slices

- P0 probes: (1) DONE: dual-preset include + per-preset persona composition with positive control (see 3.1 probe facts). (2) Extractor prototype plus the pinned four-family regex list (early P2 task). (3) Transcript coverage baseline measurement (P2, using the frozen section-8 convention).
- P1 carrier slice: the three-file split in one directory + one appended preset-vwa patch row + command-preset package + resolvePresetId refactor + resume-gap fix + validator closure expansion + composition spec migration. DoD trio: driver = the probe fleet re-run plus a live `/preset vwa` on a real profile; observable = a fresh session mounts id `vwa` (the transcript carries `agent-preset/selected`) and resume re-mounts `vwa`; `/preset bogus` lists valid ids; a session with turns gets "default changed only"; clearing selectedDefault returns fresh sessions to cc. pass = all of the above plus the composition-spec closure assertions green (cc behavior unchanged).
- P2 substrate + lane-1 MVP: the vwa-evidence package (4.1, 4.2, 4.3, 4.5 complete) + evaluation package (gold set and sampling harness) + writing guidance (AGENTS fragment). DoD = section 5's machine predicate plus the human spot-check table.
- P3/P4: directional specs (see sections 6 and 7); each gets its own design doc (behavioral contract + DoD trio) before implementation. D4 gates P3.

Each slice is its own PR, stacked delivery, with the husky four gates plus `check:size` plus parity per PR.

## 10. Non-goals (with negative evidence)

1. No formal-tier verification (Lean or proof certificates) for prose outputs.
2. No autonomous publication loop; outputs are drafts plus receipts (AI Scientist precedent).
3. No self-built DCIM or telemetry platform; consume existing exports.
4. No speculation about vendor product internals (OpenAI/Anthropic/Google deep-research systems) beyond public statements (no dedicated public records in the local knowledge base either).
5. Standing calibration: invest in delivery reliability over scaffold intelligence (carried from this repo's earlier borrow-list review).
6. No new subagent types (standing decision from the data-analysis skill work; does not consume D1).

## 11. Review ledger

Round r1 (three blind seats, 2026-10-12; brief and all logs in session records):

- Internal critic: GO-WITH-CHANGES (10 findings). Grok: NO-GO (5 blockers, 5 majors, 6 minors, $0.92, 50 turns). Codex: NO-GO (3 blockers, 8 majors, 1 minor, 100k tokens). The verdict split was adjudicated as severity calibration plus genuine document holes (the three large blocker families were two-seat concurrences).
- Two-seat concurrences treated as top-confidence: default chain pinned to cc (Codex F1 = Grok B1), three gates deadlock (F5 = B4), no reproducible coverage denominator (F7 = B5).
- Cross-seat divergence adjudications: the `/preset` mount went to Grok's double-write over Codex's shared placement (existing I4 needs the anchor literally in the cc file; vwa needs its own row anyway to switch back); the manifest resolution combined the two (validator include-closure expansion serves displaced existing rows; vwa-exclusive capabilities stay out of the manifest per independent three-way agreement).
- Orchestrator corrections on record (honesty ledger): the "duplicate id throws" mechanism was fabricated by scaffolding (actual behavior is silent last-wins, verified at vendor/loader `group.ts:51-53`); the `selectedDefault`/volatile bridge is not a host fact (settings-provider configure is a deliberate no-op and `update` on an unregistered namespace throws, both verified); "zero new code" was inaccurate phrasing (gates live in the new vwa-evidence package); entity names in the claim denominator have no deterministic criterion; several harness anchors failed literal path checks initially.
- Delta round: critic GO (all 10 folds verified against source). Grok GO-WITH-CHANGES with three anchor-precision residuals (folded). Codex GO-WITH-CHANGES with two residuals (nudge-budget projection field, failure-delivery state) plus a mechanism-evidence disagreement note acknowledged and folded (double-write kept, rationale restated as a design choice rather than a mechanism necessity).
- Micro-confirm round: codex NO-GO on two closures (receipt lacked a nudge-round field; `delivered-unverified` was coupled to overall ≠ pass), both folded into v4; grok GO; codex second micro-confirm GO. Final: three seats GO.

## 12. References

-
All URLs below were fetched and verified during the research phase (28 + 22 external sources plus knowledge-base pages).

- [Ai2 blog](https://allenai.org/blog/ai2-scholarqa)
- [FActScore](https://arxiv.org/abs/2305.14251)
- [ALCE](https://arxiv.org/abs/2305.14627)
- [STORM](https://arxiv.org/abs/2402.14207)
- [SAFE (arXiv)](https://arxiv.org/abs/2403.18802)
- [arXiv](https://arxiv.org/abs/2408.06292)
- [Co-STORM](https://arxiv.org/abs/2408.15232)
- [arXiv](https://arxiv.org/abs/2409.13740)
- [arXiv](https://arxiv.org/abs/2501.04227)
- [arXiv](https://arxiv.org/abs/2502.18864)
- [arXiv](https://arxiv.org/abs/2504.08066)
- [At Scale: Meta Capacity Planning for AI Training Hardware](https://atscaleconference.com/meta-capacity-planning-for-ai-training-hardware)
- [AWS blog](https://aws.amazon.com/blogs/aws/aws-documentation-is-now-open-source-and-on-github/)
- [Google blog](https://blog.google/products/gemini/google-gemini-deep-research/)
- [Claude blog](https://claude.com/blog/introducing-citations-api)
- [Google Cloud Blog](https://cloud.google.com/blog/topics/systems/enabling-1-mw-it-racks-and-liquid-cooling-at-ocp-emea-summit)
- [Uptime 2024 Survey Report PDF](https://datacenter.uptimeinstitute.com/rs/711-RIA-145/images/2024.GlobalDataCenterSurvey.Report.pdf?version=0&ref=zenduty.com#4#1)
- [SAFE (Google DeepMind publication page)](https://deepmind.google/research/publications/85420/)
- [ACM DL: Resource Central, SOSP 2017, DOI 10.1145/3132747.3132772](https://dl.acm.org/doi/10.1145/3132747.3132772)
- [GitHub Docs contributing](https://docs.github.com/en/contributing)
- [Python doctest](https://docs.python.org/3/library/doctest.html)
- [Schneider AI Cluster eGuide](https://download.schneider-electric.com/files?p_Doc_Ref=AIClustereGuide&p_enDocType=EDMS#1#1)
- [Engineering at Meta: Maintaining large-scale AI capacity](https://engineering.fb.com/2024/06/12/production-engineering/maintaining-large-scale-ai-capacity-meta)
- [Faddom: DC Capacity Planning KPIs, Methods, Best Practices](https://faddom.com/data-center-capacity-planning-kpis-methods-and-best-practices/#Data_Center_Capacity_Planning_Methodologies)
- [awsdocs](https://github.com/awsdocs)
- [RelationalAI templates: energy_grid_planning](https://github.com/relationalai/templates/blob/main/v1/energy_grid_planning/README.md#1)
- [Uptime "DLC adoption remains slow and steady" PDF](https://intelligence.uptimeinstitute.com/sites/default/files/2025-07/UI%20Field%20181_Data%20center%20cooling.pdf#1#1)
- [llms.txt](https://llmstxt.org)
- [MAHAPREIT 200MW tender PDF](https://mahapreit.in/assets/uploads/tender-ext-65-1786772024.pdf#7#6)
- [OpenAI blog](https://openai.com/index/introducing-deep-research/)
- [Citations docs](https://platform.claude.com/docs/en/build-with-claude/citations)
- [Google Research blog](https://research.google/blog/accelerating-scientific-breakthroughs-with-an-ai-co-scientist/)
- [Google Research：Autopilot: Workload Autoscaling at Google Scale](https://research.google/pubs/autopilot-workload-autoscaling-at-google-scale/)
- [Google Research：Large-scale cluster management at Google with Borg](https://research.google/pubs/large-scale-cluster-management-at-google-with-borg/)
- [Sakana blog](https://sakana.ai/ai-scientist-first-publication/)
- [Sakana blog](https://sakana.ai/ai-scientist/)
- [Uptime 14th Annual Survey press release](https://uptimeinstitute.com/about-ui/press-releases/uptimes-14th-annual-global-data-center-survey-results-shows-expanding-industry-planning)
- [Uptime Tier Topology reference page](https://uptimeinstitute.com/resources/asset/tier-standard-topology)
- [Vale](https://vale.sh)
- [Anthropic engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- [APC/Schneider White Paper 155 (Neil Rasmussen), mirror PDF](https://www.apcbj.com/pdf/NRAN-8FL6LW_R0_EN.pdf)
- [ASHRAE Datacom Series page](https://www.ashrae.org/technical-resources/bookstore/datacom-series)
- [Baltimore County data center study PDF](https://www.baltimorecountymd.gov/files/departments/planning/documents/datacenterstudy20260716.pdf)
- [DCD: Railway taps Claude to design a data center](https://www.datacenterdynamics.com/en/news/railway-taps-claude-to-design-a-data-center)
- [FAR.AI / arXiv 2405.06624](https://www.far.ai/research/towards-guaranteed-safe-ai-a-framework-for-ensuring-robust-and-reliable-ai-systems)
- [OCP 48V Onboard Power Requirements](https://www.opencompute.org/documents/ocp-48v-onboard-power-solution-requirements-version-1-0-0-2024118-google-docs-pdf#1#1)
- [OCP Open Rack V3 Spec](https://www.opencompute.org/documents/open-rack-base-specification-version-3-pdf)
- [Planera: Data Center Construction Guide 10 Phases](https://www.planera.io/data-center-construction-guide)
- [Raritan: data-center trends (citing Uptime 10th Annual Survey)](https://www.raritan.com/resource/detail/data-center-trends-rack-densities-and-outages-on-the-rise)
- [Sunbird DCIM: GB200 NVL72 readiness guide](https://www.sunbirddcim.com/blog/is-your-data-center-ready-nvidia-gb200-nvl72)
- [Vertiv press release: GB200 NVL72 power/cooling blueprint](https://www.vertiv.com/en-emea/about/news-and-events/news-releases/vertiv-codevelops-with-nvidia-complete-power-and-cooling-blueprint-for--nvidia-gb200-nvl72-platform)
- [WTD docs-as-code](https://www.writethedocs.org/guide/docs-as-code/)
- [WTD testing](https://www.writethedocs.org/guide/tools/testing/)
- [Uptime Institute 2024 Global Data Center Survey Report](https://datacenter.uptimeinstitute.com/rs/711-RIA-145/images/2024.GlobalDataCenterSurvey.Report.pdf)
- [Schneider Electric AI Cluster Reference Designs eGuide](https://download.schneider-electric.com/files?p_Doc_Ref=AIClustereGuide&p_enDocType=EDMS)
- [Faddom: DC Capacity Planning KPIs, Methods, Best Practices](https://faddom.com/data-center-capacity-planning-kpis-methods-and-best-practices/)
- [Uptime Institute Field Note: Direct Liquid Cooling Adoption](https://intelligence.uptimeinstitute.com/sites/default/files/2025-07/UI%20Field%20181_Data%20center%20cooling.pdf)
- [MAHAPREIT 200MW Data Center Tender](https://mahapreit.in/assets/uploads/tender-ext-65-1786772024.pdf)
