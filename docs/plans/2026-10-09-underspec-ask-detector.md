# Under-specified target → ASK detector for gauge (design)

- Date: 2026-10-09
- Status: draft v3 — internal critic GO after 2 rounds; user sign-off pending. NOT yet implemented.
- Scope: `packages/interaction/permission-rules` only (gauge adapter, probe lane, stage merge, settings schema) + capability manifest evidence rows + transcript event additive field. No new package. Default OFF (opt-in dogfood).
- Sources: UnderSpecBench (under underspecified instructions, action-boundary violations run 55.8–67.8%; blast-radius prompting barely helps — *asking must be a first-class action*), SafetySentry (EXECUTE/ASK/REFUSE ternary gate — dsh-cc auto-mode already implements it; this design adds a second, orthogonal question on the same gate).

## 1. Problem

gauge/laya's System One lane answers one question: *is this action risky?*
UnderSpecBench shows a different, orthogonal failure dominates in the wild:
**the action's target/scope is under-specified relative to the apparent task**
— `rm -rf .` when the user named one file, a force-push without a named branch,
a batch rewrite when the task named one file. These actions can be perfectly
"low risk" by the risk rubric and still wrong, because the rubric never asks
whether the target is known. UnderSpecBench's key finding: prompt-level
blast-radius warnings barely move this; the fix is making ASK a first-class
outcome driven by its own criterion.

Probe-verified dsh-cc facts (2026-10-09, this worktree):

- The verdict pipeline's merge point for a second detector:
  `packages/interaction/permission-rules/src/auto-stage.ts:322-331` (eligibility
  gate: auto mode + passthrough + LOW/MEDIUM + not read-only), dispatch at
  `:341` into `systemOneEscalate`
  (`packages/interaction/permission-rules/src/gauge-stage.ts:184`), whose verdict
  merge returns at `gauge-stage.ts:252` (`allow→allow`, else `ask`).
- The System One request carries a **questions map**:
  `prepareSystemOneInput` (`gauge-adapter.ts:163`) builds `questions =
  { verdict: buildVerdictQuestion(slots) }` (`:168`, builder `:94`);
  `systemoneDecide` takes the whole map (`gauge-adapter.ts:296`); answers come
  back keyed by question name (`probe-systemone.ts:96` reads
   `result.answers['noul']` — the read-by-name pattern precedent; the
   multi-question shape itself is proven by the Day-0 live probe, §3.1 below).
- Budget machinery exists for added payload: `capMiddleToTokenBudget`
  (`probe-systemone.ts:67,72`), truncation detection `isTruncated`
  (`gauge-adapter.ts:226`, used `probe-systemone.ts:93` → fail-open).
- Classifier event emission: `CLASSIFIER_EVENT = 'permission/classifier'`
  (`classifier-audit.ts:14`), assembled in `systemOneEscalate`
  (`gauge-stage.ts:233-250`) with fields
  tool/digest/verdict/callId/route/provider/model/reason/probabilities/confidence/latencyMs/cacheHit
  — an additive optional field here is cheap and back-compatible (event consumers
  read by key).
- Settings: namespace `permissions` (`index.ts:151`), schema sections
  `autoMode.classifier.*` / `autoMode.probe.*` (`settings-schema.ts:247,263`),
  absence-preserving idiom `z.union([…, z.const(undefined)])`, consumption via
  `readSlice` (`auto-stage.ts:169`) and defaults at `:181-183`.
- No ambiguity heuristic exists anywhere today (probe: ABSENT); shell
  primitives available: `firstShellToken` (`shell-words.ts:25`),
  `stripLeadingAssignments` (`:11`).

## 2. Goals and non-goals

Goal: when the System One lane is armed and the new detector flag is on, every
classified bash/edit/write call additionally answers the question *"is the
action's target/scope under-specified relative to the visible task?"*; an
`ask` answer escalates the final verdict to `ask` with a reason that names
under-specification (never hallucinating risk).

Non-goals:

- No changes to the risk rubric, thresholds, or the HIGH-deny tier
  (`decide.ts:125` is untouched).
- No deterministic ambiguity heuristic (rejected up front as primary: brittle
  wordlists; keep the model — one extra question on the same request, no extra
  call).
- No chat-lane (classifier) second question in v1 (the System One probe lane is
  the production lane per the gauge series; chat lane follow-up §7).
- No new verdict tier: the output folds into the existing ternary.

## 3. Design

### 3.0 Code-change checklist (named sites)

- `gauge-adapter.ts`: add `buildAmbiguityQuestion`; `prepareSystemOneInput`
  questions type at `:151` gains `ambiguity?: SystemOneQuestion`;
  `classifyViaSystemOne` return type + budget drop rule (§3.1);
  `GatedVerdict` (`:230-236`) gains optional `ambiguity`.
- `gauge-stage.ts`: `SystemOneClassification` (`~:40-60`) gains optional
  `ambiguity`; event assembly `:233-250` appends the field; cache key
  (`:105-112`) and cache.set (`:134`) carry it (§3.0a-c below).
- `auto-stage.ts`: `readSlice` / `AutoModeSlice` (`:160-190`) gain
  `ambiguityAsk`; include the flag in the `raw` rebuild string at `:184`
  (so toggling it invalidates derived state); thread through dispatch at
  `:341` into `createSystemOneLane` options.
- `settings-schema.ts`: `autoModeProbeSchema` (`:263`) gains
  `ambiguityAsk` (absence-preserving addition).
- `classifier-audit.ts`: event type gains the optional `ambiguity` field;
  digest-only posture unchanged.

Cache plumbing (BLOCKER-2 resolution, all adopted):

a. Extend `GatedVerdict` (`gauge-adapter.ts:230-236`) and
   `SystemOneClassification` (`gauge-stage.ts ~:40-60`) with optional
   `ambiguity`.
b. Fold the flag/question-set digest into the cache key via a **dedicated
   new param** on `classificationKey` (`llm-classifier.ts:165`) — do NOT
   overload `contextDigest` — so flag toggles rotate keys.
c. `cache.set` (`gauge-stage.ts:134`) stores the extended verdict so cache
   hits carry `ambiguity`.
d. Tests (§5): cache-hit returns `ambiguity`; flag toggle produces a
   different key.

### 3.1 The second question

In `prepareSystemOneInput`, when `autoMode.probe.ambiguityAsk` is enabled, add
`questions.ambiguity = buildAmbiguityQuestion(slots)` next to `verdict`:

- **Choice type** with two options: `specified` / `underspecified`.
- Instructions (draft, tuned at implementation): the action is underspecified
  when its targets or blast radius cannot be inferred from the visible
  task context — examples: recursive deletion without a named target, glob
  deletes, force operations without a named branch/ref, batch edits where the
  task named a single file, install/remove of packages the task never named.
  NOT underspecified: commands whose targets are named explicitly, reads, and
  idempotent checks.
- The payload slots already fed to the question builder are the tool call's
  own text (`gauge-adapter.ts:139-140` reads `command`/`file_path` presence),
  so no new slot plumbing. Question text tuning follows the existing
  criteria-slot idiom (`buildVerdictQuestion`, `gauge-adapter.ts:94`).

**Day-0 probe, 2026-10-09, CLOSED.** A real POST to the production System One
gateway (`POST http://127.0.0.1:8080/v1/systemone`, model `bjev`) with a
questions map of THREE choice questions — `{verdict, ambiguity}` plus a decoy
key with a typo `'ambiguitY'` — returned `answers` keyed by question name for
ALL three, in one request: 124 input tokens / 56.8ms. The multi-question
wire shape is verified end to end, closing the former BLOCKER-1. Sample
behavior is healthy: for `rm -rf .` with a single-file task, `ambiguity`
answered `underspecified` (confidence 0.9668) while `verdict` said `deny` —
the two signals are orthogonal as designed. Guard test kept: a wire-shape
unit test asserting the client request supports a multi-question map and the
response parser reads answers by name (the `probe-systemone.ts:96` pattern),
so a future gateway regression fails the suite. Note: the probe lane has its
OWN questions literal — the two-question shape cannot reuse
`prepareSystemOneInput` unchanged; the guard test targets the shared
client/`systemoneDecide` path (`gauge-adapter.ts:296`).

Budget semantics (honest version): the added question consumes the same
budget pool and can push a borderline state past `MIN_STATE_TOKENS`, at which
point `classifyViaSystemOne` (`gauge-adapter.ts:290-293`) short-circuits the
WHOLE call to `ask` — i.e. fail-closed on the primary risk lane, not
fail-open on the detector. Mitigations, spec'd:

a. The ambiguity question's instructions are hard-capped tiny: **≤600 chars
   of instructions + criteria text total**.
b. When adding the question would trip `budgetExhausted`, drop ONLY the
   ambiguity question and proceed with the verdict alone (record
   `ambiguity: undefined`).
c. Test asserting default-window calls with a representative payload do NOT
   trip `budgetExhausted` with the question added (§5).

### 3.2 Merge rule

In `systemOneEscalate` (`gauge-stage.ts`), after the existing verdict merge
(yielding `final ∈ {allow, ask}` at `:252`):

```
if (enabled && verdict.ambiguity === 'underspecified' && final === 'allow')
  final = ask(reason: "target/scope under-specified (underspec detector)")
```

(the `answers` map does not exist in `systemOneEscalate` scope — the
ambiguity value arrives on the lane result; local naming in `gauge-stage.ts`
may differ.)

Underspecified never converts `ask`→`allow` and never touches `deny` paths
(gauge never denies — see the in-repo comment at `gauge-stage.ts:12-13`:
the adapter collapses deny→ask). The reason string is sanitized at the single serviceAsk funnel
(`packages/core/tools/src/runtime-code.ts` sanitize precedent from PR #209) —
our reason is a fixed template, so it passes through unchanged.

### 3.3 Event and transcript surface

`permission/classifier` gains one optional field `ambiguity:
'specified'|'underspecified'|undefined`. Back-compatible (absent when the flag
is off or the answer is missing). The classifier event assembly site
(`gauge-stage.ts:233-250`) appends it; `classifier-audit.ts` digest-only posture
unchanged. The failure-path / stale-mode audit rows (`gauge-stage.ts:226-233`
and `:219`) omit the field by design — they describe a cache/failure outcome,
not a classification answer.

### 3.4 Settings

Add to the `autoMode.probe` settings section (`settings-schema.ts:263`),
absence-preserving:

- `permissions.autoMode.probe.ambiguityAsk` — boolean, default OFF
  (dogfood-first; matches the gauge-series flip pattern).

Read via `readSlice` (`auto-stage.ts:169`) with the same default. Hot-reload
comes free with the settings publish seam (PR #127).

### 3.5 Failure discipline

- Missing/truncated ambiguity answer ⇒ treated as absent (fail-open to the
  existing verdict), explicitly *not* as `underspecified` — mirroring
  `isTruncated` fail-open (`probe-systemone.ts:93`).
- Any detector exception inside the lane ⇒ detector result dropped, verdict
  pipeline untouched (never mask the risk verdict).

## 4. Edge cases and interplay

- `classifyAllShell` and segment-level L1/L2 evaluation run upstream of this;
  the ambiguity question sees the same payload the verdict question sees — no
  interaction.
- Allow-rule suspension (`auto-rule-filter.ts`) still applies; a suspended rule
  never reaches the classifier, so it never reaches this detector — status quo
  preserved (documented, matches the gauge landscape memory).
- Sessions without a probe backend configured: flag is a no-op (lane absent ⇒
  no second question possible; no error).
- The detector cannot see approval decisions; it only escalates allow→ask.

## 5. Verification plan

Unit tests (package-internal, vitest; note vitest4 timeout-as-third-arg
convention):

1. `prepareSystemOneInput` with flag on/off ⇒ questions map contains/omits
   `ambiguity`; budget shortfall ⇒ omitted, not error.
2. Merge: all four combinations of (final ∈ {allow, ask}) × (ambiguity ∈
   {specified, underspecified, absent}) — escalation only on (allow,
   underspecified).
3. Event: `permission/classifier` rows carry the additive field when enabled;
   absent otherwise.
4. Fail-open: simulated truncation/absent answer ⇒ verdict unchanged.
5. Cache plumbing: cache-hit returns `ambiguity`; a flag toggle produces a
   different `classificationKey` (dedicated param, not `contextDigest`).
6. Budget: default-window calls with a representative payload do NOT trip
   `budgetExhausted` with the ambiguity question added; forcing the trip
   drops only the ambiguity question and proceeds with the verdict alone.
7. Wire-shape guard (Day-0 probe, CLOSED): client request supports a
   multi-question map; response parser reads answers by name
   (`probe-systemone.ts:96` pattern) against the shared
   client/`systemoneDecide` path (`gauge-adapter.ts:296`).
8. Gates: `pnpm check:capabilities` (evidence rows updated), `docs:parity`,
   package tests, `check:file-size` (gauge-adapter/gauge-stage are size-tracked
   files — the diff budget is tiny but checked).

Dogfood (config-is-prompt; the gauge dogfood rubric exists from the gauge
series): enable on the dsh-cc repo for one week; expected observables in
transcripts: `permission/classifier.ambiguity` present; escalation rate in the
low single digits (UnderSpecBench's 55.8–67.8% figure is a benchmark average
over deliberately under-specified tasks, NOT our traffic's base rate — the
dogfood number must be reported, not assumed); manual spot-check of the first
20 escalations for sanity.

## 6. Why a model question and not a wordlist

UnderSpecBench's result is precisely that the ambiguity signal is semantic
(scope relative to task), and its prompt-mitigation result is that *warning*
the model doesn't move it — the fix is an explicit decision point. A wordlist
("contains rm -rf") double-counts risk classification and cannot express scope
mismatch. The second question on the same backend call costs one question
slot, zero extra requests.

## 7. Follow-ups

1. Chat-lane parity (add the same question to the classifier chat lane) if
   dogfood shows the probe lane isn't the only consumer path in the wild.
2. Calibration: cohort escalation quality by model/version once the D3 config
   snapshot event exists (cross-design dependency, noted in both docs).
3. If precision proves poor, per UnderSpecBench, tighten criteria text and
   re-dogfood — the tuning surface is the question text only.

## 8. Review ledger

- Round 1 (2026-10-09, internal critic): verdict **GO-WITH-AMENDMENTS**.
  - BLOCKER-1 (multi-question wire shape unverified): **CLOSED** by live
    gateway probe — three named questions (incl. typo decoy) answered by
    name in one request, 124 input tokens / 56.8ms; healthy sample behavior
    (`rm -rf .` → `underspecified`, conf 0.9668, verdict `deny`). Guard
    wire-shape test kept (§3.1, §5).
  - BLOCKER-2 (cache plumbing): folded as the named checklist in §3.0
    (GatedVerdict/SystemOneClassification field, dedicated
    `classificationKey` param, cache.set extension, tests).
  - 3 MAJOR findings (budget fail-closed honesty + mitigations; named
    code-change checklist; complete §5 tests) and all minor findings
    (in-repo deny→ask comment citation, audit-row omission note,
    criteria-slot idiom for tuning) — **all adopted**.
  - Status: draft v2; round-2 confirm pending; user sign-off pending.
- Round 2 (2026-10-09, internal critic): verdict **GO**; two minors folded —
  §1 evidence pointer corrected to the §3.1 Day-0 probe (`probe-systemone.ts:96`
  cited only as read-pattern precedent); §3.2 pseudo-code reads
  `verdict.ambiguity` (value arrives on the lane result, not `answers`).
  - Status: draft v3 — internal critic GO after 2 rounds; user sign-off pending.
