# dsh-cc-writing Genre Expansion: Document Types and Engineering Strategy

- Date: 2026-11-19
- Status: Proposed (design; not implemented)
- Target: `packages/plugin/dsh-cc-writing` (optional marketplace plugin)
- Baseline: worktree `writing-skill-enhancement`, based on origin/main
- Scope: add document types to the existing profile system (technical-essay / academic / natural-prose / engineering-strategy) and introduce a lightweight structure-skeleton capability

## 1. Problem and goals

dsh-cc-writing currently ships four profiles: `technical`, `research`, `opinion`, and `technical-ste`. Real writing needs go well beyond these four:

1. **Technical essay** (`technical-essay`): a long-form piece that explains a technical subject — more narrative than `technical`, with less literature overhead than `research`.
2. **Academic paper** (`academic`): rigorous argumentative structure, terminology discipline, and protection of citations and hedges.
3. **Everyday natural prose** (`natural-prose`): de-templated, conversational, readable informal writing — every existing profile is a formal register, so this class has no carrier today.
4. **Engineering strategy document** (`engineering-strategy`): a senior engineer or architect reporting technical strategy and roadmap choices to management. This is the most highly structured of the new genres: the Rumelt kernel (diagnosis / guiding policy / coherent actions), a SCQA opening, an inverted reading order, and fluff-resistant checks.

Goals:

1. Adding document types must not change the writing workflow's state machine (9 phases and 3 operations stay untouched).
2. The first three genres ship as pure profiles (enum extension plus new JSON files only); the fourth introduces a single optional `structure` field that carries the section skeleton.
3. Preserve the standing promise: "profiles are prompts, not gates" — mechanical checks verify structure and meaning preservation only, never the correctness of a judgment.
4. Move every synchronization surface (bilingual README, i18n hash pins, test pins, marketplace description) in the same change.

Non-goals:

- No new skill entry points (the `cc-plugin-loader` 4-skill pin stays intact) and no new operation type.
- No DOCX/PDF layout output; the workflow still manages Markdown bodies only.
- No machine style scoring (no LLM judge scores the article and gates delivery).

## 2. Source findings and design mapping

### 2.1 The two papers

**WritingBench (arXiv:2503.05244)**: a benchmark for LLM generative writing, 6 domains × 100 subdomains. Its core construct is not a fixed dimension table but **query-dependent, instance-specific review criteria** — each criterion has a name, an extended description, and a 10-point rubric, scored independently by a critic model with written justification; the only fixed axes are the three coarse dimensions style / format / length.

Mapping: the profile rule shape (`{id, instruction, rationale, severity}`) is isomorphic to WritingBench's criterion (name/description/rubric). **New profile rules must be written as independently decidable criteria**: each rule states one observable property of the text (e.g. "each H2 section opens with one sentence stating that section's conclusion"), not a vague style slogan. Calibrate rule density for academic and technical-essay against this standard.

**Self-Refine (arXiv:2303.17651)**: a single-model generate → self-feedback → iterative refinement loop whose feedback dimensions are task-specific. It offers no style taxonomy; the only transferable construct is the loop itself.

Mapping: writing-workflow already *is* that loop (draft → review → proposal → apply → check, with immutable findings and the derived `addressed` label). **The genre's role is to feed task-specific feedback dimensions into this loop** — the profile replaces Self-Refine's few-shot feedback prompt. No new mechanism is needed.

### 2.2 The four books (genre spec for engineering strategy)

The four books converge strongly on what a strategy document looks like; they yield the genre rules for engineering-strategy:

**Skeleton (Rumelt, *Good Strategy Bad Strategy*, Ch. 5; both Larson books adopt it verbatim)**:
- Diagnosis: defines and explains the nature of the challenge, singling out the critical aspects of an overwhelming reality.
- Guiding policy: the overall approach for coping with the obstacles the diagnosis identifies. **It must imply a real tradeoff.**
- Coherent actions: coordinated steps that work together to carry out the policy.

**Anti-pattern lint (Rumelt, Ch. 3-4)**:
- Fluff: empty high-level verbiage ("customer-centric intermediation").
- Failure to face the challenge: no defined challenge, so the strategy cannot be evaluated or improved.
- Mistaking goals for strategy: a wish list is not a plan for overcoming obstacles.
- Bad objectives: goals that address no critical issue or cannot be executed.

**Policy quality gate (Engineering Executives' Primer, Ch. 3)**: every policy must be Applicable (usable to navigate real tradeoffs), Enforced (you will actually hold teams accountable), and Creates Leverage (compounding, multiplicative impact).

**Inverted reading order (*Crafting Engineering Strategy*, Ch. 11)**: writing order (explore → diagnose → refine → policy → operate) is not reading order. For an approval audience, Policy comes first (it keeps the approval meeting from derailing into a research discussion); for an org-rollout audience, Policy + Operations come first; the thinking (refine / diagnose / explore) goes last but **must not be deleted** (future readers must be able to trace the reasoning, or they will assume the authors were foolish).

**Opening and length (*Staff Engineer*)**: open with a SCQA paragraph (Situation / Complication / Question / Answer); vision-class documents cap at 1-2 pages (readers drop off at 5-6); assume nobody reads to the end.

**The document carries its process (Primer, Ch. 11)**: metadata (date, approval status, where to ask questions), a single canonical source, a named contact; before release, have someone uninvolved flag unclear areas; after release, disable in-document comments (an open comment thread signals an unapproved strategy).

**Specificity (*Staff Engineer*)**: specific statements create alignment; generic statements create the illusion of alignment. Show your work — keep the reasoning so others can modify and extend as context shifts.

## 3. Current state and extension seams (code anchors)

- The only closed set for profiles: `skills/writing-workflow/scripts/schema.lib.mjs:141`, `PROFILES = ['technical','research','opinion','technical-ste']`. `brief.profile` goes through `readEnum` at `brief-run.lib.mjs:104`; an unknown id fails with `INVALID_INPUT` before any file lookup.
- Profile loading: `state.lib.mjs:51-59` reads `profiles/<id>.json` by id; **a missing file is silent** (returns a null profile) — the enum and the on-disk file are two independent gates with opposite failure modes.
- Profile schema: `check-profile.lib.mjs:121-147` — `schemaVersion:"1"`, `id`, `description`, `applicableLanguages:string[]`, `rules:[{id,instruction,rationale,severity}]`, `protectedTerms:string[]`; unknown fields are rejected.
- **Genre branching exists in exactly one place in code**: protected terms feeding the mechanical compare (`preservation.lib.mjs:107-108`). Phase derivation and record gating branch on `operation` (write/review/edit), never on profile.
- Synchronization surfaces (the change list): the `schema.lib.mjs` enum; `references/contracts.md:33` and its §6; the `article-writing/SKILL.md:40,67-73` routing table; `language-editing/SKILL.md:37`; `article-review/SKILL.md:33-41` (currently has no profile row — this change adds one); `README.md:17-18,129` + `README.zh.md:16,113` (both languages must move in the same commit; re-record hashes with `pnpm check:readme --write`); `tests/package-shape.spec.ts:23` `PROFILE_IDS` (drives the schema-validation loop); `tests/contracts.spec.ts:294` (enum pin: `profile:'poetry'` must fail); the description in the repo-root `.claude-plugin/marketplace.json`.
- Semantic constraint: profiles are "prompts, not gates" (`references/review-rubric.md:53-55`); scripts validate structure, identity, and preservation — they "do not prove that a judgment is correct."

## 4. Concept model: a genre is still a profile, in two capability tiers

**Decision D1: do not introduce a new "document type" concept.** A document type is a profile id. Rationale:

1. In the current architecture the profile already carries every responsibility of a genre (style rules, term protection, language applicability), and the code consumes only protected terms — the extension cost is minimal.
2. A new concept (say, a `genre` field or a parallel directory) would create a second metadata family beside profiles, and the combination semantics (genre × profile) would have no consumer.
3. Everything the first three new genres need fits inside the existing profile schema.

**Decision D2: deliver in two tiers.**

- **Tier A (pure profiles)**: technical-essay, academic, natural-prose. Only the enum, new JSON files, docs, and tests — zero logic change.
- **Tier B (structure skeleton)**: engineering-strategy needs "must contain a diagnosis section / policy section / actions section, SCQA opening, reading-order constraints," which exceeds what rule text can express. Add a single **optional** `structure` field to the profile schema to carry the skeleton, with limited mechanical verification at check time.

**Decision D3: no new skill, no new operation.** engineering-strategy is carried by `article-writing`'s profile routing (its trigger description gains "engineering strategy, roadmap reporting, strategy documents for management"). Rationale: `packages/compat/cc-plugin-loader/tests/dsh-cc-writing.spec.ts:41` pins the skill count at 4; the workflow's research stage happens to be the natural carrier for the explore/diagnose material a strategy document needs; a new operation would drag four operation-keyed branch sites (`OPERATIONS`, `BRIEF_FIELDS`, `derivePhase`, `nextRequiredStage`) for disproportionate benefit.

**Decision D4: record/derivePhase keep branching on operation, not genre.** engineering-strategy's diagnostic material goes through the research stage (the same "collect context" stage; the material type is dictated by profile rules, not by code gating). academic's literature review reuses it the same way.

## 5. New profile specifications

### 5.1 `technical-essay`

Position: a long-form piece that makes one technical subject clear, with a narrative line but precise terminology. Between `technical` (leans manual) and `opinion` (leans argument).

Rule highlights (each written as an independently decidable criterion):
- Single throughline: the whole piece can state in one sentence "what this article makes the reader understand"; every H2 serves that line.
- Concept before mechanism: every new term is defined in plain language before first use; the first occurrence is bolded or given an inline definition.
- Example ratio: after more than two consecutive paragraphs of abstraction, the text must land on a concrete example (code, data, incident, scenario).
- Figure discipline: every figure is referenced in the body ("see Figure N") and has a self-contained caption — legible even when screenshotted alone.
- Uncertainty stated honestly: performance / cost / risk claims carry conditions and magnitudes; no bare assertions.
- `protectedTerms`: empty array (the brief injects the topic's technical terms).

`applicableLanguages: ["zh","en"]`.

### 5.2 `academic`

Position: strictly argued academic writing (papers, long surveys, and academic-style technical reports).

Rule highlights:
- Paper skeleton: abstract/introduction (contribution list), related work, method, evaluation/argument, limitations, conclusion. A missing limitations section is itself a defect.
- Claim-evidence pairing: every non-trivial claim is backed by a citation, data, or a formal argument; claim strength matches evidence strength (correlational evidence must not be worded as causal).
- Hedge protection: hedges such as "may" / "suggest" / "consistent with" must not be weakened or removed during copy editing (a semantic rule beyond protectedTerms; goes into the review rubric).
- Terminology consistency: one concept, one name throughout; synonymous paraphrase appears only at first definition.
- Citation discipline: every citation has a carrying sentence in the body (no parenthetical stacking), and the citation supports what the sentence actually says.
- Tense and voice: method in past tense / passive or the venue's established convention; contribution list in present tense.

`applicableLanguages: ["zh","en"]`.

### 5.3 `natural-prose`

Position: informal, conversational, readable writing — blogs, essays, newsletters. Distinction from `opinion`: opinion serves argument; natural-prose serves "sounds like a person talking." It complements the four existing formal profiles, and its rules subtract rather than add:

- Ban templated openings ("in today's rapidly developing era"; "with the growing popularity of …") and templated endings ("in conclusion … let us look forward together").
- Paragraph breathing: average paragraph length stays under 5 sentences; three consecutive equal-length paragraphs is a defect (monotone rhythm).
- No filler triads; delete three-part summaries that carry no information.
- Consistent voice and reader distance: one "speaker" throughout; no mid-piece switch from chatting to preaching.
- First-sentence hook: the opening sentence puts the reader inside a concrete scene or problem; no background survey openers.
- Every sentence survives being read aloud without stumbling (the read-aloud test).

`applicableLanguages: ["zh","en"]`. Division of labor with local post-hoc de-AI-flavor cleanup skills on the zh side: this profile operates only inside writing-workflow (as rules) and never invokes those one-shot cleanup skills; the two can be used in sequence without conflict.

### 5.4 `engineering-strategy` — Tier B

Position: a document reporting technical strategy or roadmap choices to management. Its spec comes directly from the book digests in §2.2.

**structure skeleton** (new field; see §6):

```json
{
  "structure": {
    "openingPattern": "scqa",
    "sections": [
      {"id": "summary",     "headingHint": "TL;DR / 摘要", "required": true,  "order": 1},
      {"id": "policy",      "headingHint": "指导方针",     "required": true,  "order": 2},
      {"id": "operations",  "headingHint": "落实机制",     "required": false, "order": 3},
      {"id": "diagnosis",   "headingHint": "诊断",         "required": true,  "order": 4},
      {"id": "explore",      "headingHint": "背景与调研",   "required": false, "order": 5}
    ],
    "audienceVariantNote": "Approval audience: policy first. Org rollout: policy + operations first. Diagnosis and explore go last but must not be deleted."
  }
}
```

Rule highlights (style rules beyond the structure):
- The three policy questions: every guiding policy passes Applicable / Enforced / Creates Leverage (the Primer quality gate).
- Explicit tradeoffs: a policy must state what it gives up ("choosing A means not doing B"); a policy without a tradeoff is fluff.
- The four banned anti-patterns (Rumelt): fluff, failure to face the challenge, goals-as-strategy, bad objectives — checked item by item at review.
- Specificity: policies are stated as ratios / thresholds / mechanisms ("new services default to Rust unless X", "20% platform time each quarter"), not direction adjectives.
- Length discipline: assume a 1-2 page budget (vision-class documents cap at 2 pages), details behind links; assume the reader vanishes at page three.
- Show your work: the diagnosis retains data and reasoning (roadmap, competitive pressure, financial constraints, issues collected in 1:1s) for future readers to trace.
- The document carries its metadata: date, approval status, canonical-source link, and where to ask questions (a named channel or person).
- Before release, an uninvolved reader flags unclear areas (carried by the workflow's review stage; noted in the SKILL.md routing text).

`applicableLanguages: ["zh","en"]`.

## 6. Schema change (Tier B)

`validateProfile` in `check-profile.lib.mjs` gains validation for an optional `structure` field:

```
structure?: {
  openingPattern?: "scqa" | "none",
  sections: [{ id, headingHint, required: boolean, order: number }],
  audienceVariantNote?: string
}
```

Constraints:
- When `sections` is non-empty: `id` unique, `order` strictly increasing starting from 1.
- `openingPattern` currently allows only `"scqa" | "none"` — the enum stays minimal; extend only with book-backed evidence.
- Profiles without `structure` (all existing profiles and the three Tier A additions) behave unchanged. The change is additive and optional; `schemaVersion` stays `1`. Note that the current `readObject` rejects unknown fields, so "adding an optional field within the same version" means every reader (`validateProfile`) must extend its allow-list in the same PR. Profiles ship only inside the package, so there is no cross-version profile circulation today; revisit as v2 only if that ever changes.

**Mechanical-verification boundary (key decision D5)**: at check time the `outline` check (deliberately not named `structure` — that is an existing review stage; see below) verifies exactly two things:
1. Every `required:true` section exists in the final body (by heading match; see below).
2. The skeleton sections that do appear keep their declared relative order.

**Not verified**: section writing quality, whether the opening truly reads as SCQA, whether a policy implies a tradeoff — these are model judgments at review time, encoded in profile rules and the review rubric. This boundary continues the "prompts, not gates" promise.

**Naming (fold of r1 P1-4)**: the new concept is uniformly called `outline` (the profile field remains `structure` because it describes the document's structure; the check result category is `outline`). The word `structure` is already taken by a review stage (`STAGES`, `schema.lib.mjs:156`) and a proposal intent (`PROPOSAL_INTENTS:177`), both model-judgment surfaces (the `reviews/` artifacts); the new check is mechanical, and the name collision would tempt an implementer to wire it into the structure review flow.

**Artifact home and replay contract (fold of r1 P0-1)**: the outline result does **not** go into the check artifact's `changes` array. Every `changes` entry is `{type ∈ CHANGE_TYPES, before, after, disposition, reason}` (`check-profile.lib.mjs:44-90`), produced exclusively by `compareBodies`, and `verifyMechanicalChanges` (`record.lib.mjs:390-408`) **rejects any change the mechanical replay cannot reproduce** — "a required section is missing" is an absolute property of the after-body with no natural before/after representation; putting it into `changes` either fails replay validation or forces a fabricated diff. Instead the check artifact gains a **top-level `outline` field**:

```
outline?: {
  status: "compliant" | "non-compliant",
  missingRequiredSections: string[],   // section ids
  orderViolations: [{section, declaredOrder, actualOrder}]
}
```

- `outline` is a pure function of the after-body: computed when the check is recorded, recomputed and compared on replay from the body hash — isomorphic to the `checks/` artifact's "independently verifiable" contract — and it **leaves untouched** `CHANGE_TYPES`, `compareBodies`, `verifyMechanicalChanges`, and `mechanicalStatus` (`clean` still means only "empty mechanical diff"; it no longer implies outline compliance — the two are separated, each honest).
- The field is present only when the run's profile declares `structure`; the check artifact shape is unchanged for every other profile.

**Enforcement path (folds of r2 P0/P1 and r3 F1)**: outline non-compliance **mints no finding**. Findings exist only in review artifacts (`validateReview` requires stage ∈ `STAGES` and category ∈ the closed `CATEGORIES` list, `schema.lib.mjs:156-172`, plus position fields an outline violation does not have); the check-record step has no channel that mints findings. Instead `outline.status` feeds directly into **`evaluateCompletion`** (`mutation.lib.mjs:299-338`): when the latest check has `outline.status === "non-compliant"`, **finalize is blocked** (completion judges `blocked`, with the reason pointing at outline). Note that `derivePhase` (`state.lib.mjs:167-199`) still advances a run that has recorded a check to `phase:'checked'` — this design **does not touch phase derivation**; "blocked at finalize, not at checked" is the accepted behavior contract, and no new state is added to the state machine. The repair path is the workflow's ordinary path: revise the body (proposal/apply or a fresh draft) → re-check → `outline.status` becomes compliant. No new finding category, no new `PROPOSAL_INTENTS` entry, no review-schema change.

**Implementation sites (folds of r2 P1 and r3 F1/F5, pinned to functions)**:
1. `check-profile.lib.mjs`, `validateCheck`: the `readObject` field allow-list gains an **optional** top-level `outline` field with a fixed nested shape — `status ∈ {"compliant","non-compliant"}` (readEnum), `missingRequiredSections: string[]`, `orderViolations: [{section: string, declaredOrder: number, actualOrder: number}]` (nested readObject). Optionality is a hard requirement: existing check artifacts of profile-less runs and old runs carry no such field.
2. `record.lib.mjs` (`recordCheck`): outline computation plus replay verification against the body hash (alongside `verifyMechanicalChanges`, which already reads the after-snapshot here).
3. `mutation.lib.mjs` (`evaluateCompletion`): gains the outline input (above). Exit vocabulary (r4 P2 pin): on outline non-compliance, **reuse the existing run `outcome:"blocked"`** (`contracts.md:53` already contains the value; the enum is unchanged) and add an `"outline"` entry to `missing` — no new outcome value.
4. `commands.lib.mjs:234-252` (`nextRequiredStage`): when the latest check is outline-non-compliant, return the new stage token `re-check` (one addition to the vocabulary; the only new exit besides `finalize`), with the guidance text "add the required sections and re-check". Insertion point pinned: **immediately before** the `finalize` decision in the write branch's priority chain (so `re-check` is reachable only after structure/semantic reviews are present and a check is recorded).
5. Matcher edges (fold of r2 P2): one H2 heading serves at most one skeleton section (when two sections' alternative lists hit the same heading, the section with the lower `declaredOrder` wins the match); when a section is hit by multiple identical headings, the first match wins.
6. `outline` appears only when the profile declares `structure`; the check artifact shape is unchanged for every other profile.

**Matcher specification (fold of r1 P1-3, pinned to pure heading matching)**:
- Match **H2 only** (ATX `##`). Setext headings count as prose per the current `markdown.lib.mjs:136` behavior and do not participate — a known limitation, to be documented in contracts.md. A document with no H2 ⇒ every required section is reported missing.
- `headingHint` is a `/`-separated list of alternative headings (e.g. `"TL;DR / 摘要"`). Match rule: each H2 heading text, trimmed and lowercased, is compared for **equality** (no substring, no language normalization) against each alternative, trimmed and lowercased. A hit means the skeleton section exists.
- Relative order: `declaredOrder` must be strictly increasing **only among H2s that matched skeleton sections**; H2s matching no skeleton section (the author's own sections) may sit anywhere and do not affect the verdict. Optional sections may be absent.
- No positional fallback. A reworded heading that misses ⇒ judged compliant (a soft-match miss), backstopped by the profile rule at review — this keeps the verdict deterministic and replayable, with the cost (misses) declared honestly in contracts.md. A `synonyms` array remains available to profile authors as a manual way to extend the alternatives (the `/` list in `headingHint` already suffices); no fuzzy matching.

## 7. Implementation checklist (by file)

| # | File | Change |
|---|---|---|
| 1 | `scripts/schema.lib.mjs:141` | Add the 4 ids to PROFILES |
| 2 | `profiles/technical-essay.json` etc. ×4 | New profiles (§5 specs) |
| 3 | `scripts/check-profile.lib.mjs` | validateProfile gains `structure` validation; validateCheck's `readObject` allow-list gains the top-level `outline` field |
| 4 | `scripts/record.lib.mjs` (recordCheck) + `scripts/mutation.lib.mjs` (evaluateCompletion) + `scripts/commands.lib.mjs:234-252` (nextRequiredStage gains the `re-check` token) | Outline computation + body-hash replay verification + finalize gate + guidance text (§6 enforcement path; `CHANGE_TYPES` / `compareBodies` / `verifyMechanicalChanges` / `mechanicalStatus` / `derivePhase` all untouched) |
| 5 | `references/contracts.md` | Phase 1 changes only the Brief.profile enum text (:33); **the §6 structure contract belongs to Phase 2** (r3 F4: Phase 1 must not ship a contract for a field that does not exist yet) |
| 6 | `article-writing/SKILL.md` | Routing table +4 rows (:40) + profile description paragraph (:67-73) + trigger description gains "engineering strategy / roadmap reporting" |
| 7 | `article-review/SKILL.md` | Add the (currently missing) profile row |
| 8 | `language-editing/SKILL.md:37` | Update the "closest profile" enumeration |
| 9 | `README.md` + `README.zh.md` | Genre sentence + profile count (four → eight), both languages in sync |
| 10 | `README.i18n.yaml` | Re-record hashes with `pnpm check:readme --write` (use check:readme's write channel; `pnpm docs:parity` does not pass it through) |
| 11 | `tests/package-shape.spec.ts:23` | Add the 4 ids to PROFILE_IDS (drives the schema-validation loop) |
| 12 | `tests/contracts.spec.ts` | Phase 1 part: enum pin gains cases for the three new ids (`poetry` still fails); Phase 2 part: positive/negative `structure` validation cases + positive/negative `outline`-field cases for validateCheck |
| 13 | `tests/workflow.spec.ts` / fixtures | End-to-end outline-gate case for engineering-strategy (§8.2) |
| 14 | Repo-root `.claude-plugin/marketplace.json:16-19` (note: **not** inside the plugin package — the package ships only `.claude-plugin/plugin.json`; the r1 review corrected the original wrong path) | Description update (no test pin; text only) |

Explicitly untouched: `OPERATIONS`, `BRIEF_FIELDS`, `derivePhase` (r3 F1: the phase still advances to `checked`; the gate is at finalize — note nextRequiredStage moved into the "do" list, row 4), the capability manifest (`docs/claude-code-capabilities.yaml` has no dsh-cc-writing row, verified), and the cc-plugin-loader test (the 4-skill pin is unchanged).

## 8. Verification plan

1. **Unit tests** (vitest, in-package): positive/negative `structure` validation (missing required section / inverted order / a profile without `structure` unaffected); the profile loop validation (package-shape automatically covers the 4 new JSON files); enum pin (new ids accepted, `poetry` rejected).
2. **End-to-end** (fixtures driving `writing.mjs`, walking the full write-op chain): init(profile=engineering-strategy) → record research/plan/draft → record structure review + semantics review (all findings addressed) → record check (semanticStatus reaches no-issue-found) → that check reports `outline.status="non-compliant"` (missingRequiredSections non-empty, `changes` empty and `mechanicalStatus:"clean"` — the two stay separated, each honest). At this point assert the gate attribution is isolatable: `status` hits the outline reason, not review-missing (control-variable fixture: a second case missing only reviews but not outline; the two errors must be distinguishable). `nextRequiredStage === 're-check'`. → Revise the body to add the section (the ordinary draft/proposal/apply path) → re-review + re-check with `outline.status="compliant"` → finalize passes. Assert exit codes, gate attribution, the `re-check` token, and replay consistency (recomputed outline equals the recorded value field by field).
3. **Gates**: `pnpm check:readme`, the in-package vitest suite. (The docs-only portion touches nothing else; capability/parity verified unrelated to this package.)
4. **Live acceptance** (a separate session after implementation): run real strategy material through article-writing + the engineering-strategy profile and manually check the SCQA opening, policy-first ordering, and diagnosis-last placement against the §5.4 spec.

## 9. Phased delivery

**Phase 1 (small PR, pure data, three Tier A profiles only)**: #1 (enum gains only technical-essay / academic / natural-prose), the three JSON files from #2, #5 (enum text only) + #6-#10 doc sync, and the Phase 1 parts of #11/#12. **engineering-strategy moves wholly to Phase 2** (fold of r1 P1-2: `validateProfile`'s `readObject` rejects unknown fields, so a Phase 1 carrying an engineering-strategy.json with `structure` would go red on the `package-shape.spec.ts:153-163` profile-validation loop; the enum entry and the profile file must land in the same PR as the schema capability). Estimated diff ~450 lines.

- **Phase 2 (logic PR, stacked on Phase 1)**: #3/#4 — the `structure` schema, the check artifact's `outline` field, the matcher, and the evaluateCompletion gate (the folded §6 specs) — plus the engineering-strategy profile and its enum entry, the Phase 2 part of #12, the #13 end-to-end cases, and the contracts.md §6 contract. Estimated diff ~400 lines.
- Both phases on one worktree as stacked PRs, Phase 2 based on Phase 1.

## 10. Risks and open questions

1. **Heading-match brittleness** (settled in §6: pure headingHint equality matching, no positional fallback; misses backstopped by review; declared in contracts.md). The remaining open question is only whether to NFC-normalize full-width/half-width differences in Chinese headings first — leaning yes (one line of code; the verdict stays deterministic).
2. **Silent profile absence** (today `state.lib.mjs:56` returns a null profile for a missing file): with the enum growing to 7-8 entries, the "enum has it, disk does not" configuration error becomes more common. Phase 1 should make `loadProfile` fail loudly for an in-enum id with a missing file. Folded supplement (r1 P2-6): fail with `INVALID_INPUT`, raised at the `loadRun` boundary; the blast radius is every state-loading command on the same run, but profiles ship inside the package and never go missing there, so the realistic trigger is plugin downgrade or manual disk edits; land it as its own commit whose message states the expected observable change.
3. **Boundary between natural-prose and the local cleanup skills**: the documentation must state the division of labor (rule-based, in-workflow vs one-shot post-draft cleanup) so users are not confused by the two channels. README/SKILL text only; no code.
4. **Bilingual rule-writing cost**: are profile instructions language-neutral or written twice (zh/en)? `technical-ste` today is en-only. Decision: the three everyday genres get English rules (model-consumed, language-neutral), with headingHints and user-facing hints bilingual. engineering-strategy's Chinese strategy-document market is large; its rules are written in English with bilingual examples.
5. **Long-term shape of the `structure` field**: if `academic` later needs a skeleton (IMRaD), the field must support per-language variants (Chinese paper skeletons). Only engineering-strategy consumes it today; no variant machinery yet — YAGNI.
