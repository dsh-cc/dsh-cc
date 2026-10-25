# Formal-design implementation record

Status: skill integration implemented; three-lane review and remote-channel
delivery acceptance recorded below (2026-10-25 revision). Effective-rule
activation, manual workflow scenarios and receiver-side local check-evidence
remain out of scope and are not claimed.
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

1. ~~Obtain the current effective review protocol~~ Resolved for this PR by a
   scoped user decision (2026-10-25): the user directed this round's
   three-lane review and remote-channel delivery acceptance. The AGENTS.md
   forwarding loop remains unrepaired; project-wide screening adoption of
   the rules snippet remains a manual step outside this record.
2. ~~Demonstrate full-file transport/reconstruction through actual authorized
   channels~~ Completed 2026-10-25 for both remote lanes actually used (see
   the delivery-acceptance section): byte-preserving delivery, receiver
   enumeration/hashing/full-log read, a log above the channels' inline
   limit, a multi-case package, and the capacity/access-failure exercise.
   Recorded capacity is what was tested; larger packages stay blocked.
3. Record manual hard-kill and additional filesystem-boundary stress
   scenarios; do not claim unexecuted scenarios as passing. (Pending.)
4. Record all §16.4 real workflow scenarios, including abstraction challenges,
   effective-rule activation, approval reuse and full remote receiver replay.
   (Effective-rule activation and the remaining manual scenarios remain
   pending; receiver-side full-log inspection/replay is recorded above.)
The implementation PR keeps the remaining pending items visible. Local automated
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

## Three-lane implementation review (2026-10-25)

The user supplied the review direction for this round ("three-lane review and
actual remote-channel delivery acceptance"), resolving the pending item 1
below as a scoped user decision for this PR. Lanes: the local critic seat and
the two remote bridge lanes actually used by this repository (codex and grok
canonical bridge launchers). Each remote lane received the same review brief
(implementation files pinned, design sections pinned by line range, live
probes invited, output capped) plus the delivery-acceptance tasks; the local
lane received the review brief only. All three lanes ran blind.

Round 1 verdicts: critic GO-WITH-CHANGES (1 major, 2 minor); codex NO-GO
(1 major, 3 minor — severity calibration, see below); grok GO-WITH-CHANGES
(1 major, 2 minor), after an initial auth interruption on the grok lane was
resolved by user re-login (recorded as interrupted, not consumed).
Substance overlapped on the marketplace-test gap; the codex seat uniquely
reproduced a false-verified channel via a live probe, and the grok seat
independently confirmed the severity fix's preconditions hold (R3: "severity
3/4 forgeries stay unverified"). Adjudication used the
implement-as-written test; every finding is folded or dispositioned:

- Parser severity hole (codex major, reproduced): success-sequence codes
  2187/2193/2186 and the 2199 statistics frame were counted regardless of
  severity, so forged severity-3/4 flow frames could classify a case as
  verified, contradicting §11.1 ("STATE is trace output, not a success
  signal"). All 41 captured real pinned logs emit these codes at severity 0
  only. Fix: `tlc-output.lib.mjs` gates modeIndex/successIndex/finishedIndex
  and the statistics capture on severity 0; red regression test pins
  ordered=false, statistics=null and incomplete/output-invalid for severity-3
  and severity-4 forgeries. Evidence audit replay inherits the fix (same
  frame parser).
- Marketplace cache coverage (critic major / codex minor): the required
  §16.2 byte-preservation coverage exists in
  `packages/compat/cc-plugin-manager/tests/install-dsh-cc-agents.spec.ts`
  (git ls-files byte-compare of every tracked formal-design resource between
  marketplace source and versioned cache, cached bundled-JAR sha256, all
  three cached entrypoints from another cwd) and runs repo-wide in
  presubmit, which builds the sibling harness that spec imports. It was
  briefly added to the dedicated `formal-design.yml` line and reverted:
  that workflow intentionally installs without a harness build, and the
  spec cannot resolve its harness-linked imports there (CI-verified
  failure, recorded here). Presubmit remains its coverage lane.
- macOS symlinked-tmpdir test failures (codex minor, reproduced): the runner
  realpath-normalizes resolved paths while test fixtures were built from the
  un-normalized temp base. Fix: canonical temp bases in the three test rigs.
- Lock ownership loss on stat failure (critic minor): cleanup now also
  unlinks on content equality with this run's lockBytes (unique runId =
  content-level ownership proof) when creation-time inode identity could
  not be captured; a foreign lock is never removed. Two regression tests.
- `--`-leading CLI values rejected (critic minor): conservative fail-closed
  by design; recorded here, no change.
- SKILL.md false inference (grok major): "No cfg generation means TLC
  passed" is false — existing cfgs skip generation and blocked/cancelled
  runs skip it too. Reworded to "Skipped cfg generation only means every
  declared cfg already matched — it says nothing about the check result,
  and blocked or cancelled runs also skip generation."
- Late-signal exit-code clobber (grok minor): check.mjs removed its
  SIGINT/SIGTERM listeners in a finally before process exit, so a late
  signal could fall through to the default signal exit and clobber the
  committed exit code. The listeners now stay installed for the remaining
  process lifetime (§10.1: keep the committed result and its exit code).
  The window is not deterministically unit-testable; the fix is
  inspection-verified with the rationale pinned in the code.
- Missing OOM fixture (grok minor): a real pinned OOM capture was produced
  by running the bundled TLC v1.7.4 with a 16 MiB heap on a large-state
  model — exit 75 with 1000:1 ("Java heap space"), 2103:1, all-zero 2199
  statistics and no 2193. Captured verbatim in
  `tests/fixtures/formal-design/protocol-captures/oom.stdout.txt` and pinned
  in its index.json (exit 75 → error/property-evaluation-failed per the
  §11.3 table; the design forbids prose-cause inference, and the capture
  now documents what a real OOM run classifies as).
- Deliberate missing-file manifest entry (codex "blocker"): that entry is the
  §16.4 channel capacity/access-failure exercise itself; the lane correctly
  reported the package containing it as blocked, not approved. Recorded in
  the delivery-acceptance record; no defect.

Orchestrator-found during folding (disclosed to all lanes): the CLI entry
guard compared `pathToFileURL(process.argv[1])` with `import.meta.url`, so
on macOS a script path through a symlinked directory (for example `/tmp`)
made every command a silent zero-byte exit-0 no-op. Fix:
`realpathSync(process.argv[1])` in all three entrypoints plus a regression
test. This also explains the codex seat's initially failing then passing
test runs on this platform.

Post-fold suites: 117 tests passed across formal-design.spec.ts (85,
including the severity-forgery, symlink-invocation, lock-identity-loss and
real OOM capture regressions), formal-design-integration.spec.ts (21, real
TLC with the bundled JAR), package-shape.spec.ts (9) and
install-dsh-cc-agents.spec.ts (1), plus the readme/spec-deps/
workflow-pipefail static gates. Round 2 (delta/micro confirmation): the
local seat confirmed all its folds OK (GO); the codex seat re-verified its
major fold with its own targeted reproduction (severity-3/4 rejected,
severity-0 statistics/exit-code preconditions intact) and all other folds
(GO); the grok seat's delta round is recorded in the delivery section
below.

## Remote-channel delivery acceptance (§20.8 / §16.4, 2026-10-25)

Effective rule source for this round: the user's direct instruction in this
work line (scoped decision recorded above), not a loadable project protocol;
the AGENTS.md forwarding loop remains unrepaired and is recorded as
unavailable. Remote lanes and channels: the codex and grok bridge lanes as
actually invoked in this repository (canonical launcher, multi-line prompt
via `--prompt-file`, receiver file access inside the workspace checkout).
Both channels' inline mode accepts a single-line prompt only, so every
multi-line payload — including each delivered 2.3 KiB log — exceeds the
inline limit and must be file-delivered; this is the recorded inline limit of
the channel, and byte-preserving delivery was demonstrated by the receivers
enumerating, reading and hashing the files.

Producer package (regenerated with the folded runner, runnerDigest
`f376aa8c…`): the shipped task-lifecycle example as a single-case project
(verified, runId `20261025T031622Z-…c06de26a`, inputDigest recorded in
evidence) and a two-case core+expansion project (both cases verified, same
run timestamp family), each with full raw stdout/stderr logs, evidence.json,
current-run.json, generated cfgs and the producer's complete check-evidence
JSON output (valid/fresh/verified for both). Producer enumeration:
`package-manifest.json` lists all 33 files with byte counts and SHA-256
values; capacity-probe.bin (8,388,608 bytes, SHA-256
`3a3a1e97a704002bf556ce4f7b73a68fceb275a4f1748cf2fa395f1e86c9cb70`); one
deliberately absent missing-probe entry.

Codex receiver results (round 1; that run inspected the pre-fix package with
runnerDigest `dc50be…` — provenance noted, the fold changes only
classification of forged non-zero severities, and the same receiver tasks
were repeated against the regenerated package by the grok lane below):
complete enumeration of both project trees (15 and 18 files), every hash
matching the manifest and each run's recorded log hashes, full-byte read of
all three case logs ending in a complete final frame, runId/inputDigest
agreement across marker/evidence/producer outputs, capacity-probe byte count
and hash match, the missing-probe retrieval failure reported verbatim with
the package correctly declared blocked rather than approved, and an explicit
statement that this is evidence inspection, not a receiver-side
check-evidence run. No delivered component exceeded retrieval capability;
observed capacity is recorded without inferring 800 MiB support.

Grok receiver results (round 1, against the regenerated fixed-runner
package, runnerDigest `f376aa8c…`): complete enumeration of both project
trees (15 and 18 files, no extras/missing), all 33 file hashes matching the
manifest and each run's recorded log hashes, full-byte reads of all three
case logs each ending in a complete final frame, runId/inputDigest
agreement (single: `…c06de26a` / `d16ba77d…`; multi: `…3b1aae31` /
`4c6eb83d…`), capacity-probe byte count and hash match, the missing-probe
retrieval failure (ENOENT) reported with the package correctly declared
incomplete/blocked, and an explicit statement that this is evidence
inspection, not a receiver-side check-evidence run. No delivered component
exceeded retrieval capability.

Final package provenance: after the grok folds the runner scripts changed
once more, so the delivered package was regenerated a final time
(runnerDigest `06e192d4…`, both projects verified, producer check-evidence
valid/verified for both, 33 files re-enumerated with hashes). The grok
delta/micro-confirmation round verified all three of its folds against the
final checkout and spot-checked one delivered log hash against the final
manifest (2329 bytes, match) — VERDICT: GO. All three lanes ended at GO
after delta confirmation: critic GO, codex GO, grok GO.
