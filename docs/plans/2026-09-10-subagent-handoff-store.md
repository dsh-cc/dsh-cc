# Subagent Handoff Store

Date: 2026-09-10. Status: proposed — critic cold review passed with
amendments (6 items: tool-whitelist blocking fix, flat globally-unique id
store, store-primitive sharing deferred, config trimmed to enabled+
threshold single-source, honest benefit boundary, orphan-sweep caveat);
all baked in.
Scoped to what dsh-cc's orchestration model actually needs;
zero harness changes.

## 1. Problem — and the honest benefit boundary

dsh-cc's delegation discipline already forces "conclusions, not bulk",
but the residual bulk cases are real: **a critic (no Write in its
whitelist) producing a long review cannot put it in a repo file itself**,
and the parent's only channel back is the final-message text, which lands
whole in the parent context. Ditto sibling-to-sibling transfer via the
orchestrator.

Scope of benefit, stated precisely:
- sibling transfer and never-fetched artifacts: real token savings;
- parent fetching the full text anyway: **zero savings** — this feature
  does not pretend otherwise (compression-based savings are explicitly
  excluded from v1);
- executor/marathon already have Write and can return repo paths — the
  artifact-out convention exists for them; the gap is *sandboxed or
  read-only agents* and *$DSH_HOME-based cross-session transfer*.

## 2. Feasibility ground truth (verified 2026-09-10, re-verified in review)

- Host packages register agent-visible tools via `ctx.tools.register`
  (precedent: `packages/memory/memory/src/save.ts:123-130`), and such
  globally registered tools are visible to subagent sessions by default
  (negative control: `packages/memory/memory/tests/recall-tool-surface.spec.ts:115-131`).
- **BUT — blocking fact found in review**: the target agents
  (`dsh-cc-agents` critic/executor/marathon) all declare frontmatter
  `tools:` whitelists, and intersection semantics
  (`packages/subagent/task/src/restrict.ts:6-12`) mean an absent tool is
  silently unavailable. `handoff_put` MUST be added to those whitelists
  or the contract dies silently (restrict.ts only errors on unknown names
  already inside a list).
- Callers' session is reachable in executor via `exec.agent.session.id`
  (precedent: `save.ts:179`) — used for the ledger only, not the path.
- Host fs writes under `$DSH_HOME` are available to tool executors
  (writeback precedent).

## 3. Design

Package `packages/subagent/handoff-store` (cordis) + contract addition in
`dsh-cc-agents` frontmatter and CLAUDE.md orchestration slice.

### 3.1 Tools

- `handoff_put({ content, label?, agent? })`
  - stores content at **`$DSH_HOME/handoff/<projectKey>/<id>.md` — flat,
    NO per-session subdir**,
  - `id` = 16-hex sha256 prefix + 4-hex random suffix (content-collision
    safe AND globally unique; `handoff_get({id})` resolves by direct path —
    a child handed `handoff://<id>` in its prompt can fetch regardless of
    which session stored it),
  - ledger row appended to `$DSH_HOME/handoff/ledger.jsonl`
    `{ts, project, sessionId, id, label, agent, chars}` — ledger is a
    rebuildable index, not part of the read path.
- `handoff_get({ id, maxChars? })`
  - returns content, optionally head-truncated with a truncation note;
  - typed errors `unknown_id` / `expired`; fail-closed, never reads
    outside the store root.

Retention: TTL 24 h + 500-entry LRU, hard-coded constants, swept on put.
Caveat recorded: a store directory with no further puts is never swept —
orphans from dead sessions linger until the next put; acceptable, noted.

### 3.2 Contract (dsh-cc-agents, frontmatter + prose; separate PR)

Phase 1 ships BOTH:
- Add `handoff_put`, `handoff_get` to the `tools:` whitelists of
  `critic.md` / `executor.md` / `marathon.md` (the blocking unlock).
- One contract rule in house phrasing: reports/artifacts above the
  threshold → `handoff_put` first, return a ≤2 KB summary embedding
  `handoff://<id>`; the orchestrator (or a follow-up child) may
  `handoff_get` it. Threshold appears in the tool description (single
  source of truth — NOT duplicated in prose; prose says "see tool
  description").
- Tripwire: recall-tool-surface-style spec asserting each agent's
  EFFECTIVE tool surface really contains the pair after whitelist edit.
- Config-is-prompt discipline: commit states the expected observable
  delta (smaller parent-context deltas after review-heavy delegations).

### 3.3 Configuration

`cc-handoff.enabled` (default `true` — inert without contract adoption),
`cc-handoff.threshold-chars` (default 8192). Nothing else.

### 3.4 Relationship to the CCR feature

Both keep originals under `$DSH_HOME` with content-addressed ids and a
jsonl ledger — intentionally separate stores in v1 (different lifecycles
and failure domains; CCR must survive marker references across resume
while handoffs are short-lived). A later refactor PR MAY extract a shared
`artifact-store` helper package once both exist; neither feature depends
on the other.

## 4. Phases

0. Package + tools + ledger + sweeps. Usable immediately via explicit
   prompting.
1. Whitelist edits + contract in `dsh-cc-agents` and CLAUDE.md (separate
   PR — prompt discipline + tripwire test).
2. Follow-ups: shared store extraction (with CCR), TUI badge in /agents
   when a child returned `handoff://` references.

## 5. Verification

- Unit: put/get round-trip, collision-suffix uniqueness, TTL/LRU sweeps,
  typed errors, unicode + 10 MB payload.
- Component (real preset composition):
  - whitelist tripwire: spawned critic/executor/marathon effective
    surfaces each contain `handoff_put`+`handoff_get` (fails pre-edit);
  - a stub child `handoff_put`s 30 KB, returns summary with
    `handoff://<id>`; parent-context next pre-step batch does NOT contain
    the bulk; a SECOND spawned child resolves the id via `handoff_get`
    (cross-session fetch — the §3.1 path claim);
  - shunt-reader/writer whitelists still exclude the tools.

## 6. Risks / explicit non-goals

- Advisory contract drift: metric of success is parent-context bytes per
  delegation in dogfood, not policing.
- No compression in v1; no cross-project sharing (projectKey partition);
  no repo writes; no memory-system claims.
