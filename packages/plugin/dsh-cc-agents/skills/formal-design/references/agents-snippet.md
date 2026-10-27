# Optional project screening rules

A human can copy the following section into the project's effective rules.
Do not auto-edit AGENTS.md/CLAUDE.md. This snippet adds screening obligations;
it does not supply reviewer identities or replace an existing review protocol.
Installing/updating the plugin alone does not adopt it. Confirm the effective
source/revision and actual screening behavior in the session.

## Formal design screening

After each initial design and before the existing formal design review,
screen changed protocol/state-machine and high-impact deterministic behavior
using the formal-design skill. Enable TLA+ for independent actors changing
shared state where ordering matters; retry, timeout, duplicate or late delivery
affecting outcomes/effects; crash recovery affecting ownership/dedup/persistence
order; or authorization, lease or resource ownership across asynchronous
changes (FD-T1..FD-T4). Enable Lean for permission/policy/eligibility/
configuration composition with a stated invariant; budget/quota/allocation/
ranking arithmetic with a stated conservation/bound/monotonicity/ordering
requirement; a deterministic transformation or algorithm with a requested
general correctness property; or an explicit Lean request (FD-L1..FD-L4). Mere
determinism does not trigger Lean. Select backends `tla`, `lean`, `both` or
`none`, record enabled/not-needed/waived with rationale, trigger IDs and
explicit task directives, and name the business property and the consequence of
violating it. Load the skill on a hit or explicit verification request.
not-needed work returns to the ordinary pipeline without Java or Lean.
Distinguish available skill from adopted project-wide screening; confirm the
effective review rules separately.

An enabled task may enter the existing formal design review only when every
selected backend's own admission predicate holds, at the same recorded inputs:
for `tla`, every configured case (core and expansion) verifies, its evidence is
valid/fresh for the same run and `verification` is `verified`; for `lean`, the
proof evidence is valid/fresh for the same proof input digest with
`proofVerdict: verified` and every required/witness declaration and axiom
dependency accepted. A Lean-only task is never admitted by vacuous TLC-case
verification, and a TLA+-only task is never admitted by a Lean proof. For
`both`, both proof admission and, before implementation acceptance, conformance
admission are required: conformance evidence valid/fresh with
`conformanceVerdict: passed` and its `executionDigest` bound to the same proof
run/digest. A missing, stale or `not-run` required verdict blocks. The complete
coverage matrix must have been checked and no findings may remain unresolved.
Early consultation is not reusable formal approval. An inability to check never
auto-waives; an explicit scoped user waiver is reported as waived, not
verified, and conflicts with mandatory project rules need a decision.

All three existing review lanes receive one complete design/model/config/evidence package
at the same inputDigest/runId (plus, for Lean, the proof input digest and, when
conformance is in scope, the execution digest), including full raw
stdout/stderr for every phase and case and complete coverage/dispositions.
Existing dispatch identities, pass criteria and approval requirements remain
authoritative. Missing/inaccessible/truncated or wrong-run logs block the
affected lane, never count as approval. Prepare actual-channel full-file
capacity before integration and record actual receiver enumeration/hashes/
replay for acceptance. Do not invent a channel, uploader or reviewer roster.
Missing effective review rules permit modeling, but block the review/
implementation gate until resolved by the main dialog.

The executor receives approved inputDigest/design, fresh evidence, the Lean
proof input digest and execution digest when applicable, concrete code plan,
action/property → code/test mapping and regression commands/assertions. It must
not change semantics, assumptions or properties to fit implementation.
Preserve agent report trailers. Main dialog owns coverage and acceptance.

Re-screen when requirements, design revisions, reviewer requests or reported
implementation deviations change protocol or model-checked behavior, including
existing modeled behavior. A newly relevant trigger invalidates an ordinary-
design approval. An executor discovering such a deviation reports Blockers and
pauses affected work. A previous waiver extends only to its recorded scope.
Changes in requirements/model/config/properties/assumptions/atomicity or in the
Lean codec/shared operation contract require re-check and new review. Record
routine observed implementation/test locations outside the digested design so
acceptance bookkeeping does not invalidate approvals.

Tool-only upgrades may reuse historical approvals only under the skill's
unchanged-input, fresh verified all-case check/audit and complete reuse-record
policy. Main dialog owns that decision. Keep historical approvals and the
single fresh current run separate; historical reviewers did not review the
new tool execution. Unresolved findings block reuse. During unfinished review,
a changed run requires one complete new package redispatched to all lanes.
