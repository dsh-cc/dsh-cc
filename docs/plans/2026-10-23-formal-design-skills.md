# On-demand TLA+ Design Verification Workflow for dsh-cc: Detailed Design

## Status: Design — three-lane blind review converged (r1 full review folded
54 findings into 40 changes; r2 delta verified the folds and surfaced 7 more,
all folded; v4 shape pivot by explicit user decision from a create/maintain
installer pair to the packaged form here; r3 reduced-roster micro-confirmation
of the v4 text GO-WITH-CHANGES from both remaining seats with all reported
residue folded — the Codex lane was recorded interrupted after two
platform-flake aborts, roster reduction approved by the user);
user sign-off and implementation pending.

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
  not bumped separately in this PR.
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
  examples/task-lifecycle/…      # see §14
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

The main dialog runs the screening once after forming an initial design and
before dispatching the three-lane formal design review. First check: does
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
notes the materialized runner version in the design document; evidence from
different runner versions is never mixed into one review package.
## 5. Workflow, states, and pass conditions

| State | Owner | Condition to advance |
|---|---|---|
| screened | main dialog | enabled-or-not and rationale recorded |
| modeling | main dialog | requirements, properties, assumptions, model, and check config complete |
| checking | main dialog, or an executor running explicit checks | actual script output obtained |
| revising | main dialog | counterexamples/errors explained and revised; back to checking |
| review-ready | main dialog | every required case verified, evidence fresh, coverage matrix complete |
| reviewing | the existing three lanes | all review the design package at one digest |
| approved | main dialog | three lanes meet the existing pass bar; no unresolved blockers |
| implementing | executor | approved package contains implementation mapping and regression scenarios |
| accepting | main dialog | implementation, tests, model, and design checked for consistency |
| complete | main dialog | acceptance passed; every deviation handled |

not-needed tasks return to the original pipeline from screened; waived tasks
follow the original pipeline as modified by the explicit user change, and
the report says "waived, not verified." waived never arises from a failing
script run.

review-ready = every required case verified in the current run + input
digests consistent + the manual coverage-matrix check done. The runner's
verified only certifies execution conditions; it does not judge model
sufficiency. When inputs are unchanged, a previous run that check-evidence
judges valid may be cited (§12).

Counterexample handling: replay the trace first, then decide whether it is a
design defect, a modeling defect, or a requirements ambiguity. The main
dialog fixes the corresponding part and re-checks. Forbidden for the sake of
passing: deleting properties, adding unrealistic assumptions, carving a
failing action out of Next, or shrinking the problem boundary. Every
property, assumption, and boundary adjustment MUST be justified in design.md
for the three lanes.

Check timeouts, missing Java/JAR, unknown output, model errors, and resource
exhaustion all block an enabled task from review-ready. Continuing to write
the design or fixing the environment is allowed; silently jumping to
executor development is not. An explicit user waiver re-records the
decision; history is not rewritten.

There is no "pass by default after three retries." When the same blockage
repeats with no new information, stop re-running; report the concrete
blocker and the available options.

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
  implementation.md             # written after implementation: mapping and test results
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

## 9. checks.json: the single configuration source

UTF-8 JSON, no comments; schemaVersion fixed at 1; every object rejects
unknown fields and duplicate keys. If JSON.parse cannot detect duplicate
keys, a JSON tokenizer pass MUST detect them before parsing — this item is
not optional. Case IDs must not repeat.

```json
{
  "schemaVersion": 1,
  "modelId": "task-lifecycle",
  "module": "Model",
  "cases": [
    {
      "id": "small",
      "required": true,
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
[A-Za-z][A-Za-z0-9_]*. cases length 1..16, at least one required=true; each
case has at least one invariant; array names do not repeat. required is an
explicit boolean. properties may be empty. limits is required; timeoutMs an
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
set      := "{" [ atom ("," atom)* ] "}"
```

- Between atoms and set elements, only zero or one space is allowed:
  `{1, 2, ok}` is legal, `{ 1 , 2 }` is not (validation canonicalizes to the
  comma-then-one-space form — **the generator only ever emits the canonical
  form**).
- **ident blacklist**: an ident must not equal any cfg directive reserved
  word: `SPECIFICATION`, `CONSTANT`, `CONSTANTS`, `INVARIANT`,
  `PROPERTIES`, `PROPERTY`, `CONSTRAINT`, `ACTION_CONSTRAINT`, `SYMMETRY`,
  `VIEW`, `CHECK_DEADLOCK`, `INIT`, `NEXT` (exact match against TLC
  directive casing; the blacklist itself is written as a manifest constant
  and covered by tests).
- Rejected: negative integer literals (the pinned parser reports a
  configuration error for `MaxAttempts = -1`; reproduced in r1), string
  literals (quotes are an injection vector), nested sets, trailing garbage,
  newlines, comments, semicolons, empty strings.
- Semantics: booleans, non-negative integers, model-value idents, and their
  finite sets; type and expression validity remain TLC's job at check time.
  Anything needing other expressions uses a named definition inside the
  model (define in .tla, then assign the ident) — the free cfg channel is
  not extended.

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
reviewed material automatically is forbidden. After editing checks.json the
developer re-runs check to update .cfg explicitly.

Finite bounds live in constants and state definitions; the bounds must not
quietly carve out events still being handled. Terminal states are modeled
with explicit self-loop actions; disabling deadlock checking to mask them is
forbidden.

optional cases widen parameter exploration and are not required to pass.
Their failures MUST be shown (§11 warnings); when a counterexample affects
the real design covered by required cases, the main dialog MUST resolve it
before development — the optional label must not be used to ignore a known
defect.

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
- Without an explicit `--jar`, read TLA2TOOLS_JAR; there is no default
  scanning, no networking, and no auto-download. Without `--java`, use the
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
node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs"      --project "$PROJECT" --model specs/tla/task-lifecycle --jar /absolute/tla2tools.jar
node "${CLAUDE_SKILL_DIR}/scripts/check.mjs"          --project "$PROJECT" --model specs/tla/task-lifecycle --jar /absolute/tla2tools.jar
node "${CLAUDE_SKILL_DIR}/scripts/check-evidence.mjs" --project "$PROJECT" --model specs/tla/task-lifecycle
```

(Inside this repository's own test suites the same commands run from the
package tree path `packages/plugin/dsh-cc-agents/skills/formal-design/` —
identical files, since that tree IS the shipped artifact.)

All three commands support --help; check supports the same --java as
preflight; check-evidence never starts Java and does not require the JAR to
exist at its original path. Unknown arguments, missing values, or duplicates
exit 2. Extra TLC/JVM argument pass-through is forbidden. stdout is exactly
one JSON object plus a newline (schema in §20); diagnostics go to stderr;
--help is the only plain-text exception.

**Path-argument normalization (shared by preflight/check)**: an explicitly
passed `--jar`/`--java` must exist; it is realpath'd **once at argument
parsing** to an absolute path (symlinks allowed; the resolved path is
recorded) and must be a regular file; evidence argv records the normalized
absolute path. The `--jar` (or the resolved TLA2TOOLS_JAR) bytes get a SHA-1
compared against toolchain.json (mismatch → blocked/jar-checksum) and a
SHA-256 recorded in evidence. PATH-form java is not pre-resolved (the argv
and javaExecutable recording rules are in §12).

preflight is read-only: **what it validates is checks.json (all §9
rules) and existing cfgs against their generated values**, plus the Java
version and JAR checksum; runner identity is attested by evidence's
runnerPackage+runnerDigest (§12), not by preflight. Missing cfgs may still
yield ready-for-check with the will-generate paths listed. Success is
exit=0/status=ready-for-check; environment problems are
exit=2/status=blocked. It does not claim verified.

check runs the same preflight first; any blocker means TLC never starts.
**Pinned run order:**

1. Take the model lock (§13); conflict → blocked/model-locked.
2. Run preflight.
3. Generate missing cfgs per §9.2 **into the model directory** (cfgs are
   committed inputs).
4. Compute the input digest inputDigest (§12 input set, now including cfgs).
5. Copy the input snapshot into the run directory byte-for-byte
   (`fs.copyFile`, no text transforms); recompute the snapshot digest and
   require equality with inputDigest — **mismatch → incomplete/input-changed,
   no JVM is spawned**.
6. Atomically write the model-root current-run.json (state=running).
7. Execute the cases sequentially (process contract below).
8. When all finish: recompute the original-input digest and the
   runner/jar/toolchain digests against step 4's recorded values; any
   mismatch → evidence status=incomplete/artifact-changed (still written to
   disk; never dressed as verified).
9. Write evidence.json (sibling temp + rename), then update current-run.json
   to state=finished.
10. Release the lock in a finally.

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
(SIGINT/SIGTERM to the wrapper) takes precedence over all aggregation**:
clean up the current child, mark the current case cancelled, mark remaining
cases not-run, record incomplete/cancelled per §11's global preconditions,
exit 3. The JVM is started directly — no shell subprocess. v1 supports
macOS/Linux; Windows returns blocked/unsupported-platform — silently running
unverified termination logic is forbidden.

JVM resource exhaustion, signal exits and the like are judged
incomplete/error only. heapMiB is a JVM heap cap; it does not limit total
JVM RSS.

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

- severity ∉ {0,1,2} → output-invalid;
- severity = 2 (TLCBUG class) → error/tlc-bug regardless of code;
- a code outside the pinned-version vocabulary with severity = 1 →
  error/unknown-error;
- an unknown code with severity = 0 → recorded in eventCodes only; no effect
  on judgment.

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

### 11.3 Classification priority table (complete; first match top-down)

| # | Condition | Classification / reason |
|---|---|---|
| 1 | cancellation, timeout, log ceiling, signal exit, spawn failure, snapshot or mid-run digest mismatch | incomplete/{cancelled,timeout,log-limit,spawn-failed,input-changed,artifact-changed} |
| 2 | exit=11 with 2114 (deadlock) | counterexample/deadlock |
| 3 | exit=12 with 2107 (initial invariant) or 2110 (next-state invariant) | counterexample/invariant |
| 4 | exit=13 with 2108/2112/2116 (temporal/action property violated) | counterexample/temporal |
| 5 | exit=13 with 2113 (action property evaluation failed) | error/property-evaluation-failed |
| 6 | exit=14 with TLC_VALUE_ASSERT_FAILED=2132 | counterexample/value-assert |
| 7 | exit=10 | error/assumption-failed (corroborated by events, e.g. the 1000/5006 chain) |
| 8 | exit ∈ {75,76,77,150,151,255} | error/config-invalid or error/unknown-error (discriminated by corroborating events) |
| 9 | other nonzero exit | error (reason inferred from events; absent that, error/unknown-error) |
| 10 | §11.2 fully satisfied | verified |
| 11 | anything else | incomplete |

A contradiction between the exit code and events (e.g. exit=0 with a
violation event, or exit=12 with no violation event) →
error/output-inconsistent. Complete counterexample logs are preserved; v1
does not promise to parse every TLA+ value into a structured trace.

### 11.4 Aggregation and exit codes

summary.status: **run-level global preconditions are checked first** (any of
cancellation / input change / ceiling / artifact change → incomplete with
the corresponding reason); then: all required verified → verified; any
required with a counterexample → counterexample; else any required with an
error → error; else → incomplete. optional results never change summary;
when an optional case has a counterexample, warnings gains
`optional-counterexample:<id>`. preflight blockage → blocked.

check exit codes: 0 = all required verified; 1 = a required case has a
counterexample; 2 = blocked or error (multiple blockers are all listed);
3 = incomplete (including cancellation). TLC's own exit code is never used
directly as the wrapper's exit code. check-evidence: 0 = the evidence is
intact and fresh (**which does not mean the model passed** — its JSON
explicitly carries the fresh and verification fields, §12/§20); 2 =
invalid/stale/missing, with a concrete reason.

## 12. Evidence, digests, and staleness rules

Each run preserves the input/ snapshot, each case's stdout.log/stderr.log,
and the run's evidence.json. The latest summary is published to the
model-root evidence.json via sibling-temp + rename after the whole run ends,
failures included — passing off a previous success as this run's result is
forbidden. current-run.json is maintained per §10 steps 6/9: state=running
before any case starts; state=finished after evidence lands. check-evidence
MUST require: matching runId/inputDigest across both files and
state=finished; then consult the model lock — lock present with a live pid →
`run-in-progress`; otherwise running/missing/mismatched → incomplete-run. If
the process is hard-killed, an old success summary therefore cannot
impersonate the latest result. **A preflight or check blocked before
starting a run leaves existing evidence untouched**: an old finished
evidence keeps its validity (validity is determined only by content and
toolchain version, below).

Input file set: design.md, checks.json, all .tla under the model root, and
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
startedAt, finishedAt, status, warnings[],
cases[{id,required,status,reason,exitCode,signal,
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
id/required and status=not-run, with the other runtime fields null.

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

check-evidence (read-only, no Java) recomputes the current inputDigest,
runnerDigest, and toolchainDigest, and verifies: current-run.json's finished
state and lock state (above), toolchainVersion, config↔case correspondence
(every declared cfg exists individually), required-status aggregation
consistency, log file presence and SHA-256, and that the run directory is
inside the project .formal-design/runs. Any mismatch → exit 2 + reason:
stale/{input,runner,toolchain}, log-missing, log-mismatch, schema-invalid,
incomplete-run, run-in-progress. **On success it exits 0 and outputs
`{"status":"valid","fresh":true,"verification":<evidence.summary.status>}`**:
fresh and verification are decoupled — a fresh counterexample/error/
incomplete evidence is equally "valid evidence"; callers MUST read the
verification field, and treating exit 0 as "the model passed" is forbidden.
Cross-machine missing logs are not valid local evidence — re-run (which also requires the same runnerPackage version installed there, plus Java); committed summaries aid review readability but never substitute for an actual check on the new machine.

Evidence has no time TTL; staleness is determined by content and toolchain
version. Design review opinions MUST reference an inputDigest. Changes to
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
  project-relative path — absolute paths, `..`, empty segments, and
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
callback handler and test name; before implementation it may name planned
symbols, and at acceptance those MUST be replaced with real locations.

implementation.md finally contains: inputDigest, the code symbol for each
model action, how atomicity is implemented, the test or manual-review
evidence for each key property, the unmodeled scope, and deviations. TLC
passing and code tests passing are reported separately.

## 15. Normative content of AGENTS.md and the skills

agents-snippet.md provides a complete copyable version of the following
rules, without assuming lane identities:

1. After design and before the existing formal design review, run the
   formal-design screening; on a hit, load the skill and record the
   rationale.
2. An enabled task enters the formal three-lane design review only after
   its required checks verified, the evidence is fresh, and the coverage
   check is complete; consulting reviewers early is allowed but is not a
   formal approval.
3. All three lanes review the design+verification package at the same
   inputDigest; the existing three-lane pass criteria continue to apply.
4. The executor receives the approved design, model evidence,
   implementation mapping, and regression scenarios; it must not edit model
   semantics to make checks pass.
5. Changing properties, assumptions, or behavior invalidates the evidence —
   re-check and re-review.
6. Inability to check never auto-waives; an explicit user waiver displays
   the unverified scope.

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
- No skill prose writes into the target project beyond the runner's §3.2
  write set.
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
| manifest | full valid example, unknown/duplicate JSON keys, missing fields, duplicate cases, no required, no invariant, illegal IDs, out-of-range limits, **value grammar** (directive-token-in-value like "2 CONSTRAINT Prune"/"TRUE PROPERTY", reserved-word idents, nested sets, trailing garbage, negative integers, quotes) |
| cfg | key order, LF, CONSTANTS header present/absent, existing-identical, existing-different refuses overwrite, extra directives forbidden, canonical serialization |
| paths | `..`, absolute model, input symlinks, output ancestor symlinks, paths with spaces, file/total ceilings, --jar/--java symlink resolution and recording |
| environment | missing Java/JAR, version too low, checksum mismatch, Windows, env-var scrubbing |
| parser | arbitrary chunk splits, CRLF, **nested frames**, END mismatch, unclosed frames, severity∉{0,1,2}, severity=2, unknown codes at both severities, success/finish ordering |
| classification | at least one case per §11.3 table row (incl. 2113 vs 2132 discrimination, 255, exit-0-without-success, exit-0-with-error, nonzero-with-success, output-inconsistent, OOM, signals, timeout, log-limit, unknown output); **an all-zero-stats empty Init is never verified** |
| lifecycle | timeout TERM→KILL, same ladder for log ceiling, no case runs after cancellation and summary=incomplete/cancelled, results written only after close, lock conflict, lock release on error, failed runs overwrite the latest summary, running marker after hard-kill blocks reuse of old success, **snapshot digest ≠ inputDigest → no spawn**, mid-run artifact change → incomplete |
| evidence | staleness on model/design/cfg/runner/toolchain changes, missing declared cfg → invalid, mid-run input change, logs missing/modified, summary schema invalid, cross-project path refusal, **fresh/verification decoupling** (a fresh counterexample evidence exits 0 with verification=counterexample), live lock → run-in-progress |
| aggregation | required failures, optional failure goes to warnings, deterministic order, no not-run case dropped, precedence among multiple failures, **cancellation/global preconditions beat required aggregation** |
| publish | the whole skill tree (SKILL.md, references, scripts, toolchain.json, examples) ships in the package (npm-pack assertions), agent trailers unchanged, every §2.2 description surface consistent, bilingual doc hashes re-recorded, every shipped file is clean under `git check-ignore` |

### 16.2 Real TLC integration tests

formal-design-integration.spec.ts skips explicitly when TLA2TOOLS_JAR is
unset locally; the dedicated CI job MUST provide the pinned JAR — a missing
JAR fails the job rather than skipping. Real runs against: the correct
model, the buggy-callback model, a deadlock model, liveness pass and fail
models with fairness, a syntax-error model, **an empty-Init model**
(asserting non-verified), and **a safety-form PROPERTY model** (asserting
verified WITHOUT 2267), asserting wrapper statuses and log events. **Every
exit of the §11.3 classification table gets at least one real-run fixture
pinning it** (including the injection constant, which is stopped at manifest
validation and never reaches TLC). First confirm §11's stats and frame
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
4. setup-java Temurin 17; download the JAR to RUNNER_TEMP from the pinned
   URL, verify the official SHA-1, export TLA2TOOLS_JAR; download or
   checksum failure MUST fail the job.
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
- Plain formatting work: not-needed recorded; original three-lane flow
  continues; no Java required.
- Cancellation/retry design: auto-enabled — model first, formal review
  second; all three lanes get the same digest.
- User explicitly asks for TLA+: enabled even when auto-screening misses.
- User explicitly opts out: waived recorded, unverified reported; conflicts
  with stricter project rules follow the conflict rule.
- Missing Java / check timeout: blocked/incomplete reported truthfully —
  never called a pass, never handed to development.
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

v1 adds no new automated multi-agent evaluation platform; existing dsh-cc
sessions perform the manual acceptance with records kept, while automated
tests own the executable scripts. Manual scenario demonstration must not be
claimed as a runtime enforcement guarantee.

## 17. Implementation order and definition of done

Deliver in this dependency order; at every step pin the corresponding
failing tests first, then implement:

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
pnpm exec vitest run packages/plugin/dsh-cc-agents/tests/formal-design-integration.spec.ts   # requires TLA2TOOLS_JAR
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
in the correct example's required checks.

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

Every runner command's stdout is exactly one JSON object + one LF. Fields
below (`?` = may be absent/null; enum values are kebab-case). This appendix
is the machine-facing completion of §10/§12: the body sections own the
semantics, and this appendix owns the field names.

### 20.1 preflight.mjs

```json
{"schemaVersion":1,"command":"preflight","status":"ready-for-check|blocked","reason":"…","blockers":[{"code":"…","detail":"…"}],"willGenerate":["cases/small.cfg"]}
```

### 20.2 check.mjs (the stdout projection of the evidence summary)

```json
{"schemaVersion":1,"command":"check","status":"verified|counterexample|error|incomplete|blocked","reason":"…","summary":{…same shape as evidence.json…}}
```

evidence.json's complete field list is in §12; stdout's `summary` is
identical in shape.

### 20.3 check-evidence.mjs

```json
{"schemaVersion":1,"command":"check-evidence","status":"valid|invalid","reason":"<see 20.5>","fresh":true,"verification":"verified|counterexample|error|incomplete","runId":"…","inputDigest":"…"}
```

`status=valid` always pairs with `fresh:true`; `verification` relays the
audited evidence's summary.status (**not a pass**, §12). When invalid:
fresh=false, verification=null, reason concrete.

### 20.4 Runner exit codes (fixed per command)

- preflight: 0 = ready-for-check; 2 = blocked or usage errors.
- check: 0 = all required verified; 1 = a required case has a
  counterexample; 2 = blocked or error (all blockers listed); 3 =
  incomplete (including cancellation).
- check-evidence: 0 = valid (integrity+freshness; **not a pass**); 2 =
  invalid/stale/missing, with a concrete reason.

### 20.5 The complete reason vocabulary (implementations pick ONLY from here)

- preflight blocked: `config-invalid` (checks.json validation failure),
  `config-drift` (cfg mismatch), `input-limit`, `model-path-unsafe`,
  `java-missing`, `java-version`, `jar-missing`, `jar-checksum`,
  `unsupported-platform`.
- check: `model-locked`, `lock-io`, plus everything from preflight.
- Case level: `verified`, `counterexample/deadlock`,
  `counterexample/invariant`, `counterexample/temporal`,
  `counterexample/value-assert`, `error/assumption-failed`,
  `error/property-evaluation-failed`, `error/config-invalid`,
  `error/unknown-error`, `error/tlc-bug`, `error/output-inconsistent`,
  `error/spawn-failed`, `incomplete/timeout`, `incomplete/log-limit`,
  `incomplete/cancelled`, `incomplete/input-changed`,
  `incomplete/artifact-changed`, `incomplete/not-run`,
  `incomplete/output-invalid`. (evidence's cases[].reason records the
  post-slash half; cases[].status records the pre-slash half.)
- check-evidence: `valid`, `stale/input`, `stale/runner`,
  `stale/toolchain`, `log-missing`, `log-mismatch`, `schema-invalid`,
  `incomplete-run`, `run-in-progress`, `evidence-missing`,
  `runs-path-unsafe`.

With multiple coexisting causes: preflight lists them all in the blockers
array; summary/status reports the single highest-priority one per §11.3's
table order.

### 20.6 Representative output samples (truncated; field order not fixed)

Spawn failure (one case of a check):

```json
{"id":"small","required":true,"status":"error","reason":"spawn-failed","exitCode":null,"signal":null,"timedOut":false,"elapsedMs":3,"argv":null,"statistics":null,"eventCodes":[]}
```

User cancellation (check, exit 3):

```json
{"schemaVersion":1,"command":"check","status":"incomplete","reason":"cancelled","summary":{"status":"incomplete","cases":[{"id":"small","required":true,"status":"incomplete","reason":"cancelled"},{"id":"large","required":false,"status":"not-run","reason":"not-run"}]}}
```

Stale evidence (check-evidence, exit 2):

```json
{"schemaVersion":1,"command":"check-evidence","status":"invalid","reason":"stale/runner","fresh":false,"verification":null,"runId":"20261023T120000Z-9f1c","inputDigest":"…"}
```

Multiple blockers (preflight, exit 2):

```json
{"schemaVersion":1,"command":"preflight","status":"blocked","blockers":[{"code":"java-missing","detail":"no java on PATH"},{"code":"jar-checksum","detail":"SHA-1 mismatch"}]}
```

## Review ledger

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
- Sign-off: user sign-off pending; "Approved" is not claimed until then.
