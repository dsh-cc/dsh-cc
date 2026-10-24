# Formal-design implementation record

Status: skill integration implemented; remote/manual workflow acceptance pending.
Date: 2026-10-24. This is an implementation record, not formal design approval or actual
remote/manual workflow acceptance.

## Scope and authority

Design: `2026-10-23-formal-design-skills.md`, implementation-contract revision
at repository baseline `3bddc9ee68019c49840c1774dcb8b579fb781829`.
The user requested TDD implementation and a PR after completion, and then
specified that only current AGENTS.md is the project-rule source. No
historical AGENTS.md roster, CLAUDE.md traversal, or invented reviewers were
used. AGENTS.md and CLAUDE.md are unchanged.

Current AGENTS.md was read locally and fetched again from main during this
work. Its Git blob is `7c0dadd52aaacbe3858d125efd7ba64983e6c03b`.
It contains a seven-line forwarding stub with an `@AGENTS.md` self-reference,
not an effective three-lane dispatch/approval protocol. Current project-wide
screening adoption and required reviewer identities cannot be established
from that source. The main dialog owns reporting this dependency; the user
owns supplying a current protocol or making an explicit scoped design decision.

The original design §17 permits independent steps 1–3, but requires step 4 to wait for
both available effective review rules and the §20.8 actual-channel
feasibility record for every remote lane. Neither prerequisite is established.
No remote transport probe, receiver inspection/replay, or remote approval is
claimed. No new service/uploader or implicit channel authorization was added.
The forwarding-rule repair is outside the design's authorized scope.

After the checkpoint and an explicit explanation of this prerequisite, the
user instructed: “继续完成技能集成和PR” (continue skill integration and the PR).
This authorizes completion of implementation/integration and opening the PR
while the three-lane review/remote-delivery acceptance remain explicitly pending.
This is a scoped exception for this implementation, not a change to the shipped
skill's normal review or adoption rules. No unavailable protocol or channel is
represented as established.

## Implemented

- Strict duplicate-key JSON parsing, exact manifest schema, constants grammar,
  deterministic cfg serialization and stable public blocker ordering.
- Flat Node runner modules, pinned toolchain, identity validation, path and
  input enumeration/limits, raw-byte fingerprints and cfg drift detection.
- Read-only preflight; bounded Java probe with scrubbed environment,
  normalization, output/deadline limits and cancellation.
- Sequential isolated TLC cases; exact argv; raw separate logs, bounded
  prefix capture, TERM/KILL handling, per-model lock and ownership cleanup.
- Running/finished markers, retained atomic cfg generation, cancellation
  observation boundary and synchronous final publication, failure recovery
  that cannot present old success as the latest completed attempt.
- Read-only evidence audit with schema, marker/lock, input/tool freshness,
  log presence/hash and streamed parser/classifier replay checks. Validity
  and verification are separate results.
- Minimal model copied verbatim from §18; buggy callback and explicit
  delivered-tag companion fixtures, bounded liveness and protocol fixtures;
  illustrative design matrix and workflow walkthrough. No actual task
  handler verification or external-effect guarantee is claimed.

Skill integration now includes SKILL.md, modeling/review/adoption references,
orchestration and critic/executor duties, four-skill descriptions in all six
surfaces, bilingual README hashes, npm-pack package assertions (including
marathon), and a dedicated pinned-TLC CI workflow. CI checks out the same
sibling harness pin as presubmit, verifies the bundled JAR before tests, fails if the
JAR is absent or corrupt, and preserves hidden .formal-design diagnostics on failure. There is no version bump, dependency addition,
AGENTS.md rewrite, startup hook, or automatic Java/JAR download.

## TDD observations and validation

Tests were written and executed before each implementation increment. Initial
imports failed for missing manifest/fingerprint, parser, process/preflight,
and check/audit modules. Later focused red tests exposed and drove fixes for:
inline nested exception frames, post-child log hashing failures, cancellation
while opening logs, partial owned-lock writes, unexpected audit I/O, and
interleaved Java probe streams. The checked-in tests preserve these cases.

Commands used:

```sh
pnpm exec vitest run packages/plugin/dsh-cc-agents/tests/formal-design.spec.ts packages/plugin/dsh-cc-agents/tests/package-shape.spec.ts
TLA2TOOLS_JAR=/absolute/tla2tools.jar pnpm exec vitest run packages/plugin/dsh-cc-agents/tests/formal-design-integration.spec.ts
node scripts/check-readme.mjs
node scripts/check-spec-deps.mjs
node scripts/check-workflow-pipefail.mjs
node scripts/check-publish-manifests.mjs
npm pack --dry-run --json # in packages/plugin/dsh-cc-agents
```

The sibling deepseek-harness checkout uses the presubmit pin
`c1b47e41fcd54d20a0f061df28683bfc29ee24e5` (not its default branch).
No harness library build is needed for these runner tests.
The original focused runs passed 76 runner contract tests, 9 package-shape
tests and 20 actual TLC integration tests (105 total); bundled-toolchain
coverage is recorded below. README, dependency,
workflow-shell and publish-manifest gates pass; the plugin dry-run manifest
contains all 22 skill/runner/example files. The original full plugin suite passed
120 tests, including its existing skills and hooks. The repository artifact scanner also
passes (99 packages, 35 files checked). A full repository build and the
end-to-end workflow acceptance are not claimed by this checkpoint. A first publish
check used the sibling's newer default prerelease and failed; checking out
the repository's specified pin resolved those manifest diagnostics without
changing this repository.

Real execution used Linux, Node 24.22.1 and OpenJDK 17.0.20. The separately
obtained TLC v1.7.4 JAR matched official SHA-1
`bee4a54f3ee3d4afc347c3240ec2d9e93b075104` and SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
The user subsequently requested committing this exact JAR with the plugin;
the bundled-toolchain revision below supersedes the external-JAR setup.
The runner does not download tools.

| Contract | Concrete automated evidence | Observed scope / remaining limit |
|---|---|---|
| Manifest/cfg (§9) | manifest/cfg, grammar, duplicate keys, concurrent publication and second-generation failure tests | Retains completed cfgs and refuses drift; no reviewed cfg is overwritten |
| Input/path/digest (§8/12/13) | enumeration, helper/support files, nested TLA, unsafe roots/symlinks, size limits, original/snapshot mutation and write-set tests | Only declared inputs are digested/copied; implementation.md remains outside inputs |
| Process/CLI (§10) | argument normalization, version headers, independent probe streams, bounded probe, scrubbed env, termination ladder and log I/O tests | Synthetic clock/process injections; actual Java/TLC runs separately |
| Parsing/classification (§11) | combined-error precedence tests and captured pinned logs under tests/fixtures/formal-design/protocol-captures | Stream stack parsing handles inline nested frames and CRLF/chunk splits; no prose success oracle |
| Lifecycle/persistence (§10/20.7) | cancellation before marker/snapshot/staging/after last case/after commit, failed finished publication, lock acquisition, write/flush/close/hash loss tests | Do not claim exhaustive OS/filesystem fault certification; manual hard-kill scenarios remain pending |
| Audit (§12.1/20.7) | valid counterexample, summary tampering, missing/hash-mismatched logs, schema/I/O, staleness and conservative lock tests | Trusts schema-valid wrapper observations; no cryptographic execution attestation |
| Real bounded models (§14/16/18) | packaged-runner integration tests, plus raw negative-cfg protocol test | Correct/buggy, companion, deadlock, liveness, empty Init, safety PROPERTY and error fixtures exercised |
| Packaging | npm dry-run manifest and git check-ignore validation | Complete skill tree included by npm pack; source-integrity test rejects ignored runner/example/protocol files |
| Adoption/coverage/remote review (§4/5/16.4/20.8) | No claimed acceptance | Pending current rules and actual authorized channels; integration proceeds under the scoped user instruction above, not fabricated acceptance |

Real fixture outcomes include normal exit 0 (both verified and non-verified
empty-Init), 10/11/12/13/14, 75/76, 150/151 and nested cfg-parse 255.
The classifier also pins 77 synthetically; a reachable real exit-77 fixture
has not been established and must not be claimed. General Next and action
arithmetic evaluation exceptions can produce 255 rather than 75 or 13;
under the unchanged classification table these are error/unknown-error.
The raw negative cfg yields nested 1000/5006 and error/config-invalid;
the safe manifest rejects that negative constant before spawning TLC.

The real logs exposed a parser defect: the inner STARTMSG can be preceded
by `: ` on the same line. A red regression preceded the token-stream parser
fix. The actual output agrees with the design's linear nested-frame contract;
no public status, acceptance condition or design requirement was changed.

## Pending workflow acceptance

1. Obtain the current effective review protocol from the authorized source,
   or an explicit scoped user decision changing the prerequisite.
2. Identify each rule-provided remote lane and demonstrate full-file
   transport/reconstruction capacity through its actual existing authorized
   channel, including failures. Record byte/file counts and receiver hashes.
3. Record manual hard-kill and additional filesystem-boundary stress
   scenarios; do not claim unexecuted scenarios as passing.
4. Record all §16.4 real workflow scenarios, including abstraction challenges,
   effective-rule activation, approval reuse and full remote receiver replay.
The implementation PR keeps these pending items visible. Local automated
results are not full workflow acceptance.

## Packaged execution and integration verification

The actual npm tarball was extracted outside the checkout. From a different
cwd, its preflight returned ready-for-check, its check returned verified for
the shipped task-lifecycle example, and its check-evidence returned valid /
verification=verified. This checks the packaged manifest-relative identity
resolution and runner imports, not only source-tree presence. The dedicated
CI missing-JAR path was also executed and failed explicitly as required.
The new workflow YAML, shell syntax and sibling pin were checked locally;
GitHub-hosted workflow execution is reported separately after the PR opens.

## User-approved bundled TLC revision

The user requested that installation include TLC so Java >=17 is the only
additional local prerequisite, then requested updating this PR. The exact
upstream v1.7.4 binary is committed under skills/formal-design/toolchain,
with its original MIT license, JavaMail EPL-2.0 license/source provenance,
and original Eclipse Orbit/Geronimo Activation Apache-2.0 notices. The binary
is unchanged; its Git blob, SHA-1 and SHA-256 are checked. Git attributes
preserve its bytes and the original third-party notices across checkouts.

Selection is --jar > TLA2TOOLS_JAR > the bundled resource. An explicitly
configured missing or checksum-invalid artifact blocks, with no silent
fallback. All selections use the same pinned checksum and record actual
jarPath/jarSha256. No public evidence/CLI schema or model input changes.
No postinstall, prepack or runtime download is added. The JAR is tracked in
normal Git so both marketplace clones and npm packages carry it.

New red tests pinned absent default resources, source precedence, configured
missing paths and packaging/hash integrity before implementation. Packaged
zero-JAR-configuration preflight/check/audit, cache selection and exact bytes
are covered. Cache byte-comparison uses Buffer.equals so a 2.2 MiB binary
is compared exactly without an expensive per-byte assertion traversal.
Dedicated CI validates the bundled resource and runs FORMAL_DESIGN_CI=1 with
TLA2TOOLS_JAR unset; local real TLC tests remain opt-in. The old external-JAR
CI download and missing-environment guard are superseded by these tests.
Review/adoption/remote-acceptance requirements remain as recorded above.

Bundled-toolchain validation: 482 tests passed across plugin-loader,
plugin-manager and the agents plugin, including 21 actual TLC/packaged-run
tests. Configured checksum failure, missing configured/bundled paths and
selection precedence remain explicit failures. README, publish-manifest,
dependency and workflow-shell gates pass. CI YAML/pin/shell syntax also pass.
