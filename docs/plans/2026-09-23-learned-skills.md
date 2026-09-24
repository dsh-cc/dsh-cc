# Learn → learned-skill promotion, plus a manage_skill tool

**Status:** **Shipped** — implemented in the same PR that carries this revision;
the design below matches the as-built behavior (see §5 spec files as executable
anchors). Critic cold round 2 (2026-09-24)
re-verified every anchor against this repo, the pinned harness
(`DSH_HARNESS_REF 1ef9c1fa` = 0.1.5-rc.1, `.github/workflows/presubmit.yml`),
and oh-my-pi source (sibling `oh-my-pi` repo checkout — read-only reference). Round 2 corrected two factually inverted
claims from round 1: the "companion harness change" was fictitious (the catalog
`SkillSource` is an **open** union — no harness change needed), and the size cap
is **full-file**, not body-only. Round-2 verification confirmed all 20 gap
closures and closed its own four follow-ups (mkdir before wx create;
update/delete use on-disk existence as the oracle; command-learn `inject` +
`skill-loader` dep pinned; same-session spec sequencing). The refresh seam is
designed here, not assumed — cordis sibling event delivery verified at
`vendor/cordis/src/events.ts:163-167`.
**Date:** 2026-09-23
**Worktree:** `.claude/worktrees/learned-skills` (branch `worktree-learned-skills`)

## 1. Problem

`/learn` (PR #35, capability `commands.learn`) closes the loop from a session
failure to a durable memory lesson. What it cannot do is graduate a *reusable
procedure* into the skills system: a lesson about "how to do X in this repo"
stays a memory topic even when it is really a checklist the model should load
on demand as a skill. Today the only path is a human hand-writing `SKILL.md`.

oh-my-pi closes this with two mechanisms (verified 2026-09-23 and re-verified
2026-09-24 against source):

- `learn` optionally promotes a lesson into a **managed skill**
  (`oh-my-pi/packages/coding-agent/src/tools/learn.ts:102-143`: memory write
  first, skill mint second, collision → `isError` + `shadowed: true`, and a
  failed skill write surfaces as a *partial outcome* — memory stands);
- a `manage_skill` tool does create/update/delete over managed skills
  (`oh-my-pi/packages/coding-agent/src/tools/manage-skill.ts:65-87`), capped at
  `MAX_MANAGED_SKILL_BYTES = 64_000`
  (`oh-my-pi/packages/coding-agent/src/autolearn/managed-skills.ts:20`) measured
  over the **full serialized file** — the source comment says: *"Cap the UTF-8
  byte size of the FINAL file (body + description + frontmatter), not the
  UTF-16 code-unit length of the body alone"* (`managed-skills.ts:163-172`).

One trap must not be ported: in omp, `learn`'s promotion does **not** refresh
the skill registry (only `manage_skill` calls `refreshSkills`,
`oh-my-pi/docs/tools/manage_skill.md:32,40`), so a promoted skill is invisible
until some other action rescans. We build the refresh as a first-class seam of
every write (§4.5).

Deliberate divergences from omp, each pinned below: no `list` action in omp
(we add one); omp's `update` regenerates frontmatter and **loses extra keys**
(ours preserves them); omp checks name claims on create only (we check on
update too); we do not port omp's symlink/race hardening
(`managed-skills.ts:120-215`) — the learned root lives under `$DSH_HOME`, which
the model can already write via the `write` tool.

## 2. Goal

1. `/learn` gains an optional promotion token: the **user** marks a captured
   lesson as a reusable procedure; it becomes a `SKILL.md` under a dedicated
   **learned** root (§4.3).
2. A new `manage_skill` tool provides create/update/delete/list over that same
   root, with authored-name collision refusals (§4.4). This is also the
   **model's** promotion path — commands are composer-facing only (§4.3), so
   the model acts through the tool, guided by its description.
3. Skill discovery integrates the learned root at **lowest precedence**, and
   same-session catalog visibility is guaranteed by an explicit event seam
   (§4.5), spec-pinned (§5).

## 3. Non-goals

- No editing of authored skills (`$DSH_HOME/skills`, project `.claude/skills`,
  plugin-shipped skills) through the tool; authored content stays human-owned.
- No promotion of *facts* (those stay memory); the promotion decision is the
  user's (via `/learn promote=`) or the model's (via `manage_skill`),
  guided by the lesson shape — see §4.4 tool description.
- No sync of learned skills across machines or into git; they are local-user
  state, exactly like memory topics.
- Not reusing the existing `managed` discovery root — see §4.2.
- No model-side `/learn` invocation surface; see §4.3.

## 4. Design

### 4.1 The learned root

`<dshHome>/learned-skills/<kebab-name>/SKILL.md` — a peer of the existing user
root `<dshHome>/skills` (`packages/skill/skill-claude-code/src/discovery.ts:90`).
Supporting resources may live beside the `SKILL.md` (hand-authored or later
`update` targets; v0 tools never create them).

File contract:

- Name charset: `^[a-z0-9][a-z0-9-]{0,63}$` (bounded; omp
  `managed-skills.ts:31-37` and harness `isSkillName` both bound the length).
- Size cap: `MAX_LEARNED_SKILL_BYTES = 64_000` measured as
  `Buffer.byteLength(serializedFile)` over the **final file bytes**
  (frontmatter + body) — exact omp semantics (§1).
- Frontmatter written by both write paths:

  ```yaml
  ---
  name: repo-release-dance
  description: Release dance for this repo: version bump, tag, and publish order
  learnedFrom: /learn 2026-09-24
  ---
  ```

  `name` and `description` are mandatory; `description` must be non-empty
  after sanitization (the harness registry hard-drops empty-description
  skills — harness `packages/skill/skill/src/index.ts:745,762`).
  `learnedFrom` records the writer and ISO date (`/learn <isoDate>` from the
  promotion path, `manage_skill <isoDate>` from the tool) — **no session id**:
  `/learn` scans the sessions directory and has no current-session id, and
  `CommandInvocation` carries none. Unknown frontmatter keys are preserved by
  `parseCcFrontmatter` (they flow into `metadata` at
  `skill-claude-code/src/index.ts:265`).
- Descriptions pass through `sanitizeLearnedDescription` on every write
  (promotion and tool): strip `\p{Cc}\p{Cf}`, strip `<`, `>`, backticks,
  collapse all whitespace runs to single spaces, one line. Learned
  descriptions are machine-generated text that lands in the model-facing
  catalog; omp treats this as a trust boundary
  (`sanitizeManagedDescription`). We do **not** sanitize at load time —
  consistent with authored skills.

### 4.2 Discovery: a new `learned` source, lowest precedence — explicitly not `managed`

The `managed` source means the opposite of what we need: `MANAGED_RANK = 100`,
scanned **first** (`discovery.ts:62,77-79`) — a *policy* root meant to override
everything. Learned skills sit **below** user/project/additional roots:

- `discovery.ts` (all in `packages/skill/skill-claude-code/src/`):
  add `'learned'` to `CcSkillSource` (:17), add `500` to the `CcRootRank`
  union (:20), add `const LEARNED_RANK = 500` beside :62-65, and in
  `discoverCcRoots` push
  `{ path: join(resolve(options.dshHome), 'learned-skills'), source: 'learned', rank: LEARNED_RANK }`
  **after** the `additionalDirs` loop (:91-93).
- `index.ts` (same package): add `const LEARNED_SOURCE: SkillSource = 'learned'`
  beside :53-56 and a `case 'learned'` in `sourceOf` (:278-289).
- **No harness change is needed.** Round 1 claimed the catalog `SkillSource`
  union was closed and required a companion harness PR. Verified false at the
  pinned SHA: harness `packages/skill/skill/src/index.ts:40` is an open union
  — `'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents'
  | 'custom' | 'bundled' | (string & {})` — so `'learned'` is assignable today
  (`'managed'` itself passes only via the open-string escape). The harness
  repo is read-only regardless; delete any companion-harness-change plan.
- Rank-ordered first-wins resolution happens in the registry, so an authored
  skill naturally wins over a learned one if both exist — §4.3/§4.4 make that
  collision impossible at write time instead.
- Loading, rendering, and the session catalog inherit for free once the root
  is in the ordered list.

### 4.3 Promotion path (inside `/learn`)

Verified surface: `/learn` is registered via `ctx.commands.register`
(`packages/session/command-learn/src/index.ts:181`) — **composer-facing only**,
with `parseLearn` tokenizing `invocation.rawInput` (:68-81) and the
`cc-learn.enabled` gate read via the package-private `sectionSource` thunk
(:136-139). dsh-cc has no model-invocable command surface (no slash-command
tool exists in the harness or this repo — verified by search on both, and by
the runtime tool catalog). Therefore: **`promote=` is user-typed only**; the
model's promotion path is `manage_skill create` (§4.4), whose tool description
carries the procedural-vs-factual guidance. v0 adds no model-side command
surface.

Changes in `packages/session/command-learn`:

1. `parseLearn` (:68-81) gains a `promote=<kebab-name>` token
   (`/^promote=([a-z0-9][a-z0-9-]{0,63})$/u`); a malformed value lands in the
   existing `invalid` slot (current behavior: `kind: 'error'` with usage text
   — :141-143). Duplicate `promote=` tokens: last one wins (mirror how
   repeated `days=` behaves — plain reassignment).
2. `promote` **implies `apply`** (a promotion without the memory write is not
   a supported shape). All other tokens compose freely; `all promote=x` is
   allowed (the finding set already depends on `all`).
3. `executeLearn` (:135-159), after the existing memory write succeeds:
   - **Single-finding rule**: promotion requires exactly one finding. On
     `findings.length === 0` the existing no-op text is extended with
     "— nothing to promote". On `findings.length > 1` promotion is refused
     and the result text names all finding titles: the user re-runs with
     tighter `days=`/`min-occurrences`, or the lesson is refined later via
     `manage_skill`. (Rationale: `runForensics` returns N findings; there is
     no per-lesson object to promote, and inventing multi-name syntax is
     over-engineering for v0.)
   - Skill content: `description` = `finding.title` (sanitized per §4.1);
     `body` = `renderFinding(finding)` lines (`render.ts:38-46` — title,
     detail, evidence) joined as markdown. Deterministic, already
     unit-covered shape.
   - Validation order: name charset → claim check → body assembled → size cap.
     Any failure returns a `kind: 'error'` result **after** the memory write
     and names the failed stage — the memory write stands, no rollback (omp
     partial-outcome semantics, §1).
   - **Claim check**: `await ctx.skills.list({ cwd: process.cwd() })` — the
     harness registry's merged view, which includes bundled skills
     (provider appends them, `skill-claude-code/src/index.ts:153-157`) and
     runtime-registered skills. **Consumer reality (verified during
     implementation): `ctx.skills.list()` returns `SkillSummary`
     (`harness packages/skill/skill/src/index.ts:57-72`) — `{name,
     description, invocation, source, provider, resourceBase?}`, NO `path`**
     (`path` exists only on provider-internal `SkillCandidate`, :75-84).
     Claim outcomes therefore combine the registry view with on-disk truth
     (full rule pinned in §4.4/§4.6): a learned file already on disk →
     `already_exists`; a claimant with `source !== 'learned'` and no file →
     `shadowed`, text naming the claimant's `provider` and `source`. Accepted
     blindness: conditional paths-gated skills are excluded from `list()`
     until activated (`index.ts:145-150`) — the wx `EEXIST` backstop still
     maps to `already_exists`, so the outcome stays correct.
   - Write `join(dshHome, 'learned-skills', name, 'SKILL.md')` via the shared
     store (§4.6) — create semantics with exclusive flag; `EEXIST` after a
     clean claim check → report as collision (race guard).
   - On success: fire the refresh event (§4.5) and report both write paths
     (memory topic + skill path) in the result text.
4. `command-learn` gains a top-level `export const inject = ['skills']`
   (skill-claude-code precedent, `skill-claude-code/src/index.ts:50`; the
   plugin is root-realm mounted and the claim check genuinely requires the
   registry — unlike the optional settings read, no graceful degradation
   exists), imports the shared store helpers (§4.6), and adds
   `"@dsh-cc/skill-loader": "workspace:^"` to its `dependencies` (its other
   `@dsh-cc/*` deps are regular workspace deps — precedent in its own
   package.json; `check:spec-deps` may also require declaring what tests
   import).

### 4.4 `manage_skill` tool

New package **`packages/core/tool-manage-skill`** (`@dsh-cc/tool-manage-skill`;
precedent: `packages/core/tool-web-fetch`, PR #79). Tool name `manage_skill`
(snake_case, consistent with the catalog). Mounted unconditionally in the
preset; the `cc-learn.enabled` gate is checked **at call time** — the tool
reads `settings.get('cc-learn')` directly via `ctx.inject(['settings'], …)`
(the `readSection`/`sectionSource` plumbing is package-private to
command-learn; a direct two-line read with the same enabled-default
fallback). Gate off → plain non-error result text: "manage_skill is disabled
(`cc-learn.enabled` is false in settings)."

Tool description (model-facing) carries the promotion guidance: promote only
procedural, repeatable lessons ("how to do X here"); facts and secrets stay
in memory.

Schema: `{ action: 'create' | 'update' | 'delete' | 'list', name?: string,
description?: string, body?: string }`. **No `resource` param** (omp has none;
supporting resources remain hand-authored files that `update` never touches).

Semantics (all backed by the shared store, §4.6):

- `create`: requires `name` + `description` + `body`; charset/sanitize/cap
  per §4.1; claim check per §4.3. Claim outcomes, evaluated in order:
  (1) a learned SKILL.md already on disk → `already_exists`; (2) else a
  claimant whose `source !== 'learned'` → `shadowed`, naming the claimant's
  `provider` and `source` (no path — §4.3); (3) else a claimant with
  `source === 'learned'` (stale registry view of a deleted file) → proceed,
  the wx write heals state; (4) exclusive-write `EEXIST` → `already_exists`
  (race backstop).
- `update`: requires `name` plus at least one of `body`/`description`.
  **Existence oracle is on-disk** (`learnedSkillPath`), never the registry —
  this keeps a learned skill shadowed by an authored one updatable, and a
  skill never collides with itself. Replaces the body (and/or description)
  **while preserving all other frontmatter keys** — parse the existing file
  with `parseCcFrontmatterDocument` (exported from `@dsh-cc/skill-loader`,
  `index.ts:43`), substitute, re-serialize. This is an explicit divergence
  from omp (whose update regenerates frontmatter as name+description only,
  silently dropping extra keys). On-disk miss → `not_found`; when
  `listClaimants` additionally shows an **authored** claimant (`source !==
  'learned'`), append the hint "an authored skill with that name is provided
  by \<provider\> (source \<source\>) and is not managed by this tool" (the
  registry is consulted on update/delete **only** for this hint — the refusal
  semantics stay create-only, another pinned divergence from omp).
- `delete`: removes the whole `<name>/` directory; on-disk miss → the same
  `not_found` (+ authored hint) rule as update.
- `list`: plain text, one line per learned skill:
  `<name> — <description> (<bytes> B) — <path>`; `bytes` is the full SKILL.md
  file size. Empty root → "no learned skills".

Error taxonomy — tool results with `isError: true` and a stable code word in
the message: `invalid_name` (charset), `invalid_params` (missing required
fields), `too_large` (§4.1 cap), `shadowed` (authored collision, naming the
claiming path), `already_exists`, `not_found` (+ authored hint when
applicable). Gate-off is not an error (text above).

Write atomicity: `create` first runs `mkdir(dirname(path), { recursive: true })`
(the wx write ENOENTs otherwise; recursive mkdir also creates the
`learned-skills/` root on first use), then `writeFile(path, content, { flag:
'wx' })` (atomic create; `EEXIST` → `already_exists`, closing the race after
the claim check); `update` uses temp-file + rename within the same (already
existing) directory; `delete` is `rm -r` of the skill directory only. Failures
never partially write.

Every successful mutation emits the refresh event (§4.5).

### 4.5 Refresh seam — built, not assumed

Same-session visibility is the **v0 commitment**, spec-pinned in §5. The naive
reading "provider `list()` re-runs discovery, so we're done" is false: the
harness registry caches per `{cwd, scope-chain, revision}` in `collectCache`
(harness `packages/skill/skill/src/index.ts:368-369,525-529`); only
`SkillProviderControl.invalidate()` bumps the revision. And `control` is
created **inside `registerProvider`'s closure** (harness `index.ts:392-405`),
handed only to the provider factory — unreachable from other plugins.

Seam (precedent: the existing `fs/observed` listener in the same provider,
`skill-claude-code/src/index.ts:325-343`, which already calls
`this.control.invalidate()` cross-plugin):

- `skill-claude-code` adds
  `ctx.on('skills/learned-changed', () => this.control.invalidate())`
  beside that listener, wired through the same context.
- Both writers (`command-learn` promotion, `manage_skill` mutations) call
  `ctx.emit('skills/learned-changed')` after a successful write.
- `skills/learned-changed` is a dsh-cc-private cordis event; the registry's
  own `skills/change` notification continues to fire off `invalidate()`
  as today.

The §5 same-session spec (write → immediately visible via `ctx.skills.list()`
in one process) is the arbiter. If the preset's realm topology blocks cordis
event delivery between these plugins, the implementation escalates the
listener wiring to a shared-ancestor context — behavior and spec unchanged;
any such deviation must be named in the PR description. Neither the event nor
the spec may be dropped silently.

### 4.6 Shared learned-skill store

The two writers share one implementation. Home:
**`packages/skill/skill-claude-code/src/learned-store.ts`** — the skill
package already owns the learned root on the read side (§4.2), so it owns the
write side too; consumers depend on `@dsh-cc/skill-loader` (a repo package,
not harness).

Exports (pure and cordis-free for direct unit testing):

- Constants: `LEARNED_SKILLS_DIRNAME = 'learned-skills'`,
  `MAX_LEARNED_SKILL_BYTES = 64_000`, `LEARNED_NAME_SOURCE`,
  `isLearnedSkillName(name)`, `sanitizeLearnedDescription(text)`,
  `serializeLearnedSkill({ name, description, learnedFrom, body })`,
  `learnedSkillPath(dshHome, name)`.
- `class LearnedSkillStore` constructed with
  `{ dshHome, listClaimants: () => Promise<readonly {name, provider, source}[]>, onChanged: () => void }`
  — the caller maps `SkillSummary` entries straight in (all three fields exist
  there; `path` does not, §4.3) and wires the §4.5 emit. Methods
  `create/update/delete/list`, each returning a discriminated result:
  `{ ok: true, … } | { ok: false, code: 'invalid_name' | 'invalid_params' |
  'too_large' | 'shadowed' | 'already_exists' | 'not_found', detail: string }`.
  Claim rules (per §4.4): on **create**, on-disk existence decides
  `already_exists` first, then a claimant with `source !== 'learned'` yields
  `shadowed`; a stale `'learned'` claimant whose file is gone does not block
  (the wx write heals); wx `EEXIST` always maps to `already_exists`. On
  **update/delete**, on-disk existence at `learnedSkillPath` is the sole
  oracle and `listClaimants` is consulted only to enrich `not_found` with the
  authored-claimant hint (provider + source, §4.4).
- `command-learn` maps store results to command text; `tool-manage-skill`
  maps them to tool results (`isError` per §4.4).

### 4.7 Registration checklist (new package)

`tool-manage-skill` touches all of these (each verified against the
`tool-web-fetch` precedent and current gates):

1. `packages/core/tool-manage-skill/`: `package.json` (`@dsh-cc/tool-manage-skill`),
   `tsconfig.json`, `src/index.ts`, `tests/tools.spec.ts` (pattern:
   `tool-web-fetch/tests/tools.spec.ts`). Harness packages go in
   `peerDependencies` (`>=0.1.5-rc.1`) + `devDependencies` (`link:` to the
   sibling checkout) per the house rule; `@dsh-cc/skill-loader` as a regular
   workspace dep; `@dsh-cc/*` test imports declared per `check:spec-deps`.
2. README trio: `README.md`, `README.zh.md`, `README.i18n.yaml`
   (`pnpm check:readme --write` re-records hashes) — gate enforced in
   pre-commit, presubmit, and publish.
3. Preset row in `packages/preset/cc/agent.cordis.yml` in the cc-services
   group next to `tool-web-fetch` (:491), with a comment that the package
   publishes no Service and needs no isolate key (wording precedent:
   handoff-store comment :495-500). The plugin must resolve the root-realm
   `skills` service for `ctx.skills.list` and gate settings.
4. Add `@dsh-cc/tool-manage-skill` to `packages/preset/cc/package.json`
   deps — `composition.spec.ts:298-312` fails otherwise; launcher bundles
   reach it automatically via preset-cc (spec :314-375; no structural edit —
   the composition spec is generic over `@dsh-cc/*` rows).
5. Capability manifest + docs parity (§4.8).

### 4.8 Capability manifest impact (same PR)

`docs/claude-code-capabilities.yaml` + `pnpm docs:parity` (regenerate matrix,
README parity block, `capabilities.json`; commit all three — hand-edits fail
CI). Validator rules I3/I4/I7 apply.

- `commands.learn` (:1792-1808): behavioral stays `full`; extend evidence with
  the new promotion spec; deviation note mentions the promotion step (CC has
  no equivalent).
- New entry for the `manage_skill` tool, modeled on the net-new `web_fetch`
  precedent (:975-1000): `mounted: true`, `plane: preset`, evidence = the
  `agent.cordis.yml` anchor (`- id: tool-manage-skill`) + the spec file;
  dsh-cc-extra deviation recorded per the validator's expectations; placed in
  alphabetical order within its category (I7).

No user docs page beyond the generated parity artifacts exists, so
`docs:parity` is the whole docs delta. Release: no manual changeset — the
daily release is conventional-commit driven (`feat(...)` → minor).

## 5. Verification

Spec files (fixture patterns already exist):

- `packages/skill/skill-claude-code/tests/discovery.spec.ts`: learned root
  ranks last (below user/project/additional); a fixture learned skill is
  discovered with source `learned`. (`tempDir` + `writeSkill` helpers,
  spec :13-23 pattern.)
- `packages/skill/skill-claude-code/tests/skill-claude-code.spec.ts`
  (provider + registry booted together): **the §4.5 pin**, sequenced so the
  negative half cannot pass vacuously — (1) `ctx.skills.list()` once
  **before** any write to populate `collectCache`; (2) write a learned
  SKILL.md **without** emitting, list again → the new skill is still absent
  (staleness proven, not assumed); (3) emit `skills/learned-changed`, list
  again → the skill is now visible with source label `learned`.
- `packages/skill/skill-claude-code/tests/learned-store.spec.ts` (new):
  charset/size/sanitize units, claim distinction
  (`already_exists` vs `shadowed`), update preserves unknown frontmatter
  keys, wx-create race → `already_exists`, not_found + authored hint, list
  output shape. Store is cordis-free — inject fake `listClaimants`/
  `onChanged`.
- `packages/session/command-learn/tests/command-learn.spec.ts`: `promote=`
  parse (valid, malformed → `invalid`, last-wins), promote implies apply,
  zero-finding text extension, multi-finding refusal naming titles, promotion
  writes SKILL.md with exact frontmatter (`learnedFrom: /learn <date>`),
  collision refusal text, cap refusal, **memory stands on promotion
  failure**, event emitted on success.
- `packages/core/tool-manage-skill/tests/tools.spec.ts`: full CRUD + list,
  every error code from §4.4, gate-disabled text, `onChanged` fired per
  mutation. Tests pass `dshHome` as a tempdir (the provider takes it as
  config, `index.ts:77`; no env seeding needed).

Gates (all must run green before the PR):

- `pnpm --filter @dsh-cc/skill-loader test`,
  `pnpm --filter @dsh-cc/command-learn test`,
  `pnpm --filter @dsh-cc/tool-manage-skill test`
- `pnpm check:capabilities`, `pnpm docs:parity`, `pnpm check:parity`,
  `pnpm check:readme`, `pnpm check:spec-deps`, `pnpm typecheck`
- Presubmit composition spec (`composition.spec.ts`) — no structural change
  expected; verify.

Dogfood (this repo): teach `/learn` a real procedural lesson from a past
failure session, promote it, show it visible via `ctx.skills.list()` in the
same session, then load it once via the `skill` tool; exercise
`manage_skill list/update/delete` against it; delete it at the end.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Model promotes trivia into skills | Tool-description guidance (§4.4) + `description` required + human review via `list` |
| Learned skill goes stale and misleads | provenance frontmatter (`learnedFrom`); `manage_skill delete`; future `/learn` runs may supersede rather than pile up |
| Registry serves stale catalog after write | §4.5 event seam + same-session spec that proves both directions |
| Realm topology blocks the cordis event | §4.5 escalation rule; spec is the arbiter; deviation named in PR |
| Name squatting blocks future authored skills | refusal direction is learned→authored, never reverse; deleting learned frees the name |
| Learned description is prompt-injection-shaped | `sanitizeLearnedDescription` on every write (§4.1) |
| Symlinked learned root/file abuse | Not ported from omp (§1) — learned root is under `$DSH_HOME`, already model-writable via `write` |

## 7. Open questions

- Should `/skills` mark `learned` sources visually (a suffix tag)? The
  `SkillSource` label is already `learned` (§4.2), so this is a renderer-only
  nicety — decide against the TUI/CLI renderer in a follow-up.
- Workspace-scoped learned skills (project dir under `.dsh/`)? v0 is
  user-global, mirroring memory's global-vs-workspace split later if demand
  shows.

## 8. DoD

1. `/learn promote=` path and `manage_skill` tool shipped behind the
   `cc-learn` gate; §5 specs green.
2. Discovery orders `learned` last; claim refusals (`shadowed`,
   `already_exists`) proven by spec.
3. Same-session refresh proven by spec in both directions (§5).
4. Manifest updated in the same PR; `pnpm check:capabilities` +
   `pnpm docs:parity` green; README trio recorded.
5. Dogfood capture: one real lesson promoted and consumed via the `skill`
   tool, then exercised and removed via `manage_skill`.
