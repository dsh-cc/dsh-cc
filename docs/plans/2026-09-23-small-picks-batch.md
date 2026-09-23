# Small picks from oh-my-pi: seven mini-designs

**Status:** **Proposed** — critic cold review round 1 (2026-09-23)
incorporated: C1 rescoped to the TUI /resume listing with per-file read-time
preference and safe caps; C2 gains store-hash coherence + boot-time env
capture + concrete floors; C3 rewritten onto the existing bypassImmune
machinery; C5 de-hunked into deterministic-collect + model-split; C6
re-seamed to applyModelSwitch with skip-toast; C7 split actionable vs
upstream with ordering un-pinned; manifest impact stated per item.
Origin: oh-my-pi borrow analysis (2026-09-23,
workspace memory `oh-my-pi-analysis-borrow-list`). C-tier batch: each section
is one self-contained mini-design with problem → design → implementation →
verification. Items marked **[upstream]** are proposal texts for the harness
repo, actionable here only as documentation. **Date:** 2026-09-23
**Worktree:** `.claude/worktrees/oh-my-pi` (branch `worktree-oh-my-pi`)

## C1. Session-title sidecar for cheap session listing

**Problem.** Every listing that wants titles — concretely the TUI `/resume`
picker (`packages/ui/tui/src/session-list.ts`, plus `resume-target.ts`) —
pays a full zstd JSONL parse per
session file (`session.v3.jsonl.zstd` naming since harness 0.1.5). oh-my-pi
keeps a physical 256-byte fixed-width title slot at the head of each session
file so listing reads a 4 KB prefix (`oh-my-pi/docs/session.md:63`; verified
2026-09-23).

**Design.** We cannot put a slot inside the harness-owned file (that is the
harness's format). The dsh-cc-side equivalent is a **sidecar**:
`<sessionId>.title` (one line, UTF-8) written wherever a session
title is set or generated — the seam already exists at
`packages/compat/session-title-provider` (`src/index.ts`, `invariant.ts`).
The 200-byte cap is applied by code points (truncate at ≤200 code points, or
199 bytes + a safe multibyte trim) so a multibyte character is never split.
Sidecar directory: prefer a dsh-cc-owned directory keyed by session id; if the
harness session-store path is handed to the title provider, colocate the
sidecar next to the session file instead — decision rule is "use whichever
path the provider can already resolve; no new harness API."
Listing paths prefer the sidecar and fall back to a full parse, so a missing
or stale sidecar degrades gracefully; preference is evaluated per file at
read time — a sidecar whose mtime predates the session file's last write
loses to a fresh parse.

**Implementation.** Write-through in the title provider (fsync-free,
write-temp+rename); read-preference in the resume picker listing path; sidecar
contents always re-derivable from the session file (never the source of
truth). House rule observed: session listing code tolerates unknown files
already (per-file try/catch, the PR #86 lesson). Manifest impact: the
`commands.resume` row's ux dimension evidence is updated when this ships.

**Verification.** Unit spec: title set → sidecar appears; corrupt sidecar →
fallback parse. Perf check in PR: list 100 session files with and without
sidecars, report wall time on a normal dev box.

## C2. Transcript secret redaction at export/store boundaries

**Problem.** Session transcripts can contain pasted secrets (keys, tokens),
and they fan out: `/export` (`packages/session/command-export/src`,
`transcript.ts`), the context-crusher's externalized store
(`packages/context/context-crusher`), session sharing. oh-my-pi ships a
secrets pipeline with env-name patterns, a per-user `secrets.yml`, built-in
credential regexes, and two modes — `obfuscate` (reversible placeholder) and
`replace` (one-way) (`oh-my-pi/docs/secrets.md:1-57`; verified 2026-09-23).

**Design (v0 deliberately narrow).** One matcher table module
(`packages/observability`-free, new `packages/interaction/transcript-secrets`
or fold into an existing home — implementer picks the smaller diff): built-in
credential regexes (Anthropic/OpenAI/GitHub/AWS shapes), plus env-var name
patterns (`*_KEY`, `*_TOKEN`, `*_SECRET`) resolved against values captured
from `process.env` at session boot by the session/provider process (the
env snapshot is taken once at boot, not re-read at export time). Application
points, in order:

1. `/export` (one-way `replace`, always on) — anything leaving the machine.
2. Crusher store writes (one-way `replace`, on by default; the in-context
   copy is untouched, so nothing reverses). Redaction happens BEFORE hashing,
   so `ccr://<hash>` references and ledger keys derive from the redacted text
   consistently (seam: `CrusherStore.put`,
   `packages/context/context-crusher/src/index.ts:227`); `context_retrieve`
   returns the redacted text with a one-line note. Accepted caveat: cross-
   session dedup then correlates redacted placeholders rather than raw
   secrets — that is the deliberate price of coherence.

Two-way `obfuscate` (reversible, for live streams) is phase 2 — the replay
surface (provider payload rebuilds) is harness-side.

**Implementation.** Redactor is pure string→string with a stats return
(counts and matched env var names only — never values); unit-tested against a
fixture transcript containing canary values. No network
or settings read at match time; settings only add custom regexes
(`cc-secrets.extraPatterns`).

**Verification.** Specs: canary redaction in export output and in the crusher
store; no redaction of lookalike non-secrets — the false-positive floor is
≥20 chars of base64url/hex/quoted-ASCII charset classes. Manifest: extend
`commands.export` evidence (behavioral
change to a parity command — deviation note required).

## C3. Non-bypassable critical-bash denylist

**Problem.** permission-rules already curate catastrophic patterns
(`packages/interaction/permission-rules/src/classifier.ts:33`,
`DEFAULT_DANGEROUS_PATTERNS`) — but a match only raises the command to HIGH
risk, and HIGH routes into mode/classifier logic that permissive modes
approve. oh-my-pi's approval model keeps a pattern tier that even `yolo`
cannot auto-approve (`oh-my-pi/docs/approval-mode.md`; verified 2026-09-23).

**Design.** Reuse the existing `bypassImmune` machinery in the permission
evaluation pipeline (`packages/interaction/permission-rules/src/evaluate.ts`
— rules flagged bypass-immune at evaluate.ts:40 are evaluated first and
always deny, evaluate.ts:87-89). No new `critical` tier is invented: the
design is to curate which patterns are mounted as bypassImmune deny rules.
Initial list, exact and small: fork-bomb shapes and `rm -rf /`-shape only —
sudo and `curl | sh` are NOT reclassified, keeping bypass useful. Sandbox
interplay: a critical-deny gates the pre-execute tool call regardless of any
`danger-full-access` sandbox grant, and the spec matrix covers that
combination. CC parity: CC has no such tier, so this is a deliberate
deviation recorded in the manifest (`permissions.rules` entry), not parity
drift by accident.

**Implementation.** Move the curated patterns from advisory
`DEFAULT_DANGEROUS_PATTERNS` matching into bypassImmune deny-rule entries in
the permission evaluation pipeline (`evaluate.ts`), so the deny runs before
mode short-circuits by construction. Settings: `cc-permissions.critical.extra`
(append-only list, same deny semantics). The classifier stays advisory-only
about everything else.

**Verification.** Spec matrix: patterns × modes (`default`, `acceptEdits`,
`auto`, `plan`, `bypass`) × sandbox grants (including
`danger-full-access`) → deny with reason; non-critical dangerous patterns
keep current behavior. Dogfood: try the fork-bomb canary in a bypass-mode
session, capture the denial.

## C4. Todo invariants (phases, single-active, lenient repair) **[upstream]**

**Problem.** `todo_write` is harness-owned: whole-list replace, no phases, no
single-active-task invariant, strict args. oh-my-pi's todo keeps phase
tracking, a single-`in_progress` invariant with auto-promote/demote, and
lenient repair of unambiguous arg shapes
(`oh-my-pi/packages/coding-agent/src/tools/todo.ts:131,501,722-726`;
verified 2026-09-23).

**Design here is the proposal text only.** Recommend to the harness: phase
model with markdown round-trip, exactly-one-`in_progress` normalization on
every mutation, lenient op inference only for unambiguous shapes, and
all-or-nothing mutation semantics (discard on any error). dsh-cc-side
fallback if upstream declines: none planned — the tool is core surface and
shadowing it from the preset would break the capability contract.

**Verification (against the upstream PR, when written).** Specs for the
invariant transitions and the repair table.

## C5. `/commit-split`: atomic-commit split advisor

**Problem.** Large mixed diffs become one messy commit. oh-my-pi's
`omp commit` reads the working tree (overview → file diff → hunk), splits
unrelated changes into atomic commits ordered by dependency, rejects cycles,
excludes lockfiles, and ranks source files above tests/docs
(README feature 16; `oh-my-pi/README.md:225-227`; verified 2026-09-23).

**Design.** New command package (registration checklist per PR #6:
package + preset row + command-usage help + manifest entry + README trio —
house gate scripts `pnpm check:capabilities`, `pnpm check:parity`, and the
bilingual README gate `pnpm check:readme` plus the capability manifest row
and preset row).
`/commit-split` is **advisory and dry-run-only**: it emits an ordered split
plan (per-commit FILE lists + one-line messages, dependency-ordered, cycles
called out as an error — no hunk-level analysis), and never commits. The
user (or model, explicitly asked) executes proposals one by one.

**Implementation.** Two-layer: the command handler collects git data
deterministically — `git status --porcelain` plus per-file diffs (staged +
unstaged), via the shell tool (no new process primitives, and no shelling
mid-model-call); a cheap/slow-lane model call
(`resolveAlias(ctx, 'slow')` with the no-inherit rule — fall back to the
main model with a visible note, splitting is not cost-sensitive) then does
the split analysis from that data. Dependency = co-changed import edges
(textual heuristic, declared as such in output).

**Verification.** Fixture repo with two interleaved topics → plan separates
them and orders dependency-first, with source ranked above test above docs
pinned as a fixture expectation; cyclic fixture → clean error. Dry-run
invariant pinned by spec asserting zero `git commit` invocations
(shell-recording fixture).

## C6. Ctrl+P alias cycling

**Problem.** Switching models mid-session means typing `/model`. oh-my-pi
cycles the active role's configured list with Ctrl+P / Shift+Ctrl+P
(`oh-my-pi/packages/tui/src/prompt/custom-editor.ts:59-60`; verified
2026-09-23).

**Design.** dsh-cc's analog of "configured models" is the alias table plus a
new setting `cc-model-cycling.cycleOrder: [alias…]`. Ctrl+P in the TUI global
key listener (precedent: ctrl+t/ctrl+o handlers in
`packages/ui/tui/src/input.ts:471-486`) cycles the **main session** route
through that list, applying via `applyModelSwitch(provider, model)`
(`packages/ui/tui/src/harness/driver-pickers.ts:98`, exposed through
`driver-ctx.ts:320` with `model-catalog.ts`), with a one-line status toast.
Aliases resolve against the advertised catalog at cycle time; a cycle step
landing on an unadvertised route is skipped with a toast and never bricks
the next request. Ctrl+P = forward, Shift+Ctrl+P = backward. No entry in
`cycleOrder` → binding inert. 500-line file cap honored by a new file under
`packages/ui/tui/src/` (statusline PR #124 discipline). Manifest impact: the
`commands.model` row (currently mounted:false / behaviorally divergent) gets
its ux dimension re-evaluated when this ships.

**Verification.** Unit-level: key-event → apply-call sequence with a fake
model seam; dogfood: bind, cycle twice, confirm status line + next request
headers show the rotated route.

## C7. Foreign rules/context import beyond Cursor dialect

**Problem.** Our rules ingestion covers Cursor `.mdc`; claude-md `@import`
expansion is already recorded missing
(`docs/claude-code-capabilities.yaml:2200`, `memory.claude-md-imports`,
recognized:false / downgrade). Meanwhile other tools' rule files on disk
(`.clinerules`, `.windsurfrules`, `.windsurf/rules/*.md`,
`.github/copilot-instructions.md`, `**/copilot-*.instructions.md`) are
invisible to us; oh-my-pi harvests all of them at priorities below native
(`oh-my-pi/packages/coding-agent/src/discovery/{cline,windsurf,github}.ts`;
verified 2026-09-23).

**Design (split in two).**
*Foreign-format ingestion (dsh-cc-actionable):* a NEW system-prompt injection
section riding the plugin rules-seam precedent
(`packages/bundle/cc-shell/src/rulesSeam.ts`), covering the four foreign
formats at **lowest** precedence among dsh-cc sections, every one opt-out via
a `disabledProviders`-style list. No format conversion: each file is ingested
as-is and rendered like other context blocks. Ignore rule: vendored
directories and `node_modules` are never matched by the foreign globs.
*claude-md `@import` expansion:* stays upstream-owned (harness
`agent-instructions` plugin, per `packages/subagent/task/src/strip-instructions.ts:2-3,28-29`)
and remains a manifest deviation only (`memory.claude-md-imports`).

**Implementation.** One discovery module + render glue on the rules seam;
unknown formats stay inert. Silent-discovery noise rule: one consolidated
debug line listing what was picked up, nothing in-context unless content
exists.

**Verification.** Fixture workspace containing all four formats → system
prompt snapshot spec shows each block once; foreign section renders after the
dsh-cc cursor-rules section, while position relative to the
harness-injected baseline (CLAUDE.md/AGENTS.md) is best-effort and
documented, not pinned by spec. Manifest: `memory.claude-md-imports` keeps
its own entry; the new section's evidence lands with its own row when
shipped.

## Cross-cutting DoD for the batch

1. C1/C2/C3/C5/C6/C7 each land behind their own PRs or one batched PR; every
   landed item carries the specs named in its section.
2. Every item touching the CC-compatible surface updates the capability
   manifest in its own commit per the I3/I4/I7 validator rules +
   `pnpm docs:parity`.
3. C4 leaves this repo as a link to the upstream harness issue/PR, which
    lands together with the item's manifest note once filed.
