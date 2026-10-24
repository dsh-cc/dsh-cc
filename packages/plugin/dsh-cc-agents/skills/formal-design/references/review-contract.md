# Review, handoff and acceptance contract

## Authorities and admission

Use only the current effective project's review rules for reviewer identities,
dispatch, approval thresholds and existing report trailers. The project's existing three review lanes retain those rules. This skill adds
no fourth lane or substitute reviewer. Missing rules are a concrete workflow
blocker, not permission to quote an old roster. Main dialog owns semantics,
coverage, findings, consolidation, approval reuse and acceptance. Reviewers
are read-only: they inspect evidence and request any mutating independent
re-run from the main dialog. No background reviewer runs check in the project.

| Condition | Review admission | Implementation admission |
|---|---|---|
| Missing/invalid/stale audit | Blocked | Blocked |
| Valid audit but any case counterexample/error/incomplete/not-run | Blocked | Blocked |
| All cases verified but incomplete coverage or unresolved finding | Blocked | Blocked |
| Fresh verified complete coverage and resolved findings | Existing formal review may start | Wait for required approvals |
| Any lane has incomplete evidence or unresolved blocker | Incomplete; supply evidence or revise | Blocked |
| Same inputDigest approved under current rules; fresh verified evidence | Complete | Allowed |
| Tool-only change, unchanged inputs, successful all-case re-check/audit and complete reuse record | Historical approvals may be reused | Allowed under existing approval requirements |

Explicit scoped user waivers return to the modified ordinary pipeline, labeled
waived/unverified. They are never evidence satisfying the enabled-task gate.
A non-verified expansion cannot be called optional to enter review. Deleting a
failing property/action or making an unsupported assumption merely to pass is
forbidden. Reviewers challenge requirement completeness, fault/race coverage,
critical abstractions, and preservation of atomicity and assumptions.

## Preparation before workflow integration

For every remote lane, establish feasibility through its actual existing
user-authorized channel before integrating this workflow. Local reviewers may
use accessible paths; remote reviewers need accessible exact full contents.
Producer-only paths and inline summaries are not transport. Representative
files may establish initial feasibility before a runner exists, but do not
establish actual runner-package acceptance. No new service/uploader, expanded
channel limit or implicit external authorization is added.

Record effective rule source/session/revision, authorized lane identities,
channel, probe date, actual byte/file counts, producer/receiver enumeration
and hashes, reconstruction/read results and failed attempts. Test a log larger
than the channel's inline limit and a representative multi-case package.
Sixteen 50 MiB logs can approach 800 MiB; do not claim universal capacity.
Record tested bounds and block any actual package exceeding them. Reconfirm
when rules, channel, receiver access or package size invalidates the probe.
Missing protocol or capable route blocks integration; main dialog requests a
scoped decision rather than weakening the full-log gate.

Readiness claims are separate: runner contracts implemented; workflow
prerequisites established; actual workflow acceptance complete. None implies
the next. An explicitly authorized implementation exception must be recorded
as such, with pending acceptance still visible, not fabricated probe results.

## Complete package, one run

Deliver all of the following to every required lane:

- Exact bytes of every evidence.inputFiles path: design.md, checks.json,
  all direct-child .tla files and every declared cfg, with relative paths.
- Matching current-run.json and evidence.json; runId/inputDigest;
  runnerPackage, runnerDigest, toolchainDigest, toolchainVersion and jarSha256.
- Full persisted stdout AND stderr for every attempted configured case,
  preserving evidence's project-relative paths and matching SHA-256 hashes.
  A summary, excerpt, missing empty stderr or wrong-run file is insufficient.
- The producing main dialog's complete check-evidence JSON result showing
  valid/fresh/verification=verified, completed coverage assessment, planned
  implementation mapping, regression scenarios and counterexample dispositions.
  Outside-design records reference the same inputDigest; unresolved findings
  block formal dispatch.

Record each lane's package identity and accessible artifacts in implementation.md
or the review record, outside inputs. Each lane confirms runId/inputDigest,
full enumeration/cfg bytes, both log hashes, replay-derived eventCodes,
statistics, warnings, case verdicts and all-case aggregation. Distinguish those
from trusted wrapper observations (exit/signal/timing/spawn/cancel metadata),
and review model sufficiency. Record actual tools used. Receiving a committed
summary alone is not local check-evidence success. That claim requires the
actual read-only command against a complete reconstructed local package with
matching installed runner/toolchain; old Java/JAR paths need not exist.

Missing, truncated, inaccessible, mismatched or summary-only input produces
“blocked: incomplete review evidence”, naming paths and expected runId/digest.
This is a review disposition, not a new CLI status, and cannot count as approval.
Supply the complete same-run package or independently re-run and redispatch
one complete new-run package to every unfinished lane. Never mix runs. After
completed approval, the tool-only reuse exception below permits historical
approval references with one fresh current run instead of redispatch.

## Handoff, change adjudication and reuse

Executor receives approved inputDigest/design path, fresh complete evidence,
actual approval references, concrete code plan, planned atomicity/code/test
mapping and commands with expected assertions. It can implement pinned plans,
mechanically generate files and run designated checks. It cannot invent
fairness/cancel/idempotency semantics, weaken properties, broaden claims beyond
bounds or modify an approved model to fit code. Ambiguity is a Blocker.
Formal enablement alone does not escalate to marathon.

At acceptance, implementation.md maps the same requirement/property/action IDs
to actual code locations, mechanisms, tests/results, unmodeled scope and
deviations, keyed to the approved digest. Do not replace planned design.md
cells merely to record progress. A name change/helper extraction preserving
the approved transition, guard and atomicity needs mapped code tests. Restoring
an omitted approved guard needs a justified restoring fix and regression.
Changing an atomic transaction to separate read/write, persistence order or
ownership semantics updates design/model and requires re-check/review. If
equivalence is uncertain, affected work pauses for main-dialog adjudication.

Input/model/design/config/property/assumption/bound changes invalidate evidence
and approvals. Tool-only upgrades permit reuse only with unchanged inputDigest,
every case verified, a fresh valid audit, complete original approval references
and no unresolved findings. Main dialog records upgrade scope (including
parser/classifier or TLC changes), old/new runner/tool/JAR/run identities,
case outcome/warning/configuration comparisons, relevant release changes or
known issues, explanations of differences and finding dispositions. Historical
lanes did not review the new execution; this is the stated trust policy, not
proof of tool equivalence. Current evidence contains only the new run; original
approvals retain their original identities as separate historical references.

## Actual workflow acceptance record

Do not substitute keyword checks for session behavior. Record actual responses,
artifacts and gate states for explicit invocation, orchestration selection,
effective-rule screening (including not-needed), missing/unconfirmed adoption,
waiver/conflict scope, not-needed becoming retries, missing Java/timeout,
expansion failure, partial cfg recovery, acceptance bookkeeping versus semantic
change, tool-only historical approval reuse versus changed inputs, reviewer
assumption changes, executor atomicity blockers and newly discovered duplicate
callbacks. Preserve failures rather than “just delete the property and code”.

Exercise rejected rollback/omitted-charge abstractions and the eligible bounded
logical-state case with actual rationale. Demonstrate both cancel/complete
orders, retry/old completion and cancel/pending delivery. For each remote lane
actually deliver a large/full multi-case runner package, record receiver
hash/replay and access/capacity failures, missing one stderr, truncation,
wrong-run logs and summary-only rejection. All approval claims require the
actual effective rule-provided lanes. Pending scenarios remain pending.
