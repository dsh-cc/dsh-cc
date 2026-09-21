# Edit Tool Fuzzy Matching and the Read-State Delta

Date: 2026-09-21. Status: **Proposed**. Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960). Design-review record: first draft **amended** in cold review
— it wrongly claimed the harness has no read-state structure (it has
`fs-observation-policy`) and placed the dsh-cc mitigation on a hook point that cannot
reach the model. Both corrected below; anchors re-verified 2026-09-21.

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
  `FS_NOT_OBSERVED` (`tool-fs/src/edit.ts:115-125`). The genuine deltas against ZCode
  are: **(a)** no full-vs-partial observation granularity (a partial Read satisfies the
  gate the same as a full one), **(b)** no bash read-backfill — `cat/head/tail/sed`
  output does not register an observation, so the model pays a redundant Read before the
  next edit even when it just saw the content. (ZCode's `isPartialView`,
  strict-full-read fast path, and mtime/size staleness in
  `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts:421-437`,
  `bash-read-file-state.ts` are the reference behavior.)

**ZCode edit-matcher reference (verified):**

- Eight strategies in fixed narrow→broad order (`edit-matchers.ts:2-9,52-58`); results
  are tri-state with `candidateCount` on ambiguity (`edit-matchers.ts:135`) — **counts
  only, no locations**; BROAD matchers are skipped under `replaceAll`
  (`edit-matchers.ts:62`), a safety property worth adopting as-is.

**dsh-cc hook seam (verified):**

- `PostToolUseFailure` bridging is detached and observe-only
  (`packages/hooks/hooks-claude-code/src/register-events.ts:135`): its outcome goes to
  `turnSafety.detachedOutcome` → user notices/logs. The model cannot see it.
- `PostToolUse` **does run on isError results**, and its `additionalContext` is injected
  via `exec.agent.inject` (`register-events.ts:109-118`, with the documented divergence
  that context lands in the post-result FIFO). `updatedToolOutput` replacement returns
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
   `cat/head/tail/sed -n` invocations and write the same observation records, so a later
   edit proceeds without a redundant Read; (c) keep the success hint ("file state is
   current — no need to Read it back", the ZCode behavior that suppresses pointless
   re-reads).
3. The proposal states measurable deltas (edit not-found event rate, Read-call rate per
   session) instead of quality adjectives.

### Track B — dsh-cc-side mitigation (ships regardless of Track A)

A `PostToolUse` hook (not PostToolUse-Failure: that point is detached and invisible to
the model) that fires when: tool is edit/write, the result `isError`, and the response
matches the not-found shape on a multi-line `old_string`. It returns
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
  model sees it; the check result goes in the implementation commit either way.

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
