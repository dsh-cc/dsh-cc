# Skill lifecycle: usage telemetry + demote-candidate reporting (design)

- Date: 2026-10-09
- Status: draft v3 — internal critic GO after 3 rounds (final minors folded: package-name correction + worktree-aware slash-seam keying); user sign-off pending. NOT yet implemented.
- Scope: new package `packages/skill/skill-usage` (name tentative: `@dsh-cc/skill-usage`); capability manifest row; preset registration. Read-only observation + derived rollup file. Content-audit of skill/memory *writes* is deliberately a different design (D8, persistent-write auditing); held-out admission scoring is a follow-up (§7).
- Sources: Dynamic Agent Skills Survey (eight-stage lifecycle acquisition→governance — dsh-cc today covers acquisition and loading, nothing after), SkillOpt/SkillAxe (bounded edits + held-out gates), Progressive Crystallization (promote/demote, never freeze), SHarP (pruning 24/27 harness modules made the agent *better* — unused surface has negative value), SkillCorpus boundary finding (skill gains are harness-conditioned: vendor numbers never transfer; measure on dsh-cc's own traffic).

## 1. Problem

dsh-cc's skill pipeline ends at loading. Once a skill exists — learned,
managed, marketplace — nothing answers: is it ever loaded? does loading it help?
should it be demoted? The catalog accretes: every learned skill sits in
`LEARNED_RANK = 500` (`packages/skill/skill-claude-code/src/discovery.ts:63-67`)
forever, competing for the model's attention in every available-skills block.
SHarP's result is directly on point: harness surface you never use still costs
attention, and removing it *improved* success rate. The lifecycle survey's
verdict is that the missing stages are exactly usage measurement, utility
evaluation, and governance (promotion/demotion).

Probe-verified facts (2026-10-09, this worktree):

- Skill loads are observable, but only generically: there is **no** skill-load
  event (probe: ABSENT — harness `packages/skill/tool-skill/src/index.ts:81-161`
  `execute` emits nothing; note: that path is harness-upstream, anchored here as
  report of absence, not as a line-level citation in this worktree). What IS
  visible in-process: the `skill` tool call itself flows through the
  `tools/post-execute` waterfall like any other call (payload shape:
  `packages/core/tools/src/tool-types.ts:119-144`), with `exec.name === 'skill'`
  and `exec.arguments.name` carrying the skill name.
- Slash-form invocations (`/name`): **UNVERIFIABLE upstream claim** — the
  assertion that the harness injects a `user/message` with
  `source: { kind: 'skill-invocation', … }` has no in-repo occurrence, and the
  contrary evidence is in-repo: the TUI sends an unknown `/name` as an ordinary
  user prompt with `source: { kind: 'user' }`
  (`packages/ui/tui/tests/driver-skill-slash.spec.ts:11,131`), riding tool-skill's
  injected pre-step gesture boundary. The slash listener below is therefore
  spec'd against a live-capture precondition (§5 step 0), not against the
  upstream claim.
- Skill management chokepoint: `manage_skill`'s `execute`
  (`packages/core/tool-manage-skill/src/index.ts:119`) →
  `LearnedSkillStore.create/update/delete`
  (`packages/skill/skill-claude-code/src/learned-store.ts:126/169/215`), with the
  name grammar (`:25,28`) and 64_000-byte cap (`:22`) enforced inside the store.
- Learned-skill churn already emits `skills/learned-changed`
  (`packages/core/tool-manage-skill/src/index.ts:83`) → catalog invalidation
  (`packages/skill/skill-claude-code/src/index.ts:148`).
- Side-query lane for cheap offline-ish scoring exists:
  `runSideQuery` (`packages/llm-tuning/side-query/src/index.ts:80`, default
  alias `'haiku'` :69).

## 2. Goals and non-goals

Goals:

1. **U1 — load telemetry.** Every skill load (tool form and slash form) is
   counted: one append-only JSONL row per load, plus a typed session event.
2. **U2 — utility rollup.** A derived, regenerable per-workspace report
   (`<dshHome>/skills/utility-<projectKey>.md`) answering: per skill — loads,
   distinct sessions, last-loaded-at, never-loaded learned skills with age, and
   a demote-candidate list (rule in §3.4).
3. **U3 — transcript anchoring.** Load events ride the transcript so
   session-forensics/dogfood can correlate skill usage with outcomes later
   (the DoD-grade utility scoring is §7; this change ships the substrate).

Non-goals:

- **No automatic demotion/deletion in v1.** Progressive Crystallization says
  demote-not-freeze; operational caution says the first version reports, the
  human demotes. Auto-demotion requires the dogfood evidence collected here.
- **No held-out admission scoring** (SkillOpt-style) — needs the eval harness,
  follow-up §7.
- **No edits to the upstream skill registry or `tool-skill`** (read-only).
- **No content audit** of skill files (D8 owns the write-side chokepoints).

## 3. Design

### 3.1 Package and registration

`packages/skill/skill-usage` (`@dsh-cc/skill-usage`), plain cordis plugin that
declares `export const inject = ['skills']` — cordis throws
"cannot get property 'skills' without inject" at resolve time otherwise
(trap precedent: `packages/interaction/advisor-watchdog/src/index.ts:63-70`,
`export const inject = ['llm']`).
preset row (`packages/preset/cc/agent.cordis.yml` cc-services group) +
capability manifest `engine.*` row (with preset anchored evidence per validator
rule I4) + README trio, same commit; composition pin
(`packages/preset/cc/tests/composition.spec.ts`) bumped deliberately; regenerate
parity docs via `pnpm docs:parity`.

### 3.2 U1 — load telemetry

Listener: `ctx.on('tools/post-execute', …)` (default priority; observe-only —
returns the decision untouched, errors caught + debug-logged).

Match: `exec.name === 'skill'` AND `result.isError === false`. Read
`exec.arguments.name` (typed `unknown` → narrowed to string).
**Upstream-unverified:** the exact shape of `exec.arguments.name` on the real
payload is unverified upstream; the §5 fixture (step 4) pins it from a real
captured payload, and the listener counts + debug-logs rows where
`exec.name === 'skill'` matches but the argument is absent (never crashes, never
writes a skill-less row).

Per load:
1. Append row to `<dshHome>/skills/loads-<projectKey>.jsonl`:
   `{ v:1, ts, sessionId, skill, via:'tool' }` — awaited-then-detached write
   (`void appendFile().catch(debugLog)`; never throws into the waterfall).
   If `ctx.dshHomePath` is undefined (providerless host / bare tests), the
   telemetry write is a **complete no-op**, debug-logged — mirror of
   `dshHomeFn` (`packages/subagent/handoff-store/src/index.ts:57`).
   `projectKey` reuses the exported `cwdProjectKey(agent)` from
   `@dsh-cc/handoff-store` (definition
   `packages/subagent/handoff-store/src/tools.ts:44`, re-export
   `index.ts:41`), passing `exec.agent`.
2. If `exec.agent?.session` reachable, append session event
   `'skill-usage/loaded'` with the same row (SessionEventMap module
   augmentation pattern: `packages/hooks/hook-protocol/src/types.ts:8-9`).

Slash form: a second listener on `session/event` records `{ …, via:'slash' }`
rows (same ledger and event type) — but only after the §5 step-0 live capture
lands, pinning the actual `source.kind` of a real `/skill-name` invocation
(or discovering slash-form rides tool-skill's injected pre-step message, in
which case the listener matches THAT message's source kind instead). The
implementation may not start the slash listener until that capture lands.
The `session/event` payload carries no agent handle, so for the slash form the
key MUST reproduce `getSessionCwd`'s resolution order
(`packages/workspace/session-cwd/src/api.ts:31-37`) without the Agent:
`projectKeyOf(store.resolve(session.id, session.snapshotEvents()) ??
session.header.cwd ?? process.cwd())` — reuse the exported store/`projectKeyOf`
from `@dsh-cc/session-cwd` rather than re-deriving. This matters because a
session that entered a worktree (`worktree/entered` event) keys on the worktree
cwd while `session.header.cwd` stays at the creation cwd; a raw
`sha256(session.header.cwd)[:16]` would silently split one session's rows across
two ledgers/reports. (Worktree-mismatch caught by critic round 3.)
Dogfood gate: after one week, `via:'slash'` rows must be nonzero, or the slash
half is reported dead and removed.

### 3.3 U2 — utility rollup

Trigger: recomputed at session start (the `session/created` seam — precedent
`packages/interaction/permission-rules/src/index.ts:294`) **only if** the report
is stale (older than 24h or ledger mtime newer than report mtime); cost is one
JSONL scan of a local file; failures are swallowed. If `ctx.dshHomePath` is
undefined (providerless host / bare tests), the rollup is a **complete no-op**,
debug-logged (same `dshHomeFn` mirror as §3.2,
`packages/subagent/handoff-store/src/index.ts:57`). Staleness semantics: a
`stat` ENOENT on the report (first run, or file cleaned up) is treated as
stale — the rollup computes. Accepted limitation, stated: a single session
running longer than 24h never triggers a recompute (the seam only fires at
session start).

Report shape (`<dshHome>/skills/utility-<projectKey>.md`):

```markdown
# Skill utility report — <projectKey> — generated <ts>
## By loads (30d / all-time)
- <skill>: 12 / 41 loads, 6 sessions, last 2026-10-08
## Never loaded (learned skills, age > 7d)
- <skill>: created 2026-09-30, 0 loads  ← demote candidate
## Demote candidates (rule: learned rank, 0 loads in 30d, age > 14d, observation window ≥ 30d)
- …
## Insufficient observation window (excluded from demote list)
- …
```

"Learned" classification comes from the catalog: learned skills live at
`LEARNED_RANK = 500` (discovery.ts:67). With `inject = ['skills']` declared
(§3.1), `ctx.skills` is **guaranteed** at load (or the plugin fails to mount) —
there is no "if reachable" case in production. The learned-store-directory
fallback (`learnedSkillPath(dshHome, name)`,
`packages/skill/skill-claude-code/src/learned-store.ts:73`; dshHome resolved
through the `ctx.dshHomePath` seam, same defensive read pattern as
`packages/subagent/handoff-store/src/index.ts:46-58`) exists **for unit tests
only** (bare testkit contexts without a mounted catalog). The report header
states the classification source used.

### 3.4 Demote-candidate rule (report-only)

A skill is listed as a demote candidate iff all hold: learned-rank; zero loads
in the trailing 30 days; age > 14 days; **and the observation-window guard —
min(ledger earliest timestamp, skill created timestamp) < now − 30d**. If the
guard fails, the skill appears under a separate report section,
"insufficient observation window", not in the demote list. The report states
the rule verbatim and
says **demotion is manual** (`manage_skill` delete or edit) — v1 takes no
action. This is the honest version of Progressive Crystallization: we implement
the *measurement* that makes demote decisions evidence-backed.

### 3.5 Configuration

Kebab namespace, `registerNamespaceSafe` family (precedent
`packages/interaction/advisor-watchdog/src/settings.ts:6`):

- `skill-usage.enabled` — default `true` (append-only local telemetry; no
  behavior effect).
- `skill-usage.rollup-stale-hours` — default `24`.
- `skill-usage.never-loaded-days` — default `30`.

### 3.6 Failure discipline

Observe-only at both seams; all errors swallow + debug log; a corrupt ledger
line-step skips that line (handoff-store reader tolerance precedent). The rollup
never edits catalog or stores.

## 4. Edge cases

- Skills loaded before this package ships: absent from the ledger — the report
  is honest by construction (it reports measurements from its install date; a
  header line states the observation window start).
- `skill` tool renamed/aliased upstream (CC-parity name): the match is on the
  canonical internal name observed at post-execute (`exec.name`), which is the
  runtime tool id — if upstream renames it, telemetry silently stops; mitigated
  by §5 test 4 (rollup over a synthetic stream asserts nonzero match rate
  against a fixture built from the real tool name today) plus the dogfood
  observable "loads rows exist at all".
- Slash invocations of non-skill slash commands do not match (source-kind gate).
- Possible double-count: one invocation may produce both a slash-form and a
  tool-form row; dogfood checks the 1:1 correlation, and rows are deduped by
  `(sessionId, skill, ts±2s)` only if the double-count is actually observed.
- `manage_skill` calls flow through `tools/post-execute` but never match
  `exec.name === 'skill'` — no false ledger rows.

## 5. Verification plan

0. **Live-capture precondition (blocks the slash listener):** dump the real
   session/event shapes of one live `/skill-name` invocation; pin the actual
   source kind (or discover slash-form rides tool-skill's injected pre-step
   message — then match THAT message's source kind/test instead). The
   implementation may not start the slash listener until this capture lands.
1. Unit: ledger row shapes for both via-forms; unreadable ledger dir ⇒ no throw.
2. Unit: rollup generation — synthetic ledger + fake catalog → expected report;
   staleness gating (fresh report skips recompute; stat ENOENT ⇒ computes).
3. Integration (testkit): session with a synthetic `skill` tool call ⇒ exactly
   one `skill-usage/loaded` event + one ledger row; the synthetic slash-form
   test is **explicitly conditional on §5 step-0's pinned live shape** (it is
   skipped/withdrawn if the capture contradicts the assumed source kind).
4. Guard: fixture built from a **real captured payload** asserting BOTH
   `exec.name === 'skill'` AND `typeof exec.arguments.name === 'string'`
   (documents the upstream-renames and arg-shape failure modes).
5. Gates: capabilities manifest + `pnpm docs:parity`, README trio,
   `check:file-size`, composition pin, `check-spec-deps` if tests import harness
   packages (declare in devDependencies; CI gate precedent).

Dogfood: after one week, the utility report exists and its demote list is
reviewable by the user in one minute (config-is-prompt expectation:
`skill-usage` produces the report file; verified by opening it).

## 6. Falsification / why this is the right first increment

The lifecycle literature's strongest warnings are about *unmeasured* governance
(SkillCorpus: gains don't transfer across harnesses; SHarP: unused surface is
negative-value). Any admission-scoring or auto-demotion built without per-harness
usage data inherits the 12227 confound. This change is the measurement substrate
and deliberately nothing more; §7 items gate on its data.

## 7. Follow-ups

1. Held-out admission gate for learned skills (SkillOpt shape: bounded edit →
   held-out task pass-rate delta → accept/reject, rejection kept as negative
   memory), reusing `packages/memory/memory/eval/lib.ts`'s golden-query scorer
   shape and `runSideQuery` for cheap grading.
2. Outcome correlation: join `skill-usage/loaded` with task outcomes (needs the
   D1/D3 substrates to be meaningful).
3. Auto-demotion with the A11 credit discipline once the report has dogfood
   weeks behind it.
4. Cross-harness portability lint for marketplace skills (SkillCorpus warning),
   folded into D8's content audit when both are live.

## 8. Review ledger

Round 1 — internal critic, 2026-10-09 — verdict: GO-WITH-AMENDMENTS
(7 findings, all adopted).

1. **F1 — slash-form seam unverifiable.** The `source.kind === 'skill-invocation'`
   claim has no in-repo occurrence; contrary evidence
   `packages/ui/tui/tests/driver-skill-slash.spec.ts:11,131` (`kind: 'user'`).
   Adopted: §1 bullet reclassified UNVERIFIABLE; §3.2 slash listener gated on
   §5 step-0 live capture; §3.2 one-week `via:'slash'` dogfood gate.
2. **F2 — arg key unverified.** Adopted: §3.2 states `exec.arguments.name` is
   upstream-unverified; §5 step 4 fixture asserts both `exec.name === 'skill'`
   and `typeof arguments.name === 'string'` from a real captured payload;
   listener counts + debug-logs name-match/arg-absent rows.
3. **F3 — demote-rule honesty.** Adopted: §3.4 observation-window guard
   (min(ledger earliest ts, skill created ts) < now − 30d), separate
   "insufficient observation window" report section (§3.3).
4. **F4 — cordis inject trap + dshHome helper.** Adopted: §3.1 declares
   `export const inject = ['skills']` (advisor-watchdog precedent); §3.3 dshHome
   via `ctx.dshHomePath` seam (handoff-store pattern) with
   `learnedSkillPath` (learned-store.ts:73) as the directory-path helper.
5. **F5 — staleness semantics.** Adopted: §3.3 stat ENOENT on first run =
   stale (compute); >24h single-session runs never recompute — accepted, stated.
6. **F6 — double-count risk.** Adopted: §4 line — dedupe by
   `(sessionId, skill, ts±2s)` only if observed; dogfood checks 1:1 correlation.
7. **F7 — manage_skill noise.** Adopted: §4 line — no false rows.

Upstream-unverifiable items recorded: (a) `skill-invocation` source kind (F1);
(b) the shape of `exec.arguments.name` on the real post-execute payload (F2).
Both are pinned by §5 step 0 / step 4 live-capture fixtures instead of assertion.

Round 2 — internal critic delta, 2026-10-09 — verdict: GO-WITH-AMENDMENTS
(3 minors, all adopted):

1. **§3.1/§3.3 `ctx.skills` guarantee.** With `inject = ['skills']` declared,
   `ctx.skills` is guaranteed at load (or the plugin fails to mount); the
   "if reachable" language is deleted; the learned-store-directory fallback is
   unit-tests-only, and the report header states the classification source.
2. **§3.2/§3.3 dshHome absence.** Undefined `ctx.dshHomePath` (providerless
   host / bare tests) makes telemetry and rollup complete no-ops, debug-logged
   (mirror of `dshHomeFn`, handoff-store index.ts:57).
3. **§3.2 project key.** Reuse exported `cwdProjectKey(agent)` from
   `@dsh-cc/handoff-store` (tools.ts:44, re-export index.ts:41) for
   the tool-form listener; the slash-form `session/event` listener computes
   the same convention directly as `sha256(session.header.cwd)[:16]` (no agent
   in the payload; session headers carry cwd). §5's synthetic slash-form test
   is marked conditional on step-0's pinned live shape.

### Round 3 (delta confirm) — GO-WITH-AMENDMENTS → folded

- Verdict: GO-WITH-AMENDMENTS with 2 minors (no NO-GO): package name `@dsh-cc/handoff-store`; slash-seam projectKey must reproduce getSessionCwd resolution order (worktree cwd vs header cwd split-key defect).Both folded by orchestrator edit; convergence criterion met (two consecutive rounds with only wording/wiring-level findings).
- Net status after this round: GO.
