# On-demand TLA+ Design Verification Workflow for dsh-cc: Detailed Design

## Status: Design — bundled-toolchain revision (2026-10-24).
User-approved distribution change: ship the unmodified pinned TLC JAR and
its upstream/third-party notices as Git-tracked plugin resources, covering
both npm and Git marketplace installs. Selection is explicit --jar, then
TLA2TOOLS_JAR, then the bundled file. A configured missing/invalid JAR never
silently falls back. Java >=17 remains the only additional local prerequisite
for checks; runtime/installation do not download tools. This supersedes the
older user-supplied-JAR statements in historical review entries.
Earlier r1–r3 review history is retained in the Review ledger; it does not
constitute review of this revision. User authorized this document update
and chose approval reuse after a successful tool-only re-check (§12).
The subsequent user-approved clarification requires every configured case
(including expansion cases) to verify before formal review (§5.2), retains
completed cfg generation on failure (§9.3), and blocks remote approval when
the review package is incomplete (§20.8).
The subsequent user-approved determinism revision specifies log-replay auditing,
the cancellation publication boundary, core/expansion coverage labels, I/O
recovery, conservative lock probing and real remote-delivery acceptance.
The workflow-clarity revision additionally specifies adoption states,
re-screening, flat model inputs, historical approval reuse, remote-channel
feasibility before implementation, and a worked workflow example.
The implementation-readiness clarification adds an ordered classification
algorithm, staged integration prerequisites, reuse ownership, concrete
adoption notices and an explicit late-event companion fixture.
The contract-consistency revision additionally fixes manifest identity mapping,
unknown-error precedence and the bounded Java version probe. It preserves
manual adoption, full-log delivery and the existing tool-only approval reuse
policy; readiness claims still require actual preparation/acceptance records.
Feature implementation and final design sign-off remain pending.

Date: 2026-10-23 (Asia/Singapore). This document is a design review draft; it
is not yet implemented. "Must" and "must not" statements here are acceptance
requirements for the implementation.
Baseline: repository tree `f6523b56` (facts-verification baseline),
@dsh-cc/plugin-dsh-cc-agents 0.9.2-rc.1. Line numbers drift with the
baseline; symbol names are authoritative.

## 1. Goals, scope, and key decisions

Keep the existing pipeline — main-dialog design → three-lane review →
executor development → main-dialog acceptance — and insert optional TLA+
modeling and TLC model checking between design and the three-lane review.
All three lanes receive the same version of the design, the model, and the
check evidence. TLA+ adds no fourth review lane and replaces none of the
existing ones.

Version 1 delivers, as **one new skill inside the existing
@dsh-cc/plugin-dsh-cc-agents package** — and nothing else on the packaging
axis:

1. The `formal-design` skill: SKILL.md (workflow entry), references
   (modeling guide, review contract, AGENTS.md snippet), the Node.js runner
   (preflight / check / check-evidence commands plus their libraries), a
   pinned `toolchain.json`, and examples. The runner is invoked by path
   through `${CLAUDE_SKILL_DIR}` — the same pattern vwa-writing already
   ships.
2. The target-project model-package contract (`specs/tla/<model-id>/`), a
   minimal correct example plus buggy counterpart fixtures, automated tests,
   and a dedicated CI workflow.

No new agent types, MCP servers, slash commands, settings namespaces, runtime
hooks, or permission interceptors. No installer/updater machinery of any
kind: version upgrades ride the ordinary plugin release flow
(`/plugin update` + restart), never a project-side state machine. The
toolchain is never auto-downloaded, and Java does not become a required
dependency for ordinary dsh-cc use.

Why plugin-only (the shape decision, recorded):

- The host already substitutes `${CLAUDE_SKILL_DIR}` in rendered skill
  bodies and materializes per-version plugin caches, so a packaged runner's
  own location and versioning needs no new mechanism at all;
- Every review round's most failure-dense area was the installer's own state
  machine; removing the mechanism removes the problems, not just their
  fixes;
- What plugin-only deliberately gives up, with the substitute constraint:
  (a) no per-project independent runner pinning — a plugin upgrade advances
      all projects on a machine at once (after restart), and prior evidence
      stales honestly as stale/runner until re-run;
  (b) re-running evidence on another machine requires the same plugin
      version there (the evidence records it, §12) plus Java — not merely a
      git checkout.

This is a workflow protocol plus executable checking tools — not a runtime
enforcement mechanism. The tools can judge whether evidence is valid; the
main dialog owns invoking them, collecting the three-lane reviews, and
deciding what reaches the executor. Version 1 does not claim to block
development that bypasses the skill, nor to prevent forged reviews.

Verification conclusions may only be stated as: "with the specified model,
parameters, and assumptions, TLC completed its check and found no violation
of the checked properties." Never claim that an arbitrary-scale system, the
real implementation, or an actual deployment is proven correct.

Alternatives considered: prompt-only conventions lack a stable pass/fail
oracle; runtime-mandatory gates would restructure task authorization and
recovery, which is out of scope. The skill-plus-scripts approach adds
reproducible evidence without changing how sessions are used.

## 2. Verified repository facts and integration constraints

Every fact below was verified against the repository source (tree
`f6523b56`); line numbers drift with the baseline, symbol names are
authoritative. The three r1 review lanes independently re-verified the
load-bearing anchors.

### 2.1 Skill discovery and registration (why the catalog needs nothing new)

- Project skills are discovered only at
  **`<projectRoot>/.claude/skills/<name>/SKILL.md`** (rank 200); the user root
  is `<dshHome>/skills/` (rank 300, usually `~/.dsh/skills/`); learned skills
  live at `<dshHome>/learned-skills/` (rank 500); managed (100) and
  additional (400) roots are config-injected; bundled skills rank 600
  (README "Bundled skills"). Anchors:
  `packages/skill/skill-claude-code/src/discovery.ts:63-102` and the
  Discovery/Bundled sections of that package's README.
- **A project-local `.dsh/skills/` is not a discovery root** (zero hits
  repo-wide), and `~/.dsh/skills/` is global, not project-scoped — so if a
  later version ever generates project-local skills, `.claude/skills/` is
  the only discovery-capable home (precedent: `.claude/skills/change-cookbook`).
  v1 generates nothing project-side; the shipped skill lives in the plugin.
- The project root is the nearest ancestor of cwd containing `.git`; absent
  one, cwd itself is used (`discovery.ts:183-191`). In a monorepo, only an
  install at that root is catalog-discoverable.
- Discovery is **one level deep**: only `<root>/<name>/SKILL.md` counts
  (README "One-level discovery") — so packaging the skill as a plain
  `skills/formal-design/` directory is sufficient; nothing about deeper
  nesting is needed or registered.
- **Registration names come from two different paths — do not conflate
  them:**
  - Plugin skills (the one new one in this package) are mounted by
    cc-plugin-loader: the directory name wins when it is a valid registry
    name; otherwise the loader falls back to the frontmatter `name`
    (`packages/compat/cc-plugin-loader/src/skills.ts`).
  - Provider discovery roots (project/user/managed/additional/learned)
    register by **frontmatter `name`**; a missing or invalid name is
    rejected (`toCandidate`/`validCcName` in
    `packages/skill/skill-claude-code/src/index.ts`).
  - This design's skill is a plugin skill, so directory-name registration
    applies; `formal-design/SKILL.md` still declares `name: formal-design`
    for uniformity (no reliance on fallback). Registry grammar is
    `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`; `formal-design` is valid.
- Frontmatter `description` is **required**; a missing or non-string value
  throws during parse (the `stringValue` helper in `frontmatter.ts`).
  Frontmatter natively supports a `version:` field; **this design does not
  use it** — the runner needs no separate version carrier, because the
  runner's version IS the plugin's version (§3).
- Body rendering substitutes `${CLAUDE_SKILL_DIR}` (`renderSkillBody`,
  README Rendering section) — the packaged skill locates its own directory
  in documentation and examples exclusively through it (§3).
- **Catalog visibility is a session-start snapshot**: skill catalogs are
  built at session start, and plugin content changes take effect after a
  `/plugin update` followed by restarting dsh (existing plugin lifecycle;
  the plugin README says so). A mid-session catalog rebuild happens only on
  the shared `skills/learned-changed` event or `paths` conditional
  activation (the corresponding listeners in `index.ts`). Once the plugin is
  installed and the session (re)started, `formal-design` is simply in the
  catalog.
- Name conflicts: within one registration layer, first-wins with a warning
  only. If a project/user skill named `formal-design` already exists, it may
  shadow or be shadowed by the plugin skill per layer rules — the skill's
  SKILL.md tells the main dialog to surface such a collision instead of
  guessing which copy is which.

### 2.2 Packaging, README, and gate facts

- The plugin package `@dsh-cc/plugin-dsh-cc-agents` currently ships 3 agents
  (agents/critic|executor|marathon.md), 3 skills
  (skills/dsh-cc-agents-orchestration, data-analysis, vwa-writing), and 3
  Serena hooks.
- Both `package.json` and `.claude-plugin/plugin.json` describe it as
  "three subagents, three skills, and optional Serena hooks"; adding one
  skill makes it **four**. The version follows the repo release flow and is
  not bumped separately in this PR. The manifests have distinct names:
  package.json uses `@dsh-cc/plugin-dsh-cc-agents`, while plugin.json uses
  `dsh-cc-agents`. These identify the npm package and host plugin respectively;
  only their versions must be equal (§20.7).
- npm `files` already includes the whole `skills` directory, so the new
  skill ships without touching `files`; publish contents are pinned by an
  npm-pack test (precedent: `tests/vwa-writing.spec.ts`).
- Description surfaces to sync (all of them, no omissions):
  1. `packages/plugin/dsh-cc-agents/package.json` description;
  2. `packages/plugin/dsh-cc-agents/.claude-plugin/plugin.json` description;
  3. plugin `README.md` / `README.zh.md` (tag line + one new row in the
     Components table);
  4. `packages/plugin/dsh-cc-agents/README.i18n.yaml` (re-record hashes with
     `node scripts/check-readme.mjs --write`, then `pnpm check:readme`;
     `pnpm check:readme --write` does NOT forward the flag and is wrong usage);
  5. **root `README.md` ("three subagents, three skills" and the skill list
     — two spots) and root `README.zh.md`**;
  6. **`.claude-plugin/marketplace.json`, the dsh-cc-agents entry's
     description** (independently authored, names the skill list — must be
     synced).
- `tests/package-shape.spec.ts` holds the agent/skill assertion precedent
  (it currently asserts only critic/executor — **new assertions must also
  cover marathon.md**); add assertions in the same style for the new skill's
  SKILL.md, its scripts (including the `*.lib.mjs` modules), toolchain.json,
  and the example tree.
- Capability yaml (`docs/claude-code-capabilities.yaml`): the existing
  data-analysis and vwa-writing skills have no entries; the new skill
  likewise needs none.
- **`.gitignore` contains a `lib/` rule** (with only a root-level
  `scripts/lib/` negation and two plugin-specific full-path negations);
  packaging policies elsewhere may follow similar patterns —
  **this design therefore mandates fully flat scripts directories: shared
  modules are named `*.lib.mjs`, and no `lib`/`dist` directory name appears
  at any level** (§3, §7.1). An integrity test asserts with
  `git check-ignore` that every shipped skill file is ignored by no rule.
- `check:size` gates only `.ts` implementation sources (500-line cap, tests
  exempt); `.mjs` and `.md` are unaffected (`scripts/check-file-size.mjs`
  header).
- Root package.json engines: `"node": "^22.19 || >=24"`.
- The root vitest config includes `packages/*/*/tests/**/*.spec.ts`; this
  package's tests run directly with
  `pnpm exec vitest run packages/plugin/dsh-cc-agents/tests/<file>`. Tests
  may import only relative-path runner scripts + Node builtins + vitest;
  **no new npm dependencies** (check:spec-deps goes red on undeclared ones).
- CI conventions (a new workflow MUST follow):
  - all existing workflows set `defaults: run: shell: bash`; the
    `check:workflow-pipefail` gate rejects non-compliant new files;
  - many dsh-cc packages depend on the sibling harness via
    `link:../../../../deepseek-harness/...`, so `pnpm install` requires a
    side-by-side checkout (presubmit.yml header and its DSH_HARNESS_REF env
    are the template for the new workflow);
  - this package's tests import only Node builtins and the `.mjs` under
    test, so harness lib build outputs are NOT required (the link targets
    only need to exist for install). If implementation proves otherwise,
    fall back to copying presubmit's cache/build block and say so in the
    implementation record.

### 2.3 Current state of AGENTS.md (recorded, not fixed)

- On main, AGENTS.md was cut from 209 lines to a 7-line CLAUDE.md forwarding
  stub by #250 (0023a4c0) (a forwarding loop: CLAUDE.md is a symlink to
  AGENTS.md). The authoritative three-lane review protocol text lives at
  `git show b5a8165d:AGENTS.md` (the 209-line version): dsh-cc-agents:critic
  + the cc-grok-bridge review lane + the cc-codex-bridge lane (review-only
  brief) — all three blind to each other, dispatched in one message, bridges
  invoked through the bash canonical invocation rather than as Task
  subagents.
- The user has confirmed that the three-lane review used in practice comes
  from AGENTS.md; this design does NOT fix the forwarding problem, and the
  snippet does not invent lane identities.
- Integration stays as designed: a copyable AGENTS.md add-on snippet, never
  an automatic rewrite of the user's rules file. The snippet only adds the
  formal-design conditions; lane dispatch, pass criteria, and existing
  approval requirements continue to come from the AGENTS.md actually in
  effect for the session. When those rules cannot be loaded, the main dialog
  may complete modeling but MUST report the missing review rules before
  development begins; fabricating three reviewers on the spot is forbidden.

### 2.4 Existing executor / critic contracts

- critic is a read-only persona, background by default; executor/marathon
  can modify files, foreground by default (orchestration SKILL.md).
- executor accepts only approved, unambiguous plans; on spec conflicts it
  MUST report Blockers rather than redesign.
- Both agents' report trailers remain unchanged (critic:
  Recommendation/Reasoning/Risks-unknowns; executor:
  Changed/Checked/Deviations/Blockers); §6 adds duties before those
  trailers.

## 3. Delivery shape: one packaged skill

### 3.1 Layout

The whole deliverable is one skill directory inside the existing plugin
package. **All scripts directories are flat: shared modules are named
`*.lib.mjs`; no `lib`/`dist` directory name appears at any level**
(ignore-rule isolation, §2.2).

```text
packages/plugin/dsh-cc-agents/skills/formal-design/
  SKILL.md                       # name: formal-design; triggers, workflow, roles, reporting, script invocation
  references/modeling-guide.md
  references/review-contract.md
  references/agents-snippet.md
  scripts/preflight.mjs
  scripts/check.mjs
  scripts/check-evidence.mjs
  scripts/manifest.lib.mjs
  scripts/fingerprint.lib.mjs
  scripts/tlc-output.lib.mjs
  scripts/process.lib.mjs
  scripts/toolchain.json
  toolchain/tla2tools.jar         # exact pinned upstream binary, tracked in Git
  toolchain/LICENSE
  toolchain/THIRD-PARTY-NOTICES.md
  toolchain/licenses/…            # original embedded dependency notices
  examples/task-lifecycle/…      # see §14, including workflow.md
```

### 3.2 Locating and invoking the runner

- SKILL.md examples invoke through `${CLAUDE_SKILL_DIR}` (render
  substitution, §2.1); scripts resolve their own files (`*.lib.mjs`,
  `toolchain.json`) via `import.meta.url`. Hardcoding machine paths is
  forbidden, as is depending on the caller's cwd.
- The runner MUST NOT write into its own skill directory or anywhere in the
  plugin cache. Its write set is exactly: model-package files it is told to
  create under `<project>/specs/tla/**` (generated cfgs, evidence.json,
  current-run.json) and everything under `<project>/.formal-design/**`
  (locks, snapshots, logs, state stores). A package test asserts the
  write-path prefixes.
- Platform: the three commands are pure Node and run anywhere Node runs;
  the macOS/Linux-only restriction in §10 is about unverified process
  termination on Windows, not about the scripts' own portability.

### 3.3 Versioning, upgrades, and the visibility lifecycle

- The runner's version IS the plugin's version: the `version` fields of
  `package.json` and `.claude-plugin/plugin.json`, kept in lockstep by the
  existing package-shape test. There is no template manifest, no per-file
  stamp, and no separate runner version anywhere.
- Upgrades ship with plugin releases. After `/plugin update` and a dsh
  restart, every project on the machine runs the new runner at once; prior
  evidence stales honestly as stale/runner (§12) until re-run. Per-project
  independent runner pinning is NOT offered in v1.
- Re-running evidence on another machine requires the same plugin version
  installed there (recorded in evidence as `runnerPackage`, §12) plus
  Java — not merely a git checkout.
- `formal-design` is in the catalog whenever the plugin is installed and
  the session was (re)started; it does not appear or refresh mid-session
  (§2.1 snapshot semantics). A session that predates a plugin update keeps
  its materialized copy on disk; every produced evidence records the actual
  runnerPackage so that version is always visible in the record.
- Project hygiene: adding `/.formal-design/` to the project `.gitignore` is
  a one-time plain file edit the main dialog performs (SKILL.md instructs
  it); no script writes outside the runner's §3.2 write set.

## 4. User behavior and the trigger algorithm

### 4.1 How it is used

Ordinary requests still go straight to the main dialog; nobody manually
invokes a skill for them. A user may explicitly say "verify this one with
TLA+" or "no formal modeling this time." No new command parser is added;
natural-language intent is interpreted by the main dialog and recorded in
the design document.

Priority: the user's explicit instruction for the current task > the user's
project rules > this skill's auto-trigger rules. When the user explicitly
opts out, record waived — never fabricate a verified. If a user instruction
conflicts with mandatory project rules, report the conflict and ask for a
decision with an explicit scope; never silently override.

### 4.2 Auto-trigger

The main dialog runs the initial screening after forming an initial design and
before dispatching the three-lane formal design review. Re-screening after
scope or semantics changes follows §4.4; not-needed is not permanent.
First check: does
the work add or change the behavior of some protocol/state machine? If not,
the mere presence of concurrency nearby does not trigger.

When the precondition holds and any of the following matches, formal design
is enabled:

| ID | Trigger | Example |
|---|---|---|
| FD-T1 | Two or more independent actors can change shared state and correctness depends on event ordering | completion racing cancellation |
| FD-T2 | Retries, timeouts, duplicate/late messages can alter a committed outcome or side effect | a stale callback overwriting a newer attempt |
| FD-T3 | Crash recovery touches task ownership, execution dedup, or persistence ordering | restart after persisting but before acknowledging |
| FD-T4 | Validity of an authorization/lease/resource ownership spans asynchronous state changes | an old grant still honored after its parameters changed |

Formatting-only, docs, pure UI layout, deterministic computation without the
behaviors above, and behavior-preserving refactors do not trigger by
default. When a behavior already covered by an existing model changes, the
task triggers regardless of whether it is called a "refactor".

The screening result is recorded in the design document's Formal design
section: mode (auto/required/off), decision (enabled/not-needed/waived),
triggerIds, rationale, modelDir (required when enabled), userDirective
(quoted verbatim when present). This section is a workflow record; no script
guesses natural-language truthfulness.

Auto-enablement needs only a brief notice to the user — no extra permission
round-trip. When requirement semantics are unclear, ask only the business
questions that genuinely affect the properties; preparatory work that does
not depend on the answers may proceed.

If the trigger applies and the installed plugin predates the current
session (possible right after an update, before restart), the main dialog
records the actual materialized runner version in implementation.md or the
review record, outside digested inputs. A current package contains one run
and one tool identity; historical approval references follow §12 and must
not be mixed with current evidence.

### 4.3 Activation prerequisites and observable behavior

v1 adds no automatic catalog hook. Installation makes the skill discoverable;
it does not guarantee that an arbitrary main dialog will load its body.
For project-wide screening on every design, a human must adopt the copyable
agents-snippet into the project's effective rules. The plugin orchestration
skill also points to formal-design when that orchestration skill is loaded.
An explicit request loads formal-design directly. Missing project screening
rules must not be described as a technically enforced automatic gate.

The installed skill's description must summarize all four triggers so that
ordinary semantic skill selection can find it. Acceptance separately
demonstrates: explicit invocation; orchestration-selected invocation; and
project-rule-driven screening including a not-needed task. No catalog scan,
rules-file auto-edit or new startup dependency is introduced.

### 4.4 Adoption states and re-screening

The main dialog distinguishes two workflow observations, not new CLI fields:

| Observation | Behavior within the adopted workflow |
|---|---|
| Skill available, project screening rules not confirmed | Explicit requests load the skill; semantic selection or a loaded orchestration skill may select it. Installation alone does not promise screening of every design. |
| Effective project rules include the screening snippet | Screen every initial design, including not-needed work, and re-screen at the change boundaries below. This is a prompt-level obligation, not runtime enforcement. |

On the first formal-design invocation in a project/session, the main dialog
checks the effective rules supplied or loadable in that session. Record the
effective rule source and whether project-wide screening is confirmed, or
why confirmation is unavailable, in implementation.md or the existing
workflow record before a model package exists. If unconfirmed, tell the
user that this invocation can proceed but project-wide screening needs
manual adoption of references/agents-snippet.md. Do not automatically edit
AGENTS.md/CLAUDE.md or claim installation enabled universal screening.
Installation/update documentation MUST state that availability alone does
not enable project-wide screening, and link the manual adoption snippet.
It must not advertise an automatically enforced gate.
The first-use response states one of: screening adopted and review rules
available; screening unconfirmed with the exact snippet path to adopt; or
review rules missing with the rule source that could not be loaded. State
which work may proceed and which gate is blocked. Repeat this notice when
the observed adoption/review state changes; do not imply that installation
performed adoption. Acceptance records must exercise real effective rules,
not merely the presence of a snippet file.
No startup hook or Java dependency is added.

Screening adoption and review-rule availability are separate checks.
If the existing review protocol cannot be loaded, modeling can proceed;
implementation remains blocked under §2.3/§6. For this repository, record
the forwarding-loop dependency without treating this PR as its repair or
inventing a roster. Recheck effective rules after the user changes them;
a previous session's observation does not establish current adoption.

Re-screen when a requirement, design revision, reviewer request or reported
implementation deviation adds or changes protocol/state machine behavior,
including any FD-T1…T4 behavior or behavior covered by an existing model.
Before formal dispatch and executor handoff, confirm the screening still
describes current scope. An executor discovering such a deviation reports
Blockers and pauses affected implementation; the main dialog owns the
re-screening and semantic decisions.

A previous not-needed decision may become enabled: record the new rationale
and trigger IDs, then complete modeling/checking/coverage and formal review
before implementation proceeds. Prior ordinary-design approvals do not
satisfy the newly enabled gate. Enabled-task input changes follow §12.
Retain a previous explicit waiver only if its recorded scope covers the
changed work; otherwise obtain a new scoped user decision. Keep superseded
decision history outside digested inputs; design.md carries the current
screening decision when a model package exists.

## 5. Workflow, states, and pass conditions

| State | Owner | Condition to advance |
|---|---|---|
| screened | main dialog | enabled-or-not and rationale recorded |
| modeling | main dialog | requirements, properties, assumptions, model, and check config complete |
| checking | main dialog, or an executor running explicit checks | actual script output obtained |
| revising | main dialog | counterexamples/errors explained and revised; back to checking |
| review-ready | main dialog | every configured case verified, evidence fresh, coverage matrix complete, no unresolved findings |
| reviewing | the existing three lanes | all review the design package at one digest |
| approved | main dialog | three lanes meet the existing pass bar; no unresolved blockers |
| implementing | executor | approved package contains implementation mapping and regression scenarios |
| accepting | main dialog | implementation, tests, model, and design checked for consistency |
| complete | main dialog | acceptance passed; every deviation handled |

not-needed tasks return to the original pipeline from screened; waived tasks
follow the original pipeline as modified by the explicit user change, and
the report says "waived, not verified." waived never arises from a failing
script run.

review-ready = every configured case verified in the current run + input
digests consistent + the manual coverage-matrix check done + no unresolved
findings. coverage=expansion does not relax this gate (§9). The runner's
verified only certifies execution conditions; it does not judge model
sufficiency. When inputs are unchanged, a previous run that check-evidence
judges valid may be cited (§12).

Counterexample handling: replay the trace first, then decide whether it is a
design defect, a modeling defect, or a requirements ambiguity. The main
dialog fixes the corresponding part and re-checks. Forbidden for the sake of
passing: deleting properties, adding unrealistic assumptions, carving a
failing action out of Next, or shrinking the problem boundary. Every
property, assumption, and boundary adjustment MUST be justified in design.md
for the three lanes. Run IDs, timestamps, tool-upgrade reuse records and
review opinions go in implementation.md or the review record, not design.md:
adding run-specific bookkeeping to a digested input would stale the run.

Check timeouts, missing Java/JAR, unknown output, model errors, and resource
exhaustion all block an enabled task from review-ready. Continuing to write
the design or fixing the environment is allowed; silently jumping to
executor development is not. An explicit user waiver re-records the
decision; history is not rewritten.

There is no "pass by default after three retries." When the same blockage
repeats with no new information, stop re-running; report the concrete
blocker and the available options.

### 5.1 The manual coverage gate (all rows required)

design.md contains a table with columns:
requirement ID / business outcome / property ID / TLA operator /
case IDs and bounds / fault-or-race trace / assumption IDs /
planned code symbol and atomicity mechanism / regression scenario /
exclusion and justification.

The main dialog checks these minimums:

- Every business correctness requirement has a property or an explicit
  exclusion. Every property names at least one core case.
- Each applicable FD-T1…T4 trigger has a modeled adverse ordering or a
  specific exclusion rationale. Include both competing event orders,
  duplicate and late delivery, timeout/retry, and crash/restart when in scope.
- Every modeled atomic action has a concrete implementation mechanism
  (for example one transaction or a guarded state update). A sequence of
  separate writes cannot be called atomic without explaining the mechanism.
- Every assumption identifies real code, infrastructure guarantees or a
  declared external obligation. Unsupported assumptions remain blockers.
- Each critical abstraction names omitted real events/state, the affected
  property IDs, and why their omission preserves those properties. Include
  at least one adverse concrete trace challenging each such justification;
  if it can change an observed outcome, model it or record an approved
  exclusion. A filled matrix is not evidence of a valid abstraction.
- Each safety property has a regression scenario and expected assertion;
  each liveness property lists fairness and response assumptions. If
  liveness is excluded, explain why that is acceptable for this task.
- An exclusion records the affected requirement, the risk left unverified,
  the reason and the existing project's required approval/disposition.
  A known defect cannot be excluded merely to pass.

No empty cells or unexplained “N/A” pass this gate. Before implementation,
planned symbols and test scenarios are allowed. The approved design.md
retains that planned matrix unchanged. At acceptance, implementation.md
contains a corresponding observed matrix keyed by the same requirement,
property and action IDs, with real code locations, test names, observed
results and any deviations; it references the approved inputDigest.
Do not replace planned cells in design.md merely to record implementation
progress. A change in semantics, abstraction, atomicity or assumptions does
change the design inputs and requires re-check and re-review (§12).
Reviewers may still reject model sufficiency: a complete table is necessary,
not sufficient.

### 5.2 Formal review admission and implementation admission

The main dialog applies this decision table; script exit codes alone never
constitute workflow approval. Early consultation may help modeling, but is
not the formal three-lane review and cannot produce a reusable approval.

| Evidence and workflow condition | Formal review admission | Implementation admission |
|---|---|---|
| Audit invalid, missing or stale | Blocked; repair or re-check | Blocked |
| Audit valid, verification=counterexample/error/incomplete (including any configured case failure or not-run) | Blocked; resolve and re-check | Blocked |
| Audit valid, verification=verified, but coverage incomplete or findings unresolved | Blocked; complete coverage and dispositions | Blocked |
| Audit valid, verification=verified, coverage complete, no unresolved findings | May dispatch the existing three lanes with the complete package | Wait for their existing approval requirements |
| Any lane lacks complete evidence or returns an unresolved blocker | Review is incomplete or must return to revision | Blocked |
| Same inputDigest approved by all required lanes, fresh verified evidence, no unresolved blockers | Review complete | Allowed |
| Only tool identity changes, same inputDigest, fresh verified re-check of every configured case, reuse record complete | Existing approvals may be reused per §12 | Allowed under the existing approval requirements |

All configured cases means every entry in checks.json, regardless of its
coverage label. No failed, timed-out, log-limited, signalled or not-run
expansion case can be dismissed as a warning to admit formal review.
Explicit user waiver follows §4.1 and §5; it returns to the modified original
pipeline as waived/unverified and is never described as satisfying this
enabled-task gate.

### 5.3 Coverage decisions and implementation-change precedents

These precedents calibrate the manual gate; they do not turn model
sufficiency into a runner verdict. The main dialog records the decision,
requirement/property/action IDs, concrete trace, code mechanism, rationale
and reviewer disposition in the workflow record. A reviewer may challenge
the rationale under the existing review rules. Uncertainty is an unresolved
finding, not permission for the executor to choose semantics.

| Situation | Required disposition |
|---|---|
| Cancellation is modeled as undoing an external payment that may already have committed | Reject the abstraction unless an actual compensating protocol and its guarantees are specified. Model the committed effect or obtain the existing project's approval of a stated exclusion; never claim rollback from logical cancellation. |
| The matrix covers cancellation stability but omits the business requirement that one logical request causes at most one external charge | Reject coverage even if every listed property passes. Add the requirement, relevant retry/duplicate traces, property and implementation mechanism, or an explicitly approved exclusion. |
| A bounded logical-task model omits payments and explicitly claims only cancellation stability and attempt-tag filtering | Eligible for review only when those are the task's relevant requirements or the omitted requirements have approved exclusions; the bound and omitted effects must remain visible. Passing is not approval of payment deduplication. |
| A stale callback is assumed to stutter without modeling its delivered attempt tag | The minimal fixture alone is insufficient evidence for a real receiver guard. Use the explicit companion pattern (§18.1), challenge guard/update atomicity, and map it to the target handler. |
| Implementation changes names or extracts helpers while preserving the approved state transitions, guard, atomicity and assumptions | Record observed mapping and run affected code tests; unchanged model inputs do not require new formal approval. |
| A guarded single transaction becomes a read followed by a separate write, or retry ownership/persistence order changes | Treat as a semantic/atomicity/assumption change. Update design/model and mappings, re-check and re-review before affected implementation continues. |
| A bug fix restores the exact approved guard and atomic update after code omitted them | Record why this restores rather than changes the approved semantics; run the mapped regression tests. If restoration cannot be established, return to main-dialog adjudication. |

At acceptance, assess the actual change rather than its label ("refactor" or
"fix"). The executor reports uncertain cases as Blockers and pauses affected
work (§6.3); the main dialog owns the disposition. Any resulting change to
digested inputs follows §12. This does not add a new approval authority.

§16.4 acceptance MUST exercise both rejected coverage examples above, the
eligible bounded example, and each implementation-change category. Preserve
the actual rationale and resulting gate state; a pre-filled table or keyword
match is insufficient.

## 6. Roles and dispatch

### 6.1 Main dialog

Owns the design and the model: semantics, states, actions, properties,
abstractions, faults, parameter bounds, and fairness; writes the model;
reads counterexamples; consolidates the three lanes. May run checks itself.
While the model is still exploratory, open-ended modeling work MUST NOT be
delegated to an executor.

### 6.2 critic and the three-lane review

critic's read-only persona and report contract are unchanged; no mutating
duties are added. Reviewers read evidence; a background task MUST NOT run a
runner that writes into the project. Independent re-runs are executed by the
main dialog, and the output is handed to the reviewers.

The identity, model, and tools of each existing lane are unchanged. The
current three lanes inside the dsh-cc repository are dsh-cc-agents:critic +
the cc-grok-bridge review lane + the cc-codex-bridge lane (review-only
brief), all blind, dispatched in one message, bridges invoked through the
bash canonical invocation (protocol text in §2.3); the shipped formal-design skill and
the agents snippet are **not bound to those identities** and say only "the
project's existing formal design review." Every lane receives the complete
package and reviews per its own charter; the main dialog ensures the
three-lane consolidation explicitly answers: do requirements match the
properties; does the model cover the critical faults and races; can the
implementation plan preserve the model's atomicity and assumptions.
Questions nobody covered stay open; three returned opinions do not by
themselves constitute a pass.

Formal review input list: design.md, all .tla files, checks.json, each
case's .cfg, evidence.json, full log paths, the model-package digest, the
implementation mapping, and counterexamples with their dispositions.
Existing report trailers (Recommendation / Reasoning / Risks-unknowns) are
unchanged; the body notes the digest under review.

### 6.3 executor

Allowed: implement approved plans; mechanically generate files when the spec
is fully pinned; run designated checks; turn counterexample scenarios into
code tests; update the implementation mapping.

Forbidden: deciding fairness, cancellation semantics, or idempotency
semantics on its own; weakening properties; asserting beyond the constant
bounds; editing an approved model to fit the code; reporting
unknown/incomplete as success.

The handoff package MUST contain: the approved model digest, the design.md
path, the concrete code-change plan, the property/action → code/test mapping
table, and commands with expected results. Changed / Checked / Deviations /
Blockers keep their format; Checked lists both the code tests and the actual
model-check results.

### 6.4 marathon

TLA+ enablement never auto-escalates a task to marathon. marathon is chosen
only by the existing long-horizon/cross-module routing conditions; even
then, review-ready and the formal design review cannot be bypassed.

### 6.5 Concurrency constraints

One author per model directory at a time. Inputs do not change during a
check; if the input digest differs across a run boundary, the result is
incomplete/input-changed. The three lanes may read in parallel. Different
model directories may be developed in parallel, but v1 executes the cases
inside one model package sequentially. Subagent lifecycles follow the
existing one-task-one-instance rule.

## 7. File inventory and module boundaries

### 7.1 New

`packages/plugin/dsh-cc-agents/skills/formal-design/`: see §3.1 (SKILL.md,
references, scripts/*.mjs + *.lib.mjs, toolchain.json, examples — **flat,
no subdirectories under scripts**).

Tests:

```text
packages/plugin/dsh-cc-agents/tests/formal-design.spec.ts               # runner unit/contract
packages/plugin/dsh-cc-agents/tests/formal-design-integration.spec.ts    # real TLC integration
packages/plugin/dsh-cc-agents/tests/fixtures/formal-design/…             # §16.1/16.2 fixtures
```

CI: `.github/workflows/formal-design.yml` (§16.3).

### 7.2 Modified

- `skills/dsh-cc-agents-orchestration/SKILL.md`: a short section pointing at
  formal-design's occasions (design work hitting the §4.2 triggers), and
  stating that modeling reasoning stays with the main dialog/critic while
  running checks and implementing approved plans may route to executor. The
  three-lane policy is not copied into the skill — one canonical copy
  avoids double-source drift.
- `agents/executor.md` / `agents/critic.md`: add the §6.2/§6.3 duty
  constraints, preserving the current report trailers.
- Every description surface in §2.2 (package.json, plugin.json, plugin
  bilingual READMEs, README.i18n.yaml, root bilingual READMEs,
  marketplace.json) — three skills becomes four.
- `tests/package-shape.spec.ts`: **add marathon.md** to the agent
  assertions; add existence assertions for the new skill's SKILL.md,
  scripts, toolchain.json, and example tree (§2.2).

Do not modify AGENTS.md or CLAUDE.md; do not add custom fields to the plugin
manifest; do not change model aliases; add no npm dependencies; do not
modify the root .gitignore (the flat layout keeps every new file visible to
git, test-asserted).

## 8. The model package in a target project

```text
specs/tla/<model-id>/
  design.md
  checks.json
  Model.tla
  Helpers.tla                    # optional, same-directory dependency
  cases/<case-id>.cfg             # deterministically generated from checks.json and committed
  evidence.json                  # latest run summary, committed for review
  current-run.json               # latest attempt and its completion state, committed for review
  implementation.md             # run/review records; observed mapping and test results at acceptance
```

Raw logs, TLC state stores, and input snapshots live under the project's
`.formal-design/runs/<model-id>/<run-id>/`; the main dialog adds
`/.formal-design/` to the project `.gitignore` once, as a plain edit per
SKILL.md guidance (§3.3). Only the checker creates the directory —
preflight never does. run-id is a compact
UTC timestamp + UUID; directories are never reused. Other runs are never
cleaned up; users may delete history dirs themselves.

design.md MUST contain: the problem and business semantics; state variables;
actions and their atomicity; S-* safety properties; L-* liveness properties
or the reason liveness is not verified; A-* environment assumptions; F-*
faults; parameter bounds and limits; the property → TLA operator → case
mapping; the action → intended code → test mapping; counterexample
dispositions; the trigger record for this run.

Assumptions MUST explain "why the real system satisfies them." Locks,
database transactions, external idempotency keys and other implementation
premises must not hide inside the model alone. Liveness properties MUST list
the fairness and eventual-external-response assumptions; a safety model does
not add fairness merely to terminate.

v1 accepts only hand-written TLA+. It does not run the PlusCal translator,
TLAPS, Apalache, Java module overrides, custom classpaths, external module
directories, or arbitrary user commands. TLC's bundled standard modules are
usable; non-standard .tla modules must live in the model root with a file
name equal to the module name.

### 8.1 Exact input directory and enumeration rules

The model root is specs/tla/<model-id> itself. All non-standard TLA+ modules,
including the checks.json entry module, are direct children of that root.
Enumerate direct-child regular .tla files only. Any nested .tla, including
under cases/, is rejected as config-invalid by preflight/check and
schema-invalid by check-evidence; never silently ignore it or treat it as
a recursive dependency. Symlink violations retain §13 path-error precedence.

The digested set is exactly root design.md, root checks.json, all
direct-child .tla files and cases/<id>.cfg for each declared case. The §9
ID grammar permits no nested cfg path. Old undeclared cfgs are neither
executed nor digested; removal remains an explicit edit (§9.2).
implementation.md, evidence.json, current-run.json and non-input support
files are not copied into the snapshot or added to inputDigest. The §13
symlink, unsafe file-type and Java-override prohibitions still apply;
exclusion from the digest does not authorize a prohibited file.
Support files cannot supply model dependencies or substitute for requirements
restated in design.md. Use identical enumeration/validation in preflight,
check, snapshot comparison and check-evidence, independent of traversal order.

## 9. checks.json: the single configuration source

UTF-8 JSON, no comments; schemaVersion fixed at 1; every object rejects
unknown fields and duplicate keys. If JSON.parse cannot detect duplicate
keys, a JSON tokenizer pass MUST detect them before parsing — this item is
not optional. Case IDs must not repeat. Every field shown in the §9 example is required,
including constants and properties when empty; no implicit defaults are
introduced. The §9.1 directive blacklist also applies to configuration
identifier fields (specification, constant keys, invariants and properties)
so none can be parsed as a cfg section keyword.

```json
{
  "schemaVersion": 1,
  "modelId": "task-lifecycle",
  "module": "Model",
  "cases": [
    {
      "id": "small",
      "coverage": "core",
      "specification": "Spec",
      "constants": {"MaxAttempts": "2"},
      "invariants": ["TypeOK", "CancelledStable", "StaleCannotComplete"],
      "properties": [],
      "limits": {"timeoutMs": 120000, "heapMiB": 1024}
    }
  ]
}
```

Constraints: modelId/case.id match [a-z][a-z0-9-]{0,63}; module,
specification, constant keys, and property names match
[A-Za-z][A-Za-z0-9_]*. cases length 1..16, at least one coverage=core; each
case has at least one invariant; array names do not repeat. coverage is an
explicit string enum, core|expansion. The legacy required field is rejected
as an unknown field; there is no alias or migration mode in this unimplemented
v1. properties may be empty. limits is required; timeoutMs an
integer 1000..600000, heapMiB an integer 256..4096.

### 9.1 The constants value grammar (complete, and the only one)

A constants value is a single-line string that **the grammar must consume in
full**, at most 512 characters. Grammar (EBNF):

```text
value    := atom | set
atom     := bool | nat | ident
bool     := "TRUE" | "FALSE"
nat      := "0" | [1-9][0-9]*
ident    := [A-Za-z][A-Za-z0-9_]*
set      := "{" [ atom ("," [" "] atom)* ] "}"
```

- The grammar's comma token permits an optional single ASCII space
  immediately after it. No other whitespace is permitted. Thus `{1,2, ok}`
  is legal and `{ 1 , 2 }` is not. Canonical serialization emits one
  ASCII space after each comma; element order and duplicates are preserved.
  A top-level atom has no leading or trailing whitespace.
- Naturals are limited to 0..2147483647 (the pinned TLC integer domain);
  validation compares decimal strings or BigInt, never rounded JS Numbers.
- **ident blacklist**: an ident must not equal any cfg directive reserved
  word: `SPECIFICATION`, `CONSTANT`, `CONSTANTS`, `INVARIANT`,
  `PROPERTIES`, `PROPERTY`, `CONSTRAINT`, `ACTION_CONSTRAINT`, `SYMMETRY`,
  `VIEW`, `CHECK_DEADLOCK`, `INIT`, `NEXT`, `CONSTRAINTS`,
  `ACTION_CONSTRAINTS`, `INVARIANTS`, `TYPE`, `TYPE_CONSTRAINT` (exact match against TLC
  directive casing; the blacklist itself is written as a manifest constant
  and covered by tests).
- Rejected: negative integer literals (the pinned parser reports a
  configuration error for `MaxAttempts = -1`; reproduced in r1), string
  literals (quotes are an injection vector), nested sets, trailing garbage,
  newlines, comments, semicolons, empty strings.
- Semantics: booleans, non-negative integers, model-value idents, and their
  finite sets; type and expression validity remain TLC's job at check time.
  An ident is a TLC model value, NOT a reference to a TLA+ definition:
  `C = Derived` does not evaluate a `Derived == ...` operator. v1
  supports no `<-` overrides. Derive complex values inside .tla from
  supported primitive constant parameters; if that cannot express the case,
  report the unsupported configuration rather than emit arbitrary cfg text.

### 9.2 The cfg generation format (byte-exact)

check.mjs generates each case's `cases/<id>.cfg` **exactly** as follows (LF
endings, a single trailing newline; constants in key-sorted order):

```text
SPECIFICATION Spec
CONSTANTS
MaxAttempts = 2
INVARIANT TypeOK
INVARIANT CancelledStable
INVARIANT StaleCannotComplete
CHECK_DEADLOCK TRUE
```

Rules: `SPECIFICATION <name>` is the first line; when constants are
non-empty the second line is `CONSTANTS`, followed by one
`<key> = <canonical value>` line per constant in **key-sorted** order (one
space on each side of `=`); no constants → both lines omitted; one
`INVARIANT <name>` line per entry in array order; one `PROPERTY <name>`
line per entry in array order (none when empty); the fixed final line is
`CHECK_DEADLOCK TRUE`. No additional keywords (CONSTRAINT,
ACTION_CONSTRAINT, SYMMETRY, VIEW, constant overrides, INIT/NEXT, or
anything that disables deadlock checking).

When cases/<id>.cfg is absent, check writes it into the model directory per
these rules (a committed input, §12 ordering); when it exists but differs
from the generated bytes the result is blocked/config-drift — overwriting
reviewed material automatically is forbidden. To update configuration:
(1) edit checks.json; (2) inspect the old cfg and remove only the changed
declared cfg files explicitly, as a main-dialog/executor file edit;
(3) run preflight (willGenerate lists the absent files), then check;
(4) inspect and commit the generated diff with checks.json. No new CLI flag
or update command is added. Merely re-running check against a mismatched cfg
always blocks. Removed cases' old cfgs may be explicitly deleted; undeclared
cfgs are neither executed nor included in inputDigest.

Finite bounds live in constants and state definitions; the bounds must not
quietly carve out events still being handled. Terminal states are modeled
with explicit self-loop actions; disabling deadlock checking to mask them is
forbidden.

Cases with coverage=expansion widen parameter exploration; the label records
core versus expansion coverage, not permission to ignore a configured
case. Once present in checks.json, every case must verify for the aggregate
to be verified and for formal review admission (§5.2). Failures remain
visible in results and warnings (§11), and block formal review until resolved
and re-checked. Removing or weakening a failing expansion case solely to
pass is forbidden by §5. Any justified scope/configuration change is a
changed input requiring new evidence and review, never a waiver of a known
defect.

### 9.3 cfg generation failure and recovery

Preflight runs before any cfg generation (§10). If Java/JAR or any other
preflight prerequisite blocks, no cfg is generated; willGenerate=[] in the
blocked response. A ready preflight only reports missing paths and never
writes them.

After successful preflight, check creates absent declared cfgs in manifest
order. Stop generation on its first failure; do not generate later files.
Each file uses a unique same-directory exclusive temporary file whose name
ends in .tmp (never .cfg), complete
write and close, then atomic publication without replacing any existing
destination (for example fs.link(temp, destination), then unlink(temp),
on supported local filesystems). A platform/filesystem without atomic
no-replace publication reports blocked/io rather than overwriting a file.
If a destination appears concurrently, compare its complete bytes: an exact
match is retained; a difference reports blocked/config-drift. Ordinary
rename-overwrite is not an acceptable publication mechanism for cfgs.

| Failure boundary | Files retained | Output and recovery |
|---|---|---|
| Preflight blocks | Existing cfgs unchanged; no generated files | blocked with ordered blockers; fix prerequisites and retry |
| One cfg write/publication fails before the running marker | Previously completed cfgs remain; remove only the current attempt's temporary file when possible; no partial destination | blocked/io, summary=null, exit 2; stderr identifies completed and unfinished declared paths; repair I/O and retry |
| A concurrently created cfg differs | Previously completed cfgs and the concurrent file remain | blocked/config-drift, summary=null, exit 2; inspect and explicitly remove only changed cfgs per §9.2 |
| All cfgs exist, but later preparation fails before the running marker | Completed cfgs remain; previous evidence/marker untouched | blocked/io, summary=null, exit 2 for I/O; repair and retry |
| Failure after publishing the running marker | Completed cfgs remain | §20.7 error/incomplete persistence rules; no reusable success for the failed attempt |

Diagnostics identify project-relative completed and unfinished cfg paths in
manifest order; no new stdout fields or status codes are added. On retry,
preflight checks retained cfg bytes and lists only still-absent declared
paths when ready. check never rolls back completed cfgs and never reports
verification merely because generation succeeded. Abrupt process death may
leave uniquely named temporary files; they are never treated as cfg inputs
and may be removed after confirming no checker owns them. Normal failures
attempt cleanup and report cleanup failure on stderr.
Existing evidence is audited against current inputs, so changed checks.json,
changed cfg bytes or a missing declared cfg prevents reuse even when a
pre-run failure leaves old evidence files untouched. An unchanged-input
pre-run failure retains the existing §12 validity rule.

## 10. Toolchain and CLI contract

Node follows the repo's existing requirement ^22.19 || >=24; Java major
version >=17. v1 pins TLC v1.7.4:

- JAR source: https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
- The official release page publishes SHA-1:
  bee4a54f3ee3d4afc347c3240ec2d9e93b075104 (independently re-verified by one
  r1 lane against the release page).
- toolchain.json pins exactly three fields: version, downloadUrl, sha1. The
  SHA-1 is a compatibility/integrity match against the official artifact —
  no anti-collision guarantee is claimed. Run evidence separately records
  the actual JAR's SHA-256.
- Selection is explicit `--jar` > nonempty TLA2TOOLS_JAR >
  `${CLAUDE_SKILL_DIR}/toolchain/tla2tools.jar`. The bundled file is an
  unmodified Git-tracked plugin resource, not Git LFS or a prepack/postinstall
  download, so npm packages and Git marketplace clones both contain it.
  A configured path that is missing, unreadable or checksum-invalid blocks;
  it never silently falls back to another source. Every selection must match
  the pin. Keep the upstream MIT and embedded dependency licenses/notices
  and source provenance beside the binary. No scanning, networking or
  auto-download occurs at runtime or installation. Without `--java`, use the
  PATH java (not pre-resolved; spawn resolves it, and javaVersion is
  recorded as usual).
- Changing the TLC version requires reviewing it together with the pinned
  log fixtures and the real integration tests; "latest" or "any compatible"
  versions are forbidden.

The runner lives wherever the host materialized the installed plugin;
SKILL.md instructions render `${CLAUDE_SKILL_DIR}` to that absolute skill
directory (§2.1), and scripts resolve their siblings (`*.lib.mjs`,
`toolchain.json`) via `import.meta.url` — never via the caller's cwd, and
never with hardcoded machine paths. Invocation shape ($PROJECT is the
target project root):

```sh
node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs"      --project "$PROJECT" --model specs/tla/task-lifecycle
node "${CLAUDE_SKILL_DIR}/scripts/check.mjs"          --project "$PROJECT" --model specs/tla/task-lifecycle
node "${CLAUDE_SKILL_DIR}/scripts/check-evidence.mjs" --project "$PROJECT" --model specs/tla/task-lifecycle
```

(Inside this repository's own test suites the same commands run from the
package tree path `packages/plugin/dsh-cc-agents/skills/formal-design/` —
identical files, since that tree IS the shipped artifact.)

All three commands require one --project and one --model, except --help
used alone. preflight/check additionally accept one --jar and one --java;
check-evidence rejects these environment flags. All three commands support
--help; check supports the same --java as
preflight; check-evidence never starts Java and does not require the JAR to
exist at its original path. Unknown arguments, missing values, or duplicates
exit 2. Extra TLC/JVM argument pass-through is forbidden. stdout is exactly
one JSON object plus a newline (schema in §20); diagnostics go to stderr;
--help is the only plain-text exception.

**Path-argument normalization (shared by preflight/check)**: an explicitly
passed `--jar`/`--java` must exist; it is realpath'd **once at argument
parsing** to an absolute path (symlinks allowed; the resolved path is
recorded) and must be a regular file; evidence argv records the normalized
absolute path. The selected JAR bytes (explicit, environment or bundled) get a SHA-1
compared against toolchain.json (mismatch → blocked/jar-checksum) and a
SHA-256 recorded in evidence. PATH-form java is not pre-resolved (the argv
and javaExecutable recording rules are in §12).

preflight is read-only: **what it validates is checks.json (all §9
rules) and existing cfgs against their generated values**, plus the Java
version and JAR checksum; runner identity is attested by evidence's
runnerPackage+runnerDigest (§12); preflight additionally validates that the
two plugin manifests expose a consistent identity (§20.7). Missing cfgs may still
yield ready-for-check with the will-generate paths listed. Success is
exit=0/status=ready-for-check; environment problems are
exit=2/status=blocked. It does not claim verified.

check runs the same preflight first; any blocker means TLC never starts.
**Pinned run order:**

1. Validate CLI syntax and all §13 project/model/output-path boundaries
   read-only, before mkdir or any lock write; then take the model lock
   (§13). Reserve the runId in memory before writing the lock; step 5 uses
   that same ID without allocating another. Conflict → blocked/model-locked.
   Full preflight follows under lock.
2. Run preflight.
3. Generate missing cfgs per §9.2/§9.3 **into the model directory** (cfgs
   are committed inputs). Partial generation retains completed files;
   generation failure returns before the running marker or any JVM start.
4. Compute the input digest inputDigest (§12 input set, now including cfgs).
5. Allocate the unique run directory and atomically publish current-run.json
   (state=running, runId and inputDigest) BEFORE copying inputs. From this
   point, any early failure must leave a non-reusable running marker or
   publish incomplete/error evidence for this attempt. Copy the input
   snapshot into the run directory byte-for-byte
   (`fs.copyFile`, no text transforms); recompute the snapshot digest and
   require equality with inputDigest — **mismatch → incomplete/input-changed,
   no JVM is spawned**.
6. Confirm the snapshot digest matches; proceed using that snapshot only.
7. Execute the cases sequentially (process contract below).
8. When all finish: recompute the original-input digest and the
   runner/jar/toolchain digests against step 4's recorded values. Input
   mismatch → incomplete/input-changed; runner/JAR/toolchain mismatch →
   incomplete/artifact-changed. Missing or unreadable previously captured
   inputs/artifacts count as mismatches. If both change, input-changed wins.
   The incomplete evidence is still written; it is never called verified.
9. Stage evidence.json and current-run.json (sibling temps), then publish
   evidence followed by the finished marker under §10.1's cancellation boundary.
10. Release the owned lock in a finally; retain §10.1 signal handlers until
    cleanup is complete and the command exits with its committed result.

Cases execute independently and sequentially; a failing case does not stop
the others from producing results. Each case's cwd is the isolated input
snapshot root, spawned as spawn(executable,args,{shell:false}); equivalent
parameters:

```text
java -Xmx<heapMiB>m -cp <jar> tlc2.TLC
  -tool -workers 1 -seed 1 -fp 0
  -metadir <run-dir>/<case-id>/states
  -config <snapshot>/cases/<case-id>.cfg <module>
```

No -simulate/-depth/-continue/-recover. A single fixed worker reduces
liveness-check and reproduction complexity; one worker plus a fixed seed
still does not promise byte-identical logs.

stdout/stderr raw bytes are read, preserved, and streamed to disk; summaries
never load whole logs. **The per-case combined log ceiling is 50 MiB**
(the stdout+stderr byte sum); exceeding it terminates via the same
SIGTERM→2000ms→SIGKILL ladder as timeout, recorded as incomplete/log-limit.
timeout counts from successful spawn: the same SIGTERM first, SIGKILL after
2000ms; results are written after the child's close event. **A user cancel
(SIGINT/SIGTERM observed by the wrapper before final publication) takes
precedence over all aggregation**; §10.1 defines the exact boundary and
all no-child cases. The JVM is started directly — no shell subprocess. v1 supports
macOS/Linux; Windows returns blocked/unsupported-platform — silently running
unverified termination logic is forbidden.

JVM resource exhaustion, signal exits and the like are judged
incomplete/error only. heapMiB is a JVM heap cap; it does not limit total
JVM RSS.

### 10.1 Cancellation and the publication boundary

For check only, install SIGINT/SIGTERM handlers after CLI syntax validation and before any
asynchronous path validation, lock or preflight work. A handler latches
cancellation until this command successfully publishes the finished marker.
Stop starting new preparation steps or children once latched. Cancellation
means a signal observed by that handler, not an unobservable OS arrival time.

| Boundary when cancellation is observed | Required outcome |
|---|---|
| Before the running marker | Stop preparation, clean up owned temporary files/lock, retain completed cfgs and old evidence; emit incomplete/cancelled, summary=null, blockers=[], exit 3. No new Evidence is fabricated. |
| During snapshot/preparation after the running marker | Start no JVM; every case is not-run; publish incomplete/cancelled Evidence only if the §20.7 persistence conditions hold. |
| While a case child is active | Apply the TERM→2000ms→KILL ladder, await close, record that case incomplete/cancelled with actual process metadata and complete persisted logs; later cases are not-run. |
| Between cases, or after the last child closes | Preserve completed case records; unstarted cases are not-run. Even if every case verified, the run is incomplete/cancelled. |
| After the finished marker is successfully published | Keep the committed result and its exit code; finish owned-lock cleanup. Do not convert it into cancelled or use the default signal exit. |

Publication is serialized: after staging Evidence and its marker, check the
cancellation latch again. If it changed, regenerate the staged result before
publication. Use a synchronous, non-yielding final critical section: inspect
the latch, publish evidence, publish the finished marker, then mark the run
committed in memory. No await or callback dispatch occurs between those
operations. A signal handler dispatched after that successful section is
post-publication. This defines a reproducible handler-observation boundary,
rather than promising atomicity across two files or OS signal arrival time.
A failed marker publication never commits a result.

A cancellation latched during asynchronous evidence/log persistence still
wins aggregation; if consistent persistence cannot be completed, return
incomplete/cancelled with summary=null and leave a non-finished marker.
I/O diagnostics remain on stderr. Cleanup failure after successful final
publication does not change the committed status; it is reported on stderr,
and any surviving lock is handled under §13.

### 10.1.1 Java version-probe process contract

The Java version query is a real child process, distinct from a model case.
preflight and check use the same bounded implementation. Spawn the selected
Java executable with only `-version`, shell:false, cwd set to the validated
project root, and the scrubbed environment from §13. Preserve the normalized executable
selection rules in §10. Do not write probe logs or create run artifacts.

- Start a 10000 ms wall-clock deadline at the spawn attempt, including the
  wait for spawn confirmation. Limit combined stdout/stderr to 1 MiB, retaining
  at most that prefix in memory. Either limit stops the query using
  SIGTERM, followed after 2000 ms by SIGKILL if it has not closed. Allow
  another 2000 ms for close after SIGKILL; expiry is a process-control failure
  handled below. Otherwise await close before returning or starting TLC;
  clear owned timers/listeners. A spawn
  error settles the attempt without waiting for a close that cannot occur.
- A normal exit 0 must report a parseable Java major version of at least 17.
  Accept the standard `java version "<version>"` or
  `openjdk version "<version>"` header from either stream, including modern
  integer/dotted versions and legacy `1.<major>` versions. The quoted version
  token must match `[0-9]+(?:\.[0-9]+)*(?:[-+_][A-Za-z0-9.+_-]+)?` in full;
  ignore text following the closing quote. Read the first decimal component
  as major, except a first component of 1 requires and uses the second
  component. Compare components as decimal integers without rounding.
  Multiple headers must identify the same version token. Pin representative
  Temurin/OpenJDK and Oracle headers in tests. Missing, malformed or conflicting
  version headers, a lower major, nonzero exit, signal exit, timeout or output
  limit produce blocked/java-version with a deterministic diagnostic. An
  ENOENT spawn error produces java-missing; other spawn failures produce io.
- For check, the §10.1 cancellation latch takes precedence over probe failure:
  stop the active probe with the same termination ladder and await settlement,
  then return incomplete/cancelled, summary=null, exit 3. Do not start cfg
  generation or TLC. Cancellation before the probe prevents its spawn.
  Standalone preflight installs no cancellation latch or new signal policy;
  its ordinary process termination cannot create evidence or project writes.
- Probe limits are fixed internal constants, not new CLI/config fields or
  model-case timeout settings. Probe output never enters case event parsing
  or Evidence. No new public reason is introduced. If termination/close
  cannot be established because process control fails, return blocked/io
  (or the higher-priority check cancellation result), report the concrete
  failure on stderr, start no TLC, and do not claim the child has stopped.
  Do not wait indefinitely after a reported process-control failure.

## 11. TLC output and result classification

### 11.1 Frame parsing

Parse TLC -tool `@!@!@STARTMSG <code>:<severity> @!@!@` /
`@!@!@ENDMSG <code> @!@!@` frames, tolerating arbitrary chunk splits and
CRLF. **The parser is a stack machine**: scan linearly; STARTMSG pushes
(nesting is legal — ordinary error output of the pinned version does nest
frames); ENDMSG's code must equal the top-of-stack code — a match closes the
frame, a mismatch or empty stack is output-invalid; a non-empty stack at
end-of-stream is output-invalid. Frame events are collected **at any nesting
depth**. Text outside frames (the launcher, SANY) is allowed and must never
be natural-language-matched for success. Frame bodies are preserved
verbatim; nothing inside them is executed.

Event-stream gate rules:

- severity ∉ {0,1,2,3,4} → output-invalid;
- severity=3 (WARNING) is preserved as a warning, not a failure;
- severity=4 (STATE) is trace output, not an error or success signal;
- severity = 2 (TLCBUG class) → error/tlc-bug regardless of code;
- a code outside the pinned-version vocabulary with severity = 1 →
  error/unknown-error after the higher-priority interruption, spawn, malformed
  output, TLCBUG and exit/event contradiction checks in §11.3. In particular,
  exit 0 with any severity=1 remains error/output-inconsistent;
- an unknown code with severity = 0 or 4 → recorded in eventCodes only;
  no effect on judgment. A severity=3 code, known or unknown, adds
  `tlc-warning:<case-id>:<code>` to summary.warnings; no effect on judgment.
  The severity vocabulary comes from pinned MP.java, including warnings
  and printed states; rejecting 3/4 would discard ordinary counterexamples.
  stdout and stderr have independent incremental frame-parser stacks; do
  not concatenate asynchronous chunks from the two streams into one stack.
  Required ordered success events and final statistics come from stdout.

### 11.2 The only path to verified

verified holds if and only if ALL of the following hold (**this is the only
path; string-matching "success" is never sufficient**):

1. A normal close: exitCode=0, signal=null, not timed out, not cancelled,
   log ceiling not hit.
2. TLC_MODE_MC=2187, TLC_SUCCESS=2193, TLC_FINISHED=2186 all present, in
   that order.
3. No severity=1 error frame, no severity=2 frame, no recognized violation
   event (§11.3), no malformed frame.
4. A TLC_STATS=2199 frame exists whose body matches the pinned form
   `<g> states generated, <d> distinct states found, <q> states left on queue.`
   (v1.7.4 emits String.valueOf — no thousands separators), with
   **g>0 ∧ d>0 ∧ q=0** (the all-zero stats of an empty Init can never be
   verified). Missing or unparseable stats → incomplete/output-invalid.
   **Only 2199 counts**; 2200 (progress stats) participates in nothing.
   Use the last stdout 2199 frame before TLC_FINISHED, trimming only outer
   whitespace; the body must match in full. No valid final frame means
   incomplete/output-invalid, even if an earlier stats frame was valid.
5. The presence or absence of TLC_CHECKING_TEMPORAL_PROPS_END=2267 is **not**
   a negative condition: a safety-form PROPERTY (e.g. []P) is checked by the
   safety engine under invariant semantics, and the pinned version emits no
   2267 for it (reproduced in r1). Whether 2267 appears is still recorded in
   eventCodes as evidence. The properties field is RECOMMENDED for temporal
   formulas; safety assertions go in invariants — a recommendation, not a
   syntactic enforcement.
6. None of the run-level global preconditions fired (the digest comparisons
   at §10 steps 5/8, ceilings, cancellation).
7. Every scheduled case has a result record.

### 11.3 Deterministic case classification

Apply the following algorithm in order; return at the first matching step.
This ordered algorithm is authoritative for case classification. Run-global
overrides and persistence feasibility are applied separately by §11.4 and
§20.7. Wrapper observations remain trusted observations under §12.1.

1. A recorded case interruption returns incomplete with the first applicable
   reason: cancelled, input-changed, artifact-changed, timeout, log-limit,
   signal-exit. Do not require well-formed output from an interrupted child.
2. An unsuccessful spawn returns error/spawn-failed.
3. Malformed frames or invalid severity return incomplete/output-invalid.
4. Any severity=2 frame returns error/tlc-bug.
5. Exit/event contradictions return error/output-inconsistent: TLC_SUCCESS
   with any nonzero exit; a recognized violation with an exit other than its
   matching exit below; or exit 10..14 without its corresponding event.
   For exit 13, 2113 also supplies a corresponding event but is an evaluation
   error, not a violation. For exit 0, any severity=1 frame is likewise
   output-inconsistent, whether or not success events are present.
6. Any code outside the pinned-version vocabulary with severity=1 returns
   error/unknown-error, even when a known event matches a nonzero exit.
   Do not discard an unknown error merely because a familiar violation is
   also present. The vocabulary is the pinned EC.java event-code set,
   not merely the subset of codes in this classification table.
7. Classify matching nonzero exits using the table below.
8. For exit 0, return verified only if every §11.2 predicate holds;
   otherwise return incomplete/output-invalid. Missing success events,
   invalid/missing final statistics and their ordering cannot imply success.
9. Any remaining outcome returns error/unknown-error.

| Exit and corresponding event | Status / reason |
|---|---|
| 11 with 2114 | counterexample/deadlock |
| 12 with 2107 or 2110 | counterexample/invariant |
| 13 with 2108, 2112 or 2116 | counterexample/temporal |
| 13 with 2113 | error/property-evaluation-failed |
| 14 with 2132 | counterexample/value-assert |
| 10 with 2104 or 2105 | error/assumption-failed |
| 75, 76 or 77 | error/property-evaluation-failed |
| 150 with 2171 or 3002; 151 with a config event; 255 with a cfg-parse event | error/config-invalid |
| Other nonzero exits | error/unknown-error |

If multiple recognized events match exit 13, 2113 takes precedence over
the temporal-violation events. A recognized violation for contradiction
checking means 2114, 2107, 2110, 2108, 2112, 2116 or 2132.
The corresponding sets for exits 10..14 are exactly the sets in this table.
Config events are 2222..2245, 2280 and 2281; cfg-parse events are 5001..5006.
The nested 1000/5006 chain is config-invalid, not assumption-failed.
Other exit=150/151/255 outcomes are unknown-error. Do not infer causes from prose.

Pin these combined-condition fixtures in both classifier and replay tests:

| Observations | Expected status / reason |
|---|---|
| exit 0, severity=1, success events missing | error/output-inconsistent |
| exit 0, severity=1, all success events present | error/output-inconsistent |
| exit 0, no error, missing required success event | incomplete/output-invalid |
| exit 12, 2110 present, malformed frame | incomplete/output-invalid |
| exit 12, 2110 present, severity=2 | error/tlc-bug |
| exit 12, 2110 and TLC_SUCCESS present | error/output-inconsistent |
| exit 12, 2110 and an unknown severity=1 event | error/unknown-error |
| exit 0, an unknown severity=1 event, with or without success events | error/output-inconsistent |
| exit 12, 2110, unknown severity=1 and malformed output | incomplete/output-invalid |
| exit 12, 2110, unknown severity=1 and severity=2 | error/tlc-bug |
| exit 13, 2113 and 2116 present, otherwise consistent | error/property-evaluation-failed |
| timeout plus malformed output and severity=2 | incomplete/timeout |
| cancellation plus timeout | incomplete/cancelled |

Complete counterexample logs are preserved; v1 does not promise to parse
every TLA+ value into a structured trace.

### 11.4 Aggregation and exit codes

summary.status: **run-level global preconditions are checked first**:
wrapper cancellation, input change, artifact change (in that order) make the
whole run incomplete even if they occurred during an expansion case.
Timeout, log ceiling, signal exit, spawn failure and TLC findings are
case-local; aggregate every configured case as follows: all verified →
verified; any counterexample → counterexample; else any error → error;
else incomplete (including not-run). The coverage label does not filter
aggregation. A terminal run-level I/O failure uses error/io before case
aggregation,
unless a higher-priority cancellation/input/artifact incomplete cause exists;
§20.7 governs whether consistent Evidence can be persisted.
Within the selected status use the first matching case in checks.json order
for summary.reason. Successful summary.reason is verified. Expansion cases
affect aggregation exactly as core cases do; every
non-verified coverage=expansion result additionally adds
`expansion-<status>:<id>:<reason>` to warnings for coverage context. This
warning does not downgrade the failure or permit review admission. Warnings
are ordered
by manifest case order; within each case, TLC warning codes in numeric
order precede its expansion-result warning.
Preflight blockage → blocked. Not-run records are retained.

check exit codes are selected ONLY from the final summary/command status:
0 = verified; 1 = counterexample; 2 = blocked or error (multiple blockers
are all listed); 3 = incomplete (including cancellation). TLC's own exit code is never used
directly as the wrapper's exit code. check-evidence: 0 = the evidence is
intact and fresh (**which does not mean the model passed** — its JSON
explicitly carries the fresh and verification fields, §12/§20); 2 =
invalid/stale/missing, with a concrete reason.

## 12. Evidence, digests, and staleness rules

Each run preserves the input/ snapshot, each case's stdout.log/stderr.log,
and the run's evidence.json. The latest summary is published to the
model-root evidence.json via sibling-temp + rename after the whole run ends,
failures included — passing off a previous success as this run's result is
forbidden. current-run.json is maintained per §10 steps 5/9: state=running
before snapshot copying or any case starts; state=finished after evidence lands. check-evidence
MUST first apply §13's conservative lock probe (present or indeterminate
process means run-in-progress); then
require matching runId/inputDigest across both files and state=finished.
A running/missing/mismatched marker means incomplete-run; malformed evidence
means schema-invalid. The complete rejection order is §20.7. If
snapshot copying fails or the process is hard-killed after the marker,
an old success summary therefore cannot
impersonate the latest result. **A preflight or check blocked before
starting a run leaves existing evidence untouched**: an old finished
evidence keeps its validity (validity is determined only by content and
toolchain version, below).

Input file set: design.md, checks.json, all direct-child .tla files (§8.1), and
every .cfg declared for this run under cases/ (**a declared cfg that is
missing is invalid/schema-invalid to check-evidence** — it is a checked
input and should exist after §10 step 3). Dependencies outside the directory
are not allowed. evidence.json, current-run.json, implementation.md, and the
run directory are excluded, avoiding digest self-reference. Business
requirements used in the design must be copied into or fully restated in
design.md; a bare link to a mutable external requirement cannot be tracked
automatically, and keeping it in sync is the main dialog's job.

Digest algorithm: each input path contributes its POSIX path relative to the
model root plus the SHA-256 of the file's raw bytes; paths are sorted in
Unicode code-point order; SHA-256 is taken over the UTF-8 bytes of
JSON.stringify([[path,sha256],...]) — that is inputDigest. The runner,
toolchain, and JAR digests are recorded separately (below). After copying,
the snapshot digest is recomputed and compared with inputDigest (§10 step
5); after the run, the original inputs plus runner, jar, and toolchain
digests are recomputed against the recorded values (§10 step 8); any
mismatch is incomplete/{input-changed,artifact-changed}.

evidence.json, schemaVersion=1, MUST contain:

```text
runId, modelId, inputDigest, inputFiles[{path,sha256}],
runnerDigest, runnerPackage{name,version}, toolchainVersion, toolchainDigest, jarSha256, jarPath, javaVersion, platform,
startedAt, finishedAt, status, reason, warnings[], javaExecutable,
cases[{id,coverage,status,reason,exitCode,signal,
       timedOut,elapsedMs,argv,statistics,
       eventCodes,stdoutPath,stderrPath,stdoutSha256,stderrSha256}]
```

Times are UTC ISO-8601; user-facing display converts to the user's zone.
statistics is the three decimal **non-negative** integer strings
generated/distinct/queue (e.g. "0"; the positive predicates for verified
live in §11.2); when unparseable it is null and the case cannot be verified.
reason is a fixed kebab-case code (full vocabulary in §20). argv is the
argument array actually used at spawn time (file arguments like the jar are
the §10-normalized absolute paths; a PATH-form java is recorded as the
literal `java`); `javaExecutable` is recorded separately — the absolute path
resolved after the run for PATH-form java, or null when unresolvable.
exitCode/signal are null when nothing was spawned. Not-run cases keep
id/coverage and status=not-run, with the other runtime fields null.

runnerDigest: the digest, computed by the exact inputDigest algorithm, over
**all regular files ending in .mjs found recursively under the packaged
runner** (`${CLAUDE_SKILL_DIR}/scripts/`); with the flat layout that is the
entire runner plus shared libraries. runnerPackage records the plugin's
{name, version} as read from its manifests. A plugin upgrade therefore
changes runnerDigest (and usually runnerPackage.version) for every project
at once — older evidence then stales as stale/runner until re-run.
Locally hand-editing the plugin cache is outside this design's trust
boundary: upgrading or reinstalling rewrites the cache, and tampered bytes
simply produce a different runnerDigest lineage.
toolchain.json does NOT participate in runnerDigest: toolchainDigest
separately records the SHA-256 of that file's bytes; together with
toolchainVersion it enters evidence and the check-evidence comparisons.

check-evidence (read-only, no Java) replays logs per §12.1 and recomputes the current inputDigest,
runnerDigest, and toolchainDigest, and verifies: current-run.json's finished
state and lock state (above), toolchainVersion, config↔case correspondence
(every declared cfg exists individually), all-configured-case aggregation
consistency, log file presence and SHA-256, and that the run directory is
inside the project .formal-design/runs. Any mismatch → exit 2 + reason:
stale/{input,runner,toolchain}, log-missing, log-mismatch, schema-invalid,
incomplete-run, run-in-progress. **On success it exits 0 and outputs
`{"status":"valid","fresh":true,"verification":<evidence.status>}`**:
fresh and verification are decoupled — a fresh counterexample/error/
incomplete evidence is equally "valid evidence"; callers MUST read the
verification field, and treating exit 0 as "the model passed" is forbidden.
Cross-machine missing logs are not valid local evidence — re-run (which also requires the same runnerPackage version installed there, plus Java); committed summaries aid review readability but never substitute for an actual check on the new machine.

Evidence has no time TTL; staleness is determined by content and toolchain
identity. Design review opinions MUST reference an inputDigest and record
the runnerPackage, runnerDigest, toolchainDigest and jarSha256 of the
evidence actually reviewed. Approval is bound to inputDigest; tool identity
is audit metadata, not a second approval key.

**User decision (2026-10-24):** after a tool-only upgrade, unchanged
inputDigest plus a fresh, locally validated re-check in which every configured
case is verified permits reuse of the original three-lane approvals.
No new three-lane review is required solely because the runner/plugin,
TLC/JAR or toolchain identity changed. The main dialog records old and new
tool identities, the new runId, the unchanged inputDigest, approval
references, and the disposition of any prior expansion-case findings in
implementation.md. Any configured-case failure blocks reuse and formal
review admission per §5.2/§9.
Without that successful re-check, development cannot continue on the old
evidence. This exception never permits reuse across changed model inputs.

The main dialog owns the reuse decision and its record; neither a runner
exit code nor executor discretion grants reuse. It checks unchanged inputs,
all-case verification, a valid fresh audit, complete prior approval references,
and no unresolved findings. The record names the upgrade scope, including
parser/classifier or TLC changes, and acknowledges that historical lanes did
not review the new tool execution. This is the existing user-approved trust
policy even for those tool changes, not a claim of tool equivalence.
A semantic change to the requirements/model or an unresolved upgrade finding
blocks reuse under the existing rules. No new mandatory re-review category
is introduced by this clarification.

For each tool-only reuse, compare the old and new case outcomes, warning
sets and checked configuration, and record relevant tool release changes or
known issues affecting parsing/classification/model execution. Explain any
observed difference; unresolved findings block reuse under the existing
rule. The original approval references and the new successful check do not
establish equivalence between tool versions. This comparison documents the
existing trust decision and does not add mandatory re-review solely for a
tool change.

The current evidence package contains a single new runId and its actual
tool identities, never old logs, case results, markers or evidence mixed
with the new run. Historical approvals remain separate records retaining
the inputDigest and tool identities originally reviewed. The reuse record
links them to the fresh current run and the §5.2 checks; it never rewrites
their identities or implies that lanes reviewed the upgraded tool.

Example: approvals of digest D under runner R1/run A remain historical.
After upgrade to R2, run B must have the same D, all cases verified and a
successful local audit. implementation.md links A/R1 and the original
approvals to B/R2 and records reuse. Executor receives B's complete evidence
and those references. If D changes to D2, new formal review is required.
This is the explicit exception to redispatch for a changed run after
completed approval. During unfinished formal review, changing the reviewed
run still redispatches one complete new package to all lanes (§20.8).

### 12.1 Read-only log replay during evidence auditing

check-evidence MUST stream and reparse both persisted logs with the same
pinned framing/parser and classifier used by check; hashing alone is not
result validation. It never starts Java, mutates files or requires the old
Java/JAR path to exist. Share pure parser/classifier functions, not the
stored verdict, between producer and auditor.

For each attempted case (including spawn failure), reconstruct eventCodes,
final statistics and TLC
warnings from the exact persisted bytes. Apply §11 classification using
recorded exitCode, signal and timedOut, plus the recorded spawn-failed
observation for an unsuccessful spawn and the case's explicitly recorded
reason for wrapper-only cancellation/log-limit/I/O interruption. Compare
reconstructed fields, status/reason and warnings against Evidence. Recompute
all-case aggregation with the recorded run-global cancellation/input-change/
artifact-change/I/O reason where applicable. Any discrepancy is invalid/
schema-invalid (exit 2), after input/tool staleness and log presence/hash
checks in the §20.7 precedence. No new reason string is introduced.

Wrapper observations are not recoverable from TLC text. Replay trusts the
recorded spawn-failure observation, process exit/signal, timeout flag,
elapsedMs, argv, timestamps and
wrapper interruption/global reason as observations; it validates their
schema and consistency, but does not claim to independently establish
their historical truth. In particular, a recorded timeout/cancellation or
global input mismatch need not appear in a TLC frame. not-run cases have
no logs and follow the exact null/empty-field contract instead of replay.
Replay must preserve incomplete/output-invalid for legitimately malformed
captured output; it rejects a contradictory stored classification, not the
mere existence of a failed run. Global overrides may coexist with all cases
verified, as for cancellation after the final child closes (§10.1).
This detects producer/summary inconsistency within the existing local trust
boundary; it is not cryptographic attestation or independent model execution.

Changes to
design.md, the model, configuration, properties, assumptions, or bounds
invalidate all of the package's evidence and three-lane approvals.
Implementation-code changes do not automatically change the model digest; at
acceptance the main dialog confirms via the action mapping: fix-only changes
re-run the code tests; changes touching abstraction, atomicity, or
assumptions update design.md/model, re-check, and re-run the three-lane
review. Pure log reorderings do not change inputDigest.

## 13. Path, execution, and file-safety boundaries

Runner (preflight/check/check-evidence):

- --project must exist and realpath to a directory; --model is a
  project-relative path, exactly `specs/tla/<modelId>`, where modelId
  equals checks.json's modelId. Absolute paths, `..`, empty segments, and
  boundary-crossing symlinks are rejected. The model input root must contain
  no symlinks; enumeration accepts regular files only. Existing ancestors of
  the run output must also realpath inside the project without crossing
  symlinks. Path errors are caught before any file is written. --jar/--java
  normalization per §10.
- A single model input file is at most 1 MiB; total input at most 10 MiB;
  beyond that, blocked/input-limit. No .class/.jar modules or local Java
  override modules; the check snapshot copies only the allowed inputs, never
  the whole workspace. TLC's bundled modules come from the JAR.
- The environment keeps PATH/JAVA_HOME for locating Java and removes
  JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS, _JAVA_OPTIONS, CLASSPATH, and
  TLA_LIBRARY so no extra agent/classpath/module loads quietly. This is not
  a claim that arbitrary TLA+ programs become a safe sandbox; execution
  remains subject to the host's existing tool permissions and sandbox.
- Model lock: check takes `.formal-design/locks/<model-id>.lock` for one
  model-id as a `wx` exclusive file; conflict → blocked/model-locked. The
  held lock is removed in a finally. Crash leftovers are never auto-deleted:
  report the lock's pid/runId/startedAt and let a human delete it after
  confirming the recorded process is gone. Deleting the lock of a still-
  running task is forbidden.
- Lock probing never proves process identity from PID alone. On supported
  macOS/Linux use kill(pid, 0): success means present, ESRCH means absent,
  and EPERM or any other inability to establish absence means indeterminate.
  A present PID may have been reused; report that uncertainty, never assert
  it is the original checker. check refuses every existing lock as
  model-locked without deleting it. check-evidence returns run-in-progress
  for present/indeterminate probes and for malformed/unreadable lock contents
  whose owner cannot be safely probed. Only a well-formed lock with an absent
  PID may be ignored by auditing; it still blocks check. Diagnostics state
  present/absent/indeterminate and recorded identity where parseable.
  The operator must establish ownership/absence before manual removal;
  automated recovery does not infer it from PID presence or elapsed time.


## 14. The example and the business-to-implementation correspondence

The delivered task-lifecycle example is illustrative only; it does not claim
to have verified dsh-cc's real background-task implementation. The chosen
determinate semantics: once a cancellation is accepted, the logical task
stays cancelled; cancellation does not promise a rollback of external side
effects already performed. A retry increments the attempt number; a late
callback is accepted only when its number matches and the task is running.

The model contains status, attempt, cancelAccepted; actions are Start,
Timeout, Retry, Cancel, CompleteCurrent, CompleteStale, TerminalStutter.
Both cancellation and completion may be scheduled; if completion happens
first the cancellation is not accepted. Past MaxAttempts the model
explicitly enters failed, avoiding unbounded integers and action-less
terminal states.

MUST-check: TypeOK, CancelledStable, StaleCannotComplete; a property's
definition must retain enough history to be meaningful — never write it as a
trivially-true comparison. The safe correct example does not declare
unconditional liveness; the separate liveness test model uses explicit weak
fairness and verifies eventual termination.

The test fixtures also contain a buggy model whose stale callback lacks the
attempt guard; TLC should produce a counterexample. Turn that trace into a
plain code regression scenario: first execution times out, the second
starts, the first one's success callback arrives — assert the second one's
state is not overwritten. The implementation mapping MUST name the real
callback handler and test name; before implementation design.md may name
planned symbols. At acceptance the observed mapping in implementation.md
MUST name the real locations, linked to the same action/property IDs; the
approved planned mapping in design.md is not overwritten (§5.1).

implementation.md finally contains: inputDigest, the code symbol for each
model action, how atomicity is implemented, the test or manual-review
evidence for each key property, the unmodeled scope, and deviations. TLC
passing and code tests passing are reported separately.

### 14.1 Required worked workflow example

Ship examples/task-lifecycle/workflow.md in addition to the runnable model
package. It is a clearly labeled illustrative walkthrough, not generated
Evidence or a claim that TLC or real review was executed at design time.
The shipped example uses actual outputs only after §16 acceptance produces
them; until then, symbolic D/A/B/R1/R2 labels below are explanatory and must
never be serialized as valid digests, IDs or approvals. Real acceptance
records remain separate and identify their actual artifacts.

The walkthrough must connect all of the following stages:

| Stage | Concrete decision and required record |
|---|---|
| Request and adoption | User asks to support cancellation and retry while callbacks may arrive late. Record effective screening/review rules or their blockers (§4.4), and FD-T1/FD-T2 enabled. |
| Business semantics | Cancellation wins only if accepted before terminal completion; no rollback of an external side effect is promised. Only a callback for the active running attempt may complete the task. |
| Requirements and model | S-1 maps cancellation stability to CancelledStable; S-2 maps stale-result rejection to StaleCannotComplete. Map both to core case small with MaxAttempts=2, and TypeOK to the same case. State why two attempts expose an old/new-attempt race, without claiming arbitrary-scale proof. |
| Atomicity and assumptions | Plan a guarded status/attempt update, represented as one atomic action. Name planned applyCompletion(taskId, attempt) and cancelTask(taskId) symbols and the intended transaction/CAS mechanism. Keep the example in-memory unless persistence is explicitly modeled. |
| Rejected abstraction | Reject a draft that treats cancellation as rolling back a side effect already sent by a worker. Trace: worker starts effect → cancellation accepted → effect completes. Explain that logical terminal-state properties cannot establish absence of that effect. |
| Scope decision | Restate the user's logical-state contract in design.md; show that effect rollback is outside that contract. If actual requirements demand no post-cancel effects, this is a requirements/design blocker: model an enforceable effect protocol or obtain the project's required scoped exclusion approval, never drop the requirement silently. |
| Counterexample | Use the separate buggy fixture: attempt 1 times out → retry starts attempt 2 → completion for attempt 1 is incorrectly accepted. Preserve its failing evidence separately; explain the missing attempt guard and why the correct model rejects it. Never add the buggy fixture as a must-pass case in the correct package. |
| Checking and coverage | Generate/inspect cfg, run check, audit the same run, and inspect coverage. A verified tool result with incomplete atomicity/abstraction justification remains blocked. Keep actual run IDs and outcomes in implementation.md. |
| Formal review | Deliver one complete package at digest D/run A to all required lanes, each with full logs and receiver checks. Record per-lane dispositions and consolidated unresolved findings. Illustrative approvals are not reusable real approvals. |
| Revision | If a lane requires changed semantics, update design/model, obtain new digest D2, re-check and re-review all required lanes. If a lane only needs a missing log, restore that same-run package or redispatch one complete replacement run; do not merge runs. |
| Handoff | After actual required approvals, hand off approved D and fresh evidence, planned guarded-update symbols, code-change plan and regression assertions. The executor reports a blocker if the required atomic update cannot be implemented. |
| Acceptance | implementation.md maps actual symbols and tests to the same action/property IDs and approved D. Tests cover both cancellation/completion orders and stale callback after retry. Pure observed locations/results do not edit design.md. Semantic deviations require §12 redesign/check/review. |
| Tool upgrade | For unchanged D and fresh verified/audited B under R2, link historical A/R1 approvals via the §12 reuse record. Keep B's evidence complete and unmixed. Changed D2 never reuses D approvals. |

The normative coverage table in design.md still uses every §5.1 column;
the walkthrough table does not replace it. Populate the example's planned
matrix with explicit requirement/property/action IDs, case bounds,
fault traces, assumptions, atomicity, assertions and exclusions. Include
both the timeout/retry/late-result trace and cancel/late-callback trace;
state that neither establishes external effect rollback or persistence
safety. Do not invent real code locations before implementation.

Review records in the walkthrough show the required structure: lane
identity from effective rules, reviewed inputDigest/runId, tool identities,
accessible artifact locations and receiver hash/replay results, disposition,
findings and resolution. Reuse records add old/new tool/run identities,
unchanged inputDigest, original approval references and the fresh audit.
Use actual effective lane identities and real hashes in acceptance records,
never the walkthrough's symbolic labels.

## 15. Normative content of AGENTS.md and the skills

agents-snippet.md provides a complete copyable version of the following
rules, without assuming lane identities:

1. After design and before the existing formal design review, run the
   formal-design screening; on a hit, load the skill and record the
   rationale.
2. An enabled task enters the formal three-lane design review only after
   every configured case is verified, the evidence is fresh, the coverage
   check is complete, and no findings remain unresolved (§5.2). A configured
   expansion case has the same pass obligation. Consulting reviewers early
   is allowed but is not a formal approval.
3. All three lanes review the design+verification package at the same
   inputDigest; the existing three-lane pass criteria continue to apply.
4. The executor receives the approved design, model evidence,
   implementation mapping, and regression scenarios; it must not edit model
   semantics to make checks pass.
5. Changing properties, assumptions, or behavior invalidates the evidence —
   re-check and re-review.
6. Inability to check never auto-waives; an explicit user waiver displays
   the unverified scope.
7. Distinguish skill availability from effective project-wide screening;
   re-screen changed scope and stop affected implementation per §4.4.

Norms for the packaged skill:

- `formal-design`'s description covers the modeling trigger territory (the
  FD-T1…T4 shapes), not only the keyword "TLA+"; the body stays a workflow
  entry with technical detail in references; the user never has to say
  "invoke formal-design" first.
- The body instructs the runner invocation exactly as §10
  (`${CLAUDE_SKILL_DIR}` examples), states honestly that plugin content
  changes take effect after update + restart (§3.3), and names the one
  suggested project hygiene edit (the `/.formal-design/` .gitignore line)
  as a manual step.
- The runner's write set is §3.2. Main-dialog/executor plain file edits
  additionally create/update implementation.md, maintain generated cfgs per
  §9.2, and add the project .gitignore entry. Skill prose must distinguish
  these edits from runner writes; no runner edits .gitignore.
- orchestration gains one pointer sentence to this skill (§7.2). The
  three-lane policy is not copied into any skill — one canonical copy,
  no drift.

## 16. Test and acceptance matrix

### 16.1 Java-free unit/contract tests

Vitest + Node builtins; no new runtime npm dependencies. Processes are
mocked by injecting spawn/clock/file roots — no shell composition, no real
waits to fake timeouts.

| Category | Must cover |
|---|---|
| manifest | full valid example, unknown/duplicate JSON keys, missing fields, duplicate cases, no core case, legacy required field, invalid coverage label, no invariant, illegal IDs, out-of-range limits, **value grammar** (directive-token-in-value like "2 CONSTRAINT Prune"/"TRUE PROPERTY", reserved-word idents, nested sets, trailing garbage, negative integers, quotes) |
| cfg | key order, LF, CONSTANTS header present/absent, existing-identical, existing-different refuses overwrite, extra directives forbidden, canonical serialization |
| paths | `..`, absolute model, input symlinks, output ancestor symlinks, paths with spaces, file/total ceilings, --jar/--java symlink resolution and recording |
| environment | missing Java/JAR, version too low, checksum mismatch, Windows, env-var scrubbing; distinct expected manifest names with equal versions pass, wrong names/unequal versions block; Java probe deadline/output ceiling/parse failures/spawn errors and check cancellation per §10.1.1 |
| parser | arbitrary chunk splits, CRLF, **nested frames**, END mismatch, unclosed frames, severity∉{0,1,2,3,4}, WARNING/STATE retained, severity=2, unknown codes at both severities, success/finish ordering |
| classification | at least one case per §11.3 table row (incl. 2113 vs 2132 discrimination, 255, exit-0-without-success, exit-0-with-error, nonzero-with-success, output-inconsistent, OOM, signals, timeout, log-limit, unknown output); **an all-zero-stats empty Init is never verified** |
| lifecycle | timeout TERM→KILL, same ladder for log ceiling, no case runs after cancellation and summary=incomplete/cancelled, results written only after close, lock conflict, lock release on error, failed runs overwrite the latest summary, running marker after hard-kill blocks reuse of old success, **snapshot digest ≠ inputDigest → no spawn**, mid-run artifact change → incomplete |
| evidence | staleness on model/design/cfg/runner/toolchain changes, missing declared cfg → invalid, mid-run input change, logs missing/modified, summary schema invalid, cross-project path refusal, **fresh/verification decoupling** (a fresh counterexample evidence exits 0 with verification=counterexample), present/indeterminate lock owner → run-in-progress |
| aggregation | all-configured-case failures affect status regardless of coverage label; expansion failure also appears in warnings; deterministic order; no not-run case dropped; precedence among multiple failures; **run-global cancellation/input/artifact preconditions beat case aggregation; expansion timeout/log-limit/signal yield incomplete and prevent verified** |
| publish | the whole skill tree (SKILL.md, references, scripts, toolchain.json, examples) ships in the package (npm-pack assertions), agent trailers unchanged, every §2.2 description surface consistent, bilingual doc hashes re-recorded, every shipped file is clean under `git check-ignore` |

The path tests additionally assert §8.1: a direct-child helper participates
in the digest and snapshot; a nested .tla under an arbitrary subdirectory or
cases/ is rejected with the specified producer/auditor reasons; undeclared
cfgs are neither run nor digested. The same fresh enumeration is used by
producer and auditor, including newly added files.

The unit matrix additionally includes every §20.8 scenario for partial cfg
generation, stable blocker ordering and all-case aggregation. Workflow-only
admission, mapping and remote-delivery scenarios are demonstrated with main
dialog/reviewer records under §16.4, not claimed as runner enforcement.

### 16.2 Real TLC integration tests

formal-design-integration.spec.ts is opt-in locally via TLA2TOOLS_JAR or
FORMAL_DESIGN_CI=1 (using the bundle). The dedicated CI job sets the latter
and MUST validate and use the bundled pinned JAR with TLA2TOOLS_JAR unset —
a missing or corrupt bundle fails rather than skips. Include actual npm
archive extraction and zero-JAR-configuration preflight/check/audit, plus
Git marketplace cache selection and byte-preservation tests. Real runs against: the correct
model, the buggy-callback model, a deadlock model, liveness pass and fail
models with fairness, a syntax-error model, **an empty-Init model**
(asserting non-verified), and **a safety-form PROPERTY model** (asserting
verified WITHOUT 2267), asserting wrapper statuses and log events. **Every
reachable TLC exit in the §11.3 classification table gets at least one real-run fixture
pinning the reachable TLC outcome**. Wrapper-only paths (spawn failure,
signals, cancellation, timeout, log ceiling, malformed/unknown protocol,
digest races and filesystem errors) use deterministic injected unit tests;
they do not require a real TLC fixture for every synthetic code. The
injection constant must be rejected by manifest tests before any spawn. First confirm §11's stats and frame
assumptions against real output; if the pinned version's actual format
differs, revise the parser and this document's corresponding protocol —
never just edit test expectations to get past.

Integration tests run the packaged runner directly from the repository
tree's `packages/plugin/dsh-cc-agents/skills/formal-design/` directory (the
shipped artifact), and the npm-pack smoke test separately asserts that the
publish tarball carries the same files — together covering the run chain
and the packaging chain.

### 16.3 CI

Add `.github/workflows/formal-design.yml`: pull_request and push to the
default branch; ubuntu-latest. Steps follow the repo conventions (§2.2 CI
paragraph):

1. `defaults: run: shell: bash` (the pipefail gate).
2. Side-by-side checkouts of dsh-cc and deepseek-harness (pin = the same
   DSH_HARNESS_REF as presubmit env), setup-node + pnpm cache as in
   presubmit.
3. `pnpm install --frozen-lockfile` (no harness lib build needed; if
   implementation proves otherwise, fall back to copying presubmit's
   cache/build block and note it in the implementation record).
4. setup-java Temurin 17; verify the Git-tracked bundled JAR against the
   official SHA-1; missing/checksum failure MUST fail the job. Unset
   TLA2TOOLS_JAR and run with FORMAL_DESIGN_CI=1. No JAR download occurs.
5. `pnpm exec vitest run packages/plugin/dsh-cc-agents/tests/formal-design.spec.ts packages/plugin/dsh-cc-agents/tests/formal-design-integration.spec.ts`.
6. On failure, upload the test-produced .formal-design output as a
   diagnostic artifact; tests should copy output into the job-designated
   directory to avoid temp-dir cleanup.

Ordinary dsh-cc starts and other user projects never auto-run these models.

### 16.4 Workflow scenario acceptance

The developer saves the main-dialog responses and path evidence for each
scenario below; keyword searches over the skill do not count as acceptance:

- After a plugin upgrade and restart: check-evidence on a pre-upgrade model
  package reports stale/runner; re-running check restores valid evidence.
  With unchanged inputDigest and every configured case verified, the main dialog
  records approval reuse per §12; no automatic new three-lane dispatch.
- Plain formatting work: not-needed recorded; original three-lane flow
  continues; no Java required.
- Cancellation/retry design: auto-enabled — model first, formal review
  second; all three lanes get the same digest.
- User explicitly asks for TLA+: enabled even when auto-screening misses.
- User explicitly opts out: waived recorded, unverified reported; conflicts
  with stricter project rules follow the conflict rule.
- Missing Java / check timeout: blocked/incomplete reported truthfully —
  never called a pass, never dispatched to formal review or development.
- An expansion case fails while all core cases verify: no formal dispatch;
  resolve the failure and re-check every configured case. Renaming it
  optional or logging a warning cannot admit review.
- cfg generation fails partway: retain completed cfgs, report completed/
  unfinished paths, repair and retry without overwriting retained files;
  do not confuse generated inputs with verified evidence.
- Acceptance only adds observed code/test locations: update implementation.md
  and preserve design.md/inputDigest. Changed assumptions require redesign,
  re-check and new formal review.
- A remote lane lacks a complete log: record blocked review evidence;
  supply a complete same-run package before counting its approval.
- For every remote lane, deliver a real package through its actual authorized
  channel, with a log larger than that channel's inline-text limit, plus a
  representative multi-case package. Record producer/receiver enumeration,
  hashes, runId/inputDigest, retrieval and read results. Exercise channel
  capacity/access failure: no formal dispatch or summary-only approval.
- Review a critical abstraction with an adverse concrete trace, including
  cancellation followed by a late callback that produces an external side
  effect. Explain whether the stated property observes that effect;
  omitted relevant behavior must cause model revision or an approved
  exclusion, even when the coverage matrix has no empty cells.
- Asked to "just delete the failing property and start coding": the failing
  evidence is preserved and the decision returns to design; success is never
  fabricated.
- Reviewers require changing assumptions: old approvals lapse; re-check,
  then re-review.
- Executor finds the planned atomic update unimplementable: Blockers
  reported; back to the main dialog for redesign.
- After implementation the model turns out to have missed duplicate
  callbacks: extend the model, re-check, re-review, add the code test.
- Three-lane rules unloadable: finish the modeling that can be done
  independently, then report the missing rules before development — never
  invent reviewers.

Also record these workflow-clarity acceptance scenarios:

- Skill installation alone, explicit invocation without adopted screening,
  orchestration selection, and effective project rules produce exactly the
  distinct §4.4 notices/records. Missing review rules block implementation.
- A not-needed design later adds retries: re-screen, enable, and complete
  the full gate; old ordinary-design approval is insufficient. An executor
  discovering this deviation pauses and reports it.
- A scope change outside an earlier waiver requires a new scoped decision;
  no automatic extension or silent loss of the prior record.
- Upgrade R1/run A to R2/run B with identical inputs: B is the sole current
  evidence, A's approvals retain their original identities, reuse is recorded,
  and no new formal dispatch occurs after approval. A changed input or an
  unfinished review instead follows the re-review/redispatch rules.
- The remote-channel feasibility record precedes workflow integration (step 4
  of §17); independent runner work in steps 1–3 may proceed beforehand;
  later actual-package delivery records receiver hashes and replay.
  Unsupported payload sizes/access remain blocked, without adding a service.
- Walk through §14.1 end to end using real check/review artifacts for
  acceptance; demonstrate the rejected side-effect abstraction and a
  semantics-changing revision. No symbolic walkthrough approval counts.

v1 adds no new automated multi-agent evaluation platform; existing dsh-cc
sessions perform the manual acceptance with records kept, while automated
tests own the executable scripts. Manual scenario demonstration must not be
claimed as a runtime enforcement guarantee.

## 17. Implementation order and definition of done

Before workflow integration (step 4), complete the §20.8 remote-channel
feasibility record for every remote lane and confirm effective review rules
are available. Steps 1–3 may proceed independently while those checks are
pending; neither their completion nor local TLC success establishes an
end-to-end deliverable. Do not begin step 4, formal dispatch, or claim workflow
acceptance until both prerequisites are established. Before a runner exists,
representative files and an existing receiver-side hashing/streaming mechanism
establish transport feasibility only, not runner replay. Missing capability
is an end-to-end integration blocker. Independent pure runner work may proceed,
but the complete workflow cannot be claimed deliverable or done. Actual
runner-package delivery and replay remain later acceptance (§16.4).

Deliver in this dependency order; at every implementation step pin the
corresponding failing tests first, then implement:

1. manifest/cfg/fingerprint: implement §9, §12's input enumeration/digest,
   §13's path constraints as pure functions with tests; pin every boundary
   value (value grammar and canonical serialization included).
2. preflight/process/parser/check: implement §10, §11, pinned-log tests,
   then real TLC tests. Until the runner reaches the strict success
   judgment, do not advertise verifiability to the agents.
3. check-evidence and the example: implement staleness checks, the buggy
   model, and the correct model; run model → evidence → modify → stale →
   re-run end to end.
4. Skill prose and integration: the formal-design SKILL.md/references, the
   orchestration pointer, the executor/critic additions, the agents
   snippet — write the workflow per §4–6 and §15, preserving existing
   report trailers.
5. Description surfaces, CI, and scenario acceptance: sync the six §2.2
   surfaces, re-record README hashes, add the new workflow, and run the full
   acceptance matrix (§16.4).

Suggested verification commands (run by the implementation; not claimed to
pass at the time of writing):

```sh
pnpm exec vitest run packages/plugin/dsh-cc-agents/tests/formal-design.spec.ts packages/plugin/dsh-cc-agents/tests/package-shape.spec.ts
FORMAL_DESIGN_CI=1 pnpm exec vitest run packages/plugin/dsh-cc-agents/tests/formal-design-integration.spec.ts   # Java >=17; bundled JAR
node scripts/check-readme.mjs --write && pnpm check:readme
pnpm check:publish
pnpm check:artifacts
pnpm check:spec-deps
pnpm check:workflow-pipefail
```

Also run `npm pack --dry-run --json` in the plugin directory and check the
actual publish manifest for the new files — do not merely check that source
directories exist. The release version is not specified in this design; the
normal release flow decides it.

Done when: the scripts and publish checks above pass; the pinned TLC run
yields the expected classification for the correct / counterexample /
deadlock / liveness / error models; every §16.4 workflow scenario is
recorded; no unresolved blockers; the ordinary request entry point is
unchanged; documents distinguish bounded-model results from the real
implementation; no mandatory Java startup dependency was added and no
nonexistent runtime gate is claimed.

### 17.1 Contract and acceptance navigation

This table is a navigation index, not a second definition of behavior.
Normative details remain at the referenced sections. If an implementation
discovers an apparent conflict, report a design blocker rather than choose
a convenient interpretation; the main dialog resolves it before affected
work proceeds.

| Observable contract | Normative source | Verification evidence |
|---|---|---|
| Discovery, adoption notices and re-screening | §4 | §16.4 effective-rule and scope-change records |
| Coverage, review admission and change adjudication | §5, §6 | §16.4 scenarios and §5.3 decision records |
| Config validation and exact cfg generation/recovery | §9 | §16 automated fixtures; §20.8 items 1, 2, 10, 11 |
| CLI lifecycle and cancellation publication | §10, §10.1 | §20.7 serialized outcomes; §20.8 items 5, 15, 16 |
| TLC parsing, classification and aggregation | §11 | §16 pinned/real TLC fixtures; §20.8 items 3, 4, 9, 14 |
| Digests, replay, staleness and approval reuse | §12, §12.1 | §16.4 upgrade scenarios; §20.8 items 6, 7, 12, 14 |
| Path boundaries, environment and locks | §13 | §16 automated fixtures; §20.8 item 17 |
| Model examples and business/code correspondence | §14, §18, §18.1 | §16.4 actual workflow plus real companion counterexample |
| Packaging and staged integration readiness | §2, §3, §7, §17 | Publish manifest, package tests and prerequisite record |
| Serialized public shapes and rejection precedence | §20.7 | Producer/consumer round trips and failure injection |
| Complete remote evidence delivery | §20.8 | Per-lane feasibility and actual receiver records in §16.4 |

The implementation record maps each applicable contract row to concrete
test names or manual scenario records and observed results. Pending
prerequisites are recorded as pending/blocked, never as passing checks.
This index does not replace the full acceptance requirements.

## 18. The minimal example's determinate model

examples/task-lifecycle/Model.tla uses the following content verbatim.
checks.json uses the §9 example; design.md explains the semantics and limits
per §8. This example models only logical task state; it does not abstract
in-flight external side effects as roll-backable.

```tla
-------------------------- MODULE Model --------------------------
EXTENDS Naturals
CONSTANT MaxAttempts
ASSUME MaxAttempts \in Nat \ {0}
VARIABLES status, attempt, cancelAccepted, acceptedAttempt
vars == <<status, attempt, cancelAccepted, acceptedAttempt>>
Terminal == {"cancelled", "succeeded", "failed"}
Init == /\ status = "queued"
        /\ attempt = 0
        /\ cancelAccepted = FALSE
        /\ acceptedAttempt = 0
Start == /\ status = "queued"
         /\ status' = "running"
         /\ attempt' = 1
         /\ UNCHANGED <<cancelAccepted, acceptedAttempt>>
Timeout == /\ status = "running"
           /\ status' = IF attempt < MaxAttempts THEN "waiting" ELSE "failed"
           /\ UNCHANGED <<attempt, cancelAccepted, acceptedAttempt>>
Retry == /\ status = "waiting"
         /\ attempt < MaxAttempts
         /\ status' = "running"
         /\ attempt' = attempt + 1
         /\ UNCHANGED <<cancelAccepted, acceptedAttempt>>
Cancel == /\ status \notin Terminal
          /\ status' = "cancelled"
          /\ cancelAccepted' = TRUE
          /\ UNCHANGED <<attempt, acceptedAttempt>>
CompleteCurrent == /\ status = "running"
                   /\ status' = "succeeded"
                   /\ acceptedAttempt' = attempt
                   /\ UNCHANGED <<attempt, cancelAccepted>>
CompleteStale == /\ attempt > 1
                 /\ UNCHANGED vars
TerminalStutter == /\ status \in Terminal
                   /\ UNCHANGED vars
Next == Start \/ Timeout \/ Retry \/ Cancel \/ CompleteCurrent
        \/ CompleteStale \/ TerminalStutter
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"queued", "running", "waiting"} \cup Terminal
          /\ attempt \in 0..MaxAttempts
          /\ cancelAccepted \in BOOLEAN
          /\ acceptedAttempt \in 0..MaxAttempts
CancelledStable == cancelAccepted => status = "cancelled"
StaleCannotComplete == status = "succeeded" => acceptedAttempt = attempt
==================================================================
```

The buggy-callback fixture replaces ONLY CompleteStale with the following,
everything else identical. It models wrongly accepting the previous round's
success while the current task is still running; at MaxAttempts=2 it should
violate StaleCannotComplete. An expected-to-fail fixture must not be placed
in the correct example's configured checks.

```tla
CompleteStale == /\ status = "running"
                 /\ attempt > 1
                 /\ status' = "succeeded"
                 /\ acceptedAttempt' = attempt - 1
                 /\ UNCHANGED <<attempt, cancelAccepted>>
```

Only the model source and expected behavior are provided here; TLC was not
executed as of this document's delivery. The developer MUST confirm via the
§16.2 real integration tests. Late events after cancellation are represented
by stuttering in the spec; whether that abstraction suffices for the target
code MUST be reviewed separately. The example does not model workers,
leases, persistence, or external side-effect dedup, and claims no such
properties.

### 18.1 Explicit late-event companion fixture

Keep the §18 minimal fixture unchanged. Additionally ship a separate correct
companion model and buggy variant that explicitly represent a delivered
completion's attempt number. This fixture is not an external-effect or
persistence model and does not add cases to the minimal package.

The companion extends the logical task model with pending completions for
started attempts. Starting attempt a may enqueue a completion tagged a;
delivery nondeterministically selects a pending tag and removes it. Delivery
changes status to succeeded and acceptedAttempt to that tag only when
status is running and the tag equals the current attempt. Other deliveries
leave the logical task fields unchanged. Cancellation does not erase pending
events, allowing delivery after cancellation. State exactly which operation
atomically removes the event and conditionally updates task state.

Use finite attempts and at most one pending completion per attempt; explicitly
exclude duplicate deliveries in this fixture and explain that it establishes
no duplicate-side-effect property. Include TypeOK, CancelledStable and
StaleCannotComplete, plus coverage traces for timeout → retry → old delivery,
both cancel/current-completion orders, and cancel → pending delivery.
The buggy variant removes only the attempt-equality guard, and must yield
a stale-result counterexample at two attempts. Record actual TLC outputs at
implementation acceptance; this design text claims no execution.

This companion tests the modeled receiver guard rather than assuming all
stale deliveries stutter. It still requires the abstraction and atomicity
review in §5.1; a passing companion is not proof that a real callback handler
implements its guard atomically.

## 19. Official protocol references

- TLC v1.7.4 release and official checksum:
  https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4
- Pinned-version event and exit codes:
  https://github.com/tlaplus/tlaplus/blob/v1.7.4/tlatools/org.lamport.tlatools/src/tlc2/output/EC.java
- Pinned-version message framing:
  https://github.com/tlaplus/tlaplus/blob/v1.7.4/tlatools/org.lamport.tlatools/src/tlc2/output/MP.java
- Pinned-version command entry:
  https://github.com/tlaplus/tlaplus/blob/v1.7.4/tlatools/org.lamport.tlatools/src/tlc2/TLC.java
- Pinned-version ModelConfig (cfg syntax and parse behavior):
  https://github.com/tlaplus/tlaplus/blob/v1.7.4/tlatools/org.lamport.tlatools/src/tlc2/tool/impl/ModelConfig.java

These sources ground the tool protocol; the trigger policy, workflow states,
file formats, and acceptance criteria are this project's design decisions,
not TLA+ official requirements.

## 20. Appendix: JSON contracts and the reason vocabulary

Every runner command's stdout is exactly one JSON object + one LF.
Sections 20.1–20.6 show discriminants and abridged illustrations; §20.7
defines the complete field shapes, nullability and validation rules.
No field is optional unless §20.7 explicitly says so. JSON object key order
is not significant. Semantic algorithms in the body and the field contract
in §20.7 must agree; any new contradiction is a design blocker, not license
for executor to choose silently.

### 20.1 preflight.mjs

```json
{"schemaVersion":1,"command":"preflight","status":"ready-for-check|blocked","reason":"…","blockers":[{"code":"…","detail":"…"}],"willGenerate":["cases/small.cfg"]}
```

### 20.2 check.mjs (the stdout projection of the evidence summary)

```json
{"schemaVersion":1,"command":"check","status":"verified|counterexample|error|incomplete|blocked","reason":"…","blockers":[],"summary":"<Evidence object or null; see 20.7>"}
```

evidence.json's complete field list is in §12; stdout's `summary` is
identical in shape.

### 20.3 check-evidence.mjs

```json
{"schemaVersion":1,"command":"check-evidence","status":"valid|invalid","reason":"<see 20.5>","fresh":true,"verification":"verified|counterexample|error|incomplete","runId":"…","inputDigest":"…"}
```

`status=valid` always pairs with `fresh:true`; `verification` relays the
audited evidence's top-level status (**not a pass**, §12). When invalid:
fresh=false, verification=null, reason concrete.

### 20.4 Runner exit codes (fixed per command)

- preflight: 0 = ready-for-check; 2 = blocked or usage errors.
- check, by final command status: 0 = verified; 1 = counterexample;
  2 = blocked or error (all blockers listed); 3 = incomplete
  (including cancellation).
- check-evidence: 0 = valid (integrity+freshness; **not a pass**); 2 =
  invalid/stale/missing, with a concrete reason.

### 20.5 The complete reason vocabulary (implementations pick ONLY from here)

- Successful preflight uses `ready-for-check`; successful check uses
  `verified`; successful auditing uses `valid`.
- preflight blocked: `config-invalid` (checks.json validation failure),
  `config-drift` (cfg mismatch), `input-limit`, `model-path-unsafe`,
  `java-missing`, `java-version`, `jar-missing`, `jar-checksum`,
  `unsupported-platform`, `usage-invalid`, `io`.
- check: `model-locked`, `lock-io`, plus everything from preflight.
- Case level: `verified`, `counterexample/deadlock`,
  `counterexample/invariant`, `counterexample/temporal`,
  `counterexample/value-assert`, `error/assumption-failed`,
  `error/property-evaluation-failed`, `error/config-invalid`,
  `error/unknown-error`, `error/tlc-bug`, `error/output-inconsistent`,
  `error/spawn-failed`, `error/io`, `incomplete/timeout`, `incomplete/log-limit`,
  `incomplete/cancelled`, `incomplete/signal-exit`, `incomplete/input-changed`,
  `incomplete/artifact-changed`, `not-run/not-run`,
  `incomplete/output-invalid`. (evidence's cases[].reason records the
  post-slash half; cases[].status records the pre-slash half.)
- check-evidence: `valid`, `stale/input`, `stale/runner`,
  `stale/toolchain`, `log-missing`, `log-mismatch`, `schema-invalid`,
  `incomplete-run`, `run-in-progress`, `evidence-missing`,
  `runs-path-unsafe`, `usage-invalid`, `io`.

With multiple coexisting causes: preflight lists blockers in the fixed
order in §20.7, and reason is the first blocker's code. Run-global causes
use §11.4 precedence; otherwise summary.reason comes from the first case
in manifest order having the aggregate status. Only case classification
uses §11.3's table. These are three distinct priority domains.

### 20.6 Representative output samples (truncated; field order not fixed)

Spawn failure (one case of a check):

```json
{"id":"small","coverage":"core","status":"error","reason":"spawn-failed","exitCode":null,"signal":null,"timedOut":false,"elapsedMs":3,"argv":["java","..."],"statistics":null,"eventCodes":[]}
```

User cancellation (check, exit 3):

```json
{"schemaVersion":1,"command":"check","status":"incomplete","reason":"cancelled","summary":{"status":"incomplete","cases":[{"id":"small","coverage":"core","status":"incomplete","reason":"cancelled"},{"id":"large","coverage":"expansion","status":"not-run","reason":"not-run"}]}}
```

Stale evidence (check-evidence, exit 2):

```json
{"schemaVersion":1,"command":"check-evidence","status":"invalid","reason":"stale/runner","fresh":false,"verification":null,"runId":"20261023T120000Z-9f1c","inputDigest":"…"}
```

Multiple blockers (preflight, exit 2):

```json
{"schemaVersion":1,"command":"preflight","status":"blocked","blockers":[{"code":"java-missing","detail":"no java on PATH"},{"code":"jar-checksum","detail":"SHA-1 mismatch"}]}
```

### 20.7 Complete serialized shapes and validation

These are structural type definitions, not JSON samples. `string[]` may be
empty. All object fields shown are mandatory; unknown fields and duplicate
keys are rejected on read. Nullable fields are emitted as null, never omitted.
No schema library or new dependency is required. Tests assert these shapes
for every producer and consumer.

```text
Blocker = { code: BlockedReason, detail: string }
BlockedReason = usage-invalid | model-locked | lock-io | config-invalid |
  config-drift | input-limit | model-path-unsafe | java-missing |
  java-version | jar-missing | jar-checksum | unsupported-platform | io
RunStatus = verified | counterexample | error | incomplete
CaseStatus = RunStatus | not-run
Statistics = { generated: DecimalString, distinct: DecimalString,
               queue: DecimalString }
InputFile = { path: string, sha256: Sha256 }
RunnerPackage = { name: string, version: string }
CaseResult = {
  id: string, coverage: core|expansion, status: CaseStatus, reason: string,
  exitCode: integer|null, signal: string|null, timedOut: boolean|null,
  elapsedMs: nonnegative-integer|null, argv: string[]|null,
  statistics: Statistics|null, eventCodes: integer[],
  stdoutPath: string|null, stderrPath: string|null,
  stdoutSha256: Sha256|null, stderrSha256: Sha256|null
}
Evidence = {
  schemaVersion: 1, runId: string, modelId: string,
  inputDigest: Sha256, inputFiles: InputFile[],
  runnerDigest: Sha256, runnerPackage: RunnerPackage,
  toolchainVersion: string, toolchainDigest: Sha256,
  jarSha256: Sha256, jarPath: string, javaVersion: string,
  javaExecutable: string|null, platform: darwin|linux,
  startedAt: string, finishedAt: string,
  status: RunStatus, reason: string, warnings: string[],
  cases: CaseResult[]
}
CurrentRun = {
  schemaVersion: 1, runId: string, inputDigest: Sha256,
  state: running|finished
}
ModelLock = {
  schemaVersion: 1, pid: positive-integer, runId: string, startedAt: string
}
PreflightOutput = {
  schemaVersion: 1, command: preflight,
  status: ready-for-check|blocked, reason: string,
  blockers: Blocker[], willGenerate: string[]
}
CheckOutput = {
  schemaVersion: 1, command: check,
  status: RunStatus|blocked, reason: string,
  blockers: Blocker[], summary: Evidence|null
}
AuditOutput = {
  schemaVersion: 1, command: check-evidence,
  status: valid|invalid, reason: string, fresh: boolean,
  verification: RunStatus|null, runId: string|null, inputDigest: Sha256|null
}
```

- Sha256 is exactly 64 lowercase hex characters. DecimalString matches
  `0|[1-9][0-9]*`. UTC times use `Date.toISOString()`; finishedAt must
  not precede startedAt. elapsedMs uses a monotonic clock.
- Evidence has top-level status/reason, with NO nested summary member.
  CheckOutput.summary is the whole Evidence object, with status/reason
  equal to the outer fields. It is null for blocked/pre-run failures and
  pre-marker cancellation (§10.1). No fabricated Evidence is written for
  preflight blockage. After the running marker, it is null only when I/O
  prevents consistent publication (including a latched cancellation with
  that I/O failure), as defined below; such output is not completed Evidence.
- Ready preflight: reason=ready-for-check, blockers=[]; willGenerate lists
  absent declared cfg paths in manifest order. Blocked preflight/check:
  reason is the first blocker code, blockers is nonempty, and
  willGenerate=[] (preflight) or summary=null (check). All check output
  objects include blockers, empty for an executed run or cancellation.
- BlockedReason governs the blocked-output branch. CaseResult status/reason
  pairs are independently restricted to §20.5, including not-run/not-run;
  shared spellings such as io and config-invalid are intentional.
  Verified has reason=verified. Evidence reasons use the selected case's
  bare reason or the run-global reason (§11.4).
- cases contains exactly one result per manifest case in manifest order;
  IDs and coverage labels match checks.json, with no extras or duplicates.
  Not-run has reason=not-run, eventCodes=[], and every runtime field null.
  A failed spawn has status=error/reason=spawn-failed, elapsedMs measured
  for the attempt, timedOut=false, argv equal to the attempted command
  vector, exitCode/signal/statistics=null. Its log files exist and may be
  empty. A started child has non-null argv, elapsedMs and timedOut.
  eventCodes contains unique observed numeric codes sorted ascending.
- argv includes the executable as element 0, then the arguments actually
  supplied to spawn. PATH java is recorded literally as java; an explicitly
  supplied executable is normalized per §10. javaExecutable is audit
  metadata resolved as described in §12, not an attestation of binary bytes.
- Log paths are project-relative POSIX paths rooted under
  .formal-design/runs/<modelId>/<runId>/<caseId>/. stdout and stderr hashes
  cover their exact persisted bytes. At the combined 50 MiB limit, persist
  only the first 50 MiB in arrival order, stop adding bytes, terminate the
  child, and record incomplete/log-limit; this limit is not a success path.
  Null logs/hashes are permitted only for not-run cases.
- When a snapshot mismatch prevents all JVM starts, emit one not-run
  record per case and Evidence.status=incomplete/reason=input-changed.
  Run-global incomplete reasons and terminal error/io override case
  aggregation during auditing, in the same precedence as §11.4.
- AuditOutput valid: reason=valid, fresh=true, verification=Evidence.status,
  non-null runId/inputDigest. Invalid: fresh=false, verification=null;
  runId/inputDigest identify the current parsed marker if it is valid,
  otherwise both are null. Never copy identity from an unmatched old summary.
- runnerPackage.name/version come from package.json: the npm package identity
  is `@dsh-cc/plugin-dsh-cc-agents`. Validate plugin.json independently with
  name=`dsh-cc-agents`; its version must equal package.json.version. Do not
  compare the two name strings for equality or rename either manifest. Both
  names must match this explicit mapping and both versions must be nonempty
  strings; version equality is exact. No alias or implicit name conversion
  is permitted. Missing, malformed or mismapped identities, or unequal
  versions, block preflight with config-invalid and make evidence auditing
  schema-invalid. Auditing compares both package
  identity and runnerDigest; either mismatch is stale/runner.
- Audit inputFiles against fresh enumeration, not only paths listed by
  evidence. Validate the generated cfg bytes against checks.json, not just
  their hashes. Replay and validate cases/aggregation per §12.1 after
  verifying log hashes; hashes do not authenticate reviews or forged evidence.
- Before parsing evidence, reject symlinked/escaping run paths as
  runs-path-unsafe. Audit rejection precedence then is: present/indeterminate
  lock owner (including an unprobeable lock under §13) →
  run-in-progress; missing current-run → incomplete-run; running or invalid/
  mismatched marker → incomplete-run; missing evidence → evidence-missing;
  malformed evidence/schema/manifest → schema-invalid; stale/input;
  stale/runner; stale/toolchain; log-missing; log-mismatch;
  replay/record mismatch → schema-invalid; valid.
  For marker/evidence identity comparison parse evidence before comparing;
  malformed evidence is schema-invalid, not an arbitrary identity mismatch.
  A well-formed leftover lock with an absent PID does not invalidate evidence; check still
  refuses that lock until a human resolves it (§13).
- Preflight blocker order is: usage-invalid, model-path-unsafe,
  unsupported-platform, config-invalid, input-limit, config-drift,
  java-missing, java-version, jar-missing, jar-checksum, io.
  Run lock errors precede preflight in check. Within a category, details are
  sorted by internal relative-path and case-ID keys in Unicode code-point
  order, then by detail text as a deterministic tie-breaker. These keys are
  defined below and are not fields of the serialized Blocker.
  Independent checks continue to gather blockers, but dependent checks are
  skipped: no version query when Java is missing; no checksum for a missing
  JAR; no cfg generation comparison when the manifest cannot be parsed.
- Blocker serialization remains exactly {code, detail}. Internally collect
  {code, detail, relativePath, caseId}; relativePath is the project-relative
  POSIX path of the failing project input (checks.json or the relevant cfg/
  model file), or "" for CLI, platform, toolchain/plugin/environment and
  other errors without a project input path. caseId is the manifest case ID
  when the error is specific to one identifiable case, otherwise "".
  Use these keys when creating the diagnostic, never extract them from
  detail text. Sort by blocker category priority, relativePath, caseId,
  then detail, comparing Unicode scalar values lexicographically (shorter
  prefix first, not localeCompare). Serialize only code/detail afterward.
  Exact duplicate code/detail diagnostics are emitted once, retaining the
  lowest internal sort key. detail text must be deterministic, without
  timestamps or random temporary names. Manifest-wide parse failures have
  the checks.json path and caseId=""; malformed/unidentifiable case IDs
  use caseId="". Multiple diagnostics per category are preserved.

  Example: config-drift for cases/z.cfg encountered before cases/a.cfg
  must still serialize a.cfg first. The following is a complete blocked
  preflight response (all paths are relative to the project):

  ```json
  {"schemaVersion":1,"command":"preflight","status":"blocked","reason":"config-drift","blockers":[{"code":"config-drift","detail":"specs/tla/task-lifecycle/cases/a.cfg differs from generated bytes"},{"code":"config-drift","detail":"specs/tla/task-lifecycle/cases/z.cfg differs from generated bytes"}],"willGenerate":[]}
  ```

- Missing explicitly passed Java/JAR paths map to java-missing/jar-missing,
  not a usage error. Malformed flags, duplicates and missing flag values
  map to usage-invalid. Invalid --project/--model maps to model-path-unsafe.
  Unexpected filesystem errors before the running marker produce
  blocked/io; lock creation failure other than EEXIST produces lock-io.
- An I/O failure after the running marker stops new JVM starts and
  terminates/awaits any current child. Publishing recovery Evidence requires:
  every attempted spawn has truthful process metadata; all captured bytes
  up to child close are successfully written to both log files (except the
  intentional log-limit prefix); both files can be read/hashed; every case
  has a schema-valid record; and Evidence plus its finished marker can be
  published. An unstarted case is not-run. Never relabel a started child
  not-run or invent empty logs for bytes lost to an I/O failure.
  These requirements also apply to snapshot/preparation failures; use
  all not-run records if no spawn was attempted. Open both logs before
  attempting spawn. A failed log open means that case is not-run, not
  spawn-failed; unreferenced partial files may remain as diagnostics.

  | Failure boundary | Publication and command result |
  |---|---|
  | Log creation fails before a spawn attempt; previous cases' records/logs are complete | All unattempted cases not-run; publish global error/io Evidence if all recovery prerequisites hold; exit 2. |
  | Other run-directory/snapshot I/O fails, with no lost child output and recoverable storage | Publish global error/io Evidence, preserving completed records; exit 2. |
  | A child log write/flush/close fails, output is lost, process metadata is unavailable, or log read/hash fails | No completed Evidence; summary=null, leave the running marker; error/io, exit 2. |
  | Evidence staging/publication fails | At most one recovery publication attempt if prerequisites can be re-established; otherwise summary=null, running marker, error/io, exit 2. Never retry indefinitely. |
  | Final finished-marker publication fails | No committed result; summary=null, running marker, error/io, exit 2. Do not publish a second success or treat a newly written summary as reusable. |
  | Owned-lock cleanup fails after successful final publication | Committed Evidence/status/exit code remain; stderr reports cleanup failure (§10.1). |

  Where consistent Evidence is possible, §11.4 global precedence still
  applies: cancellation/input-change/artifact-change override error/io.
  If persistence is impossible, a latched cancellation returns incomplete/
  cancelled, summary=null, exit 3; otherwise error/io, summary=null, exit 2.
  blockers=[] in both branches. These command-only results are not Evidence.
  Always attempt owned-lock cleanup in finally, report failure on stderr,
  and never remove another owner's lock.
- check-evidence usage errors return invalid/usage-invalid; unexpected read
  errors return invalid/io; both exit 2. Help never invokes Java or mutates files.

### 20.8 Remote review and implementation acceptance

Full raw logs remain local ignored artifacts; v1 adds no uploader or remote
evidence service. The main dialog prepares and delivers the review package
to each lane through the project's existing authorized artifact channel.
A local reviewer may use accessible paths. A remote reviewer must receive
accessible full file contents; producer-only paths are not delivery.
Acceptance must demonstrate byte-preserving delivery through the actual
authorized channel used by each remote lane, not a hypothetical attachment
API. Sixteen cases can approach 800 MiB of persisted logs (16 × 50 MiB);
the channel may deliver multiple files or chunks, but they must reconstruct
the exact full files and each lane must read and hash them. Channel
availability, retention until review completion, and receiver access are
checked before formal dispatch.

Before workflow integration begins, record a feasibility probe for each remote lane:
the effective review protocol; existing authorized channel identity;
file/message/aggregate limits; chunking and exact reconstruction procedure;
receiver retrieval and streaming hash/replay capability; access lifetime
through review; and observed success or failure. Test a file above the inline
limit and a representative multi-case payload. Record the maximum package
size actually supported, without inferring support for the 800 MiB worst
case. Larger actual packages remain blocked unless the existing route can
deliver them completely. Receivers may stream files through tools; inserting
every byte into model context is not required. Uninspected logs cannot be
claimed reviewed. A review lane's existence does not establish a usable
artifact channel.

Keep this record in implementation.md or the implementation preparation
record, outside digested inputs. Missing capability is an environment/
integration blocker, not authorization to build an uploader. Resolve it
through an already authorized capable route, or request a scoped user
decision to change the delivery design. Do not weaken the full-log gate.
Actual runner-produced delivery and receiver replay remain §16.4 acceptance.
If no suitable existing authorized channel
exists, remain blocked; v1 does not add an uploader, raise channel limits
or authorize a new external service implicitly.

The preparation record MUST also identify the effective rule source and
its session/revision, the authorized lane identities supplied by those
rules, the probe date, actual byte counts/file counts, producer and receiver
hash results, and any failed access/reconstruction attempt. A forwarding
loop or an unavailable protocol is recorded as unavailable, not resolved by
quoting a historical roster. Reconfirm the record when rules, channel,
receiver access or package size changes in a way that invalidates the probe.

Readiness has three separate claims: runner contracts implemented (steps
1–3), workflow integration prerequisites established (before step 4), and
actual workflow acceptance complete (step 5). Report them separately.
Representative transport probes establish only the second claim; only
actual runner-package receiver inspection/replay establishes delivery
acceptance. No claim here requires support for 800 MiB universally:
record the tested capacity and block any actual package exceeding it.
The current design supplies requirements, not successful probe results.
For this repository, the effective review-rule source and each remote route
remain unconfirmed until those records exist. The historical roster is not
a substitute for a loadable current protocol. Missing rules or capacity
block workflow integration, not independent runner steps 1–3; report the
exact pending prerequisite and owner rather than calling the feature ready.
The forwarding-loop repair remains outside this implementation scope.

The minimum package for each lane contains:

- Every input listed by evidence.inputFiles, preserving model-relative
  paths and exact bytes: design.md, checks.json, all model .tla files and
  all declared cfgs.
- Matching current-run.json and evidence.json, the inputDigest/runId and
  the recorded runnerPackage, runnerDigest, toolchainDigest and jarSha256.
- Full persisted stdout/stderr logs for every configured case, preserving
  the project-relative paths in evidence and matching their SHA-256 values.
  An excerpt or prose summary is insufficient.
- The producing main dialog's complete check-evidence JSON output, showing
  valid/fresh/verified for that run, and the completed coverage assessment.
- The approved/planned implementation mapping, regression scenarios and
  counterexample dispositions. Records outside design.md reference the
  same inputDigest; an unresolved disposition blocks formal dispatch.

The main dialog records each lane's package identity and accessible artifact
locations in implementation.md or the review record, outside digested inputs.
Each lane confirms the runId/inputDigest, full input enumeration, cfg bytes,
log presence/hashes, §12.1 replay-derived fields and the verified all-case
results. Each lane distinguishes replay-derived fields from trusted wrapper
observations, records tool
identities and reviews the model's sufficiency. This is evidence inspection,
not an assertion that the recipient ran local check-evidence.

A Git-committed summary alone is insufficient to claim local check-evidence
success on another machine. A remote recipient may claim that only after
the actual command validates a complete local package with the matching
installed runner/toolchain. Reviewers remain read-only (§6.2); they request
any mutating independent re-run from the main dialog. Such a re-run must
have the same inputDigest, record its actual tool identity, and provide a
complete package from the new run. Different runIds must not be mixed;
redispatch the complete new package to all lanes if the reviewed run changes
during formal review. After completed approval, §12's tool-only reuse
exception instead permits historical approval references with one fresh
current package, never mixed evidence.

Missing, truncated, inaccessible or mismatched inputs/logs cause that lane
to report "blocked: incomplete review evidence", identifying missing paths
and expected runId/inputDigest. This is a review disposition, not a new CLI
status/reason. It cannot be counted as approval or waive another lane.
The main dialog supplies the complete package or independently re-runs and
supplies its outputs. Channel size limits do not permit summary-only
approval; use an existing authorized channel capable of delivering complete
files or remain blocked. No automatic upload, new artifact service,
retention policy or fourth review lane is added.

In addition to §16, automated contract tests and recorded manual workflow
scenarios must cover the following. Remote delivery and model-sufficiency
items use §16.4 records; they are not claimed as runner enforcement:

1. checks.json change → cfg drift → explicit removal → generated diff →
   stale approvals; a re-run alone must not overwrite a reviewed cfg.
2. C=Derived is a model value; complex derived values are expressed inside
   TLA+ from primitive parameters. All pinned cfg directive names, including
   plural forms, are rejected as model-value identifiers.
3. Spawn failure → error/spawn-failed/exit 2; signal → incomplete/
   signal-exit/exit 3 for any configured case. Expansion timeout/log-limit/
   signal → incomplete with an additional expansion-result warning; core
   success never masks it. Expansion counterexample/error likewise changes
   aggregation and blocks formal review.
4. Simultaneous global causes follow cancelled > input-changed >
   artifact-changed, regardless of core/expansion coverage. Any new input
   file, deletion or read failure changes the digest result.
5. Snapshot-copy failure cannot reuse an older finished success. Inject
   failures at each atomic-write/rename boundary; no false finished marker.
6. Producer→consumer round trips of every §20.7 variant, including null
   fields, not-run, invalid identity, unknown/duplicate keys and I/O failure.
7. Unchanged input plus tool upgrade: old evidence is stale, successful new
   check permits approval reuse; model/design/config change requires new
   three-lane approval even if the new checks pass.
8. Demonstrate each §4.3 activation path; demonstrate a missing critical
   coverage row blocks review-ready; remote missing logs cannot be audited
   as valid local evidence or counted as a lane approval.
9. Core case verified plus expansion counterexample/error/
   timeout/log-limit/signal/not-run: aggregate is non-verified, auditing
   retains that status, and the main dialog never dispatches formal review.
   A pure TLC warning with every case verified remains eligible subject to
   the manual coverage/findings gate. Merely renaming a failed case
   "optional" never changes its obligation.
10. Fail generation on the second of three absent cfgs: the first stays
    complete, no partial second destination exists, no third is generated,
    no JVM or running marker starts, stdout is blocked/io/summary=null,
    and stderr lists completed/unfinished paths. Retry lists only absent
    cfgs and succeeds without rewriting the first. Test differing and
    identical concurrently created destinations, cleanup failure and hard
    kill. Missing Java must generate nothing. Old evidence must fail audit
    whenever current digested inputs changed.
11. Multiple blockers in one category are stable under reversed discovery
    order; cover equal-path different-case errors, absent context, detail
    tie-breaks, duplicate diagnostics and non-ASCII Unicode code-point
    comparisons. Public objects contain only code/detail.
12. Record routine acceptance mapping/results in implementation.md and
    assert design.md/inputDigest are unchanged and approvals stay bound.
    A changed atomicity assumption instead updates design/model, makes old
    evidence stale and requires re-check before new formal review.
13. A remote lane given only a summary, missing one case's stderr, truncated
    stdout, wrong-run logs or an inaccessible artifact reports blocked and
    cannot approve. Complete delivery permits review; a re-run switches all
    lanes to one complete new run package at the same inputDigest.

14. Replay both logs with deliberately inconsistent but well-formed summary
    fields: change eventCodes, statistics, case verdict, warnings or aggregate
    while retaining the actual logs and their hashes. Reject schema-invalid.
    Untampered verified, counterexample, malformed-output and wrapper-interrupted
    runs round-trip correctly; do not confuse valid evidence with verification.
15. Inject cancellation before the running marker, during snapshot, during
    a child, between cases, after all cases verify, during async staging,
    immediately before final synchronous publication and after it. Assert
    exact summary/null shape, marker state, cases and exit codes (§10.1).
    Cancel plus unrecoverable I/O yields incomplete/cancelled with null
    summary; cancellation after commit leaves the original result intact.
16. Inject log-open, write, flush, close, metadata, hash, evidence-publication
    and marker-publication failures at every §20.7 boundary. A started child
    is never not-run; lost bytes never acquire invented logs; no partial
    publication permits old or new evidence to impersonate a finished run.
17. Probe present PIDs (including a reused unrelated PID), absent PIDs,
    EPERM/other probe failures and malformed/unreadable locks. Assert the
    conservative check/audit split and no automatic lock deletion (§13).
18. Reject legacy required fields and invalid/missing coverage labels in
    checks.json and Evidence. core and expansion retain identical pass
    obligations; expansion warnings use expansion-<status>:<id>:<reason>.
19. Perform the §16.4 actual-channel delivery and abstraction-challenge
    scenarios. Large/full logs remain required; receiver-side hash/replay
    records, not producer path listings, demonstrate successful delivery.

The executor may choose internal pure-function names and implementation
details that preserve these externally observable contracts. It must return
a design blocker rather than change a status, CLI field, acceptance
condition or product boundary to fit its implementation.

## 21. Revision scope and remaining decisions

This clarification preserves plugin-only delivery, manual adoption, complete
remote logs, the existing review authority, and successful tool-only
approval reuse. It adds decision precedents, readiness evidence and an
implementation/acceptance index; it does not change public CLI schemas or
the minimal TLA+ fixtures. No additional user policy decision is required
to implement these clarifications.

If preparation establishes that no existing authorized route can deliver
the actual package, ask the user for a scoped decision. Recommended first
option: use an already authorized capable route and preserve full logs.
An alternative that introduces a service or changes evidence requirements
is a separate design change requiring approval; do not implement it as
recovery. Likewise, unavailable effective review rules require an explicit
rule source or scoped user decision, not an invented roster. Repair of the
repository forwarding loop remains outside this document's implementation
scope.

Actual transport probes, real TLC execution, current-revision formal
sign-off and feature implementation remain pending. These are execution
obligations, not missing policy choices silently resolved by this edit.

## Review ledger

- **Bundled-toolchain revision (2026-10-24)**: user requested updating the PR
  to include the pinned JAR with the plugin. Preserve exact upstream bytes,
  licenses/provenance, checksum and actual SHA-256 evidence. Explicit/env
  errors block without fallback. npm and Git marketplace installs require no
  separate JAR configuration; CI verifies the bundle without downloading it.
  Ordinary startup still needs no Java. Existing manual review/remote-delivery
  acceptance limitations and review authority are unchanged.

- **Contract-consistency revision (2026-10-24)**: user requested revision and
  submission following the current design analysis. Correct the distinct
  npm/plugin name mapping while retaining equal versions; make unknown
  severity=1 precedence explicit in the ordered classifier and combined
  fixtures; bound Java version probing and define cancellation/failures.
  Reinforce manual adoption notices and pending rule/channel readiness.
  Preserve full-log delivery and the existing tool-only approval reuse
  policy, including its non-equivalence caveat. No actual channel probe,
  TLC execution, feature implementation or current-revision sign-off is
  claimed by this documentation change.

- **Reviewability clarification (2026-10-24)**: add coverage and change-adjudication precedents, explicit preparation evidence and separate readiness claims, tool-upgrade comparison records, and a contract/acceptance navigation index. Preserve prior policy choices and fixture bodies; no real transport, TLC execution or final sign-off is claimed.

- **Implementation-readiness clarification (2026-10-24)**: unify the
  transport prerequisite at workflow integration (step 4), while allowing
  independent runner steps 1–3; specify a single ordered case classifier
  and combined-error acceptance fixtures; name the main dialog as approval
  reuse owner without changing the previously approved reuse policy; make
  first-use adoption/blocker notices concrete; require a separate explicit
  late-event companion fixture without changing the two minimal fixtures.
  Transport probes, real TLC runs, and final current-revision review remain
  pending implementation/preparation obligations, not results of this edit.


- **Workflow-clarity revision (2026-10-24)**: user requested revision and
  submission following the design analysis. Clarify adoption versus
  discoverability, re-screening, flat input enumeration, historical approval
  references versus current evidence, early remote-channel feasibility and
  worked workflow acceptance. Preserve existing plugin-only, full-log,
  manual-adoption and tool-only reuse policies. No uploader, runtime hook,
  roster change or feature implementation is introduced. Real channel
  capabilities and effective review rules remain implementation-preparation
  facts to establish, not capabilities claimed by this document.
  Final design sign-off remains pending.

- **r1 (full review, three lanes blind, one message)**: critic
  GO-WITH-CHANGES (12 findings), Grok lane GO-WITH-CHANGES (17 findings),
  Codex lane NO-GO (25 findings; includes live reproductions against the
  pinned TLC JAR — the constants-whitelist cfg-injection false-verified, the
  exit-255 negative-constant parse failure, and a safety-form PROPERTY
  completing without event 2267). The verdict divergence was adjudicated as
  a severity-labeling difference on the same substance: the
  implement-as-written test fails the draft (a reproducible false-verified
  channel), so the strict seat ruled. 54 raw findings deduplicated to 40
  folds, all accepted; three findings had their findings accepted but their
  remedies adjusted on mechanistic evidence, recorded in the fold ledger.
  Two cross-seat contradictions were adjudicated by direct source
  verification: project-skill registration is by frontmatter name (provider
  roots) vs directory name (plugin loader) — both true on their own paths;
  the repo `lib/` gitignore rule does swallow `scripts/lib/` outside the
  root-level negation — resolved by mandating the flat `*.lib.mjs` layout.
- **r2 (delta verification, per-seat fold mappings)**: critic
  GO-WITH-CHANGES with all 11 folds OK plus two wording fixes (baseline
  re-pin, audit-conflict wording), folded. Grok lane GO-WITH-CHANGES with 15
  folds OK, 2 PROBLEM (install temp-dir leftovers broke the resume
  predicate; the JSON appendix under-specified update output) and 3 NEW
  (retracted-file-absent classification, non-negative stats typing,
  PATH-java argv recording) — all five folded. Codex lane: two consecutive
  platform-flake aborts (Rust stderr EAGAIN panic, exit 101, with a stale
  r1 verdict reprinted from an older thread — per the lane playbook,
  recorded as interrupted and not consumed either time; the second abort was
  the single free exclusive retry). The user accepted a reduced roster for
  close-out.
- **Shape pivot (v4)**: after r2 the user asked whether the whole design
  could be plugin-only; on the recorded trade-offs the plugin-only shape was
  adopted by explicit decision. The create/maintain installer pair and its
  entire state machine (stamp, classification, installer locks, partial
  install, approval flags) were removed; upgrades ride the plugin release
  flow. About a third of the earlier folds became moot together with the
  mechanism they constrained; the rest carried forward into this text.
- **r3 (reduced-roster micro-confirmation of the v4 text)**: critic
  GO-WITH-CHANGES — pivot semantically coherent, all six invariants
  unambiguous; four pivot-edit residue sites (duplicated cross-machine
  sentence tail, a §16.1 install-scripts sentence, a §16.2 orphan fragment,
  §17 done-criteria wording), all folded. Grok lane GO-WITH-CHANGES — same
  substance plus one genuinely new item (an installer-era project-install
  conclusion in §2.1) and one count wording fix, both folded. All residue
  was re-verified in the text by targeted greps; the review gate is
  satisfied with every r1→r3 finding carrying a verified fold.
- **Implementation-contract revision (2026-10-24)**: correct constant
  semantics and complete the cfg reserved-word set; specify cfg regeneration;
  reconcile classification, reasons, optional-case aggregation, evidence
  fields, CLI failures and early-run lifecycle; make trigger prerequisites,
  coverage acceptance and remote review behavior explicit. User chose
  successful tool-only re-check with approval reuse over mandatory re-review.
  This revision has not undergone a new three-lane review.
- **User-approved review-gate clarification (2026-10-24)**: user accepted all
  three recommendations: every configured case must verify before formal
  three-lane review; cfg generation retains completed atomic writes on
  failure and reports unfinished paths; incomplete remote evidence blocks
  lane approval. Also resolve acceptance-mapping digest churn and define
  deterministic internal blocker sorting without changing public shapes.
  These clauses supersede the earlier optional-case aggregation policy;
  historical r1–r3 entries are not approval of these revisions.
- **User-approved determinism revision (2026-10-24)**: user accepted all
  recommendations: read-only log replay during auditing; cancellation until
  final finished-marker publication with a synchronous observation boundary;
  coverage=core|expansion replacing the misleading required boolean; full
  remote logs with actual-channel delivery acceptance. Clarify I/O recovery
  and conservative lock probing, and challenge critical abstractions with
  concrete adverse traces. These contracts supersede earlier field/warning
  spellings and lifecycle wording; historical review entries retain their
  original terminology. No feature implementation or TLC execution is claimed,
  and final formal design sign-off remains pending.
- Sign-off: user authorized these design choices, document editing and
  committing to this PR. Final formal design sign-off and feature
  implementation remain pending.

