# Small picks from oh-my-pi: seven mini-designs

**Status:** **Implemented** — PR #139 (opened 2026-09-24). Review provenance: critic cold review round 1 (2026-09-23)
incorporated: C1 rescoped to the TUI /resume listing with per-file read-time
preference and safe caps; C2 gains store-hash coherence + boot-time env
capture + concrete floors; C3 rewritten onto the existing bypassImmune
machinery; C5 de-hunked into deterministic-collect + model-split; C6
re-seamed to applyModelSwitch with skip-toast; C7 split actionable vs
upstream with ordering un-pinned; manifest impact stated per item.
Critic cold review round 2 (2026-09-24, post #135/#136/#137 drift fixes)
incorporated: anchors re-verified against the tree, every ambiguity resolved
to one deterministic rule (no implementer-picks remain), C3's problem
statement corrected to the real gap, C5's model/shell seams re-seamed to
`runSideQuery`/`ctx.get('shell')`, C6's bogus catalog anchor replaced, C7's
section order/caps/format pinned, DoD pinned to one batched PR with an
exact local gate list. Round-2 cold review (2026-09-24) verdict: **BATCH
READY** — C1's projectKey/sessionsRoot derivation pinned byte-exact against
the harness encoder, remaining round-2 NITs incorporated.
Origin: oh-my-pi borrow analysis (2026-09-23,
workspace memory `oh-my-pi-analysis-borrow-list`). C-tier batch: each section
is one self-contained mini-design with problem → design → implementation →
verification. Items marked **[upstream]** are proposal texts for the harness
repo, actionable here only as documentation. **Date:** 2026-09-23
**Worktree:** `.claude/worktrees/small-picks` (branch `worktree-small-picks`)

## C1. Session-title sidecar for cheap session listing

**Problem.** The TUI `/resume` picker's title path pays the expensive read
today: `decorateSessionTitles` (`packages/ui/tui/src/harness/driver-sessions.ts:120-151`)
calls the host `sessionQuery.readTitleSnapshots(ids)` (driver-sessions.ts:126),
which in the harness does corpus projectMany → inspectPersisted → readColdSessionLog —
a FULL zstd decode + JSONL scan per persisted session
(harness repo: `packages/session-query/session-query/src/index.ts:249-260`, `corpus.ts:132-224`,
`corpus.ts:273-279`, `cold-read.ts:37-40`; the underlying JSONL reader
`readZstdPrefix` in `session-persistence-jsonl/src/index.ts:890-927` scans every
frame; in-memory memo is only `COLD_LOG_MEMO_MAX_ENTRIES=2`, `index.ts:64`;
live sessions avoid the cold path via `corpus.ts:141-147`; the persisted reader
layer is `session-persistence-jsonl/src/storage.ts:165-180`, `index.ts:697-707`).
The header listing itself is already cheap — `readFirstZstdLine` reads the first
frame only (harness repo: `session-persistence-jsonl/src/index.ts:975-1018, 1332-1361`) — so
the cost to attack is specifically the title read, not the listing. oh-my-pi
keeps a physical 256-byte fixed-width title slot at the head of each session
file (`oh-my-pi/docs/session.md:63`; the "4 KiB prefix" claim is at :547;
verified 2026-09-23).

**Design.** We cannot put a slot inside the harness-owned file (that is the
harness's format). The dsh-cc-side equivalent is a **sidecar**:
`title.txt` colocated at `<sessionsRoot>/<projectKey>/<sessionId>/title.txt`
(one line, UTF-8). Path derivation, pinned identically at all three touch
sites (two writers, one reader): `<sessionsRoot>` =
`join(defaultDshHome(), 'sessions')` from `@deepseek-ai/dsh-home-paths`
(precedent `packages/memory/memory-consolidation/src/index.ts:114`);
`<projectKey>` = `` `--${projectSlug(sessionCwd)}--` ``, where `projectSlug`
already exists at `packages/memory/memory/src/paths.ts:74-94` and ports the
upstream slug encoding — the harness wraps that slug in `--` on both sides
(harness repo: `packages/session/session-persistence-jsonl/src/format.ts:224-244`;
the match must be byte-exact or the sidecar is silently never found). Writer
cwd is the session's cwd; the reader (`decorateSessionTitles`) derives both
fields from the listing entry's `cwd` and `id` that the host snapshot
already returns (entry.cwd exists — `driver-sessions.ts:110`). NEVER use
`resolveProject` (`packages/ui/tui/src/project.ts:121`, consumed at
`driver-sessions.ts:191-192`) — that is the TUI-plane projects dir
(`defaultTuiDir()/projects`) and a different key. Layout precedent:
`packages/session/session-forensics/src/scan.ts:286`. Colocating keeps the
freshness mtime comparison a same-directory stat. Truncate the
sidecar title to at most 200 Unicode code points via `Array.from(title).slice(0, 200).join('')`
(never splits a surrogate pair), then UTF-8 encode. There is no byte-based
rule.

**Considered and rejected:** the harness ships a persisted projection cache
with a title hint (`packages/session/session-projection-cache/src/index.ts:130-180`,
records at `<storage-root>/storages/session_projcache.json`) — but
`readTitleSnapshots` ignores it, and we will not read it: harness-private
storage format, hint-only semantics, and it would couple dsh-cc to upstream
internals. The dsh-cc-owned sidecar stays the design.

**Implementation.** Two write sites, both write-temp+rename, fsync-free:
(i) title generation success in `packages/compat/session-title-provider/src/index.ts:66`
(`generateSessionTitleWithLlm` — write the sidecar from `request.session`'s id
and cwd; if the harness `request.session` type does not expose `cwd`, fall
back to `process.cwd()` and say so in the PR); (ii) `/rename` in `packages/interaction/command-rename/src/index.ts:35`
(write `accepted.title` after a successful `titles.rename` — the host may
internally rewrite/reject; write only the accepted value). No harness API
changes; the title provider remains a register-`generate` seam
(`session-title-provider/src/index.ts:60-74`, ownership split per
`invariant.ts:18-21`).
Read-preference lives inside `decorateSessionTitles` (driver-sessions.ts:120-151),
not in the pure `harness/session-list.ts` helpers: first attempt sidecar reads
for all ids (batch, per-file try/catch); the sidecar wins only when
`statSync(sidecar).mtimeMs >= statSync(<sessionsRoot>/<projectKey>/<sessionId>/session.v3.jsonl.zstd).mtimeMs`
(fall back to `session.jsonl.zstd` if v3 absent; missing session file ⇒ sidecar
counts as fresh; missing/corrupt/empty/stale sidecar ⇒ that id goes to the
existing `readTitleSnapshots` call at driver-sessions.ts:126 unchanged).
A stale sidecar only degrades the read; title re-derivation on the read path
is explicitly OUT of scope (re-derivation happens naturally at the next
generate/rename write). House rule observed: session listing code tolerates
unknown files already (per-file try/catch, the PR #86 lesson). Manifest
impact: the `commands.resume` row's evidence gains the new spec path; no
dimension flips.

**Verification.** Unit spec: title set → sidecar appears; corrupt sidecar →
existing fallback unchanged. Perf check in PR: time `decorateSessionTitles`
for 100 sessions with and without sidecars, report wall time on a normal dev
box — and state the premise explicitly: the title path pays a full
session-file parse today (harness anchors above), the header listing does not.

## C2. Transcript secret redaction at export/store boundaries

**Problem.** Session transcripts can contain pasted secrets (keys, tokens),
and they fan out: `/export` (`packages/session/command-export/src`,
`transcript.ts`), the context-crusher's externalized store
(`packages/context/context-crusher`), session sharing. oh-my-pi ships a
secrets pipeline with env-name patterns, a per-user `secrets.yml`, built-in
credential regexes, and two modes — `obfuscate` (reversible placeholder) and
`replace` (one-way) (`oh-my-pi/docs/secrets.md:1-57`; verified 2026-09-23).

**Design (v0 deliberately narrow).** Home, decided: **new leaf package
`packages/interaction/transcript-secrets`** (`@dsh-cc/transcript-secrets`),
pure string→string, zero runtime deps. command-export is session-plane and
context-crusher is context-plane; folding the redactor into either forces a
cross-plane dependency in the wrong direction. Both consumers add
`@dsh-cc/transcript-secrets: workspace:^`. Built-in credential regexes, in
match order (longest prefix first so `sk-ant-` is not eaten by the OpenAI
pattern), each with a ≥20-character body floor baked into the quantifier:

- Anthropic: `/sk-ant-[A-Za-z0-9_-]{20,}/gu`
- OpenAI: `/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu` (runs after the Anthropic pattern)
- GitHub: `/gh[pousr]_[A-Za-z0-9]{20,}/gu`
- AWS (fixed-shape exception to the ≥20 body floor): `/(?:AKIA|ASIA)[0-9A-Z]{16}/gu`
- Bearer header: `/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gu`

The quoted-ASCII class is dropped (too noisy on prose). Env-var name patterns:
suffix match `/(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIALS?|PRIVATE|OAUTH)$/u`
on the env NAME with value floor ≥ 8 characters (omp's floor). Env snapshot:
a module-level `Map<string, string>` captured lazily on the first `redact()`
call in the host process (lazy-once; no re-read at export/store time); export
`resetForTests()`. API: `redact(text): { text: string; matches: number; envNames: readonly string[] }`
— counts and matched env var names only, never values.

Application points, in order:

1. `/export` (one-way `replace`, always on, no setting) — redaction wraps the
   return of `renderTranscript` (`packages/session/command-export/src/transcript.ts:91`).
2. Crusher store writes (one-way `replace`, on by default; the in-context copy
   is untouched, so nothing reverses). Redaction happens INSIDE
   `CrusherStore.put` (`packages/context/context-crusher/src/store.ts:61`),
   injected via the constructor (`new CrusherStore(root, redact?)`), so all
   three call sites — `index.ts:227`, `index.ts:282`, `reducer.ts:219` —
   inherit it and it is redact-before-hash: hash, file name, and stored text
   all derive from the redacted string. `context_retrieve` (served from
   context-crusher, `index.ts:333-362`) therefore returns redacted text, with
   the note appended as a trailing line to the `{ text }` value returned by
`defineRetrieveTool`'s execute (`index.ts:355-360`):
   the exact line `[secrets redacted before store write]`.
   Accepted caveats: cross-session dedup then correlates redacted placeholders
   rather than raw secrets (deliberate price of coherence), and pre-existing
   store entries keep raw secrets until the existing LRU sweep — no migration.

Two-way `obfuscate` (reversible, for live streams) is phase 2 — the replay
surface (provider payload rebuilds) is harness-side.

**Implementation.** Redactor is pure with the stats return above; unit-tested
against a fixture transcript containing canary values. No network or settings
read at match time. Settings namespace `cc-secrets` registered via
`registerNamespaceSafe` (`@dsh-cc/settings-ns`, precedent
`cc-context-compression` in `packages/context/context-crusher/src/settings.ts:14`)
with schema `{ extraPatterns: z.array(z.string()).default([]), redactCrusherStore: z.boolean().default(true) }`.
`extraPatterns` are caller-supplied regex SOURCE strings, compiled once at
first use, invalid patterns logged-and-skipped (never thrown at redact time);
`redactCrusherStore` toggles only the crusher application point (export stays
always-on).

**Known gap, recorded:** on web profiles a NATIVE CC `/export` takes
precedence (`packages/session/command-export/src/index.ts:120-133` mount-order
dance) and BYPASSES this redaction — out of scope for this batch.

**Verification.** Specs: canary redaction in export output and in the crusher
store (this spec is the manifest canary, see manifest note); no redaction of
lookalike non-secrets below the character floors. Manifest: `commands.export`
(`docs/claude-code-capabilities.yaml:1738`) becomes behavioral: divergent with
`deviation: { kind: divergent, summary: 'always-on secret redaction of
exported transcripts (dsh-cc extension; CC exports verbatim)' }` per the
I3/I4/I7 validator rules, plus a test-evidence row pointing at the canary spec
(the spec must exist or `pnpm check:capabilities` fails), then
`pnpm check:capabilities` + `pnpm docs:parity`. `commands.resume`'s evidence
row gains the C1 sidecar spec path (dimensions unchanged).

## C3. Non-bypassable critical-bash denylist

**Problem.** permission-rules curate catastrophic patterns
(`packages/interaction/permission-rules/src/classifier.ts:33`,
`DEFAULT_DANGEROUS_PATTERNS`), and — contrary to what this doc previously
claimed — the classifier's HIGH tier ALREADY hard-denies in every mode,
including bypassPermissions (`decide.ts:124-130`:
`blocked by risk classifier: …` before the waterfall). So `rm -rf /` is
already denied under yolo today. The real gaps C3 closes: (1) the classifier
stage can be switched off entirely by config (`classifierEnabled: false`,
`settings-schema.ts:173`); (2) settings `dangerousPatterns` REPLACES the
curated table rather than extending it (`settings-schema.ts:139`; the
replace-not-merge comment lives at `classifier.ts:92`), so a misconfigured
user silently loses `rm -rf /`; (3) the `ctx.tools.guard` monotonic-guard
layer is authoritative before any sandbox/mode short-circuit
(`index.ts:376-385`; bypass-immune rules are evaluated first in
`foldDecision`, `evaluate.ts:89-95`, before the `bypassPermissions`
short-circuit at :104). oh-my-pi's approval model is the inspiration but NOT
the target: omp's critical tier alone does NOT deny under yolo — an explicit
tool/user `prompt` or `deny` policy still is what fires
(`oh-my-pi/docs/approval-mode.md:64`). Our design goal goes beyond omp: these
denies survive every mode, classifier toggle, and settings replacement.

**Design.** No new `critical` tier is invented: curated patterns are mounted
as bypassImmune deny rules through the existing machinery. DSL reality: rule
strings go through `parseRuleString` → `contentMatches` (`parser.ts:166`),
whose `ContentMatcher` (`types.ts:93-96`) has only wildcard/prefix/domain
kinds — no regex — so mounting regex patterns needs a small extension:
extend `ContentMatcher` with `{ kind: 'regex'; source: string }` and add a
branch in `contentMatches` (`parser.ts:166`) running the regex with a cached
compiled map (precedent: the `classifier.ts` regex table). Curated entries
live as a new exported `CRITICAL_BASH_PATTERNS: readonly DangerousPattern[]`
in `classifier.ts` next to `DEFAULT_DANGEROUS_PATTERNS`, mounted in the
`PermissionRulesService` constructor (`index.ts:221`) by constructing
`PermissionRule` objects directly (toolName `Bash`, a NEW source label
`curated` appended LAST in `SOURCE_PRIORITY` in `types.ts` — it only labels
the deny reason; all bypassImmune rules deny unconditionally, so ordering
among them is cosmetic) and appended to
`this.bypassImmuneRules`, so they flow through both `configRuleSet()`
(`index.ts:365-374`) and `registerGuards()` (`index.ts:376-385`). The deny
reason reuses the guard-layer string shape verbatim:
`denied by permission rule ${ruleString(rule.toolName, rule.content)} [curated] (bypass-immune)`.

**Initial list, exact, two patterns** (precision over recall — these denies
can never be bypassed, so false-positive avoidance beats coverage):

1. `/\brm\s+-[a-z]*[rf][a-z]*\s+(?:\/(?:\s|$)|~(?:\s|$|\/))/` — copied
   verbatim from `classifier.ts:34` (verified present).
2. Fork-bomb define-form: `/\(\s*\)\s*\{[^{}]*\|[^{}]*&[^{}]*\}/` — matches
   `:(){ :|:& };:` and `f(){ f|f& };f`. Generic `while … & done` loops are
   NOT denied: they are legitimate.

sudo and `curl | sh` are NOT reclassified, keeping bypass useful. Sandbox
interplay: a critical-deny gates the pre-execute tool call regardless of any
`danger-full-access` sandbox grant (bypass-immune is first in `foldDecision`
and enforced by the guard layer), and the spec matrix covers that combination.
CC parity: CC has no such tier, so this is a deliberate deviation recorded in
the manifest (`permissions.rules` entry), not parity drift by accident.

**Implementation.** `CRITICAL_BASH_PATTERNS` entries ALSO stay in the
classifier table — double-deny is harmless and the guard fires first.
Settings: add `criticalDeny: z.array(z.string()).default([])` to
`permissionSettingsSchema()` (precedent `dangerousPatterns` at
`settings-schema.ts:139` — raw regex sources), APPEND-ONLY: merged AFTER
`CRITICAL_BASH_PATTERNS`, never replacing (the opposite of
`dangerousPatterns`' replace semantics). A speculative-invalid regex in
settings is skipped with a debug log, never thrown.

**Verification.** Spec matrix: patterns × modes (`default`, `acceptEdits`,
`auto`, `plan`, `bypass`) × sandbox grants (including `danger-full-access`) →
deny with the guard-layer reason; non-critical dangerous patterns keep current
behavior; `classifierEnabled: false` and a settings `dangerousPatterns` array
that omits both patterns still deny. Dogfood: try the fork-bomb canary in a
bypass-mode session, capture the denial.

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
shadowing it from the preset would break the capability contract. Nothing
lands in dsh-cc for C4 in this batch/PR: the deliverable is the upstream
proposal, whose link will be recorded in this doc once filed. No manifest
change.

**Verification (against the upstream PR, when written).** Specs for the
invariant transitions and the repair table.

## C5. `/commit-split`: atomic-commit split advisor

**Problem.** Large mixed diffs become one messy commit. oh-my-pi's
`omp commit` reads the working tree (overview → file diff → hunk), splits
unrelated changes into atomic commits ordered by dependency, rejects cycles,
excludes lockfiles, and ranks source files above tests/docs
(README feature 16; `oh-my-pi/README.md:225-227`; verified 2026-09-23).

**Design.** New command package `packages/interaction/command-commit-split`
(`@dsh-cc/command-commit-split`), advisory and **dry-run-only**: it emits an
ordered split plan and never commits; the user (or model, explicitly asked)
executes proposals one by one. Full registration checklist (verified against
command-skills, PR #137 — the newest example):

1. Package dir `packages/interaction/command-commit-split/` with
   `package.json` (name `@dsh-cc/command-commit-split`, deps incl.
   `@dsh-cc/command-usage: workspace:^`), `src/index.ts` exporting
   `export const name` + `export const inject = ['commands', ...]`, `tests/`,
   `tsconfig.json`.
2. Project ref added to `tsconfig.packages.json`.
3. Preset row in `packages/preset/cc/agent.cordis.yml` (`- id:
   command-commit-split` / `name: '@dsh-cc/command-commit-split'`; the skills
   row sits at :728 for shape) AND dependency in
   `packages/preset/cc/package.json`.
4. Command registration: `ctx.commands.register(helpable({ ... }))` using
   `helpable()` from `@dsh-cc/command-usage` (command-skills/src/index.ts:30
   precedent).
5. Capability manifest row `commands.commit-split` in
   `docs/claude-code-capabilities.yaml` (template: the `commands.skills` row).
6. README trio (`README.md`, `README.zh.md`, `README.i18n.yaml`) +
   `pnpm check:readme --write`; then `pnpm check:capabilities`,
   `pnpm check:parity` / `pnpm docs:parity`, `pnpm check:spec-deps`,
   `pnpm check:size`.

**Model call.** Via `runSideQuery(ctx, { agent, alias: 'blueprint', … })`
(`packages/llm-tuning/side-query/src/index.ts:72` — 'blueprint' is the
deep-reasoning lane alias). On `inheritedRoute === true` (no lane configured),
print the visible note `note: alias "blueprint" unconfigured; split run on
the main model route` and proceed with the returned text. `resolveAlias` /
`'slow'` are NOT used — 'slow' is not a dsh-cc builtin alias. Splitting is
not cost-sensitive, so the inherited fallback is always acceptable.

**Git data.** Collected through `ctx.get('shell')`'s `run` (preferred) /
`exec` method with a 5s timeout — exactly the structural seam of
`packages/interaction/command-doctor/src/checks/git.ts:93-113`:
`git status --porcelain`, `git diff --cached --numstat`, `git diff --numstat`.
The handler NEVER runs the model's Bash tool and must not import
`node:child_process`. All git reads complete BEFORE `runSideQuery` is awaited,
never interleaved.

**Plan output format (pinned).** The model returns, and the command renders,
an ordered list of groups, each `{ message, files: string[], dependencyEdges:
string[] }` — one-line commit message ≤ 72 chars, files as a unified
staged+unstaged path list, edges as `A → B` pairs. Wire format: the prompt
requests STRICT JSON (an array of `{ message, files, dependencyEdges }`);
non-conforming output renders `error: model output did not match the plan
schema` and no plan is emitted. Cycle detection runs in the command (a
topological check over the returned edges), not in the model; cycles are
printed as an error section (`error: dependency cycle among groups: a → b →
a`) and no plan is emitted.

**Dependency heuristic (pinned).** Two signals: shared top-level directory
plus textual import-reference overlap between changed files (regex
`from|import\(...` / `require(...)` over the changed TS/JS files, resolved
relative-first; an edge A→B exists iff A imports changed file B). Ranking:
source > test > docs. Lockfiles (`pnpm-lock.yaml`, `package-lock.json`,
`yarn.lock`, `bun.lockb`) are always excluded from model groups into their own
trailing `chore(deps)` group if present alone. The heuristic is declared as
such in the output footer.

**Verification.** Specs in
`packages/interaction/command-commit-split/tests/` under the root vitest run;
fixture = a temp dir created in-spec (`fs.mkdtemp`) with `git init` +
interleaved commits. Expectations pinned: two interleaved topics → plan
separates them, dependency-first ordering, source ranked above test above docs
as a fixture expectation; lockfile-only change → single `chore(deps)` group;
cyclic fixture → clean error section. Dry-run invariant pinned by a spec that
injects a recording fake shell into the collector seam (the collector takes
`run: (cmd, opts) => Promise<{ stdout }>` as a parameter, mirroring
command-doctor's seam, so the spec asserts every recorded command is a
`git status|diff` read — zero `git commit` invocations).

## C6. Ctrl+P alias cycling

**Problem.** Switching models mid-session means typing `/model`. oh-my-pi
cycles the active role's configured list with Ctrl+P / Shift+Ctrl+P
(`oh-my-pi/packages/tui/src/prompt/custom-editor.ts:59-60`; verified
2026-09-23).

**Design.** dsh-cc's analog of "configured models" is the alias table plus a
new setting `cc-model-cycling.cycleOrder: [alias…]`. There is no
`model-catalog.ts` file — the catalog seam is `loadCatalog()` (`packages/ui/tui/src/harness/driver-agent.ts:378`,
exposed on the driver ctx at `driver-ctx.ts:324`). The input seam:
`handleComposerInput` (`packages/ui/tui/src/input.ts:419`) consumes keys
BEFORE the editor via the `InputSink` interface (input.ts:13-56) — new keys
are added as `matchesKey` branches there, exactly like the ctrl+t/ctrl+o
handlers at input.ts:471-486. New module `packages/ui/tui/src/model-cycling.ts`
(≤500 lines) holds the pure cycle function + the InputSink methods; the
input.ts branch calls the driver methods.

**Resolution and application.** Each `cycleOrder` entry is an alias resolved
through the existing model-aliases resolver (`packages/compat/cc-model-aliases`);
a resolved route is advertised iff `loadCatalog()` contains an entry with
matching `provider` + `id` (called per keypress — the handler may await). A
cycle step landing on an unresolvable or unadvertised alias is skipped with
the status toast and never bricks the next request. Application goes through
`applyModelSwitch(provider, model)` (`packages/ui/tui/src/harness/driver-pickers.ts:98`,
exposed on ctx at `driver-ctx.ts:320`), which changes ONLY the in-memory
`selection.current` — no settings persist, by design (the queue snapshots
`selection.current` at prompt assembly, so the switch takes effect on the
next turn). The status row toast idiom is the existing
`"Model is now X/Y."` (`driver-pickers.ts:103,112`); no other toast API
exists.

**Settings.** Namespace `cc-model-cycling` registered via
`registerNamespaceSafe` (`@dsh-cc/settings-ns`) with
`{ cycleOrder: z.array(z.string()).default([]) }`. Read LIVE per keypress,
never cached at boot (the `cc-model-aliases` service re-reads per call;
hot reload rides the settings-cascade republish for free — the PR #127
pattern).

**Binding rules.** Ctrl+P = forward, Shift+Ctrl+P = backward. Start index:
if `selection.current` matches an entry in `cycleOrder`, start at that index;
otherwise start at index −1, so the first forward step lands on element 0 —
one rule, no special cases. Empty `cycleOrder` → the handler is not
installed and the key falls through to the editor default unchanged (note:
no ctrl+p binding exists in the TUI today — checked `root.ts`, `input.ts`,
components — so no conflict baseline). 500-line file cap honored by the new
module (statusline PR #124 discipline). Manifest impact: the `commands.model`
row (currently mounted:false / behaviorally divergent) gets its ux dimension
re-evaluated when this ships.

**Verification.** Unit-level: key-event → apply-call sequence with a fake
model seam (including skip-with-toast on an unadvertised alias and the
index −1 → element 0 start rule); dogfood: bind, cycle twice, confirm status
line + next request headers show the rotated route.

## C7. Foreign rules/context import beyond Cursor dialect

**Problem.** Our rules ingestion covers Cursor `.mdc`; claude-md `@import`
expansion is already recorded missing
(`docs/claude-code-capabilities.yaml`, row `memory.claude-md-imports`,
recognized:false / downgrade). Meanwhile other tools' rule files on disk are
invisible to us; oh-my-pi harvests all of them at priorities below native
(`oh-my-pi/packages/coding-agent/src/discovery/{cline,windsurf,github}.ts`;
verified 2026-09-23). Note: the Cursor `.mdc` precedent
(`packages/compat/cc-plugin-loader/src/rules.ts`) discovers only under a
plugin root and has no ignore-list precedent — it gives the render/budget
patterns, not a discovery pattern.

**Design (split in two).**
*Foreign-format ingestion (dsh-cc-actionable):* a NEW system-prompt section
`cc:foreign-rules` on the existing rules seam — not riding
`mergePluginRules` (the seam is plugin-name keyed; there is no foreign-file
contribution path). Register it beside the existing section registration at
`packages/bundle/cc-shell/src/index.ts:148`
(`systemPrompt.section({ name: 'cc:foreign-rules', order: 107, text })`),
i.e. order 107, immediately after `cc:plugin-rules` (order 106). Providers
and globs, exactly 3 providers / 5 globs:

- cline → `.clinerules`
- windsurf → `.windsurfrules`, `.windsurf/rules/*.md`
- copilot → `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`

Discovery roots: the session cwd only — no parent walk, no symlink traversal.
Caps: per-file 4000 chars (truncate + `... (truncated)` tail, the
`RULES_BUDGET_CAP_CHARS` idiom from `rulesSeam.ts:44`, plus a one-time
`logger.warn`), per-provider 8 files, total section 12000 chars. Ignore rule:
`node_modules` and vendored directories are never matched — the repo has no
discovery ignore helper to reuse, so the literal ignore list is
`['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage']`. Opt-out:
settings namespace `cc-foreign-rules` via `registerNamespaceSafe` with
`{ disabled: z.array(z.enum(['cline','windsurf','copilot'])).default([]) }`
(the `disabledProviders` name is retired — it has no precedent in this repo).
Render format: one block per provider, header line
`## <provider> rules (<path relative to cwd>)` followed by the verbatim body,
no format conversion. The section renders after the cursor-rules section
(`cc:plugin-rules`, order 106); position relative to the harness-injected
CLAUDE.md/AGENTS.md baseline is best-effort and documented, not pinned by
spec. Discovery is lazy-once per agent spawn (inside the section's `text()`
callback, memoized per spawn, no file watcher); subagent children strip only
harness `agent-instructions` content, not this section.
*claude-md `@import` expansion:* stays upstream-owned (harness
`agent-instructions` plugin, per `packages/subagent/task/src/strip-instructions.ts:2-3,28-29`)
and remains a manifest deviation only (`memory.claude-md-imports`).

**Implementation.** The discovery module is
`packages/bundle/cc-shell/src/foreign-rules.ts` (one module: discovery +
render glue), registering the new section beside `cc-shell/src/index.ts:148`;
unknown formats stay inert.
Silent-discovery noise rule: one consolidated `ctx.logger.debug` line listing
what was picked up, nothing in-context unless content exists.

**Verification.** Fixture workspace containing all five globs' files → system
prompt snapshot spec shows each block once, honors per-file/provider/total
caps, respects `cc-foreign-rules.disabled`; foreign section renders after the
cursor-rules section. Manifest: `memory.claude-md-imports` keeps its own
entry; the new section's evidence lands with its own row when shipped.

## Cross-cutting DoD for the batch

1. ONE batched PR with one commit per item (C1/C2/C3/C5/C6/C7; C4 is
   doc-only). Rationale: every item edits `docs/claude-code-capabilities.yaml`
   and the generated parity docs, so separate PRs would conflict on the same
   generated files and yaml rows; per-item commits preserve revertability.
   Every landed item carries the specs named in its section.
2. Every item touching the CC-compatible surface updates the capability
   manifest in its own commit per the I3/I4/I7 validator rules. Exact local
   gates, all from repo root: `pnpm typecheck`; targeted root vitest runs
   `pnpm vitest run <paths>` (NEVER `pnpm -F <pkg> test` — it is a no-op in
   this repo); `pnpm docs:parity`; `pnpm check:capabilities`;
   `pnpm check:parity`; `pnpm check:readme --write` when a README is touched;
   `pnpm check:spec-deps`; `pnpm check:size`.
3. New-package wiring (project ref in `tsconfig.packages.json`, pnpm-workspace
   glob if needed, preset row in `packages/preset/cc/agent.cordis.yml` +
   `packages/preset/cc/package.json` dep) applies to
   `packages/interaction/transcript-secrets` (C2) and
   `packages/interaction/command-commit-split` (C5).
4. 500-line file cap (`pnpm check:size`, `scripts/check-file-size.mjs`):
   any new file over the cap extracts a module rather than ratcheting
   `scripts/check-file-size.baseline.json`.
5. C4 lands nothing in dsh-cc in this batch; the upstream proposal link will
   be recorded in this doc once filed. No manifest change.
