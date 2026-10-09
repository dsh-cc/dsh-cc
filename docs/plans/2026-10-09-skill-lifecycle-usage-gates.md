# Skill lifecycle: usage telemetry + demote-candidate reporting (design)

- Date: 2026-10-09 (v6 revision: same-day delta-round fold)
- Status: draft v6 — **all three review seats have passed** (critic GO at round
  6; codex and grok GO at the round-7 micro-confirmation, §8). v3's
  internal-critic GO was overturned by a code-reconciliation review (round 4),
  rebuilt through v4→v6 across rounds 5–7. Review gate: satisfied per seat
  (round 7 was a scope-constrained fold-confirmation of six edits, not a full
  v6 re-review). **User sign-off pending.** NOT yet implemented.
- Scope: new package `packages/skill/skill-usage` (name tentative: `@dsh-cc/skill-usage`);
  one additive export in `packages/workspace/session-cwd`; one additive writer
  option in `packages/observability/sidecar-io`; capability manifest row; preset
  registration + preset dependency. **v1 telemetry is sidecar-only — nothing is
  appended to session transcripts** (§3.6). Content-audit of skill/memory
  *writes* is deliberately a different design (D8, persistent-write auditing);
  held-out admission scoring is a follow-up (§7).
- Sources: Dynamic Agent Skills Survey (eight-stage lifecycle acquisition→governance —
  dsh-cc today covers acquisition and loading, nothing after), SkillOpt/SkillAxe
  (bounded edits + held-out gates), Progressive Crystallization (promote/demote,
  never freeze), SHarP (pruning 24/27 harness modules made the agent *better* —
  unused surface has negative value), SkillCorpus boundary finding (skill gains
  are harness-conditioned: vendor numbers never transfer; measure on dsh-cc's
  own traffic).
- Anchor convention: paths prefixed `H/` refer to the upstream harness
  repository (`deepseek-harness`, read-only); unprefixed paths are in this
  repository, which vendors its own copies of some harness packages (notably
  `packages/core/tools/` — cite the vendored copy for what the new package
  imports, the `H/` copy for upstream semantics).

## 0. Decisions folded into v4/v5 (adjudicated by orchestrator from review evidence; user may veto)

| # | Decision | Rationale |
|---|---|---|
| D-A | **U3 transcript anchoring removed from v1** → §7 follow-up. v1 writes only the sidecar ledger. | Appending a custom session event poisons reopen at this pin (§3.6). The in-repo escape (mutating `KNOWN_SESSION_EVENT_TYPES` at load) couples every session's reopenability to this telemetry package staying installed and enabled-independent — unacceptable blast radius for v1 telemetry. The `sessionId` column in every ledger row preserves the later join. (Confirmed by all three round-5 seats.) |
| D-B | Slash-form and rollup projectKey via a **new session-facing export** from `@dsh-cc/session-cwd` (`getSessionCwdForSession`), returning `string \| undefined`. | The old spec quoted a `projectKeyOf` export that does not exist in that package, and its formula requires `session.snapshotEvents()`, which is `@deprecated` ("new calls are prohibited"). The new export is implemented by *extracting* the existing resolution body so the deprecated call stays at exactly one call site (§3.7). It deliberately omits the `process.cwd()` fallback so "unresolvable" stays observable (D-J). |
| D-C | Learned enumeration reads the learned directory **in production** (`LearnedSkillStore.list()` + `stat`); age = SKILL.md **mtime**. | The catalog exposes no timestamps (SkillSummary fields verified) and the store records none; mtime is the only honest source. Caveat stated: an edit resets age (semantics become "untouched for N days"). |
| D-D | Sidecar dir is `<dshHome>/skill-usage/`, **not** inside `<dshHome>/skills/`. | `<dshHome>/skills/` is the USER_RANK skill discovery root; today's scan only descends into subdirectories, but the placement would silently depend on that rule forever. House sidecar convention is per-feature dirs. |
| D-E | Ledger rows carry the skill name; **tool-form rows also carry `provider`** when the result value supplies it; the rollup joins the *current* catalog and marks shadowed learned skills "attribution uncertain". | The skill tool's result value already carries `provider` (`H/packages/skill/tool-skill/src/index.ts:148-155`) — free attribution for the tool form; the slash form's persisted source carries only `name`. Current-shadowing cannot certify *historical* ownership; the report header says so explicitly. |
| D-F | Settings follow the advisor-watchdog dual-half pattern: `registerNamespaceSafe` + raw user-layer re-read of `enabled` per matched event. | Hot-toggle without restart; the raw read only runs when `exec.name === 'skill'` already matched (rare). User-layer only — project/repo cascade is invisible to the raw read, same limitation as the watchdog, stated in §3.5. |
| D-G | Settings namespace `cc-skill-usage` (house `cc-*` convention). | Consistency with the existing namespace landscape. |
| D-H | Rollup trigger: plain `session/created` listener, staleness-gated by an **input watermark**; report written **atomic temp+rename**. | `session/created` (like `session/event` and `tools/result`) is scope-filtered — an agent-scoped plugin sees only the main CC agent's sessions (§3.1), so there is no subagent-trigger storm to absorb. The watermark replaces a bare mtime compare, which could publish a report newer than an unprocessed ledger append. |
| D-I | Ledger writes go through `@dsh-cc/sidecar-io` (`appendJsonl`), extended with **trailing-newline repair**; readers use its `readJsonl` (skips unparseable lines). | sidecar-io was extracted precisely to stop observer packages copying handoff-store primitives; tail-repair is the one missing primitive and is added there (scope line). |
| D-J | When the project key is unresolvable (agent-less execution; no cwd before the fallback), the row is **skipped, debug-logged**. | A load without a resolvable workspace key cannot be attributed to any report; counting it nowhere is the honest behavior. Paired with D-B's no-fallback resolver. |

## 1. Problem

dsh-cc's skill pipeline ends at loading. Once a skill exists — learned,
managed, marketplace — nothing answers: is it ever loaded? does loading it help?
should it be demoted? The catalog accretes: every learned skill sits at the
learned discovery rank (`LEARNED_RANK = 500`, module-private const at
`packages/skill/skill-claude-code/src/discovery.ts:67`) forever, competing for
the model's attention in every available-skills block. SHarP's result is
directly on point: harness surface you never use still costs attention, and
removing it *improved* success rate. The lifecycle survey's verdict is that the
missing stages are exactly usage measurement, utility evaluation, and
governance (promotion/demotion).

Probe-verified facts (2026-10-09, this worktree; re-verified same day against
the harness checkout; three-lane blind-review cross-checked):

- **Tool-form loads** are observable at the contained emit seam `tools/result`:
  `@mode emit`, listeners receive "a deep-frozen snapshot of the final returned
  result", failures contained (declaration: vendored
  `packages/core/tools/src/index.ts:163-167`; upstream emit implementation
  `notifyResult`, `H/packages/core/tools/src/index.ts:1695-1709`). This is the
  *final* canonical outcome: a `tools/post-execute` waterfall `block` rewrites
  a success into an error, and caller cancellation replaces a success
  afterward (`H/packages/core/tools/src/index.ts:1770-1795` and `:1649-1654`
  respectively) — matching at
  `tools/result` counts only loads that actually committed. The `skill` tool is
  named `'skill'` and its schema declares
  `name: { type: 'string', required: true }`
  (`H/packages/skill/tool-skill/src/index.ts:82-92`); its execute returns
  `{ name, provider, resourceBase?, content }` (`:148-155`). Result shape:
  discriminated union `ToolExecutionSuccess { isError: false; value } |
  ToolExecutionFailure { isError: true }` (vendored
  `packages/core/tools/src/tool-types.ts:269-293`; upstream
  `H/packages/core/tools/src/index.ts:571-593`); `exec.arguments` is typed
  `unknown` (vendored `tool-types.ts:129`; `ToolExecution` at `:185`).
- **Slash-form loads** (`/name`) are observable in-tree — v3's "UNVERIFIABLE /
  no in-repo occurrence" claim was **wrong** (round-5 codex+grok, verified):
  the upstream declares a durable `SkillInvocationSource`
  (`{ kind: 'skill-invocation', name, form: 'instructions' }` +
  `MessageSourceMap` augmentation, `H/packages/skill/skill/src/index.ts:139-158`),
  tool-skill's `agent/pre-step` listener scans direct user text for `/name`
  gesture tokens (word-boundary anywhere in the message, multiple tokens
  allowed, `H/packages/skill/tool-skill/src/index.ts:405-430`) and injects one
  instructions-form user message per validated skill (`:177-203`), and the
  agent loop persists each injected message as a `user/message` event
  (`H/packages/core/agent-loop/src/agent.ts:419-422`), published through
  `session/event`. The TUI's typed `/name` line rides an *earlier* hop as a
  plain `kind: 'user'` prompt (`packages/ui/tui/tests/driver-skill-slash.spec.ts:11,131`)
  — first hop, not contrary evidence. Tokens the command plane already consumed
  never become injections.
- There is **no** dedicated skill-load event (probe: ABSENT — tool-skill's
  `execute` emits nothing of its own); both forms are observed via the generic
  seams above.
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
- Sidecar primitives already exist in `@dsh-cc/sidecar-io`: `dshHomeFn`
  (`packages/observability/sidecar-io/src/index.ts:29`), `projectKeyOf` (`:43`),
  `appendJsonl` (`:57`, mkdir + `\n`-terminated append + swallow),
  `readJsonl` (`:71-87`, skips blank and unparseable lines).

## 2. Goals and non-goals

Goals:

1. **U1 — load telemetry (sidecar).** Every skill load that commits (tool form
   via `tools/result`, slash form via persisted `skill-invocation` messages) is
   counted: one append-only JSONL row per load in a per-workspace ledger under
   `<dshHome>/skill-usage/`. No session-transcript writes (§3.6).
2. **U2 — utility rollup.** A derived, regenerable per-workspace report
   (`<dshHome>/skill-usage/utility-<projectKey>.md`) answering: per skill —
   loads, distinct sessions, last-loaded-at, never-loaded learned skills with
   age, and a demote-candidate list (rule in §3.4).
3. ~~U3 — transcript anchoring~~ **moved to §7** (blocked on the upstream
   `ignorable` channel decision; the ledger's `sessionId` column preserves the
   join key so no information is lost by deferring).

Non-goals:

- **No automatic demotion/deletion in v1.** Progressive Crystallization says
  demote-not-freeze; operational caution says the first version reports, the
  human demotes. Auto-demotion requires the dogfood evidence collected here.
- **No held-out admission scoring** (SkillOpt-style) — needs the eval harness,
  follow-up §7.
- **No edits to the upstream skill registry or `tool-skill`** (read-only), and
  no harness-repo edits at all (harness is read-only by user directive).
- **No content audit** of skill files (D8 owns the write-side chokepoints).
- **No `session.append` of any custom event type** (§3.6).
- **No subagent-realm counting in v1** — the observation seams are
  scope-filtered to the main CC agent (§3.1); subagent coverage is §7.

## 3. Design

### 3.1 Package and registration

`packages/skill/skill-usage` (`@dsh-cc/skill-usage`), plain cordis plugin that
declares `export const inject = ['skills']` — cordis throws
"cannot get property 'skills' without inject" at resolve time otherwise
(trap precedent: `packages/interaction/advisor-watchdog/src/index.ts:63-70`).
Runtime dependencies: `@dsh-cc/sidecar-io` (ledger primitives, D-I),
`@dsh-cc/handoff-store` (`cwdProjectKey`, §3.2 — package-root re-export,
`packages/subagent/handoff-store/src/tools.ts:44`; root imports only, so
`check:deep-imports` stays clean), `@dsh-cc/session-cwd` (§3.7).

preset row (`packages/preset/cc/agent.cordis.yml` cc-services group) **plus the
accompanying `@dsh-cc/skill-usage` dependency in
`packages/preset/cc/package.json` and the lockfile update** (every cc-services
row carries one); capability manifest row under the skills category with preset
anchored evidence per validator rule I4
(`scripts/lib/capability-manifest.mjs:151,173` — check the existing
`skills.system` row before choosing the new id) + README trio, same commit;
composition pin (`packages/preset/cc/tests/composition.spec.ts`) bumped
deliberately; regenerate parity docs via `pnpm docs:parity`. The `session-cwd`
(§3.7) and `sidecar-io` (D-I) additions ship in the same PR; if the capability
manifest carries surface rows for those packages they are updated in the same
commit.

Realm note (round-5 grok, verified): `session/created`, `session/event`, and
`tools/result` are all scope-filtered dispatches — "agent-scoped listeners
receive only sessions entered through that agent's context"
(`H/packages/core/session/src/index.ts:49-50,70-71`; tools dispatch uses the
same scope target). A plugin mounted in the preset's cc-services group
therefore observes the **main CC agent realm only**. v1 embraces this:
subagent skill loads are out of scope (§7), and the previously-feared
"subagent `session/created` storm" does not exist for this mount plane.

### 3.2 U1 — load telemetry (sidecar ledger)

Ledger: `<dshHome>/skill-usage/loads-<projectKey>.jsonl`, one row per committed
load: `{ v:1, ts, sessionId, skill, via:'tool'|'slash', provider? }` with
`ts` as epoch milliseconds.

**Tool-form listener**: `ctx.on('tools/result', …)` — an `@mode emit`
observe-only seam; no waterfall participation, no decision to preserve (the
round-5 seats both flagged that a `tools/post-execute` listener must
delegate-first to avoid short-circuiting downstream plugins, and that matching
there counts loads a downstream `block` later erases; `tools/result` avoids
both classes).

Match: `exec.name === 'skill'` AND `result.isError === false` — i.e. a load is
counted when the **final canonical outcome is success** (post-waterfall,
post-cancellation; §1). Read `exec.arguments.name` (typed `unknown` → narrowed
to string; schema pins it required-string today, §1, and the §5 step-4 fixture
keeps it pinned). When `result.value` is an object with a string `provider`,
copy it onto the row (free attribution, D-E). The listener counts +
debug-logs name-match/arg-absent occurrences (never crashes, never writes a
skill-less row).

**Slash-form listener**: `ctx.on('session/event', …)` (plain registration —
slash invocations are a main-realm, user-facing form) matching persisted
injection messages:

```
event.type === 'user/message' && event.data.source?.kind === 'skill-invocation'
  → skill = event.data.source.name, via = 'slash'
```

This follows the injector exactly (§1): word-boundary gestures anywhere in the
user text, one event per validated skill, several per message when several
`/name` tokens appear (each is a real load). The listener must **not** re-parse
user text — gesture semantics live in tool-skill and command-plane collisions
never reach the log. §5 step 0 remains as an end-to-end tripwire fixture, not
an implementation gate.

Per matched load (both forms), one ledger row append:

1. `projectKey`: tool form → `cwdProjectKey(exec.agent)`
   (`@dsh-cc/handoff-store`, verified re-export), which already returns
   `undefined` for agent-less executions; slash form → resolve
   `getSessionCwdForSession(session)` (§3.7) **first**, and only when it is a
   string feed it to `projectKeyOf` (`@dsh-cc/sidecar-io`, signature
   `(cwd: string) => string` — the `undefined` guard must precede hashing).
   An unresolvable key on either form → **row skipped, debug-logged** (D-J).
2. If `dshHomeFn(ctx)` (sidecar-io) is undefined (providerless host / bare
   tests), telemetry is a **complete no-op**, debug-logged. The plugin declares
   its own `dshHomePath?` module augmentation (TS augmentations apply per
   importing package).
3. Write via `appendJsonl` with the new tail-repair option (D-I): mkdir
   recursive, repair an unterminated tail (`'\n'` prepend), then append the
   `\n`-terminated row; the call is awaited-then-detached
   (`void … .catch(debugLog)`) and never throws into the emitter.
4. **Observation-start marker** (feeds §3.4's coverage guard):
   `<dshHome>/skill-usage/observing-since-<projectKey>` containing the current
   epoch ms, create-if-absent. Creation has **two** triggers so coverage does
   not depend on loads: the ledger-write path here, and the rollup trigger
   (§3.3 — `session/created` fires per session, so a zero-load workspace still
   starts coverage at its first post-install session). Enabled semantics: when
   `enabled` reads false at the rollup trigger, no marker is created and an
   existing marker for that key is **deleted** — coverage means "wall-clock
   while telemetry was enabled", and re-enabling restarts it (conservative:
   fewer false demote candidates). The report header states this.

Keying semantics (round-5 codex, verified): the ledger keys by the *live*
session cwd (where the work happens), while tool-skill's loader lookup uses
`session.header.cwd` (`H/packages/skill/tool-skill/src/index.ts:133,186`).
After a worktree entry these can disagree about which workspace a load "belongs
to"; the design keys on the live cwd deliberately and documents the loader's
lookup-cwd divergence as an upstream observation. A rollup for a newly entered
bucket is produced when a session next starts there (accepted, stated).

Writer lifecycle, stated: detached appends are best-effort — a shutdown can
lose in-flight rows (accepted for telemetry); concurrent tail-repair across
processes can at worst yield one blank or unparseable line, which
`readJsonl` skips.

Dogfood gate: after one week, `via:'slash'` rows must be nonzero, or the slash
half is reported dead and removed.

### 3.3 U2 — utility rollup

Trigger: recomputed at session start (the `session/created` seam, plain
registration — precedent `packages/interaction/permission-rules/src/index.ts:294`;
main-realm only per §3.1) **only if** the report is stale by the input
watermark (below); failures are swallowed. If `dshHomeFn(ctx)` is undefined,
the rollup is a **complete no-op**, debug-logged. If
`cc-skill-usage.enabled` reads false, no report is written (D-F/§3.5;
existing files are left untouched). Accepted limitation, stated: a single
session running longer than `rollup-stale-hours` never triggers a recompute.

**Staleness and publication (round-5 codex, folded):** the rollup records an
input watermark — the ledger's mtime at scan start — in the report header.
A report is stale when any of: the report file is absent (stat ENOENT), its
age exceeds `rollup-stale-hours`, the ledger mtime is newer than the recorded
watermark, or the report was deleted by the learned-churn invalidation below.
Publication: compute → re-stat the ledger → write to a **unique temp file +
rename** (`packages/subagent/handoff-store/src/store.ts:73-76` precedent) → if
the ledger advanced during the scan, the published report is immediately stale
(the recorded watermark predates the current ledger mtime, so the next trigger
recomputes). Concurrent rollups over the same append-only ledger converge to
equivalent content, so last-writer-wins is safe.

Ledger reading uses `readJsonl` (sidecar-io) — any unparseable line is
skipped, not only tail lines.

**Learned-skill enumeration and age (production path, D-C)**: the learned
sections enumerate `<dshHome>/learned-skills/*/SKILL.md` through the store's
directory conventions (`LEARNED_SKILLS_DIRNAME = 'learned-skills'`,
`packages/skill/skill-claude-code/src/learned-store.ts:19`; per-skill path
helper `learnedSkillPath` :73; the store's own `list()` returns
`{name, description, bytes, path}` with no timestamps — :232-254 — so age comes
from `stat` of each SKILL.md, **mtime** basis). mtime semantics = "untouched
for N days"; an edit resets age — stated in the report header.

**Catalog use** (guaranteed via `inject = ['skills']`): classification and
shadowing annotation read `ctx.skills.list({ cwd })` where `cwd` is the rollup
session's resolved cwd (§3.7) — `cwd` selects project roots
(`H/packages/skill/skill/src/index.ts:467-470`); `scope` is omitted, which
reads the global registry layers alone (`:116-118`). The preset's
skill-claude-code provider (including the learned root) registers at the
plugin/global layer (`packages/skill/skill-claude-code/src/index.ts:111`), so
it is visible without an agent scope; agent-local layers (none today in the CC
preset) would be invisible — stated limitation. A learned skill is classified
by `SkillSummary.source === 'learned'`
(`packages/skill/skill-claude-code/src/discovery.ts:96-100`); `LEARNED_RANK` is
module-private and `SkillSummary` has no rank field — rank is not an
observable seam. A learned skill whose name currently resolves to a
non-learned winner is listed under "shadowed — attribution uncertain" (D-E):
its name's loads may have exercised the shadowing skill, and current
shadowing cannot certify historical ownership either — the report header says
both.

**Invalidation beyond the watermark (round-5 codex, folded):** the ledger mtime
cannot see catalog churn, so the plugin also subscribes
`skills/learned-changed` (`packages/core/tool-manage-skill/src/index.ts:83`)
and on each event deletes **every** `utility-*.md` under
`<dshHome>/skill-usage/` — the churn event carries no project key and learned
skills are dshHome-global, so all workspace reports are invalidated — and the
next `session/created` in each workspace recomputes. Settings changes (thresholds) take
effect at the next natural staleness window (stated; no hot invalidation).

Report shape (`<dshHome>/skill-usage/utility-<projectKey>.md`):

```markdown
# Skill utility report — <projectKey> — generated <ts>
Observation coverage since: <observing-since ts> (wall-clock while telemetry
is enabled; disabling deletes the marker and restarts coverage; zero-load
periods still count).
Input watermark: <ledger mtime at scan start>.
Age basis: SKILL.md mtime (edits reset age). Loads are per-name; tool-form
rows may carry provider; shadowed learned skills are attribution-uncertain,
and current shadowing cannot certify historical ownership.
Classification source: catalog SkillSummary.source + learned dir enumeration.
## By loads (30d / all-time)
- <skill>: 12 / 41 loads, 6 sessions, last 2026-10-08
## Never loaded (learned skills, untouched > never-loaded-days)
- <skill>: last touched 2026-09-09, 0 loads
## Demote candidates (rule: learned, 0 loads in 30d, age > 14d, coverage ≥ 30d)
- …
## Insufficient observation window (excluded from demote list)
- …
## Shadowed learned skills (attribution uncertain)
- …
```

### 3.4 Demote-candidate rule (report-only)

A skill is listed as a demote candidate iff all hold:

1. learned (present under `<dshHome>/learned-skills/`);
2. zero loads of its name in the trailing 30 days (and not marked
   attribution-uncertain);
3. age > 14 days by SKILL.md mtime;
4. **observation-coverage guard: `observing-since-<projectKey>` exists and is
   older than 30 days** — coverage is established by the persisted marker
   (§3.2), never inferred from skill age or ledger content; the marker is
   deleted while telemetry is disabled, so disabled periods fail the guard.

If the guard fails, the skill appears under "insufficient observation window",
not in the demote list. (Round-5 codex blocker, folded: v4's
`min(ledger earliest, skill mtime) < now − 30d` let a 90-day-old skill qualify
on telemetry's first day — skill age substituted for coverage. The marker
separates the two concerns.) The report states the rule verbatim and says
**demotion is manual** (`manage_skill` delete or edit) — v1 takes no action.
This is the honest version of Progressive Crystallization: we implement the
*measurement* that makes demote decisions evidence-backed.

### 3.5 Configuration

Namespace `cc-skill-usage` (D-G), dual-half pattern (D-F; registration
precedent `packages/settings/settings-ns/src/index.ts:127` and
`packages/interaction/advisor-watchdog/src/settings.ts:23,90`; raw user-layer
re-read precedent `readUserSettingsSync`,
`packages/interaction/advisor-watchdog/src/settings.ts:161-175`):

- `cc-skill-usage.enabled` — default `true`. Raw user-layer re-read per matched
  event (hot toggle). When false: no ledger appends **and** no report writes;
  existing files remain. Limitation stated: the raw read sees the user layer
  only — project/repo-layer settings are invisible to it (same as the
  watchdog).
- `cc-skill-usage.rollup-stale-hours` — default `24`; read via the namespace
  cascade at rollup time.
- `cc-skill-usage.never-loaded-days` — default `30`; gates only the
  "Never loaded" report section. The demote rule's own thresholds (30d zero
  loads, age > 14d, coverage ≥ 30d) are constants, stated verbatim in the
  report (round-5 codex: v4's example labels contradicted the rule).

### 3.6 Failure discipline and the transcript-poison boundary

Observe-only at both seams; all errors swallow + debug log; the rollup never
edits catalog or stores; telemetry writes are best-effort at shutdown (§3.2).

**Why v1 appends nothing to the session (U3's blocker; verified by the
orchestrator and confirmed by all three round-5 seats):** the JSONL
persistence layer hard-refuses unknown non-`ignorable` event types when a
stored log is opened or prepared — `validateStoredEvents`
(`H/packages/session/session-persistence/src/storage-contract.ts:69-80`),
called from the production open paths
(`H/packages/session/session-persistence-jsonl/src/index.ts:675,807`;
`generation.ts:528`) — and `Session.append` exposes **no** production-side
`ignorable` channel (`H/packages/core/session/src/index.ts:722-727`: the third
parameter exists only for `SurfaceEventType` and carries only
`surfaceOp`/`sourceEventSeqs`; the constructed event object never carries
`ignorable`; the marker is defined on the stored-envelope contract and only
migration paths write it). A downstream
`session.append('skill-usage/loaded', …)` would therefore make every session
containing it unresumable at this pin (live-verified on a real production
session carrying `permission/classifier` rows; the
session-config-snapshot-event design is blocked on the same finding). Module
augmentation of `SessionEventMap` is type-level only; the `hook/invoked`
precedent is safe because that type is already in the upstream generated set
(`H/packages/core/session/src/known-event-types.ts:42-43`). An in-repo escape
exists — mutating the live `KNOWN_SESSION_EVENT_TYPES` set at plugin load
(`packages/workspace/session-cwd/src/events.ts:24`, same pattern as
`permission/mode`) — but it couples reopening every affected session to this
package being installed, and the registration must then stay unconditional
(never gated on `cc-skill-usage.enabled`). For v1 telemetry that trade is
rejected (D-A); §7 carries the deferred decision.

### 3.7 Companion change: session-facing cwd resolver in `@dsh-cc/session-cwd`

Add one exported function:

```ts
getSessionCwdForSession(session: Session, options?: SessionCwdOptions): string | undefined
```

Resolution order mirrors the agent-facing `getSessionCwd`
(`packages/workspace/session-cwd/src/api.ts:31-37`) **minus the
`process.cwd()` fallback**: live store overlay → durable `worktree/entered`
fold → session header cwd → caller fallback → `undefined`. Omitting the
fallback keeps "unresolvable" observable so D-J's skip applies (round-5 grok:
with the fallback the resolver can never signal unresolvable, and
`sha256(process.cwd())` would silently merge unrelated sessions into one
ledger).

Implementation is an **extraction, not a second copy** (round-5 codex+grok):
move the existing resolution body (which contains the only
`session.snapshotEvents()` call, grandfathered at `api.ts:34` against the
upstream deprecation "new calls are prohibited",
`H/packages/core/session/src/index.ts:630-649`) into a shared helper; the new
session-facing export and the existing agent-facing `getSessionCwd` both
delegate, the agent-facing one adding the `process.cwd()` fallback at its own
layer. The deprecated call count stays exactly one. Also register the new
function on the `sessionCwd` convenience face
(`packages/workspace/session-cwd/src/index.ts:74-85`) so host callers see it.
Unit tests extend the existing pins (`tests/api.spec.ts` — overlay readback,
header fallback) with: worktree-fold precedence over header cwd, and
`undefined` when nothing is recorded (no process-cwd fallback). The fixture
grows a session-returning helper — today's `agent()` fixture does not expose
the inner `Session` the new function takes — and both twins' tests share it
(round-5 grok).

## 4. Edge cases

- Skills loaded before this package ships: absent from the ledger — the report
  is honest by construction (it reports measurements from the
  observation-coverage marker; the header states it).
- `skill` tool renamed/aliased upstream (CC-parity name): the match is on the
  runtime tool id observed at `tools/result` — if upstream renames it,
  telemetry silently stops; mitigated by §5 test 4 (fixture asserting
  `exec.name === 'skill'` from a real captured payload) plus the dogfood
  observable "loads rows exist at all".
- Slash invocations of non-skill slash commands never reach the log as
  `skill-invocation` (the command plane consumes them first) — no false rows.
- Double-count: the slash form injects the skill body directly (no tool call
  follows) and the tool form produces no injection, so one user action yields
  exactly one row in v1's model; the dogfood correlation check (tool vs slash
  row ratio) remains as the tripwire, and dedupe by `(sessionId, skill, ts±2s)`
  is added only if a double-count is actually observed.
- `manage_skill` calls appear at `tools/result` under their own tool name —
  never match `exec.name === 'skill'`.
- Same-name shadowing, historical: loads are per-name; a currently-shadowed
  learned skill's name may carry loads from the shadowing skill, and a
  currently-clean name may carry loads from a formerly shadowing one. The
  report marks current-shadow cases and prints the historical-uncertainty
  caveat (D-E); demote candidacy excludes marked skills.
- Subagent sessions and subagent skill loads are invisible to v1 (scope
  filtering, §3.1) — not a gap in the numbers, a stated boundary.
- Resumed worktree sessions: slash rows key through the `worktree/entered`
  fold inside session-cwd (§3.7), so they land in the worktree bucket like
  tool rows.

## 5. Verification plan

0. **Slash tripwire fixture (was: blocking precondition):** capture one live
   `/skill-name` invocation's `session/event` stream; assert the
   `user/message` + `source.kind === 'skill-invocation'` shape spec'd in §3.2.
   The listener ships against the in-tree seam (§1); this fixture is the
   end-to-end tripwire, and the synthetic slash-form test is withdrawn if the
   capture contradicts the assumed shape.
1. Unit: ledger rows for both via-forms (shape, `provider` propagation,
   epoch-ms `ts`); `dshHomeFn` undefined ⇒ complete no-op; unresolvable
   projectKey ⇒ row skipped; observation-start marker create-once semantics.
2. Unit (writer): `appendJsonl` tail-repair on an unterminated pre-existing
   file; concurrent first-write; concurrent tail-repair (worst case: one
   skipped line).
3. Unit: rollup generation — synthetic ledger + learned-dir fixture + fake
   catalog → expected report; watermark staleness (fresh report skips; ledger
   advanced past watermark recomputes; ENOENT computes; ledger advanced
   *during* scan ⇒ published report immediately stale); learned-churn
   invalidation deletes the report; mtime age semantics; shadowed-learned
   annotation; unique temp + rename observed.
4. Guard: fixture built from a **real captured payload** asserting BOTH
   `exec.name === 'skill'` AND `typeof exec.arguments.name === 'string'`
   (documents the upstream-rename and arg-shape failure modes).
5. `session-cwd`: unit tests for `getSessionCwdForSession` (§3.7) including
   the no-fallback `undefined` case and the single-`snapshotEvents`-call-site
   extraction (agent-facing behavior unchanged).
6. Integration (testkit with **real `JsonlSessionPersistence` mounted** —
   concrete precedent `packages/compat/cc-model-aliases/tests/integration.spec.ts:24-67`:
   `mountAgentLoopTestDependencies` + explicit `JsonlSessionPersistence` +
   `AgentLoop`; the fake in-memory backend cannot catch transcript writes): a
   session with a synthetic `skill` tool call ⇒ exactly one ledger row **and
   zero `skill-usage/*` events in the reopened transcript** (negative
   tripwire guarding the §3.6 boundary).
7. Gates: capabilities manifest + `pnpm docs:parity`, README trio,
   **`check:size`**, composition pin, preset dependency + lockfile,
   `check-spec-deps` for harness-package test imports (declare in
   devDependencies), `check:deep-imports` clean (package-root imports only).

Dogfood: after one week, the utility report exists and its demote list is
reviewable by the user in one minute (config-is-prompt expectation:
`cc-skill-usage` produces the report file; verified by opening it).

## 6. Falsification / why this is the right first increment

The lifecycle literature's strongest warnings are about *unmeasured* governance
(SkillCorpus: gains don't transfer across harnesses; SHarP: unused surface is
negative-value). Any admission-scoring or auto-demotion built without
per-harness usage data inherits the 12227 confound. This change is the
measurement substrate and deliberately nothing more; §7 items gate on its data.

## 7. Follow-ups

1. **U3 transcript anchoring** (deferred from v1, D-A): append
   `skill-usage/loaded` once either (a) the upstream persistence layer offers a
   production-side `ignorable` channel or admits the type into the generated
   known set, or (b) the user accepts the mutable-set registration precedent
   with its couplings (registration unconditional at load; uninstalling or
   hard-disabling the package strands every session that contains rows). Shared
   decision with the session-config-snapshot-event design. The ledger's
   `sessionId` column already preserves the join key.
2. **Subagent-realm coverage**: count subagent skill loads (host-plane
   unscoped listener or a row in the subagent presets), once v1's main-realm
   numbers prove the report useful.
3. **Ledger retention**: v1 ledgers are append-only and unbounded with a full
   scan per rollup; add rotation/capping if dogfood shows size pressure.
4. Held-out admission gate for learned skills (SkillOpt shape: bounded edit →
   held-out task pass-rate delta → accept/reject, rejection kept as negative
   memory), reusing `packages/memory/memory/eval/lib.ts`'s golden-query scorer
   shape and `runSideQuery` for cheap grading.
5. Outcome correlation: join the ledger by `sessionId` with task outcomes
   (needs the D1/D3 substrates to be meaningful).
6. Auto-demotion with the A11 credit discipline once the report has dogfood
   weeks behind it.
7. Cross-harness portability lint for marketplace skills (SkillCorpus warning),
   folded into D8's content audit when both are live.

## 8. Review ledger

Round 1 — internal critic, 2026-10-09 — verdict: GO-WITH-AMENDMENTS
(7 findings, all adopted).

1. **F1 — slash-form seam unverifiable.** Adopted at the time (UNVERIFIABLE
   classification + live-capture gate); **superseded in v5** — the seam is
   in-tree upstream (round-5 fold A).
2. **F2 — arg key unverified.** Adopted at the time; closed as verified
   2026-10-09 (tool name `'skill'` + required-string `name`,
   `H/packages/skill/tool-skill/src/index.ts:82-92`); live-payload fixture
   retained.
3. **F3 — demote-rule honesty.** Adopted (observation-window guard);
   **strengthened in v5** (round-5 fold C — the guard now measures coverage,
   not file age).
4. **F4 — cordis inject trap + dshHome helper.** Adopted (§3.1; the helper is
   now sidecar-io's `dshHomeFn` directly, round-5 fold H).
5. **F5 — staleness semantics.** Adopted; **strengthened in v5** (input
   watermark + publication ordering, round-5 fold E).
6. **F6 — double-count risk.** Adopted; **resolved in v5** (the two forms are
   disjoint by construction, §4; dogfood tripwire retained).
7. **F7 — manage_skill noise.** Adopted (§4).

Round 2 — internal critic delta, 2026-10-09 — GO-WITH-AMENDMENTS (3 minors,
all adopted). Round 3 (delta confirm), 2026-10-09 — GO-WITH-AMENDMENTS
(2 minors), folded. Net status after round 3: GO (internal).

### Round 4 — code-reconciliation review, 2026-10-09 — verdict: **NO-GO against current code** (v3 GO overturned)

Orchestrator anchor audit + independent critic cold pass, run blind to each
other. Blocking: **B1** transcript append poisons reopen (U3 moved to §7,
D-A); **B2** slash-form keying seam unimplementable as written (new
session-cwd export, D-B). Contradictions: **M1** catalog-only classification
vs the age requirement (D-C); **M2** rank-based classification not observable
(`source === 'learned'` instead); **M3** shadowing attribution gap (D-E);
**M4** sidecar files placed inside the user-skill discovery root (D-D).
Errata adopted: gate name `check:size`; `cwdProjectKey` undefined case (D-J);
writer discipline (D-I); namespace `cc-skill-usage` (D-G); settings dual-half
(D-F); atomic report write (D-H). One round-4 erratum was itself **wrong** and
is corrected in v5: "the former `tool-types.ts` no longer exists" — the audit
searched only the harness repo; this repo's vendored copy persists
(`packages/core/tools/src/tool-types.ts:129,185,269-293`), and those harness
line numbers still match `H/packages/core/tools/src/index.ts`. Critic claims
overturned on re-verification that round: "jsonl read side does not throw"
(wrong call site); "fix by appending with `ignorable: true`" (no such
channel); "`ctx.skills.list()` returns rank-carrying candidates" (registry
returns `SkillSummary[]`; `SkillCandidate` is public but provider-side).

### Round 5 — three-lane blind review, 2026-10-09 (critic / grok / codex, blind to each other)

Verdicts: critic **GO-WITH-CHANGES** (5 findings); grok **GO-WITH-CHANGES**
(8 findings); codex **NO-GO** (12 findings, 1 blocking). The verdict split is
adjudicated as a severity-calibration difference: codex's single blocking
finding passes the implement-as-written test (the v4 guard really would
demote-list a 90-day-old skill on telemetry's first day), so the strict seat
is honored; the substance overlaps heavily across all three seats. All
findings folded:

- **A (two-seat hit: codex F2 ≡ grok F1) — slash seam is in-tree upstream.**
  `SkillInvocationSource` + pre-step injection + agent-loop persistence
  verified (`H/packages/skill/skill/src/index.ts:139-158`;
  `H/packages/skill/tool-skill/src/index.ts:177-203,405-430`;
  `H/packages/core/agent-loop/src/agent.ts:419-422`). v3/v4's "UNVERIFIABLE"
  claim corrected; the TUI spec is the first hop, not contrary evidence. §1
  rewritten; slash listener spec'd now; §5 step 0 downgraded to tripwire.
- **B (two-seat hit: codex F5 ≈ grok F2) — tool-form seam moved to
  `tools/result`.** Matching at `tools/post-execute` both counts loads a
  downstream `block` later erases (`H/packages/core/tools/src/index.ts:1771-1793`)
  and risks short-circuiting the waterfall if the listener forgets
  delegate-first; the contained emit seam carries the final canonical result
  (vendored `packages/core/tools/src/index.ts:163-167`). Metric semantics
  defined: a load counts when the final outcome is success.
- **C (codex F1, blocking) — observation-coverage guard.** v4's
  `min(ledger earliest, skill mtime)` formula replaced by the persisted
  `observing-since-<projectKey>` marker (§3.2/§3.4); empty-ledger and
  disabled-period semantics defined.
- **D (codex F3) — rollup catalog scope.** `list({ cwd })` specified; omitted
  `scope` reads global layers (`H/packages/skill/skill/src/index.ts:116-118,467-470`);
  the preset provider is global-layer so the learned root is visible;
  agent-local limitation stated (§3.3).
- **E (codex F4) — report freshness.** Input watermark + post-scan re-stat +
  unique temp + rename (§3.3).
- **F (codex F6) — keying semantics.** Live-cwd keying vs the loader's
  `header.cwd` lookup divergence documented (§3.2).
- **G (three-seat convergence: codex F11 + grok F3/F8) — §3.7 rewritten.**
  `string | undefined` without the `process.cwd()` fallback; extraction keeps
  `snapshotEvents()` at one call site; convenience-face registration; shared
  test helper.
- **H (grok F4) — `@dsh-cc/sidecar-io` adopted** instead of copying
  handoff-store primitives (`dshHomeFn` :29 / `projectKeyOf` :43 /
  `appendJsonl` :57 / `readJsonl` :71-87); tail-repair added there (D-I).
- **I (grok F5) — v1 realm = main CC agent.** All three observation seams are
  scope-filtered (`H/packages/core/session/src/index.ts:49-50,70-71`); the
  "subagent `session/created` storm" does not exist for this mount plane;
  subagent coverage moved to §7 (also answers codex Q9 / critic Q5).
- **J (codex F10) — `enabled` gates both writes; learned-churn invalidation**
  via `skills/learned-changed` (§3.3/§3.5).
- **K (codex F9) — report labels aligned to the rule** (§3.3 example;
  `never-loaded-days` is the section knob, demote thresholds are constants).
- **L (codex F8 + critic F3) — writer lifecycle stated** (best-effort at
  shutdown; concurrent tail-repair worst case one skipped line; §5 test 2).
- **M (codex F7) — historical-attribution caveat broadened** (§3.3 header,
  §4).
- **N (grok F6 + critic F1) — anchor repo attribution** (`H/` convention
  added; the vendored-copies note; round-4's wrong "tool-types.ts gone"
  erratum corrected above).
- **O (codex F12 + grok F5) — deployment obligations made explicit**
  (preset `package.json` dependency + lockfile; integration precedent
  anchored at `packages/compat/cc-model-aliases/tests/integration.spec.ts:24-67`;
  capability-row I4 evidence pointer `scripts/lib/capability-manifest.mjs:151,173`).
- **Critic minors adopted:** cross-process tail-repair race note (folded into
  L); §3.6 wording "opened or prepared" precision; `SkillCandidate` is a
  public exported type (round-4's "provider-internal" phrasing corrected to
  "provider-side, not what the registry service returns").
- **Citation corrections (two-seat verified):** `LEARNED_RANK` at
  `discovery.ts:67` (`:65` is `USER_RANK`); atomic rename at
  `packages/subagent/handoff-store/src/store.ts:73-76` (`:72` is mkdir);
  `SkillSummary` spans `H/packages/skill/skill/src/index.ts:56-74`; watchdog
  raw re-read at `settings.ts:161-175`.
- **Clarification questions adjudicated by the orchestrator** (each folded at
  the cited section; user may veto): load = final committed success (B);
  slash listener ships in v1 against the in-tree seam (A);
  `getSessionCwdForSession` returns `string | undefined` (G);
  `enabled=false` stops both writes (J); `never-loaded-days` is the
  never-loaded section knob only (K); telemetry is best-effort at shutdown
  (L); subagent counting is a follow-up (I); ledger `ts` is epoch ms (§3.2);
  tool-form rows carry `provider` when the result supplies it (D-E/§3.2);
  raw re-read applies to `enabled` only, staleness/thresholds read via the
  cascade at rollup time (§3.5); ledger retention is unbounded in v1 with
  rotation as a follow-up (§7 item 3).
- **Open upstream-unverifiable item (unchanged):** none blocking — the slash
  seam is now in-tree-verified; §5 step 0 remains as the end-to-end tripwire.

### Round 6 — delta confirmation, 2026-10-09 (three seats, fold-verification only)

Verdicts: critic **GO** (5/5 folds OK, 5/5 adjudications OK; spot-checked the
v5 seam moves beyond its own findings and confirmed them); grok
**GO-WITH-CHANGES** (4 NEW findings, all fold-precision); codex **NO-GO**
(2 PROBLEM findings, all fold-precision). All six folded into v6:

- **codex fold-1 PROBLEM — marker creation trigger.** v5 created
  `observing-since-<projectKey>` only in the per-load path, so a zero-load
  workspace never started coverage; and "disabled intervals do not reset it"
  let disabled time count as coverage. Fixed (§3.2 item 4): marker creation
  gained the rollup trigger (`session/created` fires without any load), and
  disabled semantics inverted — the marker is deleted while `enabled` reads
  false, so coverage means "wall-clock while enabled" and re-enabling restarts
  it (conservative direction). §3.4 rule 4 and the §3.3 report header updated
  to match.
- **codex fold-10 PROBLEM — invalidation key.** `skills/learned-changed`
  carries no project key and learned skills are dshHome-global; v5's "delete
  the affected key's report" was unspecifiable. Fixed (§3.3): the event
  sweeps every `utility-*.md` under the sidecar dir.
- **grok NEW-1 — `projectKeyOf(undefined)` hole.** §3.2 item 1 wrote
  `projectKeyOf(getSessionCwdForSession(session))`, but sidecar-io's
  `projectKeyOf` is `(cwd: string) => string`. Fixed: the `undefined` guard
  explicitly precedes hashing on the slash path.
- **grok NEW-2/NEW-3 — §1 citation precision.** The `H/.../tools/index.ts`
  citations split correctly: `notifyResult` emit implementation `:1695-1709`;
  waterfall block rewrite `:1770-1795`; caller-cancellation replacement
  `:1649-1654` (re-verified line-precise).
- **grok NEW-4 — §3.7 test fixture gap.** Today's `agent()` fixture does not
  expose the inner `Session`; the test plan now grows a session-returning
  helper shared by both twins' tests.
- **Critic informational note (no action):** `projectKeyOf` exists in both
  sidecar-io and handoff-store with identical implementations (sha256[:16]);
  no drift today, recorded for the day one of them changes.

### Round 7 — micro-confirmation, 2026-10-09 (grok + codex; critic's round-6 GO stands)

Scope-constrained fold-verification briefs (exact line ranges; no repo-wide
scans). **codex: GO** — "fold 1 OK / fold 10 OK". **grok: GO** — "fold
NEW-1/2/3/4 OK". No new findings from either seat. Provenance note: grok's
micro-round could not reach the harness checkout from its sandbox and
confirmed the citation folds against the vendored copy only; the `H/` line
cites in question (`:1649-1654`, `:1770-1795`) are orchestrator-verified
byte-level in the round-6 audit trail. With critic's round-6 GO,
**all three seats have passed their respective gates**; the convergence curve
ran architecture blockers (round 4) → mechanism precision (round 5) → fold
precision (round 6) → zero (round 7). Remaining gate: user sign-off.
