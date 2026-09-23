# Learn → learned-skill promotion, plus a manage_skill tool

**Status:** **Proposed** — critic cold review round 1 (2026-09-23) incorporated: promotion surface concretized (promote=<name> token, command-authored SKILL.md), refresh seam pinned to SkillProviderControl.invalidate() + cache-free list(), cross-repo SkillSource widening declared as companion harness change, gating mirrors /learn (runtime check on always-mounted tool), body-only 64_000-byte cap (true omp parity), delete/update/already_exists semantics specified, claim check via full provider list().
**Date:** 2026-09-23
**Worktree:** `.claude/worktrees/oh-my-pi` (branch `worktree-oh-my-pi`)

## 1. Problem

`/learn` (PR #35, capability `commands.learn`) closes the loop from a session
failure to a durable memory lesson. What it cannot do is graduate a *reusable
procedure* into the skills system: a lesson about "how to do X in this repo"
stays a memory topic even when it is really a checklist the model should load
on demand as a skill. Today the only path is a human hand-writing
`SKILL.md`.

oh-my-pi closes this with two mechanisms
(`oh-my-pi/packages/coding-agent/src/tools/learn.ts:102-143`,
`autolearn/managed-skills.ts:20-26`; verified 2026-09-23):

- `learn` optionally promotes a lesson into a **managed skill** (cap 64 KB,
  `MAX_MANAGED_SKILL_BYTES`);
- a `manage_skill` tool does create/update/delete over managed skills, and a
  create whose name collides with an **authored** skill is refused up front
  (`isError`, `shadowed: true`) — learned content may never shadow authored
  content (`oh-my-pi/packages/coding-agent/src/tools/manage-skill.ts:71-87`).

One trap must not be ported: in omp, `learn`'s promotion does **not** refresh
the skill registry (only `manage_skill` calls `refreshSkills`,
`oh-my-pi/docs/tools/manage_skill.md:38`), so a promoted skill is invisible
until some other action rescans. We design the refresh as a first-class part
of the promotion, not a side effect of a different tool.

## 2. Goal

1. `/learn` gains an optional promotion step: the model (or user) may mark a
   captured lesson as a reusable procedure; it becomes a `SKILL.md` under a
   dedicated **learned** root.
2. A new `manage_skill` tool provides create/update/delete over that same
   root, with authored-name collision refusals.
3. Skill discovery integrates the learned root at **lowest precedence**, and
   same-session visibility is planned and spec-pinned (§4.5): writes call
   `SkillProviderControl.invalidate()` so the next provider `list()` —
   cache-free by design — re-runs discovery.

## 3. Non-goals

- No editing of authored skills (`~/.claude/skills`, project `.claude/skills`,
  plugin-shipped skills) through the tool; authored content stays human-owned.
- No promotion of *facts* (those stay memory); the promotion decision is the
  model's, guided by the lesson shape — see §4.3.
- No sync of learned skills across machines or into git; they are local-user
  state, exactly like memory topics.
- Not reusing the existing `managed` discovery root — see §4.2.

## 4. Design

### 4.1 The learned root

`<dshHome>/learned-skills/<kebab-name>/SKILL.md` (harness home laid out per
the dual-home rule: peer directory beside plugin state, $DSH_HOME seeding in
tests; workspace memory `plugin-dsh-home-cascade-shipped`). Supporting
resources may live beside the `SKILL.md`. The cap applies to the SKILL.md
**body only**: `MAX_LEARNED_SKILL_BODY_BYTES = 64_000` (true omp parity —
omp's `MAX_MANAGED_SKILL_BYTES` caps body only).

Frontmatter authored by the promotion path:

```yaml
---
name: repo-release-dance
description: Release dance for this repo: version bump, tag, and publish order
learnedFrom: session <id>, 2026-09-23
---
```

`description` is mandatory (the skill catalog surfaces name+description);
provenance fields are extra and preserved as unknown keys.

### 4.2 Discovery: a new `learned` source, lowest precedence — explicitly not `managed`

The skill loader already knows a `managed` source
(`packages/skill/skill-claude-code/src/discovery.ts:5,17,52-55`), but its
semantics are the opposite of what we need: `MANAGED_RANK = 100`, scanned
**first** (`discovery.ts:62,77-78`) — that root is a *policy* root meant to
override everything. Learned skills must instead sit **below** user/project/
additional roots:

- add `CcSkillSource 'learned'` with the largest rank constant
  (`LEARNED_RANK = 500`) in this repo's `discovery.ts` — `CcRootRank` is a
  closed union 100|200|300|400 today (`packages/skill/skill-claude-code/src/discovery.ts:20`),
  so the union gains the 500 member; pushed last in `orderedRoots`;
- the catalog `SkillSource` label union (`managed|user-dsh|project-dsh|custom`,
  `index.ts:53-56`) also gains `'learned'` — that type lives in the **external**
  harness package @deepseek-ai/dsh-skill (sibling harness repo), so the
  implementation PR carries a companion harness-side change, coordinated via
  the pinned `DSH_HARNESS_REF` flow (`presubmit.yml`). **This is the plan's
  only cross-repo ask, and it is an ask, not a precondition**: if the harness
  side declines or delays, the implementation maps the learned root onto the
  existing `'custom'` label and ships fully dsh-cc-side; the `'learned'` label
  is then a cosmetic upgrade (catalog attribution) only.
- rank-ordered first-wins resolution happens in the registry (realpath dedupe
  in discovery only covers identical files), which means an authored skill
  naturally wins over a learned one *if both exist* — but §4.3/§4.4 make
  that collision impossible at write time instead;
- loading, rendering, and the session catalog inherit for free once the root
  is in the ordered list.

### 4.3 Promotion path (inside `/learn`)

In `packages/session/command-learn` (`src/index.ts`, `src/write.ts`):

1. The lesson write proceeds exactly as today (memory write unchanged).
2. `/learn` gains a `promote=<kebab-name>` token in `parseLearn` (alongside
   the existing `apply|all|days=N` tokens). When present, the command authors
   `SKILL.md` itself from the lesson it just rendered: name = the token;
   description = the lesson's one-line summary (first line); body = the
   rendered lesson text. No model-facing structured field exists today and
   none is added in v0 — the model requests promotion by writing the token
   into the `/learn` invocation (or the user types it). `manage_skill create`
   remains available for hand-authored refinements.
3. The promotion path then:
   - validate name charset (`^[a-z0-9][a-z0-9-]*$`) and body size (§4.1 cap);
   - run the claim check against the full provider `list()` (which includes
     bundled skills), not a raw discovery walk, and **refuse** with
     `shadowed: true` (isError path at the command level) if the name is
     claimed, pointing at the claiming path. The full-scan cost is accepted
     as fine at current catalog scale;
   - write `$DSH_HOME/learned-skills/<name>/SKILL.md`;
   - call the refresh seam (§4.5) so the catalog picks it up immediately;
   - report both write paths in the result text (memory topic + skill).

Guidance to the model lives in the learn prompt: promote only procedural,
repeatable lessons ("how to do X here"); factual lessons ("the release token
lives in 1Password") stay memory.

### 4.4 `manage_skill` tool

New CC-facing tool `manage_skill` (snake_case, consistent with the catalog).
The tool is mounted unconditionally (like `/learn` itself, mounted at
`agent.cordis.yml:713`) and checks the `cc-learn.enabled` runtime gate at
call time (index.ts:138 pattern), returning a disabled message when off.

- Actions: `create | update | delete`; params `{ action, name, description?,
  body?, resource? }`.
- Semantics: `delete` removes the whole `<name>/` directory; `update`
  replaces the body only (supporting resources untouched); `create` on an
  existing learned name returns `already_exists` (isError); `update`/`delete`
  on missing names return `not_found`.
- Claim check on create/update runs against the full provider `list()`
  (which includes bundled skills), not a raw discovery walk (authored-name
  collision → isError `shadowed:true` naming the authored path); the
  full-scan cost is accepted as fine at current catalog scale.
- Every successful mutation calls the refresh seam; failures never partially
  write (write-to-temp + rename).
- Read-only preview: `action: "list"` returns learned skills with sizes —
  cheap and useful for `/skills` UX delta later.

### 4.5 Refresh seam

Same-session visibility is the **planned v0**, not a fallback. The provider's
`list()` re-runs `discoverCcSkills` on every call with no file cache
(`index.ts:133-134`), and `SkillProviderControl.invalidate()` already exists
(used at `index.ts:345`). After a write, the promotion path calls
`invalidate()`; the next `list()` re-runs discovery and sees the new skill.
One honest caveat: reaching `SkillProviderControl` from this plugin's ctx is
the one unverified reach (the implementation confirms it; if unreachable, the
fallback text "available in new sessions" is returned and **named in the PR
description** — spec-pinned either way, §5).

### 4.6 Capability manifest impact (implementation PR, same commit)

- `commands.learn`: behavioral stays full; extend evidence with the new
  promotion specs; deviation note mentions promotion (CC has no equivalent
  step).
- New tool `manage_skill` is net-new dsh-cc surface: add capability entry
  (recorded like other dsh-cc extras; validator rules I3/I4/I7 applied) and
  regenerate parity docs.

## 5. Verification

- **Unit specs** (`command-learn` + skill-loader): name-charset validation,
  64 KB cap, authored-collision refusal (fixture authored skill claims the
  name), promotion writes both artifacts with correct frontmatter,
  `manage_skill` CRUD incl. `not_found`/`already_exists` branches,
  update-then-list consistency.
- **Discovery spec**: root ordering asserts `learned` ranks below user and
  project roots; a fixture learned skill appears in the rendered catalog with
  source `learned`.
- **Refresh pin**: the §4.5 spec — either same-session visibility (preferred)
  or the documented "new sessions" result text.
- **Preset composition**: `composition.spec.ts` unchanged-or-extended only by
  the tool registration line, per its contract.
- **Dogfood**: on this repo, teach `/learn` a real procedural lesson from a
  past failure session, promote it, and show it visible to the model in the
  *same* session (or the documented fallback), then drive it once via the
  `skill` tool.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Model promotes trivia into skills | prompt guidance (§4.3) + `description` required + human review via `list` |
| Learned skill goes stale and misleads | provenance frontmatter; `manage_skill delete`; future `/learn` runs may supersede rather than pile up |
| `SkillProviderControl` unreachable from plugin ctx | invalidate() is planned v0 (§4.5); fallback text (§4.5), spec-pinned |
| Name squatting blocks future authored skills | refusal direction is learned→authored, never reverse; deleting learned frees the name |

## 7. Open questions

- Should `/skills` mark `learned` sources visually (a suffix tag)? Nice, small;
  decide during implementation against the TUI/CLI renderer.
- Workspace-scoped learned skills (project dir under `.dsh/`)? v0 is
  user-global, mirroring memory's global-vs-workspace split later if demand
  shows.

## 8. DoD

1. `/learn` promotion path and `manage_skill` tool shipped behind the learn
   gate, §5 specs green.
2. Discovery orders `learned` last; authored-collision refusal proven by spec.
3. Refresh behavior (same-session or documented fallback) pinned by spec.
4. Manifest updated in the same PR; `pnpm check:capabilities` +
   `pnpm docs:parity` green.
5. Dogfood capture: one real lesson promoted and consumed via the `skill`
   tool.
