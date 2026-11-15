# VWA Autonomous Render Pipeline (vwa-draft-render)

## Status: Implemented — slices 1–7 of §15 are in the tree on branch `worktree-vwa-autonomous`
## (implementation tree `a93d2ccd`), PR pending. Design history: three-lane blind review converged
## (r1 full review, r2 delta verification, r3 micro-confirmation; all seats GO or GO-WITH-CHANGES
## with every finding folded), formal-design models verified, user sign-off given.

All anchors cite tree `041cfe72`, verified 2026-11-15 by three read-only digests and two review 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕
rounds across three independent lanes (critic, codex, grok). This text supersedes every earlier
plan or memory record that describes the same surfaces. Slice 7 re-verified every anchor fence
against the implementation tree `a93d2ccd`; that doc's header carries both pins 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L7-L13〕.

## 1. Problem and goals

VWA mode mixes working state with published content and leaves two autonomy gaps:

1. **Marker teardown is manual.** `〔src:ws:…〕` and `〔claim:<id>〕` markers are load-bearing while
   authoring (coverage gate, audit extract/align, artifact binding) but must be stripped before
   publication. Today the only mechanism is a session-side regex (repeated incidents, including a
   subagent backfilling ~800 fabricated markers) 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L322-L338〕. There is no verifiable compile step.
2. **Derived artifacts live next to real content.** Snapshots go to `docs/vwa-sources/<projectId>/`
   (`sources.ts:311`), reports to `docs/vwa-reports/<projectId>/` (`report-tool.ts:75`) — inside
   `docs/`, the same tree as published articles.
3. **Human adjudication is not durable.** `/vwa adjudicate … reject` does unstick a
   REVIEWER_DISAGREEMENT today (`tests/disagreement-policy.spec.ts:65-84`; `accept` intentionally 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L20-L48〕
   still blocks, `adjudicate.ts:176`). But `activeAdjudications` (`delivery-check.ts:80-91`) pins
   the decision to `projectDependencyDigest`, which hashes **every non-disagreement review record**
   (`delivery-check.ts:106-109`), so any later review anywhere voids the human decision; and the
   mint path (`review-current.ts:66-73`) generates a fresh random finding id per evaluation.

Goal: model + harness complete the whole loop with zero routine human interaction. The agent's only
editing surface for a VWA artifact is a **draft** under `.dsh/vwa/<projectId>/drafts/`; the
deliverable is **rendered inside the bind transaction** and is compile output; citations to project
snapshots become **graph-verified** (`gr:`) and snapshot-stable; human decisions survive unrelated
activity.

Security master invariant (unchanged): **the agent can never authorize itself and can never forge
human adjudication.** Every relaxation is confined to the drafts subtree; adjudications, signatures,
HEAD and revisions keep their current ASK/forbidden posture.

### Non-goals

- No machine adjudication; disputed conclusions stay human.
- No change to the five-stage review pipeline, cache keys, budgets, or the grant protocol beyond the
  drafts write carve-out.
- No cross-machine replay manifest (out of scope; do not implement).
- No change to the citation-check claim-detection families or the coverage threshold.
- **No signature-durability work.** `/vwa sign` stays whole-graph bound (`commands.ts:368-391`).
- Legacy inline artifacts keep working unchanged (§4.7).
- No auto-commit to git.

## 2. Design overview

**The draft is the source; the deliverable is a compile output emitted inside the bind transaction,
with a durable render-intent record so recovery can recognise its own provisional output.**

```
agent ──write/edit──▶ .dsh/vwa/<pid>/drafts/<name>.md            (markers inline)
                                │
      argument.update { op:'bind-artifact', mode:'draft',
                        path:'docs/article.md' | artifactId,
                        draftPath:'.dsh/vwa/<pid>/drafts/<name>.md',
                        occurrences:[spans over DRAFT text], outline }
                                ▼
   bind transaction (store.ts:434-456, applyFn on a structuredClone)
     a. resolve + validate the draft path (§4.2 step 2)
     b. validate every occurrence against DRAFT text
     c. rendered = stripMarkers(draft)
     d. contentHash = sha256(rendered); draftHash = sha256(draft)
     e. resolve the canonical deliverable destination (§4.2 step 7)
     f. overwrite gate (§4.3)
     g. render intent staged  (renders/<requestId>.json)          ← §7
     h. deliverable bytes staged
     i. Artifact gains { occurrences (draft coords), contentHash (rendered),
                         draft:{path, draftHash} }
                                ▼
   commit: intent → staged file → revision → operation → HEAD → read-back → intent cleared
                                ▼
docs/article.md  = clean deliverable; overwritten only by a later bind
```

Semantic work reads the **draft**; hash identity is the **rendered** deliverable. §4.4 is the
normative per-consumer table; §7 owns the crash states.

## 3. Feature A — draft store, paths, permissions

### 3.1 Layout (v2 state tree)

**Base directory — read this first.** Every path below is relative to the **session workspace root**,
i.e. `<workspace>/.dsh/vwa/<projectId>/`. That is the `root` the store already receives
(`store.ts:171` joins `root + '.dsh' + 'vwa' + projectId`, and every caller passes
`workspaceRoot(agent)`). It is deliberately **not** the harness home directory `~/.dsh` (`<dshHome>`),
which holds user-level state — `settings.json` (hot-read by the evidence layer, `settings.ts:98-101`),
installed skills, and the receipt ledger. The two never mix: VWA project state is workspace data (and
committing it stays the user's choice, §8.1), while receipts are machine-local and stay where they
are: `<dshHome>/vwa-receipts/<encodedSessionId>.jsonl` (`receipt.ts:168-171`), unchanged by this
design 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L359-L387〕.

```
.dsh/vwa/<projectId>/
  drafts/<name>.md                       NEW  agent editing surface
  sources/<sourceId>.md                  MOVED from docs/vwa-sources/<projectId>/
  reports/<artifactId>.review.{md,json}  MOVED from docs/vwa-reports/<projectId>/
  renders/<requestId>.json               NEW  unadopted render intents (§7)
  revisions/ operations/ review-runs/ evaluations/ retired/
  adjudications.json signatures.json workspace.json HEAD.json
```

- **Draft names are author-chosen**: `^[a-z0-9][a-z0-9._-]{0,63}$` (plus `.md`), so a draft can exist
  before any artifact (the artifactId is minted only inside bind, `artifact.ts:66`) 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L74-L82〕.
- **Unique draft ownership**: a bind is rejected (`SCHEMA_INVALID 'draft already bound to another 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L111-L130〕
  artifact'`) if any other artifact records the same `draft.path`. Without this, §5.5's
  one-route-per-draft rule has no foundation.
- Deliverable paths may be anywhere except the state tree (§4.2 step 7).

### 3.2 Canonical path predicates

`projectId` is a variable segment, so a fixed-prefix containment test cannot express the drafts
exemption. Two predicates are required — a **file** predicate and a **grant prefix** predicate —
sharing one project parser:

```
PROJECT_ID_RE  = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
DRAFT_FILE_RE  = /^\.dsh\/vwa\/<PROJECT_ID_RE>\/drafts\/[a-z0-9][a-z0-9._-]{0,63}\.md$/
DRAFT_PREFIX_RE= /^\.dsh\/vwa\/<PROJECT_ID_RE>\/drafts(\/.*)?$/          (grant writePaths)
```

- **Owner: `permission-rules`.** New module
  `packages/interaction/permission-rules/src/vwa-paths.ts` exports `PROJECT_ID_RE`,
  `isVwaDraftPath(relPosix)`, `isVwaDraftPrefix(relPosix)`, `vwaProjectIdOfDraft(relPosix)`,
  `VWA_STATE_ROOT`, `VWA_BATCH_ROOT`, `relativeToStateRoot(absoluteRealpath)`.
- Every predicate takes a **workspace-relative POSIX path**; the absolute-realpath call sites
  (`vwa-state.ts:39`, `task-grant-match.ts:133-136`, `task-grant-service.ts:103`) must relativize
  first (`relativeToStateRoot`), because those three compare absolute paths today.
- **`vwa-evidence` must not depend on `permission-rules`** (that would invert the layering). It
  declares its own matcher and both packages consume one shared fixture corpus
  (`packages/interaction/permission-rules/tests/fixtures/vwa-draft-paths.json`: accept/reject
  vectors incl. bad `prj_` shapes, nesting, `..`, absolute paths) with a test in each package
  asserting identical verdicts. The fixture is the contract.
- Grant `writePaths` are **prefixes** (`task-grant.ts:61-62`), hence the separate prefix predicate.
  `TaskGrantDescriptor` has no project-list field (`task-grant.ts:76-82`), so project authorization
  is encoded by the literal project segment in the prefix — the descriptor validator must require a
  `prj_` segment and reject `.dsh/vwa` / `.dsh/vwa/<pid>` ancestor prefixes.

### 3.3 Permission behaviour

- `.dsh/vwa/**` stays **ASK** by default; exemptions are the physical `batches` subtree plus draft
  **files** matching `DRAFT_FILE_RE`. `VWA_STATE_ASK_REASON` becomes: "writes under .dsh/vwa are
  authoritative VWA state (use the VWA tools); only .dsh/vwa/batches/** and
  .dsh/vwa/<projectId>/drafts/** are writable directly" 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L248-L276〕.
- **Four coupled sites, all in `permission-rules`**: `vwa-state.ts` (`isCanonicalVwaStateWrite`),
  `task-grant.ts` `validateDescriptor` — note it rejects via `underVwaState` (`task-grant.ts:106-108`,
  applied at `:213`), which does **not** route through `isCanonicalVwaStateWrite`, so widening that
  function alone does **not** widen descriptor validation — `task-grant-service.ts:103`, and
  `task-grant-match.ts:133-136`. All four take the predicates from `vwa-paths.ts`; tests in the same
  commit pin each (`task-grant.spec.ts:29`, `task-grant-match.spec.ts:21,138,181`).
- Normalization resolves aliases to physical targets; that prevents a symlink *into* the drafts tree
  from being classified as a draft only if the caller relativizes the **realpath**. The exemption is
  therefore keyed on `realpath(target)` relativized to the workspace root, and the
  `task-grant-path-security.spec.ts:98-118` cases gain a drafts counterpart.

### 3.4 Canonical-root safety for D22

`sources.ts:179-216` realpaths the candidate source then classifies by **lexical** segment comparison
against `.dsh/vwa` and the legacy output trees. If `.dsh/vwa` is a symlink to a workspace directory,
realpath yields that directory and the classification misses. Fix: compare the resolved path against
**canonicalized** state roots (`realpath(.dsh/vwa)`) and the canonical legacy trees, keeping a
lexical fallback for not-yet-existing paths. Pinned by a test that symlinks `.dsh/vwa` to
`docs/state` and expects `PATH_OUT_OF_BOUNDS` for `docs/state/<pid>/reports/a.md`.

## 4. Feature B — binding modes, rendering, coordinate identity

### 4.1 Explicit binding mode

`mode` is **required** in the bind mutation and selected **before any text is read**:

| mode | applies to | text validated | output written |
| --- | --- | --- | --- |
| `draft` | a new artifact, **or** an existing artifact (legacy or already draft-backed) — this is the conversion path | the draft at `draftPath` | rendered deliverable |
| `inline` | an existing artifact with **no** `draft` field | the deliverable, as today | nothing (v1 verbatim) |

Rules: `inline` on a draft-backed artifact is rejected (`SCHEMA_INVALID 'artifact is draft-backed; 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕
bind with mode:"draft"'`); `draft` on a legacy artifact converts it (explicit by construction — no
implicit conversion); omitting `mode` is a schema error.

### 4.2 Bind v2 algorithm (normative)

```
 0. reject if mode missing.
 1. mode 'inline': run v1 verbatim (artifact.ts:26-67); return.
 2. draftPath must satisfy DRAFT_FILE_RE, belong to this projectId, and match the project's
    draft directory after realpath relativization → else PATH_OUT_OF_BOUNDS.
    Reject if another artifact records the same draftPath (§3.1).
    draftText = artifactReader(draftPath); undefined → NOT_FOUND 'draft text unavailable'.
 3. per occurrence: spanError(span, draftText) === '' and
    draftText.slice(start,end) === exactText              (artifact.ts:33-37 predicates)
 4. rendered = stripMarkers(draftText)                    (§4.5)
 5. an occurrence intersecting a removed marker range is rejected
    (SCHEMA_INVALID 'occurrence overlaps a stripped marker').
    Occurrence coordinates stay in DRAFT coordinates (§4.4) — no remap is persisted.
 6. contentHash = sha256(rendered, 'utf8'); draftHash = sha256(draftText, 'utf8')
 7. destination resolution (replaces validateArtifactPath's lexical check, artifact.ts:73-84):
      realpath(dirname(deliverable)) inside the workspace;
      canonical target NOT inside canonical .dsh/**, docs/vwa-sources/**, docs/vwa-reports/**;
      a symlinked parent resolving into those trees is rejected.
 8. overwrite gate (§4.3).
 9. stage RenderIntent { requestId, projectId, artifactId?, draftPath, draftHash,
    renderedHash, target }        → renders/<requestId>.json      (§7)
10. stage deliverable bytes { path: absoluteDeliverable, bytes: utf8(rendered) }.
11. Artifact { id (existing or art_<uuid>), path, contentHash, occurrences (draft coords),
              outline, draft:{path, draftHash}, entityVersion++ }.
12. HEAD adoption clears the intent record (§7 step 6).
```

### 4.3 First-bind overwrite gate

"Compile overwrites its own output" justifies re-bind overwrites of a file the pipeline produced. It
does not justify destroying a user-authored file the graph never owned. Rule: require
`mutation.overwrite === true` when the deliverable exists and satisfies **both**
`sha256(currentBytes) !== artifact.contentHash` and `sha256(currentBytes) !== sha256(prevRender)`.
The second disjunct lets recovery recognise its own provisional output (§7). Legacy conversion goes
through the same gate — that is exactly the destructive case. Error:
`SCHEMA_INVALID 'deliverable exists and is not owned by this artifact; pass overwrite:true to take 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L111-L130〕
ownership'`.

### 4.4 Coordinate and text identity (normative)

Rendering yields two texts. Their use is not interchangeable.

| Field / consumer | Value | Note |
| --- | --- | --- |
| `Artifact.occurrences[].span` | **draft** UTF-16 | all span-indexing consumers index the draft |
| `Artifact.contentHash` | sha256(**rendered**) | equals deliverable bytes (`tools.ts:371-373`, `commands.ts:320-322`) |
| `Artifact.draft.draftHash` | sha256(**draft**) | graph↔source drift |
| `FrozenEvaluation.artifactText` (name kept) | **rendered** | render replay |
| `FrozenEvaluation.semanticText` (**new**) | **draft** | audit/assessment replay |
| `executeAudit(artifactId, semanticText, renderedHash)` | text=draft, record hash=**rendered** | new third parameter (§4.4a) |
| `ReviewRecord.artifactHash` / error records | sha256(**rendered**) | delivery filters join on it |
| audit reuse / audit-skip identity | sha256(**draft**) as `semanticHash` (**new field**) | reuse must follow the source, not the render |
| `review-plan.ts:156-157` block↔claim mapping | **draft** | same span space |
| `delivery-check.ts:164-168` mechanical occurrence checks | **draft** | same span space |
| `delivery-check.ts:172-183` `deliveryScope`/`computeCoreSet` | **draft** | semantic derivation |
| `delivery-check.ts:201` `artifactHash` | sha256(**rendered**) | must match audit rows |
| `evaluateDelivery` inputs | `semanticText` + `artifactHash` | signature change (`report.ts:222-265`) |
| `checkForDelivery` reads | deliverable (hash) **and** draft (hash) | §7 three-state |
| receipt `artifactHash` | sha256(**rendered**) | external identity of published bytes |
| receipt `claimBindings[].spans` (`delivery-check.ts:402`) | **draft** coordinates, explicitly documented | markers shift offsets; an external consumer must resolve them against the draft, which ships in the project tree |
| receipt claim→source rows | from **draft** markers | markers exist only in the draft |

**4.4a Audit identity must be split.** `audit.ts:125` and `review-runner.ts:176` currently derive
`artifactHash` from the text they are handed; handing them the draft would produce draft hashes that
the rendered-hash delivery filter (`delivery-check.ts:201,210`; `report-asof.ts:40`) rejects. So
`executeAudit` and the error-record writer take **both** texts and store `artifactHash` =
rendered hash, `semanticHash` = draft hash; audit-skip and audit-reuse keys move to `semanticHash`.

### 4.5 Marker stripping (`stripMarkers`)

New module `packages/interaction/vwa-argument/src/render.ts`.

- Remove every literal `/〔(?:src|claim):[^〕]*〕/g` occurrence, including inside code spans and fences.
  Uniform removal is the only deterministic rule; documented consequence: a document that must
  literally display a marker cannot be authored as a draft verbatim.
- Expose **two** maps, `draftToRendered` and `renderedToDraft`. The existing `stripClaimMarkers`
  (`audit-input.ts:82-108`) exports `strippedToOriginal` (stripped→original) and is right-biased at
  boundaries; it is therefore **not** reusable as-is for both directions. Specify half-open
  `[start,end)` with explicit endpoint affinity: a span whose `start` falls strictly inside a removed
  range is invalid (rejected in step 5); a span whose `end` equals a removed range's `start` is valid.
- Tests: adjacent markers, one-char separation, text start/end, CRLF, surrogate pairs on both sides.
- `Artifact.outline` is an array of section objects (`types.ts:152`:
  `{section, goal, claimIds, argumentIds, qualifications}`) and carries **no spans** — there is no
  outline remapping. (The v1 of this design wrongly said "outline spans".)

### 4.6 Temp files and clobbering

- Out-of-tree staged files use random-suffix temps in the same directory
  (`<deliverable>.<uuid>.tmp`, the `report-tool.ts:130-141` pattern) and are cleaned opportunistically:
  any `*.tmp` sibling older than 24 h found while staging the same destination 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕. The store's
  `recoverOrphans` (`store.ts:365-382`) walks the snapshot dir and state-tree dirs and is **not**
  extended — the temp sweep is local to the render staging path.
- Silent clobbering of an external editor is intended for an owned deliverable (compile output); git
  is the recovery path (no-auto-commit non-goal). The un-owned case is gated by §4.3.

### 4.7 Re-bind and legacy compatibility

Re-bind re-renders and overwrites (the gate passes for its own previous render or its own provisional
output). Render happens **only** inside bind/update transactions — no turn-end render, no background
render. Legacy inline artifacts keep `draft`-less behaviour and keep hash-watch semantics
(`humanities-guidance.md:10-19`); migration does not touch them (§8).

## 5. Feature C — `gr:` snapshot citations

### 5.1 Grammar

`parseMarkerInner` (`marker.ts:146-163`) already splits on `;`; the compound form is **not** new. The
only change is the spec alternative:

```
src:<spec>(;spec)*     (compound form unchanged)
spec := ws:<posix rel path>#L<a>-L<b>    (v1, live file, whitelist applies)
      | gr:<sourceId>#L<a>-L<b>          (v2, registered project source snapshot)
```

The second parser `markdown.lib.mjs:24` (`^src:ws:…`) becomes `^src:(?:ws|gr):…` with a `gr:` case in
`preservation.spec.ts:148-154`.

### 5.2 Trust boundary

Source registration (`sources.ts:179-218`) accepts any UTF-8 regular file ≤8 MiB inside the workspace — 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L223-L240〕
including `.ts` sources. Making all of them gr-citable would let an agent mechanically verify
citations that `ws:` rejects, defeating the whitelist. Rule: **a `gr:` marker is valid only for a
source whose registered path is corpus-class.**

- `Source` gains optional `corpusPath` (workspace-relative POSIX path captured at registration).
  Registration **does not persist** any workspace path today (`sources.ts:357-360`), so this field is
  populated only for sources registered after this change. Sources registered earlier stay
  **not gr-citable** until re-registered — stated, not papered over (and migration retires reviews
  anyway, §8.3).
- `gr`-citable ⇔ `isWhitelistedRel(corpusPath)` (the frozen `verify.ts:28-31` predicate, applied to
  the registered original, never to the snapshot copy). Non-corpus sources remain registrable and
  reason-able in the graph; they are simply not citable from a deliverable, returning
  `invalid-marker 'source corpus path is outside the citable corpus'`.
- The snapshot under `.dsh/vwa/<pid>/sources/` is never a whitelist target; `isWhitelistedRel`'s
  `.dsh/**` exclusion stays byte-identical and is not weakened anywhere.

### 5.3 Verification algorithm (fail closed)

```
if spec.sourceId starts with 'gr:':
  project = await projectResolver()                        // §5.4
  if !project → invalid-marker 'no active VWA project for gr: citation'
  source = project.sources.find(s => s.id === spec.sourceId.slice(3))
  if !source → invalid-marker 'gr: source not found in the active project'
  if !source.corpusPath → invalid-marker 'source has no recorded corpus path (re-register)'
  if !isWhitelistedRel(source.corpusPath) → invalid-marker 'source corpus path is outside the
                                              citable corpus'
  // snapshotPath is WORKSPACE-relative (sources.ts:311; readers join it to the workspace root,
  // delivery-check.ts:424) — resolve against the workspace root, not the project dir.
  abs = resolve(workspaceRoot, source.snapshotPath)
  realpath(abs) must be inside canonical(<root>/.dsh/vwa/<pid>/sources) → else invalid-marker
                                              'snapshot path escapes'
  bytes = readFileSync(abs); missing → invalid-marker
  if rawSha256(bytes) !== source.snapshotHash → invalid-marker 'snapshot hash mismatch (tampered)'
  text = losslessUtf8(bytes)  // non-UTF-8 → invalid-marker
  1 <= a <= b <= lines(text) → marked-ok / invalid-marker
```

### 5.4 Project resolution

- Draft files: project id from the path's `prj_` segment (§3.2), never from the pointer.
- Non-draft files: fall back to `readCurrentProject(workspaceRoot)` (read-only; agent tools never
  write the pointer). No pointer ⇒ `invalid-marker`.

### 5.5 Scan set and bound dispatch

1. `insideWhitelist` (`evaluator.ts:187-195`) accepts `isWhitelistedRel(rel) || isDraftPath(rel)` using
   the fixture-locked predicate. `isWhitelistedRel` itself is untouched: drafts are scannable, never
   citable as `ws:`, and reports/evaluations stay excluded.
2. `boundArtifactMap` (`bound-eval.ts:41-63`) keys on **absolute** paths today (not realpath); it gains
   a second index keyed on the artifact's draft absolute path, populated from the project snapshot.
   This requires the provider surface to expose the draft path: `listBoundArtifacts`
   (`report.ts:212-215`) returns only `artifact.path`, and `BoundEntry` (`bound-eval.ts:34-38`) has no
   draft field — add `draftPath` to both, plus the rendered hash needed by §5.5 item 4.
3. **The deliverable is excluded from the entire turn-end artifact set** for draft-backed artifacts —
   not just from the bound contribution: the exclusion applies to `windowEdits` and `pending`
   contributions too (`evaluator.ts:262-275`), otherwise a hand-edited deliverable scans standalone
   and yields a permanent unmarked verdict.
4. One route per draft: a draft maps to exactly one `{projectId, artifactId}` (§3.1 uniqueness); the
   receipt identity is the artifact, with `artifactPath` = draft path and `artifactHash` = rendered
   hash.
5. Project discovery for a draft uses its path segment; the pointer is only a fallback for non-draft
   files.

## 6. Feature D — adjudication durability

### 6.1 One canonical dispute resolver; content-derived ids

New module `packages/interaction/vwa-argument/src/dispute.ts`, used by evaluation, marker minting,
adjudication lookup, and liveness.

```
interface Dispute {
  disputeId: string        // 'finding_dis_' + sha256(stableJson({inputHash, stage})).slice(0,16)
  inputHash: string        // the review task cache key (review-runner.ts:404)
  stage: ReviewStage
  targetIds: Id[]          // recovered from the persisted finding's targetIds, sorted
  originRunIds: Id[]       // sorted; §6.2
}
resolveDisputes(snapshot, records): Dispute[]
```

- The id derives from `{inputHash, stage}` only. `inputHash` already encodes the task's target refs and
  dependency identity; `ruleId` is unavailable at the mint site and ambiguous later
  (`adjudicate.ts:70-93`), and `targetIds` are not stored on records as such (records carry
  `targetRefs`, `types.ts:282-305`; support/argument tasks use wider sets, `review-plan.ts:217-218`).
  Recovering `targetIds` from the persisted finding keeps the id independent of that difference.
- The resolver asserts uniqueness of `disputeId` within a snapshot and fails `SCHEMA_INVALID duplicate 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L223-L240〕
  disputeId` rather than merging 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕. Truncation to 16 hex chars is not claimed to be injective; the
  runtime check is the guarantee.

### 6.2 Liveness over the origin-run cohort

Records gain `originRunId`: the run that **produced** the judgment, which differs from `runId` when a
record is a cache reuse (`review-runner.ts:319-321` saves cached judgments under fresh run ids).
Without it, routine reuse would look like a new judgment and expire human decisions.

Adjudication rows for `REVIEWER_DISAGREEMENT` replace `dependencyDigest` with:

```
dispute: { disputeId, inputHash, stage, runIdCohort: originRunIds[] }   // sorted
```

Liveness (`activeAdjudications`, `delivery-check.ts:67-92`) requires all of:
1. a current dispute with the same `disputeId` exists;
2. its current `originRunIds` cohort **equals** the recorded `runIdCohort`;
3. the finding id still appears in a current disagreement marker (the membership check at
   `delivery-check.ts:84-90`, expressed over `resolveDisputes` output).

Why this is right where v2 was not: review records are immutable and append-per-run
(`review-run-store.ts:185-193`); hashing record *contents* cannot detect a re-run, and hashing
`runId`s (rather than `originRunId`s) would expire on cache reuse. Appending an unrelated review
changes neither the dispute id nor the cohort.

Expiry semantics:
- A genuinely fresh judgment joining the same dispute (`inputHash`+`stage`) adds an `originRunId` ⇒ the
  cohort changes ⇒ the adjudication goes inactive and the user is asked again. Intended.
- **No convergence branch.** The v2 text claimed a converged re-run removes the marker; it cannot —
  `disagreementFinding` compares *retained* verdicts (`review-run-store.ts:336-353`), so appending a
  pass does not erase an existing pass/fail conflict. A dispute therefore ends by `reject` or by a
  dependency change that makes the old records stale; that is now the stated rule.
- Review records must not be pruned while adjudications reference them; the repair path asserts it.

### 6.3 Legacy rows, and what migration does to them

Because a state-tree move rewrites `Source.snapshotPath` (and adds `corpusPath`), and source entities
participate in dependency hashing (`dependencies.ts:69-71`), every task identity changes. Migration
therefore **cannot** preserve review currency. Rather than pretense:

- `--migrate` moves existing review records and adjudications into `retired/` with a
  `retired-reason: 'state-tree-migration'` header, and reports `retiredReviews: N`,
  `retiredAdjudications: M` in the migration result.
- No id rewriting, no in-place conversion. (An in-place marker rewrite would also be destroyed by
  `readRecords`, which drops records whose `recordHash` no longer matches,
  `review-run-store.ts:204-206`.)
- The project therefore requires re-review after migration; delivery status reads `not-run` until
  then. This is honest and removes an entire class of half-converted state.

### 6.4 Unchanged semantics

`accept` still keeps the finding active (`adjudicate.ts:176`; pinned by
`disagreement-policy.spec.ts:86-95`); `currentReviews` still does not read adjudications
(`review-current.ts:40-116`) — the exclusion-aware recomputation stays in `delivery-check.ts:233-260`,
`:327-333`, `:356-358`; `/vwa adjudicate` grammar and `signer:'user'` enforcement
(`adjudicate.ts:157-172`, `report.ts:359-365`) unchanged.

## 7. Feature E — crash windows, render intents, recovery

The five-stage commit (`store.ts:458-499`) publishes the deliverable in stage 1, before HEAD moves. A
crash there leaves the graph at revision N and the deliverable ahead of it. The v2 draft tried to
recognise this from `artifact.draft.draftHash`, which is computed from the *same* bind, so the
predicate was unreachable — three seats converged on this independently. Correct shape:

### 7.1 Render intent (durable provenance before publication)

Step 9 of §4.2 stages `renders/<requestId>.json` = `{requestId, projectId, artifactId 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕?, draftPath, 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕
draftHash, renderedHash, target, at}` **before** the deliverable bytes 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L111-L130〕. HEAD adoption deletes it
(after read-back). It is the only evidence that the runtime — rather than a human — produced the bytes
currently on disk.

### 7.2 Three-state classification (draft-backed artifacts)

Given `bytes` on disk for `artifact.path`, `draft = read(artifact.draft.path)`,
`intents = parse(renders/*.json)`:

1. `sha256(bytes) === artifact.contentHash` → **current**.
2. otherwise, if either
   (a) `sha256(stripMarkers(draft)) === sha256(bytes)` — the deliverable is the render of the current
   draft, or
   (b) ∃ intent `i` with `i.target === artifact.path ∧ i.renderedHash === sha256(bytes)` — the bytes
   are a render this runtime produced and never adopted,
   → **`STALE_RENDER`** (retryable), remedy: "re-run the bind for this artifact".
3. otherwise → **`INPUT_CHANGED`** (genuine drift: draft edited, or hand-edit).

Series (a) alone is what v2 lacked; series (b) covers the case where the draft moved on after the
crash, which (a) cannot see. **Legacy inline artifacts have no `draft` field ⇒ two-state
(`current` / `INPUT_CHANGED`)** — the middle state does not exist for them.

### 7.3 Where the code must change

- `Fail` code union: `store.ts:34-45` (declare `STALE_RENDER` there).
- Read sites that compare bytes to `contentHash`:
  `tools.ts:371-376` (which currently reads one buffer for both the hash check and the audit text),
  `commands.ts:320-322` (`/vwa import`, which has no error code path today),
  `report.ts:235-250` (`checkForDelivery`), `report-asof.ts:40`.
- `report.ts:147-152` throws `InputChangedError` with a hardcoded `code = 'INPUT_CHANGED'` and
  `report-tool.ts:118-123` folds everything back into `fail('INPUT_CHANGED')`; both must carry
  `STALE_RENDER` through instead of collapsing it.
- Classification must happen **before** any `mechanicalFindings` call, so a provisional render never
  mints EVID-01 blockers.

### 7.4 Recovery, ordering, idempotency

- Remedy is a normal agent action: the next bind re-renders and re-adopts; the intent is cleared then.
- An unrelated transaction landing between the crash and the retry does not adopt the orphan; the
  deliverable stays `STALE_RENDER` until the owning bind runs.
- `/vwa repair` restores graph state only (`store.ts:314-337`) and is documented as not touching
  deliverables or intents; a repair pass may delete intents older than 24 h 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕.
- **Physical** re-writing is allowed to repeat (a retried request restages identical bytes). Replay
  recognition keys on the current HEAD operation id (`store.ts:420-423`), so after an intervening
  commit a retried request re-executes and may bump a second revision — acceptable, and stated:
  replay safety is content-level, not revision-level.

## 8. Directory consolidation and schema migration

### 8.1 Paths

- `store.snapshotDir` → `join(root, '.dsh/vwa', projectId, 'sources')` (`store.ts:172-174`), where
  `root` is the session workspace root as above (not `dshHome`);
  `Source.snapshotPath` stays **workspace-relative** (`sources.ts:311`) with the new value
  `.dsh/vwa/<projectId>/sources/<sourceId>.md`.
- Reports → `.dsh/vwa/<projectId>/reports/<artifactId>.review.{md,json}` (`report-tool.ts:75`); keep
  its atomic publication (`:130-141`) and upgrade `vwa-evidence/src/vwa-delivery.ts:208-223` (bare
  `writeFileSync`) to the same temp+read-back+rename.
- Readers that derive paths from `snapshotDir`, or derive the project root by counting levels above a
  snapshot (`sources.ts:390`), must be updated in the same commit — they are enumerated in §8.3.
- No new package. `vwa-argument/src/paths.ts` owns the argument-layer constants; the only
  cross-package need (the draft predicate) is handled by §3.2's fixture lock-step, so
  **`vwa-evidence` gains no dependency on `vwa-argument`** (the current direction
  `vwa-argument → vwa-evidence` stays one-way).
- `.gitignore` unchanged: committing `.dsh/vwa/**` remains the user's decision.

### 8.2 Schema domains

| Object | Today | After |
| --- | --- | --- |
| `ProjectSnapshot.schemaVersion` (`types.ts:168`, literal type) | 1 | **2** |
| `Head` (`store.ts:72-80`) | 1 | stays 1 |
| `RevisionEnvelope` (`store.ts:82-91`) | 1 | stays 1 |
| `workspace.json` (`store.ts:213`) | 1 | stays 1 |
| `current-project.json` pointer (`commands.ts:67,149,160`; `vwa-delivery.ts:137-138`) | 1 | stays 1 |
| `ReviewRunRequest` (`review-run-request.ts:33`) | 1 | stays 1 |
| `init` reservation (`init-tool.ts:134`) / workspace identity (`:217`) | 1 | stays 1 |

`store.ts:256` validates **HEAD.json**, `vwa-delivery.ts:137-138` validates the **pointer**; neither
reads the snapshot version. "There is no runtime check of the snapshot version today" means **at
storage load** — the exported validator does enforce it: `schema.ts:46-49` runs ajv against
`contracts/author.schema.json:327` (`"schemaVersion": {"const": 1}`).

### 8.3 Migration `schemaVersion 1 → 2` — blast radius (enumerated)

Schemas:
- `contracts/author.schema.json:327` → `enum: [1, 2]`.
- `contracts/author.schema.json` `Artifact` (`:264`) and `Source` are `additionalProperties: false`:
  add **optional** `draft` (artifact) and **optional** `corpusPath` (source) so v1 snapshots and
  legacy artifacts still validate; `sources.ts:349` validates `Source` through this schema and would
  otherwise reject the new field.
- `contracts/review.schema.json:872` (`AdjudicationRecord`): add optional `dispute`, make
  `dependencyDigest` optional (legacy rows keep it; new rows omit it).
- `contracts/review.schema.json:547` (`ReviewRecord`, also `additionalProperties: false` and enforced
  by `validateReviewRecord` on the audit-skip path): add optional `semanticHash` (§4.4a) and optional
  `originRunId` (§6.2). Without this the two new record fields are rejected at write time — a gap the
  r3 round caught.

Code:
- new write gate in `withTransaction`/`runTransaction` (not `readHead`); reads accept `{1,2}`.
- `store.ts:214` (init mints the version — new projects mint 2), `feasibility.ts:262`,
  `schema.spec.ts:99-101` (rewrite to accept `{1,2}` on read and reject writes),
  `review-helpers.ts:82`, `review-cycle.spec.ts`, and any snapshot literal typed `schemaVersion: 1`.
- path readers: `sources.ts:390` (root derivation), `sources.ts:419-421` (basename via snapshotDir), 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L223-L240〕
  `tools.ts:349`, `delivery-check.ts:151`.
- report path constants and both report writers (§8.1).

Migration transaction (`/vwa repair <projectId> --migrate`, new flag):
1. verify every source snapshot exists and hashes to `snapshotHash` (all-or-nothing).
2. stage the bytes at the new `sources/` locations.
3. rewrite `snapshotPath`; set `corpusPath` only where derivable (legacy sources get none — §5.2);
   `schemaVersion: 2`; create `drafts/`, `reports/`, `renders/`, `retired/`.
4. move review records + adjudications to `retired/` (§6.3).
5. commit as a normal revision (parent chain intact; history keeps old paths).
6. legacy `docs/vwa-sources/<pid>/` trees remain on disk (immutable history; removal is the user's
   call).

**Migration-exception to the v1 write prohibition**: the gate rejects writes to v1 projects, so
`--migrate` must be the single operation allowed to write while `schemaVersion === 1`; it is
identified by the command, not by a caller-supplied flag inside the transaction.

## 9. Delivery semantics and human touchpoints

`mode: draft` projects need no `/vwa sign`; delivery states are computed as today and the deliverable
is the rendered file. `mode: reviewed` keeps `/vwa sign` as the human attestation, unchanged and still
whole-graph bound (explicit non-goal). `/vwa adjudicate` remains the only human lane for
disagreements. Batch grants may cover drafts (§3.3) and the end-of-batch ledger collects genuine
disagreements.

## 10. Formal design — screening and models

Screening recorded before the existing formal review: TLA+ **required** — FD-T3 (crash recovery
determines persistence order and deliverable/graph agreement), FD-T2 (retried/replayed bind requests,
late review records), FD-T1 (human adjudication vs the review process over shared state), and FD-T4 only
weakly — a human decision is a form of ownership over a disputed verdict, recorded as such in the
adjudication model's `design.md`, never the primary trigger. Lean **not**
triggered: no authorization/eligibility-composition invariant with a stated behavior consequence (the
path predicate is a pure string function, exhaustively covered by the fixture corpus) and no
arithmetic conservation/bound property. A missing Lean tool never downgrades the TLA obligation.

### 10.1 `specs/tla/vwa-render-commit` (new)

State: draft versions, deliverable bytes, render-intent records, revision envelopes, HEAD,
operations, crash points between any two commit stages.
Actions: `Stage`, `CommitRev`, `CommitOp`, `CommitHead`, `Finish`, `Crash`, `Recover`, `UnrelatedTx`,
`EditDraft`, `ReadCheck`.

Invariants — each scoped to its publication state so it is a checkable statement, not an aspiration:
- **I1 NoTornOutput** — every value observed at the deliverable path is a whole render this runtime
  produced, a pre-existing foreign file, or absent. (Scoped to renderer-produced output.)
- **I2 NoMarkers** — a completed render contains none of the stripped sequences.
- **I3 AgreementByState** — split by publication state, in the same precedence order as §7.2:
  (i) deliverable hash equals `contentHash` ⇒ `current`, even if an intent is present (the intent is
  then stale bookkeeping, cleaned by the next adoption or the 24 h sweep); 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕
  (ii) deliverable hash is **neither** `contentHash` **nor** any provisional render (neither the
  `stripMarkers`-render of the current draft nor a recorded intent's `renderedHash`) ⇒ `INPUT_CHANGED`
  is correct;
  (iii) every remaining case — a provisional render with or without a matching intent ⇒
  `STALE_RENDER`, never `current`, never `INPUT_CHANGED`.
- **I4 SpanSafety** — no persisted occurrence span intersects a removed marker range and every
  occurrence still matches its `exactText` in the draft.
- **I5 ReplayContentStable** — for a fixed draft identity, replaying the same `(requestId, 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕
  payloadHash)` never yields two adopted revisions with different `contentHash`; a retry after an 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L111-L130〕
  intervening commit may produce a second revision but with identical bytes. (Content-level, not
  revision-level.)
- **I6 NoLostUserFile** — a bind without `overwrite:true` never replaces bytes that are neither this
  artifact's previous render nor its own provisional render, including across crashes.

### 10.2 `specs/tla/vwa-adjudication-durability` (new)

State: immutable review records (runId, originRunId, inputHash, stage, verdict), dispute set, human 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕
decisions, eligibility.
Actions: `AddFreshJudgment`, `ReuseJudgment` (cached, new runId, same originRunId), `Reject`, 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L395-L402〕
`Accept`, `Recompute`, `Retire` (migration).

Invariants:
- **I7 Durability** — after `reject`, appending an unrelated judgment (different inputHash/stage) never 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕
  restores the needs-review force for that dispute nor re-adds its blocker count.
- **I8 ExpiryOnFreshJudgment** — a fresh judgment joining the same dispute expires the decision; a
  reused judgment (same originRunId) does not 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L395-L402〕.
- **I9 IdStabilityAndScope** — the dispute id is a pure function of `{inputHash, stage}`; the persisted
  marker and the minted finding carry the same id; the blocker count of I7 covers only the adjudicated
  dispute, not the project.
- **I10 NoHalfConversion** — no adjudication can be simultaneously retired and active.

Model hygiene: `design.md` per model cites this document; `checks.json` declares the convention case
plus deliberately-failing probes kept in a `-probes` sibling so each model's aggregate stays clean;
`implementation.md` carries Run lineage. The eight probes, by model and by the constant that switches
the wrong design:

| Model | Probe cases | Constants |
| --- | --- | --- |
| `vwa-render-commit-probes` | strict-non-atomic, strict-misclassify-stale, strict-span-overlap, strict-overwrite-foreign, strict-adopt-without-render, strict-skip-intent | `NonAtomicWrite`, `MisclassifyStale`, `AllowOverlap`, `OverwriteForeign`, `AdoptWithoutRender`, `SkipIntent` |
| `vwa-adjudication-durability-probes` | strict-content-digest, strict-random-id | `LegacyContentDigest`, `RandomId` |

Expected verdicts: `convention` verified in all four directories; every probe a counterexample on the
named invariant. A probe that verifies has become unreachable and must be repaired.

## 11. Terminology sweep: delete the lane vocabulary

"Lane-1 / lane-2" names an internal build order, not a capability. A reader meeting "a VWA lane-2
project" in a tool description cannot tell what the tool does or when to use it. The fix is not a
prettier layer name — "evidence layer" and "argument layer" are just as unself-describing — it is to
**name the feature by what it does**:

| Old | New (prose, descriptions, docs) | What it actually does |
| --- | --- | --- |
| lane-1 | **citation checks** (`vwa-evidence`) | inline `〔src:ws:…〕` markers, claim detection, coverage gate, turn-end nudges |
| lane-2 | **argument review** (`vwa-argument`) | the claim/argument graph, staged semantic review, human adjudication |
| lane-2 path (§16.2 bound branch) | **bound-artifact evaluation** | project-bound evaluation at turn end |

Rules:

- The words "lane", "lane-1" and "lane-2" are **removed** from every prose surface. Package names,
  settings keys (`vwa-evidence`, `vwa-argument`), tool names (`evidence.register`, `evidence.search_log`,
  `argument.update`, `argument.review`, `argument.report`, `argument.init`), module paths and the
  `isolate` realm key stay exactly as they are — no `lane` token is load-bearing, so nothing has to
  move for the rename to be safe.
- **Tool descriptions are the P0 surface, not an afterthought** — they are what the model reads on
  every call: `tools.ts:148` ("Register a source snapshot … for a VWA lane-2 project"), `:179`, `:240`
  and `:273` ("Run a lane-2 semantic review stage …"). All four are rewritten in the same commit as
  §4.1's mode field; a stale description here would reintroduce the jargon into every session.
- Source comments and module docstrings are in scope (87 occurrences across the two packages at the
  time of writing), because they are what the next implementer reads first.
- Files, renamed by #423 before this slice landed: `packages/preset/cc/tests/vwa-lane2.real-boot.spec.ts`
  → `packages/preset/cc/tests/vwa-argument-review.real-boot.spec.ts` (NOT `vwa-argument-lanes.real-boot.spec.ts`,
  which was the placeholder this section first proposed); `docs/vwa/lane2-validation.md` →
  `docs/vwa/argument-review-validation.md`, with the README references updated (`README.md:195`,
  `docs/vwa/humanities-guidance.md:12,30`).
- Also updated: the six `vwa-argument/prompts/*.md` headers (each currently opens "VWA lane-2"),
  both package README pairs, plugin READMEs (`dsh-cc-agents`, `dsh-cc-writing`), skill references
  (`vwa-writing/*`, `vwa-batch/*`), and the `agent.vwa.cordis.yml:39` comment.
- One **historical note** paragraph in `docs/vwa/` keeps the mapping ("what used to be called lane-1 /
  lane-2 is now citation checks / argument review") so old design records stay readable. Historical
  `docs/plans/**` titles are not rewritten.
- Acceptance: `grep -rIni 'lane[ -]?[12]'` returns only that historical note plus this section, and
  no `lane` token appears in any tool description or settings schema text.

## 12. Documentation, preset, capability updates

- `docs/vwa/writing-guidance.md`: `gr:` form + corpus restriction; "edit the draft, never the
  deliverable"; compile semantics in the delivery-state paragraph.
- `docs/vwa/humanities-guidance.md:10-19`: hash-watch distinguishes draft-backed (compile output,
  overwritten on re-bind) from legacy inline (unchanged). `:22-36`: markers live in the draft and never
  reach the deliverable, so "removing them changes the artifact hash" no longer applies.
- `skills/vwa-writing/SKILL.md` + `references/writing-rules.md:28`: edit draft → bind(render) → review.
- `vwa-batch` SKILL/references/state-contract: writePaths guidance adds the drafts subtree 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕.
- Preset `agent.vwa.cordis.yml:18-22` persona sentence.
- Capability manifest: audit `docs/claude-code-capabilities.yaml` entries for `vwa-argument`,
  `vwa-evidence`, `permission-rules`; regenerate the parity trio with `pnpm docs:parity`.

## 13. Test plan

`vwa-argument`: `render.spec.ts` (strip cases, both maps, endpoint affinity, surrogate pairs, CRLF);
`tools.spec.ts`/`graph.spec.ts` (mode gate, draft-path validation, duplicate-draft rejection,
occurrence validation, overlap rejection, contentHash/draftHash, overwrite gate incl 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L111-L130〕. provisional
render, legacy inline regression); `dispute.spec.ts` (id derivation, cohort with originRunId, duplicate 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L20-L48〕
assertion); `disagreement-policy.spec.ts` (durability, expiry on fresh judgment, **no expiry on cache
reuse**, no convergence branch, retired adjudications); `audit.spec.ts` + new identity cases
(`artifactHash` rendered, `semanticHash` draft, reuse keyed on semanticHash); `report.spec.ts` / 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L111-L130〕
`migration.spec.ts` (retirement counts, hash-verified staging, missing/corrupt snapshot failure,
write gate + migration exception, new paths); crash-state cases for all three §7.2 series including
legacy two-state.

`vwa-evidence`: `verify.spec.ts` (`gr:` found / no project / unknown source / no corpusPath / 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L207-L215〕
non-corpus / tampered / escaped / out-of-range; `ws:` pins unchanged); `delivery.spec.ts`
(draft scan-set membership; deliverable excluded from window+pending+bound contributions;
`STALE_RENDER` vs `INPUT_CHANGED` for each series; receipt `artifactHash` rendered and spans
documented as draft coordinates); `bound-eval` draft index.

`permission-rules`: file predicate and prefix predicate accept/reject fixtures both directions;
symlink escape; descriptor validation of `prj_`-shaped prefixes (ancestor rejection); grant creation
and match.

Cross-package: shared fixture verdict test in `permission-rules` and `vwa-evidence`.
`dsh-cc-writing`: `preservation.spec.ts` `gr:` case. `preset/cc`:
`packages/preset/cc/tests/vwa-argument-review.real-boot.spec.ts` (the spec #423 renamed from
`vwa-lane2.real-boot.spec.ts`); `smoke:profile-boot`. Full battery: `check:size`,
`check:capabilities`, `check:parity`.

## 14. Open questions

1. **Retired-on-migration** (§6.3): accepting that a schemaVersion bump discards review currency is 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L346-L351〕
   the honest reading, but it means a migrated project must be re-reviewed end to end. Confirm this
   is acceptable versus building semantic identity migration.
2. **`gr:` for non-corpus sources** — §5.2 forbids citing them and legacy sources cannot be backfilled;
   confirm the "re-register to cite" path is the intended workflow rather than a `code:` marker class.
3. **Receipt span semantics** — §4.4 documents receipt spans as draft coordinates. Confirm external
   consumers can live with that (the draft ships in the project tree) rather than receiving rendered
   spans recomputed at emission.

## 15. Implementation slicing

1. `vwa-paths.ts` + fixture corpus + all four permission/grant sites (tests first).
2. `paths.ts`, directory move, path readers (§8.3), `vwa-delivery` atomic writer.
3. Schema files + version gate + `--migrate` (retirement) — needs §10.2 verified first.
4. `dispute.ts` + adjudication durability (+ `originRunId`) — needs §10.2 verified.
5. Marker grammar `gr:` + resolver + `corpusPath` registration.
6. Bind mode + render + render intent + three-state classification + consumer switch + scan-set
   dispatch — needs §10.1 verified first.
7. Terminology sweep + docs/manifest/parity.

## 16. Review and modeling ledger

Three independent review lanes, blind to each other: the in-repo critic seat, the Codex lane, and
the Grok lane. Every round was dispatched from the same brief; no lane saw another's output.

| Round | Scope | Verdicts | Outcome |
| --- | --- | --- | --- |
| r1 | full design review, v1 | critic GO-WITH-CHANGES (13 findings), Codex NO-GO (18), Grok lane unavailable at dispatch then returned | 31 findings adjudicated into `.scratch/vwa-render-adjudication-r1.md`; v2 folded all of them |
| r2 | delta verification of the v2 folds | critic GO-WITH-CHANGES, Grok NO-GO, Codex NO-GO | all three independently found the same blocker — the §7 crash classifier was logically unreachable — plus the audit-identity join and the cohort definition; v3 folded them |
| r3 | micro-confirmation of the v3 folds, narrow scope | critic GO, Codex GO-WITH-CHANGES, Grok GO-WITH-CHANGES | six of six prior findings confirmed resolved; two cosmetic drifts plus two real gaps folded (the §10.1 I3 precedence and the `ReviewRecord` schema) |

Convergence note: the r2 STALE_RENDER blocker was hit independently by all three lanes, which makes it the sole finding in this program treated as top-confidence and fixed without further adjudication〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕.

Formal design (screening in §10): four model directories, each with its own `design.md` screening
record and `implementation.md` run lineage.

| Directory | Cases | Result |
| --- | --- | --- |
| `specs/tla/vwa-render-commit` | convention | verified |
| `specs/tla/vwa-render-commit-probes` | convention + 6 probes | convention verified; 6/6 probes counterexample as designed |
| `specs/tla/vwa-adjudication-durability` | convention | verified |
| `specs/tla/vwa-adjudication-durability-probes` | convention + 2 probes | convention verified; 2/2 probes counterexample as designed |

The permitted conclusion for the TLA models: with the specified model, parameters and assumptions,
TLC completed its check and found no violation of the checked properties. This is not a proof that
the implementation is correct; the implementation handoff in each `implementation.md` maps every
modeled element to the code symbol it must preserve.

Evidence anchors: `docs/plans/2026-11-15-vwa-render-code-anchors.md` carries byte-for-byte excerpts of
the code this document cites, because inline markers may only target markdown.
