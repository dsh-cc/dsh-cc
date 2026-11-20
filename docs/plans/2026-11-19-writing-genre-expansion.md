# dsh-cc-writing Genre Expansion: Document Types and Engineering Strategy

- Date: 2026-11-19
- Status: Implemented — PR #440 (open, pending merge); design approved by three-seat blind review (all seats GO at 35ca342b)
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

### 2.2 The four books and one specimen (genre spec for engineering strategy)

The four books converge strongly on what a strategy document looks like; the 2016 shareholder letter (end of this section) adds four rules they leave implicit. Together they yield the genre rules for engineering-strategy:

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

**The shareholder letter as a fifth source (2016 Letter to Shareholders)**: the Amazon 2016 letter is a high-grade specimen of executive-grade strategic writing and supplies four rules the four books leave implicit. (a) **Named policies**: its four defenses are section headings — "True Customer Obsession", "Resist Proxies", "Embrace External Trends", "High-Velocity Decision Making" — so the policy, not the section number, is what the organization repeats back. (b) **Calibrated honesty**: "Such a question can't have a simple answer… I don't know the whole answer, but I may know bits of it" — an explicit epistemic downgrade that tells the reader how much weight the reasoning carries; this is not fluff, because fluff is empty confidence rather than a stated limit. (c) **Anecdotes before averages**: good designers "study and understand many anecdotes rather than only the averages you'll find on surveys", because "that's hard to interpret and could unintentionally mislead" — a named incident carries the mechanism where a percentage does not. (d) **A closing self-audit and revisit commitment**: the letter ends by turning each defense into a question for the reader ("Are you falling prey to proxies, or do they serve you?") and, per the Primer's two-month review, names when the strategy will be judged; a document that ends by restating its own goals gives future readers no way to evaluate it.

Genre boundary worth stating explicitly: a shareholder letter is a leadership essay, not an organization-level strategy document of the Larson kind. Its diagnosis is woven through the prose rather than carried by a "Diagnosis" heading, and its section headings *are* the policies — so such a document would not pass the §6 outline check, and that is by design. The `structure` skeleton serves documents that must be enforced through visible, approval-readable sections; it is not a universal document shape.

## 3. Current state and extension seams (code anchors)

- The only closed set for profiles: `skills/writing-workflow/scripts/schema.lib.mjs:141`, `PROFILES = ['technical','research','opinion','technical-ste']`. `brief.profile` goes through `readEnum` at `brief-run.lib.mjs:104`; an unknown id fails with `INVALID_INPUT` before any file lookup.
- Profile loading: `state.lib.mjs:51-59` reads `profiles/<id>.json` by id; **a missing file is silent** (returns a null profile) — the enum and the on-disk file are two independent gates with opposite failure modes.
- Profile schema: `check-profile.lib.mjs:121-147` — `schemaVersion: 1` (numeric literal), `id`, `description`, `applicableLanguages:string[]`, `rules:[{id,instruction,rationale,severity}]`, `protectedTerms:string[]`; unknown fields are rejected.
- **Genre branching exists in exactly one place in code**: protected terms feeding the mechanical compare (`preservation.lib.mjs:107-108`). Phase derivation and record gating branch on `operation` (write/review/edit), never on profile.
- Synchronization surfaces (the change list): the `schema.lib.mjs` enum; `references/contracts.md:33` and its §6; the `article-writing/SKILL.md:40,67-73` routing table; `language-editing/SKILL.md:38`; `article-review/SKILL.md:33-41` (currently has no profile row — this change adds one); `README.md:17-18,129` + `README.zh.md:16,113` (both languages must move in the same commit; re-record hashes with `pnpm check:readme --write`); `tests/package-shape.spec.ts:23` `PROFILE_IDS` (drives the schema-validation loop); `tests/contracts.spec.ts:294` (enum pin: `profile:'poetry'` must fail); the description in the repo-root `.claude-plugin/marketplace.json`.
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

Rule encoding convention for all four profiles: each bullet below becomes exactly one entry in the profile's `rules` array — `id` is `<profile>-` + the kebab-cased text before the bullet's first colon (or the full lead phrase through the first semicolon when there is no colon), dropping parentheticals (e.g. `technical-essay-single-throughline`); `instruction` is the bullet text verbatim; `rationale` cites the source in §2 (or "user genre requirement" for §5-only rules); and `severity` is `advisory` for every style rule — style rules are model-judgment prompts, consistent with "prompts, not gates"; no style rule is `required` (the only `required`-grade enforcement in this design is the mechanical outline gate of §6). Bullets that assign profile fields rather than style rules (e.g. `protectedTerms` in §5.1) are profile fields, not `rules` entries.

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
- Paragraph breathing: average paragraph length is at most five sentences; three consecutive equal-length paragraphs is a defect (monotone rhythm).
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
      {"id": "summary",     "headingHint": "TL;DR / Summary / 摘要",   "required": true,  "order": 1},
      {"id": "policy",      "headingHint": "Guiding Policy / 指导方针", "required": true,  "order": 2},
      {"id": "operations",  "headingHint": "Operations / 落实机制",    "required": false, "order": 3},
      {"id": "diagnosis",   "headingHint": "Diagnosis / 诊断",        "required": true,  "order": 4},
      {"id": "explore",     "headingHint": "Explore / 背景与调研",     "required": false, "order": 5}
    ],
    "audienceVariantNote": "Approval audience: policy first. Org rollout: policy + operations first. Diagnosis and explore go last but must not be deleted. / 审批场景 policy 前置；组织落地场景 policy+operations 前置；diagnosis/explore 殿后但不可删。"
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
- Close with a self-audit and a revisit commitment: turn each policy back on the reader as a yes/no audit question, and name the point at which the strategy's effect will be reviewed (a date, an event, or an observable threshold); ending on a restatement of the goals leaves the document unjudgeable later (2016 Letter to Shareholders, closing audit questions; Primer, Ch. 3, review after two months).
- Name the policies: each guiding policy gets a short name that survives being quoted out of context ("High-Velocity Decision Making", "Resist Proxies") — the name is the unit the organization repeats back, so an unnamed policy decays into a section number (2016 Letter to Shareholders, four named defenses).
- Calibrated honesty: state plainly what you do not know and how confident you are; fluff is empty confidence, whereas a stated limit tells the reader how much weight the reasoning carries (2016 Letter to Shareholders, epistemic downgrade; Rumelt, Ch. 3).
- Anecdotes before averages: support the diagnosis with named incidents and first-hand observations, not only survey averages — one traced anecdote carries the mechanism and the stakes, where a percentage alone is hard to interpret and can mislead (2016 Letter to Shareholders, anecdotes vs. survey averages).

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

**Enforcement path (folds of r2 P0/P1, r3 F1, and the English round; wiring pinned verbatim)**: outline non-compliance **mints no finding**. Findings exist only in review artifacts (`validateReview` requires stage ∈ `STAGES` and category ∈ the closed `CATEGORIES` list, `schema.lib.mjs:156-172`, plus position fields an outline violation does not have); the check-record step has no channel that mints findings. Instead `outline.status` feeds into **`evaluateCompletion`** (`mutation.lib.mjs:297-333`), wired exactly as follows:
- (a) the completion `missing` list includes `'outline'` iff the current check's `outline.status === 'non-compliant'` **and its `afterHash` snapshot is readable** (an unavailable check contributes `'final-check'`, not `'outline'`; all other missing-stage entries are computed exactly as today and retained);
- (b) the editorial `evaluateCompletion.outcome` is `'blocked'` **iff `missing` is exactly `['outline']`** — any other missing-stage token alongside or instead of `'outline'` keeps the editorial outcome `'incomplete'` as today; `majorOpen` / `blockingChanges` are not consulted when `'outline'` is in `missing`;
- (c) `finalizeCommand` persists `run.outcome = (completion.outcome === 'blocked' || completion.blocked) ? 'blocked' : 'active'` — the disjunction preserves the existing snapshot-loss `'blocked'` semantics of `completion.blocked` (`mutation.lib.mjs:320-332`), which is **not** overloaded;
- (d) finalize's failure behavior and exit codes are otherwise unchanged.

`derivePhase` (`state.lib.mjs:167-199`) still advances a run that has recorded a check to `phase:'checked'` — this design **does not touch phase derivation**; "blocked at finalize, not at checked" is the accepted behavior contract, and no new state is added to the state machine. The repair path is the workflow's ordinary path: revise the body, take a new snapshot, re-review, re-check → `outline.status` becomes compliant. No new finding category, no new `PROPOSAL_INTENTS` entry, no review-schema change.

**Implementation sites (pinned to functions; folds of r2 P1, r3 F1/F5, and the English-round seats)**:
1. `check-profile.lib.mjs`, `validateCheck`: the `readObject` field allow-list gains an **optional** top-level `outline` field with a fixed nested shape — `status ∈ {"compliant","non-compliant"}` (readEnum), `missingRequiredSections: string[]`, `orderViolations: [{section: string, declaredOrder: number, actualOrder: number}]` (nested readObject). Optionality is a hard requirement: existing check artifacts of profile-less runs and old runs carry no such field.
2. Shared outline module, used by **both** checks writers — `record.lib.mjs` (`recordCheck`) and `mutation.lib.mjs:183-214` (`compareCommand`, which stores its check directly at `:212`, bypassing `recordCheck`): a single exported `computeOutline(structure, afterText)` plus `verifyOutline(check, afterText, structure)` that recomputes and compares field by field — the `structure` argument is mandatory because the same body yields different outlines under different profiles. Provenance is compute-and-inject, never model-supplied: a `record check` payload carrying an `outline` key is **rejected with `INVALID_INPUT`** (add `'outline'` to the `INJECTED_HASH_FIELDS`-style guard, `record.lib.mjs:32,41-45`); the `compare` path takes no model payload (`INPUT_KEYS` at `commands.lib.mjs:260`), so the guard is record-only by construction. Presence symmetry: when the run's profile has no `structure`, a stored `outline` field is `INVALID_INPUT`; when it has one, a missing `outline` field is `INVALID_INPUT`. Stored-artifact replay lives at the **check-consuming** sites — `evaluateCompletion` and `finalize`, reached via the `loadContext` path where `ctx.profile` is available — and **not** in `currentCheck` (whose `finalChecked` consumer feeds `derivePhase`, contradicting the no-phase-derivation contract) and **not** on the `status`/`nextRequiredStage` path (`statusCommand` builds `ctx.profile = null`, `commands.lib.mjs:166-175`; status reads the stored `check.outline.status` as-is). Snapshot-loss interplay: when the selected check's `afterHash` snapshot file is missing (the exact case `completion.blocked` exists for), the recompute is **skipped** — and this skip **short-circuits before the presence-symmetry check** (a structured-profile check with a missing snapshot and a missing `outline` field takes the skip path: `'final-check'` in `missing` and `REVIEW_INCOMPLETE`, not `INVALID_INPUT`) — the check is treated as unavailable, `'final-check'` enters `missing`, its stored `outline` is not consumed, and finalize persists `'blocked'` through the existing `completion.blocked` arm and fails `REVIEW_INCOMPLETE`; outline divergence fails `INVALID_INPUT` only when the snapshot is readable. **Status is advisory on stored values**: `status`/`nextRequiredStage` read the stored `check.outline.status` as-is and may therefore disagree with finalize (the recompute authority) after snapshot loss or artifact tampering — this observable split is intended and to be documented in the contracts.md §6 contract. `validateCheck`'s shape check serves these reload paths; the "present iff the profile declares `structure`" invariant is enforced at the injection sites (which hold the run context), not in `validateCheck` (which does not). `compareCommand` verifies by construction (it computes the field itself); its replay contract is asserted by re-invoking `compare` and checking byte-identical outline output.
3. `mutation.lib.mjs` (`evaluateCompletion`): gains the outline input with the four-point wiring above.
4. `commands.lib.mjs:234-252` (`nextRequiredStage`): when the latest check is outline-non-compliant, return the new stage token `re-check` (one addition to the vocabulary; the only new exit besides `finalize`), with the guidance text "add the required sections and re-check". Insertion point pinned: **immediately before** the `finalize` decision in the **write branch's** priority chain (so `re-check` is reachable only after structure/semantic reviews are present and a check is recorded). The token is deliberately write-branch only: engineering-strategy rides `article-writing`, which is `operation:"write"`; the edit branch gains no new token.
5. Matcher edges: assignment proceeds over H2 headings in document order; each heading goes to the not-yet-matched section with the lowest `declaredOrder` whose alternatives contain it (so one H2 serves at most one section, and a section hit by multiple identical headings keeps the first match).
6. `outline` appears only when the profile declares `structure`; the check artifact shape is unchanged for every other profile.

**Matcher specification (pinned to pure heading matching)**:
- Match **H2 only** (ATX `##`). Setext headings count as prose per the current `markdown.lib.mjs:136` behavior and do not participate — a known limitation, to be documented in contracts.md. A document with no H2 ⇒ every required section is reported missing.
- Heading text extraction (order matters — CommonMark permits up to three leading spaces, which `scanBlocks` accepts): trim the line, strip the leading `#{1,6}`, strip any trailing closing hashes, trim again, then lowercase. The matcher reads the ATX line itself (the `scanBlocks` heading records carry only offsets and level, not text — `markdown.lib.mjs:128-131`).
- `headingHint` alternatives are split on `/` (unconditionally; no alternative may itself contain `/`), and each alternative is trimmed and lowercased before the equality comparison. No substring matching, no language or width normalization. A hit means the skeleton section exists; authors use one alternative as the actual H2 text, never the whole hint string.
- Verdict: a `required:true` section with no matching H2 goes into `missingRequiredSections` and makes `outline.status` non-compliant — **including the case where the author merely reworded the heading**; there is no leniency for reworded required sections. Absent optional sections and H2s matching no skeleton section (the author's own sections) are harmless.
- Relative order: over the H2s that matched skeleton sections, in document order, the `declaredOrder` sequence must be strictly increasing. Violation enumeration (deterministic): walk the matched headings in document order keeping a running maximum of `declaredOrder`; every matched section whose `declaredOrder` is below that running maximum is reported in `orderViolations`, in document order, with `actualOrder` = its 1-based rank among matched skeleton H2s. An inversion makes `outline.status` non-compliant.
- No positional fallback and no fuzzy matching. `headingHint`'s `/`-separated alternative list is the only extensibility mechanism; no `synonyms` field exists in the schema.

## 7. Implementation checklist (by file, with phase assignment)

| # | File | Change | Phase |
|---|---|---|---|
| 1 | `scripts/schema.lib.mjs:141` | Phase 1 adds technical-essay / academic / natural-prose to PROFILES; Phase 2 adds engineering-strategy | 1+2 |
| 2 | `profiles/technical-essay.json`, `profiles/academic.json`, `profiles/natural-prose.json` / `profiles/engineering-strategy.json` | New profiles (§5 specs; rule encoding per the §5 convention) | 1 / 2 |
| 3 | `scripts/check-profile.lib.mjs` | validateProfile gains `structure` validation; validateCheck's `readObject` allow-list gains the optional top-level `outline` field | 2 |
| 4 | `scripts/record.lib.mjs` (recordCheck) + `scripts/mutation.lib.mjs` (`compareCommand` at :183-214 — the second checks writer — and `evaluateCompletion`) + `scripts/commands.lib.mjs:234-252` (nextRequiredStage gains the write-branch `re-check` token) | Outline pure function computed and injected by both checks writers; body-hash replay verification; the four-point evaluateCompletion/finalize wiring; guidance text (§6; `CHANGE_TYPES` / `compareBodies` / `verifyMechanicalChanges` / `mechanicalStatus` / `derivePhase` / `completion.blocked` all untouched) | 2 |
| 5 | `references/contracts.md` | Phase 1 changes only the Brief.profile enum text (:33); Phase 2 adds the §6 structure/outline contract | 1+2 |
| 6 | `article-writing/SKILL.md` | Phase 1: routing rows for the three new profiles (:40) + profile description paragraph (:67-73); Phase 2: the engineering-strategy routing row and the "engineering strategy / roadmap reporting" trigger phrase | 1+2 |
| 7 | `article-review/SKILL.md` | Add the (currently missing) profile row — three entries in Phase 1, the fourth in Phase 2 | 1+2 |
| 8 | `language-editing/SKILL.md:38` | Update the "closest profile" enumeration — three entries in Phase 1, the fourth in Phase 2 | 1+2 |
| 9 | `README.md` + `README.zh.md` | Genre sentence + profile count: four → seven in Phase 1, seven → eight in Phase 2, both languages in sync | 1+2 |
| 10 | `README.i18n.yaml` | Re-record hashes with `pnpm check:readme --write` (use check:readme's write channel; `pnpm docs:parity` does not pass it through) | 1+2 |
| 11 | `tests/package-shape.spec.ts:23` | PROFILE_IDS: three ids in Phase 1, the fourth in Phase 2 (the array drives both the packaged-file check and the profile-validation loop, `:98-100,153-169`) | 1+2 |
| 12 | `tests/contracts.spec.ts` | Phase 1: enum pin cases for the three new ids (`poetry` still fails); Phase 2: positive/negative `structure` validation + positive/negative `outline`-field cases for validateCheck | 1+2 |
| 13 | `tests/workflow.spec.ts` / fixtures | End-to-end outline-gate case for engineering-strategy (§8.2), covering both check producers (`record check` and `compare`) | 2 |
| 14 | Repo-root `.claude-plugin/marketplace.json:16-19` (note: **not** inside the plugin package — the package ships only `.claude-plugin/plugin.json`) | Description update (no test pin; text only) | 2 |
| 15 | `references/workflow.md` | Completion/next-stage table gains the `re-check` row (agents read this reference) | 2 |
| 16 | `references/review-rubric.md` | Phase 1: academic hedge-protection note; Phase 2: engineering-strategy structural judgments (SCQA quality, tradeoff presence, anti-pattern lint) as review guidance | 1+2 |
| 17 | `scripts/report.lib.mjs` | Surface the editorial `blocked` / outline reason on the report/status path so the finalize failure is attributable | 2 |
| 18 | `scripts/state.lib.mjs` (`loadContext` boundary, :34-48) | `loadProfile` fails loudly (`INVALID_INPUT`) for an in-enum id whose file is missing; own commit with the expected observable change in its message (see §10.2) | 2 |

Explicitly untouched: `OPERATIONS`, `BRIEF_FIELDS`, `derivePhase` (the phase still advances to `checked`; the gate is at finalize), the `completion.blocked` snapshot-missing boolean, the capability manifest (`docs/claude-code-capabilities.yaml` has no dsh-cc-writing row, verified), and the cc-plugin-loader test (the 4-skill pin is unchanged).

## 8. Verification plan

1. **Unit tests** (vitest, in-package): positive/negative `structure` validation (missing required section / inverted order / a profile without `structure` unaffected); the profile loop validation (package-shape automatically covers the 4 new JSON files); enum pin (new ids accepted, `poetry` rejected).
2. **End-to-end** (fixtures driving `writing.mjs`, walking the real write-op chain — note there is no `record draft` kind; drafting is writing the body file and taking a snapshot): init(profile=engineering-strategy) → write the body (missing a required section) → `snapshot` → record plan + context (context is required before any check) → record structure review (no findings) → record semantics review (no findings) → record check (semanticStatus reaches no-issue-found; this check reports `outline.status="non-compliant"`, `missingRequiredSections` non-empty, `changes` empty and `mechanicalStatus:"clean"`). Assertions at this point: `status.nextStage === 're-check'`; invoking `finalize` fails with the outline reason exposed on its error surface (`missing` is exactly `['outline']`; the persisted run `outcome` is `'blocked'`); a **mixed-list control case** — an otherwise-identical run missing the reviews *and* the outline reports `missing:['structure-review',…,'outline']` with editorial outcome `'incomplete'` and persisted outcome `'active'`, distinct from both the outline-only case and a reviews-only case. → Repair path (new snapshot, not proposal/apply — outline mints no finding, so no proposal can target it): rewrite the body with the required sections → new `snapshot` → re-record structure review, semantics review, and check (`record check` stays the last check before finalize — a `compare`-produced check always carries `semanticStatus:'not-run'`, which would yield `'findings-present'` at `evaluateCompletion:325-326` and fail finalize on the wrong axis) → `outline.status="compliant"` → `finalize` passes. The `compare` producer gets its own case: re-invoke `compare` on the same body and assert byte-identical outline output; plus a stored-outline divergence case — hand-edit a stored check's `outline` on disk and assert the next check-consuming command (`finalize`, not `status`) fails `INVALID_INPUT`; plus a snapshot-loss case — delete the selected check's `afterHash` snapshot after a non-compliant check and assert finalize still persists `outcome:'blocked'` via the `completion.blocked` arm and fails `REVIEW_INCOMPLETE`, with `missing` containing `'final-check'` and **excluding** `'outline'` (recompute skipped and (a) gated on snapshot readability, per §6). Assert exit codes, gate attribution, the `re-check` token, and replay consistency (recomputed outline equals the stored value field by field, on both check producers).
3. **Gates**: `pnpm check:readme`, the in-package vitest suite. (The docs-only portion touches nothing else; capability/parity verified unrelated to this package.)
4. **Live acceptance** (a separate session after implementation): run real strategy material through article-writing + the engineering-strategy profile and manually check the SCQA opening, policy-first ordering, and diagnosis-last placement against the §5.4 spec.

## 9. Phased delivery

**Phase 1 (small PR, pure data, three Tier A profiles only)**: the Phase-1 halves of rows #1/#2/#5/#6/#7/#8/#9/#10/#11/#12 and row #16's Phase-1 half (the academic hedge-protection note in review-rubric.md) — the enum gains only technical-essay / academic / natural-prose, three profile JSONs, doc sync at "seven profiles", and the Phase-1 test parts. **engineering-strategy moves wholly to Phase 2** (fold of r1 P1-2: `validateProfile`'s `readObject` rejects unknown fields, so a Phase 1 carrying an engineering-strategy.json with `structure` would go red on the `package-shape.spec.ts:153-163` profile-validation loop; the enum entry and the profile file must land in the same PR as the schema capability). Phase 1 contains **no** logic change — the `loadProfile` fail-loud change (row 18) is deliberately Phase 2 to keep this PR pure data. Estimated diff ~450 lines.

- **Phase 2 (logic PR, stacked on Phase 1)**: rows #3/#4/#15/#17/#18 in full, the Phase-2 halves of rows #1/#2/#5/#6/#7/#8/#9/#10/#11/#12, row #16's Phase-2 part, plus #13's end-to-end cases, #14, and the contracts.md §6 contract. Estimated diff ~450 lines.
- Both phases on one worktree as stacked PRs, Phase 2 based on Phase 1.

## 10. Risks and open questions

1. **Heading-match brittleness** (settled in §6: pure headingHint equality matching, no positional fallback; a reworded required heading is reported missing and blocks finalize — authors must use the declared headings or extend the `/` alternatives). The matcher's comparison-side normalization is closed as **trim + lowercase only** (the hash stripping of §6 is extraction, not comparison folding); full-width/half-width folding (e.g. `Ａ` vs `A`) is explicitly out of scope for this design — note Unicode NFC does not fold width, so any future folding needs an explicit width-folding rule (NFKC or a targeted U+FF01-FF5E map), decided when a real zh heading case demands it.
2. **Silent profile absence** (today `state.lib.mjs:56` returns a null profile for a missing file): with the enum growing to 7-8 entries, the "enum has it, disk does not" configuration error becomes more common. Make `loadProfile` fail loudly for an in-enum id with a missing file (row 18, Phase 2, own commit): fail with `INVALID_INPUT`, raised at the `loadContext` boundary (`state.lib.mjs:34-48` — every state-loading command goes through it; `statusCommand` builds its context separately and is out of scope). The blast radius is every state-loading command on the same run, but profiles ship inside the package and never go missing there, so the realistic trigger is plugin downgrade or manual disk edits; the commit message must state the expected observable change.
3. **Boundary between natural-prose and the local cleanup skills**: the documentation must state the division of labor (rule-based, in-workflow vs one-shot post-draft cleanup) so users are not confused by the two channels. README/SKILL text only; no code.
4. **Bilingual rule-writing cost**: are profile instructions language-neutral or written twice (zh/en)? `technical-ste` today is en-only. Decision: the three everyday genres get English rules (model-consumed, language-neutral), with headingHints and user-facing hints bilingual. engineering-strategy's Chinese strategy-document market is large; its rules are written in English with bilingual examples.
5. **Long-term shape of the `structure` field**: if `academic` later needs a skeleton (IMRaD), the field must support per-language variants (Chinese paper skeletons). Only engineering-strategy consumes it today; no variant machinery yet — YAGNI.
