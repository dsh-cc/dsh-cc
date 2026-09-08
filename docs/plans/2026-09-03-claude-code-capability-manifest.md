# Machine-readable Claude Code capability manifest

- **Date:** 2026-09-03
- **Status:** Implemented — PR #95 (merged 2026-09-03). Reviewed — two cold Staff-review rounds (deep-reasoner,
  2026-09-03). Round 1 (2 blockers, 6 majors): incorporated. Round 2 (0
  blockers, 2 majors — D3 wording; missing deviation↔dimension invariant I11 —
  plus minors): incorporated. Verdict: approved as the Phase 0 basis.
- **Author:** Fable (orchestrated design; recon agents + Context7 research)
- **Scope:** docs tooling only; no runtime behavior changes.
- **Rollback:** pure git revert — one devDependency, three scripts, one YAML file,
  four presubmit steps. Nothing runtime touches the manifest (see N1), so removing
  it un-breaks nothing.

## 1. Problem

`docs/cc-parity-matrix.md` is the declared single source of truth for how dsh-cc
covers Claude Code's user-facing surface. It fails as a source of truth in three
structural ways:

1. **One status per capability carries no structure.** A row's ✅/🔶/❌/🚫 cannot
   distinguish "we parse the config" from "the default preset mounts it" from
   "the behavior matches upstream" from "a user can actually drive the feature in
   the TUI". These four collapse into one symbol whose meaning drifts per author.

2. **Claims are not anchored to evidence.** The matrix has been wrong in exactly
   this way, more than once:
   - The WebFetch row claimed "mounted"; the plan
     `docs/plans/2026-09-02-haiku-worker-stuffs.md` documents that this claim was
     wrong and had to be corrected while touching the row.
   - The IDE/LSP row claimed ✅ mounted; the plan
     `docs/plans/2026-09-03-cc-code-intelligence-serena.md` shipped a docs-only
     correction to 🔶/unmounted.
   Both were discovered incidentally, during unrelated work — nothing checks.

3. **Two hand-maintained copies drift.** The `## What you get` section of
   `README.md` duplicates a coarser 15-row status table. Today it already
   contains "Web profile support ✅" — a capability with no counterpart in the
   matrix — and its local legend omits ❌/🚫. Nothing prevents the next
   divergence.

On top of that, the format has nowhere to record **why** a gap exists (downgrade
vs. non-goal vs. blocked on an upstream seam) or **what it was compared against**
(which Claude Code docs, of which date). The deferred-items list is prose, so
nothing can verify that a "blocked" capability's dependency is itself tracked.

## 2. Goals and non-goals

### Goals

- G1. A machine-readable manifest, `docs/claude-code-capabilities.yaml`, is the
  single authored source for Claude Code parity status.
- G2. Each capability records **four orthogonal dimensions** instead of one
  status: `recognized`, `mounted`, `behavioral`, `ux` — plus `evidence`,
  `baseline` provenance, and an explicit `deviation` classification.
- G3. `README.md` and `docs/cc-parity-matrix.md` are **generated** from the
  manifest. Hand edits to generated regions fail CI. Two copies cannot drift
  because only one is authored.
- G4. `scripts/check-capability-evidence.mjs` validates the manifest: schema,
  internal consistency invariants, and **evidence existence with anchors** — a
  positive claim without an in-repo, verifiable anchor does not pass CI.
- G5. `scripts/generate-parity-matrix.mjs` renders both documents, with a
  `--check` mode for CI.
- G6. Blocked capabilities name a machine-checkable **upstream dependency**
  registered in the same file (e.g. `session-file-snapshot-seam` for
  checkpointing).
- G7. The tooling follows existing repo conventions: ESM `.mjs` scripts,
  fail-loud exit codes, paired `*.test.mjs`, `check:*` npm entries, explicit
  steps in `.github/workflows/presubmit.yml` next to the other
  `node scripts/check-*` steps, mirrored in the `.husky/pre-commit` gate list.

### Non-goals

- N1. **Not a runtime feature registry.** The manifest feeds documentation and
  CI; no dsh-cc code loads it at runtime.
- N2. **Not automated behavioral-equivalence testing.** Statuses remain curated;
  the checker enforces *consistency and anchored-evidence existence*. Behavioral
  regression remains the job of the test suite the evidence points at.
- N3. **Not a catalog of dsh-native capabilities** with no Claude Code
  counterpart. dsh-native extras stay as hand-written README prose outside the
  generated region.
- N4. **Not** a replacement for per-package READMEs.

## 3. Baseline and provenance

Every row claims "what Claude Code does". That claim must carry a citation and a
date, because the upstream surface moves (the hook event list itself grew between
2025 and 2026).

```yaml
baseline:
  upstream: claude-code
  sources:
    - id: cc-docs
      kind: context7
      ref: /websites/code_claude        # official docs mirror, 6911 snippets
      url: https://code.claude.com/docs
      retrieved: 2026-09-03
    - id: cc-repo
      kind: context7
      ref: /anthropics/claude-code      # source/changelog mirror
      url: https://github.com/anthropics/claude-code
      retrieved: 2026-09-03
  freshness_threshold_days: 120
```

Each capability carries its own `upstream.refs` entries (`source` id + doc path +
`retrieved` date). **Provenance rules:**

- A `refs` entry asserts the source was actually consulted on its `retrieved`
  date. Seed entries derived from repo recon without a fresh upstream query
  (§7 note) leave `refs: []`; the freshness warning (I8) covers only entries
  that *have* refs, and the Phase 2 ritual backfills the empty ones.
- Freshness is a **warning**, not a gate, in v1 (see D3 in §9).

## 4. Manifest schema (v1)

File: `docs/claude-code-capabilities.yaml`. One authored file; deterministically
ordered; validated as a whole.

```yaml
manifest_version: 1

baseline: { ... }                        # §3

categories:                              # ordered; defines doc section order
  - { id: engine,    title: Engine subsystems }
  - { id: hooks,     title: Hook events }
  - { id: commands,  title: Command surface }
  - { id: sessions,  title: Sessions and context }
  - { id: memory,    title: Memory and CLAUDE.md }
  - { id: skills,    title: Skills }
  - { id: subagents, title: Subagents }
  - { id: mcp,       title: MCP }
  - { id: plugins,   title: Plugins and marketplaces }
  - { id: settings,  title: Settings }
  - { id: permissions, title: Permissions }
  - { id: models,    title: Models }
  - { id: workspace, title: Workspace }
  - { id: ux,        title: Interactive UX }

upstream_dependencies:                   # registry; ids referenced by deviations
  session-file-snapshot-seam:
    title: Session file-snapshot seam
    problem: >-
      dsh sessions persist a jsonl/sqlite projection; there is no per-prompt
      snapshot store of edited files to anchor a rewind against.
    cc_contract: >-
      Every prompt checkpoints files about to be edited; /rewind (or Esc Esc)
      restores code, conversation, or both; checkpoints persist across resumed
      sessions and do not cover Bash-side changes.
    refs:
      - https://code.claude.com/docs/en/checkpointing

capabilities:
  sessions.checkpointing:
    title: File checkpointing and rewind
    category: sessions
    plane: preset                        # host | preset | mixed (default: preset)
    upstream:
      summary: >-
        Per-prompt file snapshots before edits; /rewind menu restores code /
        conversation / both / summarize; operates outside git; Bash-made changes
        are not tracked.
      refs:
        - { source: cc-docs, path: /docs/en/checkpointing, retrieved: 2026-09-03 }
    dimensions:
      recognized: false      # no checkpoint/rewind config or protocol is parsed
      mounted: false         # nothing in the default CC preset
      behavioral: missing    # no snapshot or restore behavior exists
      ux: missing            # no /rewind entry point; TUI has no rewind menu
    evidence: []
    deviation:
      kind: upstream-blocked
      summary: Feature absent; requires a snapshot seam in the session layer.
      upstream_dependency: session-file-snapshot-seam
```

### 4.1 Dimension vocabulary

| Dimension    | Type                          | Meaning |
|---|---|---|
| `recognized` | `true` \| `false` (+ notes) | dsh-cc parses/respects the upstream configuration or protocol surface: file location, settings key, frontmatter, slash-command grammar, manifest field. About *input compatibility*, not behavior. |
| `mounted`    | `true` \| `false` (+ notes) | The default configuration exposes a working path with no extra env flags or manual setup. For `plane: preset` capabilities this means a row in `packages/preset/cc/agent.cordis.yml`; for `plane: host` it means the host enables it by default. A feature behind a default-off flag (e.g. prompt hooks behind `enablePromptHooks`) is `recognized: true, mounted: false`. |
| `behavioral` | `full` \| `partial` \| `divergent` \| `missing` | Runtime behavior equivalence vs. the upstream contract. `divergent` = deliberately different (explained in `deviation`). |
| `ux`         | `full` \| `partial` \| `missing` | Can a user drive the complete upstream workflow in dsh-cc's UI? An engine can be `behavioral: full` while the TUI exposes half the entry points (`ux: partial`). For a `divergent` engine, read `ux` as the reachable fraction of the upstream workflow *or its dsh-native analogue*. |

The four dimensions are deliberately independent where reality is: e.g.
`mounted: false, ux: full` is a legal combination meaning "not on by default, but
once the user enables it, the full workflow works" — the intended reading for
flag-gated features.

Scalar shorthand (`behavioral: partial`) and object form
(`mounted: { status: false, notes: "behind enablePromptHooks, default off" }`)
are both legal; the checker normalizes to the object form internally.

### 4.2 Evidence

One enum, one rule — `type: test | source | script | doc`:

```yaml
evidence:
  - { type: test,   path: packages/hooks/hooks-claude-code/tests/dispatch.spec.ts }
  - { type: source, path: packages/preset/cc/agent.cordis.yml, anchor: "-hooks-claude-code" }
  - { type: script, path: scripts/sync-cc-preset.sh }
  - { type: doc,    path: https://code.claude.com/docs/en/hooks }   # URL allowed for doc only
```

- `test | source | script` → repo-relative path must exist. `doc` → repo path
  must exist, or be an `https://` URL (never fetched in CI).
- `anchor` (optional string) is a literal that must occur in the cited file;
  enforced by the checker via substring search. It is **mandatory** for evidence
  citing `packages/preset/cc/agent.cordis.yml`, because that file is a ~480-line
  monolith every `mounted: true` row would otherwise cite identically (the anchor
  is normally the preset row name, e.g. `-hooks-claude-code`). Anchors apply to
  repo-file citations only; the checker rejects `anchor` on a URL evidence entry.
- **Positive dimension** is defined exactly once, here: `recognized: true`,
  `mounted: true`, `behavioral ∈ {full, partial, divergent}`, or
  `ux ∈ {full, partial}`. A capability with any positive dimension must satisfy
  I4 (below). `evidence: []` is legal only when all four dimensions are
  non-positive.

### 4.3 Deviation taxonomy

| `deviation.kind` | Meaning | Extra requirements |
|---|---|---|
| `none` | Full parity, nothing to explain | — |
| `downgrade` | Weaker than upstream, still useful | `summary` saying exactly what is weaker |
| `divergent` | Deliberately different by design | `summary` |
| `upstream-blocked` | Cannot be built until a named seam exists | `upstream_dependency` resolving in the registry |
| `non-goal` | Won't port / out of parity scope | `summary` with the reason; see I6 for dimension rules |

Every non-`none` deviation renders into the generated matrix's "Deviations and
known limits" section and the README summary, so a promise made in a plan doc
stays visible until the deviation is removed. The per-kind requirements above
(dimension rules, summary contents) are enforced at checker level by I6 and I11.

### 4.4 Consistency invariants

Severity: **E** = hard fail (exit 1), **W** = warning (printed, run stays green).

| # | Rule | Severity |
|---|---|---|
| I1 | `mounted: true` ⇒ `recognized: true` | E |
| I2 | `behavioral ∈ {full, partial, divergent}` ⇒ `recognized: true` | E |
| I3 | `ux: full` ⇒ `behavioral: full`; `ux: partial` ⇒ `behavioral ∈ {full, partial, divergent}` (a deliberately-different engine can still ship a partial UX — e.g. today's "Remote sessions: different" row) | E |
| I4 | Any positive dimension ⇒ ≥1 evidence of type `test`/`source`/`script` that exists. Additionally, `mounted: true` ⇒ ≥1 **anchored** evidence entry per plane the mount claim spans: `plane: preset` ⇒ anchored into `packages/preset/cc/agent.cordis.yml`; `plane: host` ⇒ anchored into the owning host package; `plane: mixed` ⇒ both | E |
| I5 | `deviation.kind: upstream-blocked` ⇒ `upstream_dependency` resolves in `upstream_dependencies`. A registry entry's optional `needed_for` list, when declared, must reference existing capability ids. No back-link is required — reverse lookups are derived | E |
| I6 | `deviation.kind: non-goal` ⇒ `behavioral ∈ {missing, divergent}` and `ux: missing`. If `divergent` (a dsh-native local equivalent exists, e.g. `/model`), `summary` must name it | E |
| I7 | ids unique, dotted kebab-case `<category>.<slug>`, prefix equals `category`, ordered by category order then id | E |
| I8 | every `upstream.refs[].source` exists in `baseline.sources`; `retrieved` parses as ISO date. Each capability whose newest `upstream.refs[].retrieved` is older than `baseline.freshness_threshold_days` is printed in the warning list (id + dates); capabilities with empty `refs` are exempt until Phase 2 backfills them (§3) | W |
| I9 | `deprecated: true` requires `replaced_by` resolving to a non-deprecated capability id | E |
| I10 | `anchor` substrings occur literally in the cited file (repo-file citations only) | E |
| I11 | `deviation.kind` binds to dimensions: `kind ≠ none` ⇒ `summary` non-empty; `kind: none` ⇒ `behavioral: full` ∧ `ux: full` (`mounted` unconstrained — the flag-gated combination of §4.1 is legitimately `none`) | E |

### 4.5 Id stability

Published capability ids are stable API. A rename or recategorization keeps the
old id as a stub entry `{ deprecated: true, replaced_by: <new id> }`; the
generator excludes deprecated stubs from rollups and renders them in a trailing
"Renamed capabilities" table. Stubs are removed no earlier than the next minor
release, in a PR whose title says so.

### 4.6 Roll-up mapping (single definition)

The generator derives one display symbol per capability — never authored:

| Symbol | Condition (evaluated top to bottom) |
|---|---|
| 🚫 | `deviation.kind: non-goal` |
| ❌ | all four dimensions non-positive |
| ✅ | `behavioral: full` ∧ `mounted: true` ∧ `ux: full` ∧ `deviation.kind: none` |
| 🔶 | everything else |

Legend note: 🚫 means "not a parity port" — the capability may still exist as a
dsh-native equivalent (`behavioral: divergent` + `deviation.kind: non-goal` per
I6); the Deviations section of the generated matrix says which.

## 5. The two scripts and one shared library

### 5.1 `scripts/generate-parity-matrix.mjs`

- Reads the manifest via the shared loader (§5.3), renders:
  1. **`docs/cc-parity-matrix.md` — whole file.** Generated header
     (`<!-- GENERATED from docs/claude-code-capabilities.yaml — do not edit; run pnpm docs:parity -->`),
     preamble/legend, one table per category (manifest order) with columns
     `Capability | Recognized | Mounted | Behavior | UX | Evidence | Deviation`,
     a "Deviations and known limits" section, an "Upstream dependencies" registry
     dump, and a footer with baseline source ids + newest retrieval date. Every
     capability row **must** carry a stable HTML anchor
     `<a id="cap-<capability-id>"></a>` (e.g. `cap-sessions.checkpointing`) so
     sibling docs cite **ids, not line numbers** (see Phase 0 step 6); the
     generator test asserts anchor emission.
  2. **`README.md` — marked block only.** Replaces exactly the region between
     `<!-- parity:matrix:start -->` / `<!-- parity:matrix:end -->` (the current
     hand-duplicated table in `## What you get`) with per-category rollup counts,
     a flat "Known deviations" bullet list, the freshness note, and the matrix
     link. Missing markers = hard fail with an insertion instruction. All other
     README content is untouched.
- `--check` renders in memory and diffs both targets; on difference: list the
  stale files, exit 1, print `run pnpm docs:parity`. Output is byte-stable for
  identical input (no timestamps beyond the manifest's own dates).
- Exit 0/1 only.

### 5.2 `scripts/check-capability-evidence.mjs`

- Validates the manifest: schema shape (hand-rolled validator — no schema lib;
  see §5.4), I1–I10, evidence path existence, anchor occurrence, registry
  integrity, ordering. One diagnostic per violation; exit 1 on any error.
- Does **not** read README or the matrix (staleness is the generator's `--check`
  job). Does not fetch URLs.
- Preset-internal composition (rows present/absent in `agent.cordis.yml`)
  remains guarded by the existing `packages/preset/cc/tests/composition.spec.ts`;
  the manifest's mounted-anchors complement it from the claims side.

### 5.3 Test wiring (so the paired tests actually run)

Vitest includes only `packages/**/tests/**`, and presubmit runs checkers
directly but not their `*.test.mjs` — so the paired tests need explicit wiring
(a gap observed at `check:subagent-paste`, whose npm script invokes its
own test — that workaround is being superseded, not copied: here the checker and
its self-test are wired as separate, explicit entries):

- `package.json` scripts:
  - `"check:capabilities": "node scripts/check-capability-evidence.mjs"`
  - `"check:parity": "node scripts/generate-parity-matrix.mjs --check"`
  - `"docs:parity": "node scripts/generate-parity-matrix.mjs"`
  - `"test:capabilities": "node scripts/check-capability-evidence.test.mjs && node scripts/generate-parity-matrix.test.mjs"`
- `.github/workflows/presubmit.yml` gains four explicit steps **after
  `pnpm install`**: the two checkers and the two paired tests. They cannot join
  the zero-dependency static lane before install (the scripts parse YAML via
  js-yaml from node_modules), so they run immediately after `Install dsh-cc
  deps`, ahead of typecheck.
- `.husky/pre-commit` gains the two fast checks, mirroring its existing gate list.

The paired tests exercise each invariant with minimal inline fixture manifests
(pass + fail cases), following the `check-spec-deps.test.mjs` pattern; the
generator test asserts golden output and byte-stability.

### 5.4 Dependency decision

Add root devDependency **`js-yaml`** (^4). Rationale: it is already the runtime
YAML parser of three workspace packages (`preset/cc`, `preset/claude-code-agents`,
`bundle/cc-tui`) — including the preset packages this tooling reads — and root
already carries `@types/js-yaml`, so the typings dependency exists. The
alternative `yaml` ^2 (used by `cc-output-styles`, `skill-claude-code`) is
acceptable but buys nothing here. Both scripts fail with
`js-yaml module missing — run pnpm install` if unresolvable. The loader +
validator shared by both scripts (and by both `.test.mjs` files) lives in
`scripts/lib/capability-manifest.mjs`.

## 6. Capability taxonomy and seed contents

The seed is a **mechanical translation** of the current matrix, then a
granularity upgrade where the current file lumps enumerable upstream surfaces:

- **Engine subsystems** — one capability per existing row (~40), with the four
  dimensions derived from today's symbol **plus the preset scan** (what
  `agent.cordis.yml` actually mounts), not from prose claims.
- **Hook events — one row per upstream event.** Context7 baseline
  (`hooks-guide`, retrieved 2026-09-03): SessionStart, Setup, UserPromptSubmit,
  UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied,
  PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay,
  SubagentStart, SubagentStop, TaskCreated, Stop, PreCompact, PostCompact,
  SessionEnd. Today's "18 of 30 bridged" becomes per-event entries; bridged ones
  get `mounted: true` + anchored evidence under `packages/hooks/`, the rest
  `mounted: false` + deviation; prompt/agent executors get
  `mounted: { status: false, notes: "behind enablePromptHooks/enableAgentHooks, default off" }`.
- **Command surface** — one entry per mounted command and per excluded/degraded
  one. The seed pass fixes the count from `agent.cordis.yml` and
  `packages/interaction/command-*` (the matrix enumerates 21; the preset lists
  ~19 — exactly the class of discrepancy this system exists to reconcile), and
  marks `/resume /branch /config /init` as `downgrade`/`divergent`, `/rewind` as
  `upstream-blocked` on `session-file-snapshot-seam`, `/model /exit` as
  `non-goal` (divergent local equivalents named in their summaries per I6).
- **Newly enumerable gaps** the current format could not express, with proper
  structure from day one:
  - `sessions.checkpointing` — the worked example in §4 (absent repo-wide except
    TUI transcript rendering vocabulary).
  - `memory.claude-md-imports` — `@path` import machinery absent:
    `recognized: false, behavioral: missing`.
  - `ux.statusline` — the `statusLine` settings contract unimplemented (TUI HUD
    only): `recognized: false`, `deviation: downgrade`.
- **Upstream dependency registry**, seeded from the matrix's deferred items plus
  recon: `session-file-snapshot-seam`, cron selector support, WebFetch SSRF
  allowlist, `PreCompact` compaction seam, human-facing `/tasks` todo seam,
  memory mtime/`memoryAge` (FsInfo seam), notification seam, permission mode
  catalog pin, upstream issue #2124 (fork+background Task).

### Evidence backfill rule

During the seed, every positive dimension must gain an I4-satisfying evidence
entry — the package/test map exists (`tests/*.spec.ts` in every capability
package). A positive claim that cannot be anchored is **downgraded in the
seed**, with the downgrade visible in the PR diff for human sign-off. This would
not have *proven* the WebFetch "mounted" claim false (the package has tests), but
it would have forced an anchor into `agent.cordis.yml` that did not exist — the
review prompt the manual matrix never produced.

## 7. Migration plan

**Phase 0 — tooling and seed (one PR).**
1. Add `js-yaml` root devDep; add `scripts/lib/capability-manifest.mjs`.
2. Author `docs/claude-code-capabilities.yaml` per §6, including evidence
   anchors and any forced downgrades — each downgrade listed explicitly in the
   PR description. Seed entries for upstream areas not re-queried this round
   (Appendix B) ship with `refs: []`.
3. Add `scripts/generate-parity-matrix.mjs`; replace the README `## What you get`
   status table with the markers; regenerate `docs/cc-parity-matrix.md`.
4. Add `scripts/check-capability-evidence.mjs`; add the four npm scripts (§5.3).
5. Wire the four presubmit steps and the two pre-commit gates; document the edit
   loop (edit YAML → `pnpm docs:parity` → commit all files) in `docs/dev.md`
   near the existing `check:spec-deps` docs.
6. **Citation migration:** existing docs cite matrix line numbers (e.g.
   `docs/plan-mode-command-channel.md`, the serena plan). The seed PR rewrites
   those to the new `#cap-<id>` anchors; new citations must use anchors.
7. **Reviewability net:** keep the pre-generation matrix as
   `docs/cc-parity-matrix.legacy.md` for one release cycle, and the seed PR
   must contain an old-row → new-capability mapping table so note preservation
   is checkable (not just asserted).
8. **In-flight plan coordination:** several open plan docs instruct hand-edits
   to `docs/cc-parity-matrix.md` (`2026-09-03-background-agent-runtime`,
   `2026-09-03-task-background-frontmatter`, `2026-09-03-clear-new-session`,
   `2026-09-03-cc-code-intelligence-serena`, and any older ones still open).
   The seed PR description calls this out; after merge, capability-status
   changes land in the manifest only — hand-edits to the matrix now fail CI by
   design.

*Acceptance:* the four new npm scripts and the four new presubmit steps
(two checkers, two paired self-tests) are green; `pnpm test`,
`pnpm check:size` (baseline ratcheted with justification if the new scripts
exceed limits), and the full presubmit suite green; README and matrix contain
only generated parity content; the PR contains the row-mapping table and lists
every seed-time downgrade.

**Phase 1 — governance.**
Rule in `CLAUDE.md`/`docs/dev.md`: any PR changing capability-affecting code
(preset composition, hook bridging, command mounting, settings/permissions
surface) updates the manifest in the same PR. CI makes stale docs impossible;
this rule makes stale *claims* the reviewer's explicit concern.

**Phase 2 — refresh ritual.**
Monthly, or per notable Claude Code release: re-query the baseline sources on
Context7, diff upstream surface vs. manifest ids, backfill `refs: []` seed
entries, bump `retrieved` dates, open the freshness PR. I8 warnings make a
skipped refresh visible. Optional later: emit
`docs/claude-code-capabilities.json` alongside the matrix (same loader +
`JSON.stringify`) for programmatic consumers.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| R1. Curated statuses can still overstate behavior (evidence exists but behavior drifted). | Evidence anchors to tests that run in presubmit; I4 anchors force claims to name their mount point; deviations force known differences into the open. Honest residual: a stale-but-green test can still anchor a wrong claim — that is N2's accepted limit. |
| R2. YAML authoring is heavier than editing one MD line. | Scalar shorthand; deterministic ordering; generator owns formatting; documented edit loop. |
| R3. New root runtime dependency for scripts. | `js-yaml` matches three existing workspace consumers and the existing root `@types/js-yaml`; devDep only; fail-with-instruction on absence (§5.4). |
| R4. Upstream surface churn makes rows stale. | Per-capability `retrieved` + I8 freshness warnings; Phase 2 ritual; deviations localize churn to single entries; id-stability policy (§4.5) prevents renames from breaking citations. |
| R5. Authors forget `pnpm docs:parity` after editing YAML. | CI `--check` fails with the exact command; pre-commit also regenerates-checks. |
| R6. Whole-file regeneration loses hand-written nuance. | Per-dimension `notes` + `deviation.summary` carry the nuance; Phase 0 step 7 keeps the legacy file for one cycle and requires an explicit mapping table. |
| R7. Paired tests rot unexecuted. | §5.3 wires them into npm scripts, presubmit, and pre-commit explicitly — the failure mode observed at other checkers is designed out. |

## 9. Decided and open questions

- D1. `plane: host | preset | mixed` (default `preset`) **is** in v1 — the
  "Mode placement" preamble of the current matrix becomes structured data.
- D2. An informational upstream version string (e.g. from
  `/anthropics/claude-code` version listings) may be recorded as free-text
  `baseline.notes`; it is not a validated field in v1.
- D3. Warnings are never *escalated* to failures in v1 — a `--strict` mode was
  considered and cut (nothing would run it; revisit when the publish workflow
  wants it). The E/W split in §4.4 stands unchanged: E-level invariants
  hard-fail.
- O1. JSON render — DECIDED in Phase 2: shipped as docs/claude-code-capabilities.json (normalized manifest), generated and drift-checked by the same generator.
- O2. Whether dsh-native extras deserve a *separate* generated table in the
  matrix (from a second, dsh-owned manifest) — deliberately out of scope here.

## Appendix A — current-state census (recon, 2026-09-03)

From `docs/cc-parity-matrix.md`, `README.md`,
`packages/preset/cc/agent.cordis.yml`, and the package tree (enumeration by
recon agents, verified against the repository during review):

- Engine subsystem rows: ~40. Majority ✅; 🔶 for WebFetch, Subagents, Todo,
  Hooks, Schedule, IDE/LSP, Vim/keybindings, Remote sessions ("different");
  ❌ Notifications, Onboarding/tips; 🚫 Voice and vendor-bound internals.
- Hook events: ~18 of ~30 upstream events bridged; prompt/agent executors behind
  default-off flags.
- Command surface: matrix enumerates 21 mounted; preset lists ~19 — discrepancy
  to be reconciled by the seed from `agent.cordis.yml` (see §6).
- Preset mount definition: `packages/preset/cc/agent.cordis.yml` (~480 lines),
  guarded by `tests/composition.spec.ts`; shipped to
  `$DSH_HOME/.agent-presets/cc/` via `scripts/sync-cc-preset.sh`.
- Every capability package has `tests/*.spec.ts` coverage (hooks 17, memory 13,
  interaction 30, ui 66, mcp 12, settings 9, …) — the raw material for evidence
  backfill.
- Keyword census: `checkpoint` present only in TUI transcript rendering;
  `rewind` absent; CLAUDE.md `@import` machinery absent; the `statusline`
  settings contract absent (HUD only); plugin/marketplace machinery present in
  `packages/compat/cc-plugin-loader`.
- README duplicates a coarse 15-row table with one capability
  ("Web profile support") that has no matrix row — live drift as of today.

## Appendix B — research log (baseline provenance)

Context7 library resolution (2026-09-03): primary `/websites/code_claude`
(official docs mirror; 6911 snippets); secondary `/anthropics/claude-code`
(repo mirror; version listings observed).

Queries executed against `/websites/code_claude` (one per topic) on 2026-09-03:

1. **Hooks system** — event list (SessionStart, Setup, UserPromptSubmit,
   UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied,
   PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay,
   SubagentStart, SubagentStop, TaskCreated, Stop, PreCompact, PostCompact,
   SessionEnd), matcher families per event, PreToolUse JSON decision contract
   (`permissionDecision`, `updatedInput`, `additionalContext`).
   Sources: `/docs/en/hooks-guide`, `/docs/en/hooks`, `/docs/en/agent-sdk/python`.
2. **Checkpointing and session storage** — per-prompt snapshots before edits;
   `/rewind` / Esc Esc menu (code / conversation / both / summarize); persists
   across resumed sessions; Bash-side changes untracked; SDK surface
   (`enableFileCheckpointing`, `rewind_files(uuid)`,
   `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`).
   Sources: `/docs/en/checkpointing`, `/docs/en/best-practices`,
   `/docs/en/glossary`, `/docs/en/agent-sdk/file-checkpointing`.
3. **Plugins, marketplaces, settings** — optional `.claude-plugin/plugin.json`
   with layout auto-discovery; components `skills/ commands/ agents/
   hooks/hooks.json .mcp.json`; `.claude-plugin/marketplace.json`;
   `claude plugin install` scopes (user/project/local); `enabledPlugins`
   (`{"name@marketplace": bool}`) in settings.
   Sources: `/docs/en/plugin-marketplaces`, `/docs/en/plugins-reference`,
   `/docs/en/settings-reference`, `/docs/en/agent-sdk/plugins`.

Not re-queried this round (seeded from repo recon + prior knowledge; ship with
`refs: []`, backfilled in Phase 2): subagent frontmatter, SKILL.md frontmatter,
slash-command grammar, memory file hierarchy, MCP scopes/transports, output
styles, status line contract, settings precedence order.
