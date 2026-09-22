# Edit Tool Fuzzy Matching and the Read-State Delta

Date: 2026-09-21. Status: **Proposed**. Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960). Design-review record: first draft **amended** in cold review
— it wrongly claimed the harness has no read-state structure (it has
`fs-observation-policy`) and placed the dsh-cc mitigation on a hook point that cannot
reach the model. Both corrected below; anchors re-verified 2026-09-21. Round 3
(2026-09-21, cold re-review against HEAD f81883d): the PostToolUse delivery mechanism
was cited as `exec.agent.inject` — that is the PreToolUse path; PostToolUse context
goes out as `additionalContexts` on the decision via `exec.deferContext`. Also fixed:
the `FS_NOT_OBSERVED` throw-site anchor (policy `editIntent`, not edit.ts), the Track B
trigger (no `isError` flag in the hook payload), and the ZCode reference label
(anchors secondhand — no ZCode checkout present). No design-level changes. Round 4
(2026-09-21, ZCode checkout at 872ad96): all ZCode-side anchors verified against
source — every behavioral claim holds exactly; anchor precision fixed
(`edit-matchers.ts:1-10,51-59`, `edit.ts:421-441` with `hasReadStateChanged` at :444,
bash parsing at `bash-read-file-sources.ts:50-63` incl. the single-command `grep`
nuance); the secondhand label is retired.

## 1. Problem

Models — GLM-5.3 class especially — do not reliably reproduce a byte-exact `old_string`
for multi-line replaces (smart quotes, indentation drift, CRLF, unicode arrows). When
the literal match fails, the model either retries the same payload (cost, no progress) or
rereads the file (cost, context growth), and occasionally escapes to a worse channel
(sed via bash). dsh-cc has a production memory of the exact symptom: multi-line
`old_string` reported not-found with byte-identical content; the single-line-anchor
workaround had to be discovered by hand.

## 2. Current state and gap (anchors re-verified)

**harness (read-only checkout):**

- `packages/fs/tool-fs/src/edit.ts` is literal-only matching (~168 lines). No fuzzy
  tiers; ambiguity handling is "appears more than once → error".
- **A read-state structure exists**: `packages/fs/fs-observation-policy/src/index.ts`
  (`ObservedStateGate`, a per-session WeakMap registry of `FsObservation` entries whose
  discriminant keeps confirmed-absence distinct from never-seen); the edit tool consumes
  it as a single-slot decision — `{version}` basis for CAS/staleness or a thrown
  `FS_NOT_OBSERVED` — thrown by the policy's `editIntent`
  (`fs-observation-policy/src/index.ts:82`), reached via the `fs/edit-intent` slot
  consumed in `tool-fs/src/edit.ts:115-127`. The genuine deltas against ZCode
  are: **(a)** no full-vs-partial observation granularity (a partial Read satisfies the
  gate the same as a full one), **(b)** no bash read-backfill — `cat/head/tail/sed`
  (and single-command `grep`) output does not register an observation, so the model pays
  a redundant Read before the
  next edit even when it just saw the content. (ZCode's `isPartialView` refusal,
  strict-full-read fast path, and mtime/size staleness at
  `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts:421-441` plus
  `hasReadStateChanged` at :444, and the bash parser in
  `handlers/bash-read-file-sources.ts:50-63` — single invocation only, bails on
  pipes/redirects, registers only non-truncated ≤10 MB reads — are the reference
  behavior.)

**ZCode edit-matcher reference (verified against zai-org/ZCode @ 872ad96):**

- Eight strategies in fixed narrow→broad order (`edit-matchers.ts:1-10,51-59`: exact,
  quote_normalized, line_number_prefix_stripped, escape_normalized,
  unicode_escape_normalized, line_trimmed, indentation_flexible, block_anchor; `exact`
  tried first, then the seven fuzzy tiers); results
  are tri-state with `candidateCount` on ambiguity (`edit-matchers.ts:126-142`) — **counts
  only, no locations**; BROAD matchers (`line_trimmed`, `indentation_flexible`,
  `block_anchor`, `edit-matchers.ts:27-31`) are skipped under `replaceAll`
  (`edit-matchers.ts:62`), a safety property worth adopting as-is.

**dsh-cc hook seam (verified):**

- `PostToolUseFailure` bridging is detached and observe-only
  (`packages/hooks/hooks-claude-code/src/register-events.ts:135`): its outcome goes to
  `turnSafety.detachedOutcome` → user notices/logs. The model cannot see it.
- `PostToolUse` **does run on isError results**; its `additionalContext` is returned as
  `additionalContexts` on the `PostToolDecision` (register-events.ts:144-181) and
  delivered by the harness loop via `exec.deferContext`, landing after the tool result
  and model-visible even on `isError` results. (The `exec.agent.inject` site at
  register-events.ts:109-118 is the *PreToolUse* context path, not PostToolUse.)
  `updatedToolOutput` replacement returns
  `kind:'accept'`, which on an error result would flatten the failure into a
  success-shaped result — forbidden here (see §3 Track B).

## 3. Design

Track A (upstream proposal) is a **delta proposal** against fs-observation-policy, not
greenfield; Track B (dsh-cc mitigation) is re-anchored on PostToolUse.

### Track A — upstream proposal

1. **Match ladder**: the eight-strategy order from the ZCode list, plus the
   `replaceAll`-skips-BROAD rule. Ambiguity reports candidate count; reporting
   *locations* (line numbers) is a deliberate extension beyond ZCode — say so in the
   proposal so it is not oversold as borrowed behavior.
2. **Read-state delta, against the existing gate**: (a) record view extent
   (full vs partial with offset/limit) in `FsObservation` and let edit refuse on
   partial-only observation with a targeted message; (b) bash read-backfill: parse
   `cat/head/tail/sed -n` (and single-command `grep`) invocations and write the same
   observation records — reference: ZCode `handlers/bash-read-file-sources.ts:50-63`
   (single invocation only, bails on pipes/redirects, registers only non-truncated
   ≤10 MB reads) — so a later
   edit proceeds without a redundant Read; (c) keep the success hint ("file state is
   current — no need to Read it back", the ZCode behavior that suppresses pointless
   re-reads). Fair-attribution note: the harness edit tool *description* already
   carries description-level guidance (edit.ts:81: "Read the file first (the default
   fs-observation-policy requires it), unless you just created or edited it in this
   session"); what is absent is the per-result confirmation in the edit success output
   (`formatEditOutput`, edit.ts:64-67) — (c) adds only that.
3. The proposal states measurable deltas (edit not-found event rate, Read-call rate per
   session) instead of quality adjectives.

### Track B — dsh-cc-side mitigation (ships regardless of Track A)

A `PostToolUse` hook (not PostToolUse-Failure: that point is detached and invisible to
the model) that fires when: tool is edit/write and the `tool_response` matches the
not-found shape on a multi-line `old_string` — the hook payload (`payloads.ts:72`)
exposes only `tool_name`, `tool_input`, `tool_response` with no `isError` flag, so
error status is inferred from the not-found shape (which is distinctive; only the
detached PostToolUseFailure payload differs, payloads.ts:81-83). It returns
`additionalContext` with **a fixed, fully static recovery text** (strategy order:
single-line anchor, then split per hunk — the production lesson already in dsh-cc
memory). Hard rules:

- The advice never interpolates `tool_response` or file content — the failure text can
  carry file bytes, and echoing them into injected context would be a prompt-injection
  channel. Static text only.
- `updatedToolOutput` is forbidden: on an error result it would convert the failure into
  an accept-shaped result, which is worse than the defect being treated.
- Before shipping, verify the CCR crusher does not rewrite error tool results
  (`packages/context/context-crusher/src/router.ts` routes tool-result text to
  compressors): if error results are crushed, appended advice could be eaten before the
  model sees it; the check result goes in the implementation commit either way. Head
  start already present: `context-crusher/src/index.ts:198` — `if (result.isError &&
  tokensBefore < 2 * cfg.minBytes) return d` already exempts small error results from
  crushing.

## 4. Expected effect

- Track B immediately: multi-line not-found events convert from "retry same payload or
  reread whole file" to a one-turn cheaper correction; measurable via forensics counts
  of edit not-found followed by sed-via-bash (the bad ending we want to see decline).
- Track A: GLM routes stop paying an extra Read per edit failure; from the production
  lesson, one multi-line failure currently costs a full-file Read on a ≥350-line file
  or a failed retry loop.
- The read-state delta additionally kills a silent waste class: re-reading files the
  model just catted.

## 5. Non-goals and risks

- Fuzzy matching's real hazard: indentation-flexible or block-anchor matches hitting the
  wrong location. The tri-state result and BROAD labeling let the model weigh
  `ambiguous(count=2)` instead of silently editing one; Track A adopts ZCode's
  `replaceAll`-exclusion for the same reason.
- No dsh-cc shadow edit tool: a second edit tool competes with the harness one and
  pollutes parity. dsh-cc stays hook-only.
- Track A acceptance risk: whether full-vs-partial tracking belongs in
  fs-observation-policy is an upstream scoping question; the proposal must name the
  fallback (extent recorded on the observation without changing gate semantics).

## Acceptance (DoD)

- [ ] Upstream proposal document (harness-bound) with the ladder (incl.
      `replaceAll`-BROAD exclusion and the locations-extension note) and the
      read-state delta against `fs-observation-policy`; linked from here.
- [ ] Track B shipped as a PostToolUse hook behind `cc-edit-recovery-hint.enabled`
      (kebab namespace rule per settings-cascade README), unit tests over fabricated
      not-found results proving static-only advice and no `updatedToolOutput`; the CCR
      error-result check recorded in the commit.
- [ ] Capability manifest + `docs:parity` in the same commit; forensics one-pager after
      a dogfood week (edit not-found rate, recovery-path distribution).
