# Multi-agent orchestration for data-analysis tasks

Status: **Approved design** — two rounds of cold Staff-Engineer review
(dsh-cc-agents:critic); both rounds returned ship-with-changes and the
changes are folded in. Not yet implemented.
Date: 2026-09-18
Scope: `packages/plugin/dsh-cc-agents` (one new skill, a cross-reference
in the orchestration routing skill, version bump),
`packages/compat/cc-plugin-loader` (one loader test assertion), and
opportunistically `docs/claude-code-capabilities.yaml` prose. No new
subagent types. No changes to the critic/executor/marathon definitions.
No changes to any target workspace's files.

## 1. Problem

The dsh-cc-agents plugin ships three subagents — critic (Opus,
reasoning/adversarial review), executor (Sonnet, mechanical execution),
marathon (long-horizon). Their contracts are software-engineering
flavored:

- The critic's adversarial checklist triggers on code failure modes
  (edge cases, race conditions, architectural trade-offs), not on data
  failure modes (caliber/口径 mismatches, wrong dataset or region,
  filter-semantics drift, auth/session expiry, throttling).
- The executor's `Checked` contract assumes verification means
  typecheck/lint/test. Data-task verification is numeric reconciliation
  (row-count deltas, distinct counts, aggregate checksums, null rates,
  cross-caliber consistency), and its core action — running queries
  against a data platform — carries its own execution discipline
  (preflight, reuse-before-handwrite, throttling).

Goal: make the critic/executor orchestration pattern serve data-analysis
tasks across projects, **without new subagent types and without
duplicating any project-local domain knowledge**.

### 1.1 What the target projects look like

The primary target is a class of "AI workspace" projects whose data
analysis happens through a **project-specific data path** — a SQL
warehouse, a JSON query API, a BI platform, or something else; the path
varies per project and is none of this design's business. A field survey
of a representative production workspace found the pattern such projects
converge on:

- A **workspace-local skill system**: a trigger-keyword index, one thin
  skill per dataset or query family (procedure + trap checklist), a
  data-contract document (dataset/field IDs, gotchas), a pitfalls
  knowledge base, preflight procedures (auth warm-up, permission
  probes), and reusable query scripts.
- The surveyed workspace is **read-only** and has **no offline batch
  track** (no ETL, backfill, or partition management); tasks are
  interactive analysis plus report delivery. Other projects may differ —
  the design must not bake in either property.
- Real failure modes observed there: auth/token expiry, caliber routing
  errors (the same metric name served by different datasets under
  different calibers), filter-composition semantics drifting from saved
  reports, throttling, zero-row/multi-day-window debugging, and
  geography mapping mistakes.

## 2. Decisions

### D1. Dual-channel reference: inline the thin meta-rules, point at workspace files

Subagents start with a fresh conversation: no AGENTS.md, no skill tool,
but both critic and executor have `Read`. The plugin skill's own install
path is not knowable to the orchestrator and may fall outside a
subagent's file sandbox. Therefore:

- The skill's own §A–§D (thin meta-rules, tens of lines) are **inlined
  into dispatch prompts** by the orchestrator. Too small to threaten
  context discipline.
- Workspace files (skill index, data contract, pitfalls) are referenced
  by **workspace-relative path pointers** in the dispatch prompt; the
  subagent reads them itself. These files are large — pointers are
  mandatory.

critic.md / executor.md stay untouched.

### D2. Layering: the plugin skill holds meta-rules only; domain knowledge stays in the workspace

Each data-analysis workspace's own docs and skills are the **single
source of truth**, maintained and PR-reviewed by the owning team. If the
plugin skill copied any of it (caliber tables, dataset catalogs), the
copy would rot. The skill body is meta-rules: how to wire a workspace's
existing assets into critic/executor orchestration, whatever the data
path is.

**Host boundary**: this skill exists only in dsh-cc sessions. On other
hosts (e.g. plain Cursor), the workspace's own single-agent skill system
keeps working and the meta-rules silently degrade away — acceptable, and
stated as such.

### D3. No data-path-specific content until a project with that data path appears

The surveyed workspace has no offline warehouse track, so no offline
rubric ships. Dormant sections are documentation maintained for failure
modes that do not exist; the v1 offline material lives in git history if
a real offline project ever shows up. The same logic applies to SQL
dialects, cost caps, and every other path-specific concern: §A–§D ask
"where is this workspace's contract?" instead of answering for it.

### D4. No new subagent types

Exploration loops belong to the orchestrator + critic; executor takes
mechanical single steps; long-running monitoring belongs to marathon. A
read-only "data-explorer" type stays deferred until real failure modes
justify it.

### D5. The trigger chain is a soft relay; the carrier must be plugin-borne

Identification → skill load → dispatch with the right sections is three
soft steps; any one failing silently degrades to generic code review.
The routing rule must therefore live on surfaces that **travel with the
plugin**, because a repo-level AGENTS.md is workspace-scoped: a rule in
this repo's AGENTS.md is invisible to sessions running in any other
workspace. The carriers are the `data-analysis` skill itself (trigger
words in the description, self-contained §D routing) plus a
cross-reference in the plugin's `dsh-cc-agents-orchestration` routing
skill. No target-workspace file (e.g. its AGENTS.md) needs to change
for the mechanism to function — workspace-side edits are optional policy
pins owned by that workspace's maintainer.

### D6. Cost threshold: routine queries do not escalate to multi-agent

The workspace's thin skills already serve routine queries single-agent,
and this skill's trigger words overlap heavily with them. Rule: **a
routine single-caliber query runs through the workspace's own skill with
one agent; multi-agent orchestration kicks in only for caliber doubt,
cross-caliber reconciliation, or external-deliverable reports.**

## 3. Change list

| # | File | Change | Necessity |
|---|---|---|---|
| 1 | `packages/plugin/dsh-cc-agents/skills/data-analysis/SKILL.md` | New; content per §4 | required |
| 2 | `packages/compat/cc-plugin-loader/tests/dsh-cc-agents.spec.ts:179` | `skills.loaded` 1→2. Verified `package-shape.spec.ts:63-65` has no skill-count assertion and `:67` agents.loaded==3 is unaffected | required (CI red otherwise) |
| 3 | plugin `plugin.json` + `package.json` | Version bump in lockstep (`package-shape.spec.ts:68-71` enforces), following the repo-wide release cadence — no solo jump | required |
| 4 | `packages/plugin/dsh-cc-agents/skills/dsh-cc-agents-orchestration/SKILL.md` | One cross-reference line: data-analysis tasks route per the `data-analysis` skill (D6 threshold) | required — plugin-borne, so it reaches every workspace session |
| 5 | `docs/claude-code-capabilities.yaml` prose + plugin READMEs | Opportunistic prose fix + `pnpm docs:parity`; README pair changes require `node scripts/check-readme.mjs --write`. Run an empty-change parity check first to confirm this item is truly optional | optional (to be confirmed) |

No change to this repo's AGENTS.md: its routing section is
workspace-scoped to dsh-cc development sessions, and data analysis is
not a dsh-cc-repo activity. No change to any target workspace's files
either (D5): a workspace maintainer may optionally pin the D6 escalation
policy or register the plugin skill under their external-skill
bookkeeping, but the mechanism functions without it.

Skill name: `data-analysis` — `data-warehouse` would misname a design
that deliberately serves interactive analysis and stays data-path
agnostic.

## 4. Skill content (thin meta-rules, sized for inlining)

Frontmatter: `name: data-analysis`; description carries the D5 trigger
words. Body target ≤100 lines, four sections:

**§A Review meta-rubric (for critic)** — review actions, not calibers:
- Does the spec identify this workspace's data-access contract and cite
  the matching workspace-local skill or doc? If nothing matches, is that
  a genuinely new query or a trigger-keyword gap?
- Is the caliber routing correct per the workspace's own contract
  document? The critic never invents calibers.
- Does the spec state numeric expectations (magnitude, trend direction,
  cross-check relationship)? **A result without expectations is
  unreviewable**: reject and bounce back to the orchestrator instead of
  making expectations up.

**§B Verification discipline (for executor)**
- Every numeric result ships with: full query parameters (dataset /
  region / date window / filters, or the workspace's equivalents), row
  count, and the spec'd cross-check result.
- Cross-checks prefer a second independent caliber or dataset; absent
  one, fall back to time-series sanity (deltas, magnitude jumps).
- The executor reports numbers and deltas, never interpretations;
  interpretation belongs to the orchestrator/critic.

**§C Execution discipline (for executor)**
- Iron order: preflight (auth/permission state per the workspace
  contract) → find the matching skill's existing scripts → reuse →
  hand-write only on a genuine gap.
- For endpoints the preflight doesn't cover: a minimal probe (smallest
  possible query) confirms reachability and permissions — never stall,
  never guess.
- Before hand-writing anything, read the workspace's data-contract and
  pitfalls docs; on zero rows or errors, match the trap checklist and
  retry once before re-deriving.
- Throttling discipline: lightweight queries, sequential execution,
  backoff on failure; never hammer a query API concurrently.
- Stated honestly: where the data path is read-only, guardrails protect
  against *wrong numbers*, not damage; where writes exist, they must be
  explicit in the spec.

**§D Routing (for the orchestrator)**
- Escalation threshold (D6): routine single-caliber query → workspace
  skill, single agent. Caliber doubt / reconciliation / external
  deliverable → multi-agent.
- Multi-agent loop: orchestrator decomposes and **lifts numeric
  expectations from the workspace's skill/contract docs into the spec**
  (§A's expectations are the orchestrator's to supply; the critic only
  verifies) → critic reviews with §A inlined + path pointers → executor
  executes with §B/§C inlined + path pointers → orchestrator
  synthesizes.
- Report delivery goes through the workspace's own skills, never through
  multi-agent wrapping.

## 5. Verification (config-is-prompt compliant)

1. **Build gates**: `dsh-cc-agents.spec.ts` (loaded==2),
   `package-shape.spec.ts` (lockstep), `check:capabilities`,
   `check:parity` all green; README hash re-record if READMEs change.
2. **Real-session observation** (expected behavior stated in the commit
   message; run inside a real data-analysis workspace session):
   - On a metrics query task, the critic's report addresses caliber
     routing and cross-check relationships (baseline today: generic
     code-review vocabulary, no mention of calibers/datasets).
     Falsifiable.
   - The executor's report carries full query parameters + row counts +
     cross-check numbers, and its command history shows preflight and
     script reuse before any hand-written query. Falsifiable.
   - A deliberately caliber-ambiguous request makes the critic demand
     clarification instead of passing the plan. Falsifiable.
   - A routine single-caliber query does **not** trigger multi-agent
     orchestration (D6 threshold works). Falsifiable.
3. **Precondition**: session verification needs live credentials against
   the workspace's data platform and cannot run in this repo's CI; it
   runs in a real working session and the outcome is recorded on the PR.
4. Two observed sessions without the expected difference → roll back or
   revise the rubric.

## 6. Risks and open questions

- Silent degradation is the main failure mode; D5/D6 mitigate but cannot
  eliminate it. The D6 threshold also lowers the cost of false triggers.
- Meta-rules inherit whatever rot exists in the workspace's own docs;
  acceptable — fixing docs is cheaper than fixing prompts.
- Change #5's "optional" label is unverified; confirm the parity check's
  direction with an empty-change run during implementation.

## 7. Revision history

**v1 → v2 (first cold review + field survey of the primary workspace)**:
inline replaced by path pointers; two hard CI omissions added (loader
test, version lockstep); version follows repo cadence; guardrail
verification changed to observable signals; capabilities/README demoted
to optional. Survey: data path turned out to be a JSON query contract,
not SQL — §A/§B/§C rewritten; the workspace already has a complete
domain skill system — layering with zero duplication; read-only — §C
re-aimed at wrong-numbers protection; no offline track — cut.

**v2 → v2.1 (second cold review)**: reverse path-pointer break found
(the plugin skill's install path is unknowable to the orchestrator) →
D1 became dual-channel; missing cost threshold + host boundary → D6
added, D2 amended; preflight coverage gap → minimal-probe rule in §C;
§A expectation ownership clarified (orchestrator supplies, critic
verifies); skill renamed `data-analysis`.

**v2.1 → this document**: generalized away from the surveyed workspace —
all project-specific references (workspace name, CLI tooling, dataset
IDs) removed, since it is a typical member of the target class, not the
only one; the design now speaks about workspace-local contracts and data
paths abstractly. Rewritten in English and restructured to the
docs/plans conventions. Carrier-scope fix: the routing rule moved from
this repo's AGENTS.md (workspace-scoped, invisible elsewhere) to
plugin-borne surfaces — the skill itself plus the orchestration routing
skill — so the mechanism works in any workspace session with zero
workspace-side changes.
