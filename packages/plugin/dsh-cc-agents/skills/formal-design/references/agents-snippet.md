# Optional project screening rules

A human can copy the following section into the project's effective rules.
Do not auto-edit AGENTS.md/CLAUDE.md. This snippet adds screening obligations;
it does not supply reviewer identities or replace an existing review protocol.
Installing/updating the plugin alone does not adopt it. Confirm the effective
source/revision and actual screening behavior in the session.

## Formal design screening

After each initial design and before the existing formal design review,
screen changed protocol/state-machine behavior using the formal-design skill.
Enable for independent actors changing shared state where ordering matters;
retry, timeout, duplicate or late delivery affecting outcomes/effects; crash
recovery affecting ownership/dedup/persistence order; or authorization, lease
or resource ownership across asynchronous changes. Record enabled/not-needed/
waived with rationale, trigger IDs and explicit task directives. Load the
skill on a hit or explicit TLA+ request. not-needed work returns to the
ordinary pipeline without Java. Distinguish available skill from adopted
project-wide screening; confirm the effective review rules separately.

An enabled task may enter the existing formal design review only when every
configured case (core and expansion) verifies, evidence is valid/fresh for the
same run, the complete coverage matrix has been checked and no findings remain
unresolved. Early consultation is not reusable formal approval. An inability
to check never auto-waives. An explicit scoped user waiver is reported as
waived, not verified; conflicts with mandatory project rules need a decision.

All three existing review lanes receive one complete design/model/config/evidence package
at the same inputDigest/runId, including full raw stdout/stderr for every
case and complete coverage/dispositions. Existing dispatch identities, pass
criteria and approval requirements remain authoritative. Missing/inaccessible/
truncated or wrong-run logs block the affected lane, never count as approval.
Prepare actual-channel full-file capacity before integration and record actual
receiver enumeration/hashes/replay for acceptance. Do not invent a channel,
uploader or reviewer roster. Missing effective review rules permit modeling,
but block the review/implementation gate until resolved by the main dialog.

The executor receives approved digest/design, fresh evidence, concrete code
plan, action/property → code/test mapping and regression commands/assertions.
It must not change semantics, assumptions or properties to fit implementation.
Preserve agent report trailers. Main dialog owns coverage and acceptance.

Re-screen when requirements, design revisions, reviewer requests or reported
implementation deviations change protocol behavior, including existing modeled
behavior. A newly relevant trigger invalidates an ordinary-design approval.
An executor discovering such a deviation reports Blockers and pauses affected
work. A previous waiver extends only to its recorded scope. Changes in
requirements/model/config/properties/assumptions/atomicity require re-check and
new review. Record routine observed implementation/test locations outside the
digested design so acceptance bookkeeping does not invalidate approvals.

Tool-only upgrades may reuse historical approvals only under the skill's
unchanged-input, fresh verified all-case check/audit and complete reuse-record
policy. Main dialog owns that decision. Keep historical approvals and the
single fresh current run separate; historical reviewers did not review the
new tool execution. Unresolved findings block reuse. During unfinished review,
a changed run requires one complete new package redispatched to all lanes.
