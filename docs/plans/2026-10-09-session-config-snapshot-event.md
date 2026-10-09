# Session config snapshot (config-in-trace substrate) (design)

- Date: 2026-10-09
- Status: draft v7 — sidecar pivot (user-directed); ALL review seats GO (internal critic round 4 + external dual-seat blind review rounds 5-8); user sign-off pending. NOT yet implemented.
- Scope: new package `packages/observability/config-snapshot` (`@dsh-cc/config-snapshot`), plain cordis plugin (handoff-store precedent: no Service subclass, no isolate key); preset service-group row + capability manifest row + README trio, same commit; composition test pin bumped deliberately. A sidecar JSONL ledger under `<dshHome>/config-snapshot/<sessionId>.jsonl`, one row per Session construction. No harness-upstream dependency in v1; append-only data with no runtime behavior effect.

## 1. Problem

Measured on real v4 transcripts (2026-10-09 field inventory over the newest and
largest local sessions; full ledger in project memory):

- Well-stamped: gauge decisions (`permission/probe|classifier` carry
  model/provider/route/verdict/confidence/latencyMs/digest), hook verdicts
  (`hook/result`: decision/exitCode/durationMs/handlerId), approvals
  (`approval/asked|decided`), permission posture (`permission/preset`,
  `sandbox/mode`, `approval/policy`).
- Model route exists only as coarse change-point records (`request/context` with
  model/provider/contextWindow — 3 records in a 418-step session).
- **Absent entirely: the harness version, the dsh-cc version, and every plugin
  version.** The header carries identity/lineage fields (v4 verified at
  `deepseek-harness/packages/core/session/src/types.ts:94-131`:
  id/createdAt/cwd?/parentSession/isSeeded/origin?/delegationDepth?/agentPreset?)
  plus the transcript-format `version: 4`, but no version stamps for harness,
  dsh-cc, or plugins.

Consequence: across any version/dependency change, dogfood data, threshold
recalibration, and regression forensics cannot attribute behavior deltas to
model vs harness vs plugin configuration. Every planned adaptive feature in the
borrowed set (threshold recalibration, skill scoring, memory consolidation
policies) presumes this substrate, per GSME's "separate proposer from
credit-assigner" rule and 12227's warning that gains measured on the same
traffic they gate are confounded.

## 2. Goals and non-goals

Goal: every session is attributable to the configuration that produced it —
dsh-cc version, harness version (when surfaced), process default preset, and
the visible marketplace/user plugin install inventory (flagged with the
loader's per-id selection, §3.5 (d)) — captured once per Session
construction, keyed by session id, consumable by a direct `session.id` join.

Non-goals:

- No transcript embedding in v1. Appendix-grade evidence (§3.0) shows
  `session.append` of a downstream-typed event poisons the harness persistence
  read path at this pin. The in-trace form is §7 follow-up 1, gated on an
  upstream producer-side `ignorable` channel.
- No per-request route stamping upgrade (change-point `request/context` records
  stay as-is; finer-grained route/effort stamping is a follow-up, §7).
- No upstream change: the harness-version seam does not exist at this pin and is
  recorded as `null` until mounted (§3.5 (b)).
- No settings/privacy: the snapshot contains versions, identities, and
  enablement flags only — no settings values, no absolute user paths (only the
  plugin `installPath` basename, §3.5 (d)).

## 3. Design

### 3.0 Why not `session.append` at this pin (evidence chain for the pivot)

The v3 design appended a `cc-config/snapshot` session event. Audit against the
pinned harness tree (0.2.0-rc.2, `c1b47e41fc`) shows that is not viable in v1:

1. `KNOWN_SESSION_EVENT_TYPES` (`core/session/src/known-event-types.ts:22-82`)
   is generated from the harness repository only; its header comment documents
   that downstream plugin events are outside the set **by construction** and
   the persisted envelope `ignorable: true` marker is the compatibility
   mechanism.
2. `Session.append(type, data, ...opts)` (`core/session/src/index.ts:722-726`)
   accepts opts only for surface-event types and only carries
   `surfaceOp`/`sourceEventSeqs` — there is **no producer-side way to mark an
   appended event `ignorable`** at this pin.
3. The jsonl persistence backend validates every stored event on open —
   read AND write access — via `validateStoredEvents`
   (`session-persistence/src/storage-contract.ts:75-80`): an unknown,
   non-ignorable event type throws `SessionFormatUnsupportedError` and the log
   is never opened (`session-persistence-jsonl/src/index.ts:342-419` →
   `:514-577` → `decodeStoredLog` `:760+`; the throw is pinned by
   `session-persistence-jsonl/tests/current-event-admission.spec.ts:49-69`).
4. Live probe (2026-10-09, read-only, against a /tmp copy of a real local
   session — original untouched): a production session whose transcript carries
   `permission/classifier` at seq 38 fails both `open(id,'read')` and
   `open(id,'write')` with exactly that refusal. So the mechanism is not
   theoretical, and sessions carrying existing dsh-cc custom events
   (`permission/probe|classifier`, dsh-cc `tool/code-dispatch*` — the latter
   additionally collides with the harness retired-syntax gate at
   `session-format-v3-to-v4/src/retired-syntax.ts:26`) are already
   un-resumable through this backend. That pre-existing poisoning is a
   separate remediation (§7 follow-up 2), out of scope here.

Consequence: as v3 was written, a default-on plugin appending one event per
Session construction would have made EVERY session (including every subagent
session) un-openable by the persistence backend — the opposite of "no behavior
change". Chosen direction (user decision, 2026-10-09): **sidecar ledger**.

### 3.1 Package and registration

New package `packages/observability/config-snapshot`, plain cordis plugin
(handoff-store precedent: no Service subclass, no isolate key; registration-row
precedents at `packages/preset/cc/agent.cordis.yml:510-517`). Registration:
preset service-group row + capability manifest row + README trio, same commit;
composition test pin bumped deliberately (`packages/preset/cc/tests/composition.spec.ts`).

### 3.2 Capture trigger and listener

Listener: `ctx.on('session/created', (session) => …, { global: true })`.

- Firing: `session/created` is announced by `SessionStore.announce`
  (`core/session/src/index.ts:1133-1161`) once per entered session. Whether it
  fires for child/subagent sessions was TEST-PENDING; **SETTLED by the §5
  item 4 integration test (implementation, 2026-10-09): it DOES fire for
  child sessions** — the subagent leg captured `delegationDepth: 1`,
  `parentSession`, and `origin: 'subagent'` on the child's own sidecar row.
- Visibility: `{ global: true }`, not the plain style. Every invariant-FILE
  `session/created` listener in both repos uses `{ global: true }` (dsh-cc
  `packages/hooks/hook-protocol/src/invariant.ts:87-88`; harness copy at
  `packages/hooks/hook-protocol/src/invariant.ts:88-89`, plus the harness
  plan-mode, todo, user-approval, compaction, goal, session-title, and
  core/session invariant files). Behavioral plugins legitimately differ —
  `packages/interaction/permission-rules/src/index.ts:294` is the plain-style
  example (the harness schedule listener at
  `packages/schedule/schedule/src/index.ts:188` actually passes
  `{ global: true }` at `:205` and belongs to the global list). For an
  observability capture that must see every realm (§5 item 4 asserts child
  sessions), the invariant-file uniform is the safe default.
- No seeding of pre-existing sessions. hook-protocol sweeps
  `ctx.sessions.list()` at mount (`invariant.ts:87`); we deliberately do NOT,
  because a mount-time sweep would attribute mount-time configuration to
  sessions constructed earlier. Accepted gap: sessions constructed before this
  plugin mounts (e.g. after a hot-reload remount) carry no row for that
  construction; consumers treat "no row" as unknown (§3.7).
- Failure semantics (load-bearing at this pin): a **synchronously throwing**
  `session/created` listener vetoes/rolls back session creation
  (`core/session/src/index.ts:989`; pinned by `tests/session.spec.ts:1522-1536`
  — `:1534` expects the throw, `:1535` the rolled-back store entry), while a
  rejected async listener is tolerated but warn-logged by the harness
  (`index.ts:1161`, `tests/session.spec.ts:1732-1748`). The listener body must
  therefore be sync-trivial (capture header fields, stamp `appendedAt`,
  kick the async writer) and perform NO settings reads (§3.6), and the async
  writer must catch ALL failures internally so the harness never logs (and
  §3.7's debug-level discipline is achievable).

### 3.3 The sidecar store

One JSONL file per session id: `<dshHome>/config-snapshot/<encodedId>.jsonl`
where `encodedId = encodeSegment(sessionId)`. `SessionId` is an unvalidated
branded string (`util/brand/src/index.ts:28-29`) — the jsonl backend
neutralizes traversal/separators/NUL before any filesystem use via its
injective `encodeSegment` (`session-persistence-jsonl/src/format.ts:190-214`;
not exported at that package's root, and a `src/` deep import trips the
`check:deep-imports` gate — `scripts/check-deep-src-imports.mjs:26`), so this
package COPIES that escape algorithm; the raw `sessionId` also rides the row
(§3.4) so consumers never decode the filename to join. One row per Session
construction, appended at capture; resume constructs a fresh Session
(evidence: `agent-loop/tests/resume.spec.ts:629+` re-announces
`session/created`) and therefore appends a second row to the same file — the
intended version-change evidence, distinguished by `seq` (§3.4).

Home resolution (resolved ONCE, bare — never a subdirectory): `ctx.dshHomePath()`
with no segment when the boot seam is mounted (provided as that function at
`boot/app-boot/src/index.ts:995`; handoff-store read pattern
`subagent/handoff-store/src/index.ts:46-62`), else `$DSH_HOME ?? ~/.dsh`; when
neither is resolvable (providerless host), the plugin no-ops (same precedent).
The ledger path is `join(home, 'config-snapshot', encodedId + '.jsonl')`, and
the SAME bare home feeds `PathInputs.dshHome` in §3.5 (d) — passing the ledger
subdirectory there would make plugin state resolve under
`config-snapshot/plugins`.

Writer conventions (repo storage commons): `mkdir(recursive)` before
`appendFile`; fire-and-forget `void write().catch(debugLog)`; `node:fs/promises`
on the host fs. Writes into one file go through a per-file serialized queue
(distinct sessions fan out to distinct files; contention exists only for
sequential same-id constructions). Repair-on-append: before appending, the
writer ensures the file ends with `\n` (a torn tail from a crash mid-append
gets a prepended newline), so a crash fragment can never swallow the NEXT
row; readers correspondingly skip ANY unparseable line, interior included
(§3.7).

### 3.4 The snapshot row

```jsonc
{
  "schemaVersion": 1,
  "sessionId": "string",     // raw session id (the join key; filename is its encoded form)
  "seq": 1,                   // per-file monotonic row counter (the row identity)
  "bootId": "string",        // per plugin ACTIVATION, §3.4 (not per process)
  "appendedAt": 0,           // capture-initiation time, epoch ms (advisory)
  "dshCc": "string",         // §3.5 (a) — never null
  "harness": "string|null",  // §3.5 (b)
  "preset": { "id": "string|null" },          // §3.5 (c)
  "plugins": [ { "id", "scope", "version", "installPathBasename", "enabled",
                 "loaderSelected?": true } ],
                             // §3.5 (d), sorted by id then scope
  "note": "string?",         // sanitized reason code, §3.5 (d)
  "delegationDepth": 0,      // session.header discriminators (number|null)
  "parentSession": "string|null",
  "origin": "subagent|null"
}
```

Fields:

- `sessionId` — the raw session id, the consumer join key. The filename is
  its `encodeSegment` form (§3.3); carrying the raw id in the row means
  consumers never decode filenames.
- `seq` — per-file monotonic counter assigned by the per-file serialized
  write queue (NOT the sync listener — the queue owns file state). This is
  the row identity. Millisecond timestamps alone cannot guarantee it (two
  constructions of the same id in one millisecond share `appendedAt`), and
  the serialized write queue cannot fix the timestamps — only the counter
  can. Restart/remount safety: the queue LAZILY initializes the counter on
  first use by an activation as the file's total LINE count + 1 (counting
  EVERY line, unparseable ones included — every row occupies exactly one
  line and the count only grows, so the initialization can never collide
  with an existing `seq`, even after interior corruption). Uniqueness of
  (file, `seq`) across processes, activations, and resumes is claimed under
  the single-writer assumption the transcript write lease already enforces
  for a live session id (§5 item 4 cites the exclusive write ownership):
  concurrent multi-process capture of ONE session id is out of scope and
  not claimed.
- `bootId` — `${process.pid}-${Date.now()}-${activationCount}` captured once
  per plugin ACTIVATION, where `activationCount` is a per-process monotonic
  counter incremented on every activation — two activations of one process
  in the same millisecond therefore get DISTINCT ids (§5 item 5 (b) depends
  on this). Activation identity, not process identity: one process can
  emit multiple ids after hot-reload remounts (which §4 relies on), so the
  older "all rows from one process boot share it" phrasing is withdrawn.
- `appendedAt` — `Date.now()` captured in the SYNC listener body. ADVISORY,
  and it stamps capture INITIATION, not observation: the config fields are
  read asynchronously afterward, and `listInstalled` performs sequential
  multi-file reads (`list.ts:71-80`, `merged-state.ts:79-85,109-111`) that
  are not an atomic snapshot. A row therefore means "configuration observed
  during this capture", not "configuration at exactly this instant".
- Row identity: (file, `seq`). Row order within a file is append order.
- Consumer row-selection rule (clock = `SessionEvent.time`, epoch ms,
  `types.ts:499`): attribute a transcript event at time `t` to the row with
  the greatest `appendedAt` ≤ `t`; if NO row qualifies (t predates the first
  row), the attribution is UNKNOWN — there is deliberately NO fallback to
  the earliest row (a resume-only file must not explain the pre-resume log
  with post-resume configuration). Same-millisecond ties are broken by `seq`.
  The RULE is normative; its residuals are accepted and enumerated:
  (a) synthetic repair closers — missing-`tool/result` errors when a call
  is pending, `step/end` when a step is open, and always `turn/end`
  (`session/src/repair.ts:88-96`; named at
  `agent-loop/src/index.ts:848-851`, appended at `:856`) — REUSE the last
  persisted event's timestamp (`repair.ts:86-90`: `const time =
  last.time`), so they are attributed to the previous row BY TIME and by
  semantics (they close the pre-crash turn): not a misattribution at all;
  (b) genuinely fresh setup-window stamps — `session/end-seed` (appended
  at Session construction, `session/src/index.ts:620-621`) and early
  posture events (`sandbox/mode`, `approval/policy`, `permission/preset`)
  if appended during setup — carry timestamps below the new row's
  `appendedAt` and are therefore attributed to the PREVIOUS row by the
  rule when one exists (else unknown); a bounded, accepted imprecision
  (the window is the setup duration), not a correctness claim;
  (c) events of
  constructions that produced no row (failed capture, pre-mount
  construction) are attributed to the previous row when one exists — the
  attribution is best-effort, and "no row at all" remains unknown.
- `delegationDepth` / `parentSession` / `origin` — copied from
  `session.header` (fields exist at this pin, `types.ts:107/117/123`; duck-type
  consumer precedent `packages/memory/memory/tests/recall.spec.ts:243`,
  `packages/interaction/command-resume/src/resume.ts:34`). In the sidecar
  design these are NOT transcript duplication — sidecar consumers are not
  expected to load the transcript; they let a reader partition root vs
  subagent sessions from the snapshot alone. Absent-header mapping:
  `delegationDepth ?? 0`, `parentSession ?? null`, `origin ?? null` (header
  optionality at `types.ts:107/117/123`).

No event-type collision risk (no session event is emitted); the row schema is
ours alone, versioned by `schemaVersion`.

### 3.5 Field sources (all probe-verified accessors)

(a) `dshCc` — typed `string`, never null. Copy the ~15-line `readOwnVersion()`
    helper (`packages/interaction/command-version/src/version.ts:26`, fallback
    constant `:14`): the copy reads THIS package's `package.json`, correct
    because workspace packages share the release-train version. The helper is
    async and belongs in the async writer (§3.2), never the sync listener.
    Cross-package import is excluded by the repo's `check:deep-imports` gate
    (CI-only) even though command-version's exports map happens to expose
    `./src/*`; deliberate duplication. The fallback constant will NOT follow
    release bumps automatically: `scripts/release.mjs:166-200` rewrites only
    command-version's constant (and fails loudly if it moves), so this
    package's constant MUST be added to that lockstep rewrite in the same
    change, with a release dry-run assertion that both constants track the
    release version (§5 item 7).
(b) `harness` — normalize `ctx.get('harnessVersion')` to a plain
    `string | null` using the SAME duck-typed normalization the in-repo
    consumers use — accept `string | { version: string }` and narrow to
    `string` (`packages/interaction/command-version/src/index.ts:16-24`,
    `packages/interaction/command-doctor/src/checks/env.ts:12-18`); store the
    normalized string or null, never the raw wire shape. At this harness pin
    **no provider exists** (probe: zero `harnessVersion` matches in the harness
    tree), so the value is `null` and the code must carry a comment saying so.
    The normalization handles both wire shapes, so when a provider mounts,
    recorded values upgrade from `null` to a string with no schema change.
(c) `preset.id` — `ctx.get('agentPresets')` narrowed with the consumer
    precedent's typeof guard (`typeof presets?.defaultId === 'string'`,
    `packages/interaction/command-doctor/src/checks/session.ts:66-70`);
    otherwise `null` (seam absent in tests). Per-session preset overrides
    (`agent-preset/selected` events, `header.agentPreset`) are already in the
    transcript (harness-native,
    `preset/agent-preset-registry/src/index.ts:326`); the snapshot records the
    process default only.
(d) `plugins` — `listInstalled(deps)` from the PUBLIC root of
    `@dsh-cc/plugin-manager` (`packages/compat/cc-plugin-manager/src/index.ts:58`;
    internals like `loadInstalledPlugins`/`pluginsStatePaths`/`merged-state`
    are deliberately NOT exported and the package's exports map exposes only
    `.` and `./package.json`). `listInstalled`
    (`cc-plugin-manager/src/list.ts:68-109`):
    - merges the dual homes (`merged-state.ts:73-91`: dsh entries shadow claude
      entries per id, claude-only ids pass through) — matching the manager's
      own view of "installed" instead of reading one raw home file;
    - computes `effectiveEnabled` per entry (C9: local → project → user,
      first defined boolean wins, absent everywhere ⇒ disabled); the snapshot
      records it as the row's `enabled`, so the recorded caliber is the
      manager's own enablement view, not just on-disk presence;
    - applies cwd visibility filtering (`projectPath` realpath) for
      project/local scope entries — pass `session.header.cwd ?? process.cwd()`.
      Caliber caveats: project/local entries installed but not visible from
      THIS session's cwd are dropped (a row set cannot distinguish
      "not installed" from "not visible from this cwd"), while entries with
      NO `projectPath` stay visible from every cwd (`list.ts:53-56`);
      `enabled` reflects the state files at capture time — a later
      install/enable changes only subsequent constructions' rows, which is
      the intended per-boot attribution.
    `PathInputs` construction: `claudeHome` = `CLAUDE_CONFIG_DIR ?? ~/.claude`,
    `dshHome` = the SAME bare home resolved once in §3.3 (never the ledger
    subdirectory), `cwd` = session cwd. These mirror
    `CcPluginManagerOptions`' documented defaults
    (`cc-plugin-manager/src/index.ts:63-74`).
    Row shape: `{ id, scope, version, installPathBasename, enabled,
    loaderSelected? }` — `id` is the `Record` key, which includes the
    marketplace suffix (`name@marketplace`, confirmed against production
    `installed_plugins.json`); one row per (id × scope). Only the *basename*
    of `installPath` is recorded (privacy: no absolute user paths). Real cache
    layout is `…/plugins/cache/<marketplace>/<name>/<version>`, so for cache
    installs the basename simply restates `version`; the field is kept for
    directory/local installs where the basename carries the plugin directory
    name — the only location hint the row has.
    `loaderSelected` — exactly one row per id WHOSE EFFECTIVE ENABLEMENT IS
    TRUE carries `loaderSelected: true`, marking the installation the
    RUNTIME loader would pick: the loader only walks ENABLED keys
    (`discovery.ts:190`, `enabledKeys` cascade), so a disabled id gets NO
    `loaderSelected` row (none of it loaded, whatever the inventory says);
    among an enabled id's rows, the pick is by greatest `lastUpdated`
    (tie → later array index) and requires the directory to exist
    (`cc-plugin-loader/src/discovery.ts:190-193,284-293`). Replicate that
    rule from the row set (rows carry `lastUpdated`; entry order within an
    id is preserved); the tie-break is a documented approximation of the
    file's array index. Divergence is likewise approximated: the flag is
    computed over the VISIBLE row set, but the loader itself applies NO cwd
    visibility filtering (`discovery.ts:190-193` iterates enabled keys over
    the merged map directly), so when the loader's true pick is an entry
    this row set dropped as cwd-invisible, the flag marks a different
    (visible) row — recorded as a known approximation alongside the next
    one. Without this flag the rows are an INVENTORY, not the
    loaded configuration — an id installed in two scopes with different
    versions would otherwise attribute behavior to a version that never ran.
    Existence of the picked directory is not re-verified (the inventory seam
    carries no filesystem check); a deleted cache directory therefore yields
    a `loaderSelected` row the loader itself would skip — recorded as a
    known approximation.
    Missing state files are the manager's C10 defaults (empty, NOT an error,
    no note). Corrupt JSON throws through `loadJsonFile`; caught ⇒
    `plugins: []` plus `note` = a FIXED sanitized reason code
    (`plugins-state-corrupt`) — never raw error text, because
    `malformedStateFile` embeds the absolute file path in its message
    (`cc-plugin-manager/src/errors.ts:43-44`) and the row must carry no
    absolute user paths. The in-process `ccPlugins` summary stays rejected as
    a source (no version on its mount summary).

### 3.6 Configuration

One key, kebab namespace convention (`registerNamespaceSafe` family, precedent
import at `packages/interaction/advisor-watchdog/src/settings.ts:23`, call at
`settings.ts:90`):

- `config-snapshot.enabled` — default `true`. Append-only local data with no
  runtime behavior effect; a kill switch exists for minimal-footprint
  consumers. The read happens INSIDE the async writer, NEVER in the sync
  listener: `registerNamespaceSafe`'s reader rethrows non-duplicate register
  failures (`packages/settings/settings-ns/src/index.ts:166/:179`), and a
  sync throw on `session/created` vetoes session creation (§3.2). The read
  is fail-open `true` on an absent provider, `undefined`, or a throw (the
  advisor wrapper's try/catch-then-defaults precedent,
  `packages/interaction/advisor-watchdog/src/settings.ts:96-103`); a
  settings flip mid-process therefore changes subsequent constructions only,
  and a broken settings layer never disables capture OR blocks creation.

### 3.7 Failure discipline

Observability, never on a behavior path:

- The sync listener body must not throw (§3.2 — it would roll back session
  creation).
- The async writer catches everything (unreadable/corrupt state files, blocked
  sidecar dir, json serialization) and logs at debug level; harness-side warn
  logs never fire because no rejection escapes.
- A failed capture yields NO row (not a partial row) plus at most one debug
  log; consumers must treat "no row for a session id" as unknown, never as
  empty configuration.
- Crash discipline: a process death mid-append can leave a trailing
  unterminated JSON line. The writer repairs on append (a newline is
  prepended to a torn tail before the next row, §3.3), so the fragment can
  never swallow a subsequent valid row; readers must skip ANY unparseable
  line, interior ones included. Existing rows are never rewritten.
- Nothing else is touched; there is no passthrough to degrade.

## 4. Failure modes and mitigations

- Fresh install without plugin state files ⇒ manager C10 defaults: zero rows,
  no note, no error.
- Corrupt `installed_plugins.json` or settings file ⇒ `plugins: []` + `note`
  (§3.5 (d)); capture of the other fields proceeds normally.
- Hot-reload remount ⇒ sessions constructed before remount have no row for
  that construction (§3.2, accepted); the mount itself IS a new boot constant
  (`bootId`), so a later resume of such a session still yields a
  config-accurate row.
- Rows are tiny (one per Session construction — N per boot when the session
  spawns subagents; filename + `seq` keep them apart); no
  retention management in v1.

## 5. Verification plan

1. Unit: fake session object (permission-rules' spec fixtures are the
   precedent for session/created listeners) + tmp homes ⇒ row shape, plugin
   sorting, `null`-tolerance for harness version, `preset.id` typeof guard,
   `sessionId` raw-id-in-row, filename encoding for hostile ids (`../`, `/`,
   `..` ⇒ encoded segment stays one path component, row still joinable).
   Row-selection fixtures over a two-row file (§3.4 rule): event before the
   first row ⇒ unknown; between rows ⇒ row 1; after the last ⇒ row 2;
   same-millisecond tie ⇒ `seq` breaks it.
2. Unit: corrupt `installed_plugins.json` ⇒ `plugins: []` + `note`, no throw,
   other fields still recorded; missing files ⇒ zero plugin rows and NO note.
3. Unit: one id installed in TWO scopes in the fixture homes ⇒ two plugin
   rows, same `id`, distinct `scope`, each carrying its entry's `version`,
   and exactly one of them `loaderSelected: true` matching the loader's
   discovery rule (`cc-plugin-loader/src/discovery.ts:284-293`); a
   DISABLED id in the fixture ⇒ NO `loaderSelected` row (the loader walks
   only enabled keys). Include a
   dual-home case: claude-home-only id passes through; dsh empty list shadows
   the claude id. Crash-recovery leg: seed a torn unterminated JSON fragment
   at file end, append one row, append another ⇒ both new rows parse
   (repair-on-append, §3.3). Corrupt-state note is the fixed reason code and
   contains no tmp-home path.
4. Integration (dsh-cc harness integration pattern; reference spec
   `packages/compat/cc-model-aliases/tests/integration.spec.ts:24-67`; seed
   BOTH `DSH_HOME` and `CLAUDE_CONFIG_DIR` to tmp per the plugin-manager
   house rule): mount `mountAgentLoopTestDependencies(ctx)` PLUS
   `ctx.plugin(AgentLoop, …)` and a registered MockAdapter (the kit's
   dependency mount includes NEITHER the loop NOR an adapter —
   `agent-loop-testkit/src/index.ts:58-59`; the reference spec supplies them
   at `integration.spec.ts:64,79-84`) PLUS an explicit
   `ctx.plugin(JsonlSessionPersistence, { root: tmp })` — agent-loop
   `resume()` hard-throws without a persistence backend
   (`deepseek-harness/packages/core/agent-loop/src/index.ts:807-812`) — plus
   `SubagentRuntime` + `SubagentSpawn` for the subagent leg. Note this mount
   has NO `dshHomePath` seam (the kit does not provide one), so the ledger
   lands on the `$DSH_HOME` fallback of §3.3 — exactly why the env seed is
   mandatory (a handoff-style silent no-op is the failure mode it prevents).
   Boot a session with the plugin ⇒ exactly one row in
   `<dshHome>/config-snapshot/<encodedId>.jsonl`; DISPOSE the live handle
   before resuming (resume takes exclusive write ownership; disposal
   precedent `agent-loop/tests/resume.spec.ts:609-616`; implementation note: a freshly created session has zero stored events and disposing it rolls the session back (log deleted), so the resume leg must first run one stored turn via `agent.followup(...)` to idle before dispose — the resume itself still goes through `ctx.agents.resume({ resumeSessionId })`). Resume ⇒ a second
   row in the same file with a distinct `seq` (`appendedAt` may tie, §3.4); spawn a subagent ⇒ the
   child session's own file carries a row with `delegationDepth: 1` and
   `parentSession` set. Assertions run only after a bounded settle (drain the
   plugin's per-file write queue or poll until the file is stable) — the
   writer is fire-and-forget, so an unwaited assertion races it. This test
   settles the remaining TEST-PENDING (§3.2): child-session firing of
   `session/created`. Bonus tripwire: running the resume leg over the REAL
   jsonl backend also guards the sidecar purity — had this plugin (or a
   regression) appended an unknown non-ignorable row into the transcript,
   the resume's backend open would fail outright (§3.0).
5. Resilience and identity: (a) an unwritable sidecar root leaves session
   CREATION succeeding — the fake-session fixtures of item 1 never exercise
   the real `session/created` announce path (§3.2: a sync throw there vetoes
   creation), so this leg must run through the item-4 mounts; it also covers
   a THROWING settings reader (fail-open §3.6) never blocking creation;
   (b) `bootId` identical across rows within one activation, and different
   after a second plugin mount (remount = new activation id, §3.4).
6. Disabled flag: `config-snapshot.enabled: false` ⇒ no file created.
7. Repo gates: `pnpm check:capabilities`, `docs:parity` regen, README trio
   gate, `check:size`, `check:exports`, `check:spec-deps`,
   `check:deep-imports` (CI-only), preset composition pin, and the
   release.mjs lockstep: a dry run must show BOTH
   `FALLBACK_VERSION` constants (command-version's and this package's,
   §3.5 (a)) tracking the release version.

Dogfood: none needed beyond presence-by-default; first consumer is
session-forensics/regression attribution (§6).

## 6. Consumers that justify the feature (so it is not speculative)

- Gauge threshold recalibration: join `permission/classifier` transcript rows
  to the sidecar file of the same session id → app-version-cohorted
  calibration instead of cross-version soup.
- Dogfood incident forensics: "did this regression appear with the plugin
  update or the model update" becomes answerable with one join.
- Any future self-modifying feature mandated by the A11 discipline gates on
  this attribution substrate.

## 7. Follow-ups

1. In-trace promotion, gated on an upstream producer-side `ignorable` append
   channel (or upstream admission of a snapshot event type), per the §3.0
   evidence chain; harness repo is read-only locally, so this is an upstream
   proposal only.
2. Pre-existing resume poisoning: sessions carrying dsh-cc custom events
   (`permission/probe|classifier`, `tool/code-dispatch*`) already fail the
   persistence backend's open at this pin (§3.0 item 4). Separate remediation —
   decide with the same upstream conversation.
3. Upstream proposal: mount a real `harnessVersion` provider in the harness
   (the consumption seam exists in dsh-cc today; the provider side is the
   upstream patch).
4. Per-request route/effort stamping (the same transport constraint applies —
   sidecar first).
5. session-forensics views that group by snapshot fields.

## 8. Review ledger

Round 1 (internal critic, 2026-10-09): verdict **GO-WITH-AMENDMENTS**; 4 MAJOR
+ 7 MINOR findings, all adopted into draft v2 (F1 plugins `Record<string,
InstallEntry[]>` shape + no `name` field; F2 harnessVersion normalization
copied from consumer pattern, false self-upgrade claim deleted; F3 child/subagent
sessions + discriminator fields; F4 plain listener style; F5 `note?` in schema;
F6 `dshCc` typed `string` never null; F7 registerNamespaceSafe anchor fix;
F8 fire-and-forget timing note; F9 `v` → `schemaVersion`; F10 basename-privacy
moved to §2 non-goals). Upstream UNVERIFIABLE items, all marked TEST-PENDING
in text: no harnessVersion provider at this pin; resume constructs a fresh
Session for the same id; session/created firing for child/subagent sessions.

### Round 2 (delta confirm) — GO-WITH-AMENDMENTS → folded → GO (draft v3)

- Verdict: GO-WITH-AMENDMENTS with 4 minors (no third review needed per critic):
  discriminator fields added to the schema block; cross-references §5.3/§5.4 →
  §5 item 4 (3 sites); item 4 gained the spawn-subagent assertion; "confirming"
  softened to "suggesting"; ledger F10 wording fixed.
- Folded by orchestrator targeted edits, this same commit.
- Net status after round 2: GO.

### Round 3 (doc-vs-code audit → sidecar pivot) (draft v4)

Orchestrator audit of v3 against the dsh-cc tree and the pinned harness tree
(`c1b47e41fc` = 0.2.0-rc.2), 2026-10-09. Findings:

- **BLOCKER — ignorable gap.** `session.append` of a downstream-typed event
  writes a non-ignorable row; `KNOWN_SESSION_EVENT_TYPES` excludes downstream
  types by construction; `validateStoredEvents` refuses unknown non-ignorable
  types on read AND write open; `Session.append` has no producer-side ignorable
  channel. Live probe: a real session carrying `permission/classifier` fails
  both `open(read)` and `open(write)` today (§3.0). v3's "no behavior change"
  claim was false at this pin; additionally v3's §5 item 4 named no
  persistence mount, so it would not have exercised the strict read path —
  fake-vs-real gap class. (Correction applied in round 4: the dsh-cc
  integration pattern DOES mount the real backend explicitly —
  `cc-model-aliases/tests/integration.spec.ts:60-67` — while the kit's
  dependency mount and the mock-adapter helper do not include one; v3's item
  4 simply failed to name the mount.)
- Ancillary: same mechanism means sessions carrying EXISTING dsh-cc custom
  events are already un-resumable via the backend — logged as §7 follow-up 2.
- `bootId` semantics contradiction (per-construction value described as
  per-boot) — fixed: per-boot constant + per-row `appendedAt` (§3.4).
- §3.3(d) sources not importable (`loadInstalledPlugins` et al. are not
  exported from `@dsh-cc/plugin-manager`) — switched to the public
  `listInstalled`, which additionally yields merged dual-home view and C9
  `effectiveEnabled` (§3.5 (d)).
- Dual-home caliber: raw single-home read would miss claude-only installs and
  misreport dsh-shadowed ids — resolved by the `listInstalled` seam.
- In-transcript discriminator duplication claim was mistaken on facts
  (header fields list cited incompletely in v3 §1); in the sidecar design the
  header-payload copy is justified consumption, and `origin` was added.
- `installPath` basename example (`@scope/name-1.2.3`) contradicted production
  data (cache layout basename == bare version string) — rationale rewritten,
  field kept for non-cache installs (§3.5 (d)).
- `session/created` failure semantics now pinned: sync throw vetoes creation;
  async rejection is harness-warn-logged — drives §3.2/§3.7 shape.
- Listener style flipped plain → `{ global: true }` (uniform invariant
  precedent; v3's F4 adopted a plain listener on a scope argument that did not
  account for subagent-realm visibility; the §5 item 4 subagent assertion
  requires capture beyond the plugin row's subtree).
- Mount-time seeding considered and rejected (wrong attribution semantics);
  gap documented (§3.2).
- `ccPlugins.ts:134` anchor did not demonstrate its claim — claim kept,
  re-anchored to the mount-summary surface (§3.5 (d)).
- Gate list corrected: `check:size` (not `check:file-size`) + `check:exports` /
  `check:spec-deps` / `check:deep-imports` added (§5 item 7).
- `preset.id` accessor aligned with the consumer precedent's typeof guard;
  `readOwnVersion` duplication rationale corrected (deep-imports gate).
- Direction decision (sidecar vs upstream-gated in-trace vs defer) taken by
  the user, 2026-10-09: **sidecar**.

### Round 4 (critic review of v4) — GO-WITH-AMENDMENTS → folded

Verdict: GO-WITH-AMENDMENTS, 3 MAJOR + 5 MINOR, all folded by orchestrator
edits documented above (verified first against repo/harness sources):

- M1 §5 item 4 named no mounts and is unexecutable as written — now pins the
  dsh-cc integration pattern and the explicit `JsonlSessionPersistence` mount
  (reference spec `cc-model-aliases/tests/integration.spec.ts:24-67`; agent-loop
  resume hard-requires persistence, `agent-loop/src/index.ts:807-812`), and
  gains the real-backend tripwire reading. §8 round-3's parenthetical about
  "no persistence wiring" corrected accordingly.
- M2 consumer row-selection rule for multi-row files — added to §3.4
  (greatest `appendedAt` ≤ event time).
- M3 `appendedAt` capture point and per-file write serialization unpinned —
  pinned: sync-listener capture + per-sessionId serialized queue (§3.4).
- m4 crash-mid-append trailing line — reader tolerance note added (§3.7).
- m5 absent-header → row mapping — `delegationDepth ?? 0`,
  `parentSession/origin ?? null` (§3.4).
- m6 test gaps — added §5 item 5 (unwritable root ⇒ creation still succeeds
  on the real announce path; `bootId` constancy/distinctness).
- m7 `session/created` listener-style claim rescoped to invariant files, with
  the plain-style behavioral precedents named (§3.2); anchor line numbers
  disambiguated between the dsh-cc copy (`:87-88`) and the harness copy
  (`:88-89`).
- m8 `listInstalled` visibility-caliber caveat recorded (§3.5 (d)).

Critic re-verified the load-bearing anchors as correct (listInstalled
behavior/exports, dshHomePath seam, sync-throw rollback + async-warn
semantics, validateStoredEvents refusal, KNOWN-set-by-construction,
header fields, registerNamespaceSafe, readOwnVersion, harnessVersion
normalization and zero-provider probe, preset rows, resume re-announce).
Remaining TEST-PENDING: child-session firing (§5 item 4).

Net status after round 4: internal critic **GO** (round 4 GO-WITH-AMENDMENTS,
all 8 findings folded; delta-confirm re-verified every fold — 8× RESOLVED, no
new defects). External blind review (codex/grok lanes) pending user direction;
user sign-off pending. Implementation has NOT started.

### Round 5 (external dual-seat blind review) — codex NO-GO / grok GO-WITH-AMENDMENTS → folded (draft v5)

Two external blind seats dispatched in parallel with independent briefs
(user-approved), each verifying its own anchors. Verdicts: codex NO-GO
(6 MAJOR + 3 MINOR), grok GO-WITH-AMENDMENTS (5 MAJOR + 8 MINOR). Severity
divergence adjudication: the verdict split is a calibration difference, not a
substance difference — the finding sets overlap heavily; on the
implement-as-written test several findings would ship real defects (unsafe
filename interpolation, crash rows swallowing the next append, stale `dshCc`
after a release), so the NO-GO level is respected and ALL findings from both
seats are folded. Convergence map (both seats independently hitting the same
defect = top-confidence folds):

- **Convergent (both seats):** raw-session-id-as-filename is unsafe —
  `SessionId` is an unvalidated brand, so the row set must use an
  `encodeSegment`-style injective encoding and carry the raw `sessionId` in
  the row (codex M5 ≡ grok #2; grok adds: not root-exported, deep import
  trips `check:deep-imports` — copy the algorithm). Millisecond timestamps
  do not constitute row identity, and remount-new-bootId contradicted
  "one process boot shares it" (codex M6 ≡ grok #9/#12) — identity is now
  (file, `seq`), `bootId` is per-ACTIVATION, `appendedAt` advisory. The
  earliest-row fallback invented historical coverage and misattributed
  resume pre-announcement events (codex M3 ≡ grok #1) — fallback dropped,
  unknown semantics + setup-window unknowns documented. The second
  FALLBACK_VERSION copy would not follow release bumps (codex m7 ≡ grok #3;
  `scripts/release.mjs:166-200` rewrites only command-version's) — added to
  the lockstep rewrite + release dry-run gate. The integration recipe was
  not executable as written (codex m8 ≡ grok #4) — AgentLoop + MockAdapter
  mounts, dispose-before-resume, bounded settle, and the no-dshHomePath-in-
  kit note folded into §5 item 4.
- **Codex-only (verified true):** listInstalled rows are an INVENTORY, not
  the loaded set — the loader picks one installation per id by `lastUpdated`
  (`discovery.ts:190-193,284-293`); folded as the `loaderSelected` flag with
  documented tie-break/directory-existence approximations (M1). Crash
  recovery lost the NEXT row after a torn tail (append concatenates onto the
  fragment; M4) — repair-on-append folded (§3.3/§4). `appendedAt` precedes
  the async config observation (M2) — capture-initiation semantics +
  non-atomicity caveat folded (§3.4). Corrupt-state `note` must be a
  sanitized reason code because `malformedStateFile` embeds absolute paths
  (m9).
- **Grok-only (verified true):** a settings read on the sync path can veto
  session creation (`settings-ns` reader rethrows, `index.ts:166/:179`) —
  enabled read moved into the async writer, fail-open `true` (grok #5, §3.6).
  §3.3's ledger-directory dshHome would leak into `PathInputs` and resolve
  plugin state under `config-snapshot/plugins` (grok #8) — bare-home
  resolution folded. The harness schedule listener is actually
  `{ global: true }` at `:205` (grok #6) — example list corrected. The
  sync-throw test anchor was the wrong test (grok #7) — retargeted to
  `session.spec.ts:1522-1536`. Entries with no `projectPath` are visible
  from every cwd (grok #10) — caliber note. Spawn-suite listeners are
  cancel-path assertions, not firing evidence (grok #13) — supporting
  clause dropped, firing stays TEST-PENDING. Ledger cross-ref `§5 item 6`
  → item 7 (grok #11).
- One previously-folded claim of ours was retracted: "fallback constant kept
  in sync by the release-train bump" was false for a second copy (both seats).

Net status after round 5: all 14+9 findings from both external seats folded;
delta-confirmation round pending. User sign-off pending. Implementation has
NOT started.

### Round 6 (delta-confirm on both external seats) — both NO-GO on fold precision → folded (draft v6)

Both seats received delta-only briefs (their own findings → fold locations).
Results: codex 6× OK / 3 PROBLEM + 2 NEW (VERDICT NO-GO, 45k tokens); grok
10× OK / 3 PROBLEM (VERDICT NO-GO, $0.47/24 turns). The three PROBLEM items
were THE SAME DEFECTS on both seats, independently (top-confidence findings):

1. **Selection rule contradicted its own "setup-window unknown" claim** —
   the greatest-`appendedAt`-≤-t rule mechanically assigns resume
   setup-window events (closers, `session/end-seed`) to the PREVIOUS row.
   Fold: the rule is now normative; the setup-window residual is an
   enumerated, accepted misattribution (metadata-only events); unknown is
   rescoped to pre-first-row events and no-row constructions (§3.4).
2. **`bootId` same-millisecond activation collision** — folded as
   `${pid}-${Date.now()}-${activationCount}` with a per-process activation
   counter (§3.4).
3. **`seq` not restored across restart/remount** — folded: assigned by the
   per-file serialized queue (not the sync listener), lazily initialized
   from the file's existing rows on first use per activation (last `seq`+1;
   parseable-line count +1 for a torn tail), making (file, `seq`) unique
   across processes, activations, and resumes (§3.4, §3.2).

Codex-only deltas folded alongside: the `loaderSelected` flag is computed
over the VISIBLE row set while the loader applies no cwd visibility
filtering — divergence recorded as a documented approximation (§3.5 (d));
§5 item 4's "distinct `seq`/`appendedAt`" over-promised `appendedAt`
distinctness — reworded (§5 item 4); §4's row-separation phrasing updated to
`seq`.

Finding categories continued to decline (round 5: architecture/semantics →
round 6: precision of the folds themselves), the established convergence
signal. Next delta-confirm round pending.

Net status after round 6: 3+3 convergent and 2 codex-only findings folded;
delta re-confirmation pending on both seats. User sign-off pending.
Implementation has NOT started.

### Round 7 (delta-confirm round 2 on both seats) — folded (draft v7)

Results: codex 4× OK / 1 PROBLEM; grok 4× OK / 1 PROBLEM + 1 NEW.

- `seq` initialization hardened (codex): total LINE count + 1, counting
  unparseable lines — collision-free even after interior corruption
  (parseable-count+1 could equal a later existing `seq`); the uniqueness
  claim is scoped under the single-writer assumption the transcript write
  lease already enforces (concurrent multi-process capture of one session
  id out of scope, not claimed) (§3.4).
- Setup-window characterization corrected (grok): the window is NOT
  metadata-only — interrupted-turn closers are `tool/result` synthetic
  errors closing the PREVIOUS boot's interrupted turn (attribution to the
  previous row is semantically appropriate for them), and early posture
  events (`sandbox/mode`, `approval/policy`, `permission/preset`) may land
  in the window (bounded imprecision, accepted, not claimed as correct);
  residual (a) now carries the "when a previous row exists, else unknown"
  qualifier (§3.4).
- `loaderSelected` enabled-scoping (grok): the flag is set only on ids
  whose effective enablement is TRUE — the loader walks only enabled keys
  (`discovery.ts:190`), so a disabled id gets NO flag row; §5 item 3 gains
  the disabled-id assertion (§3.5 (d)).

Finding categories continue to decline (round 5 architecture/semantics →
round 6 fold precision → round 7 initialization/characterization details).
Micro-confirm round pending on both seats.

Net status after round 7: three findings folded; micro-confirm pending.
User sign-off pending. Implementation has NOT started.

### Round 8 (micro-confirm close-out) — both external seats GO

Micro-confirm rounds (fold locations + one direct question, per the
established closing form):

- **codex**: first run interrupted twice with the SAME flake signature
  (stale-verdict reprint of the delta-2 block + Rust stderr panic
  `os error 35`, exit 101 — the retry's work trace shows a pathological
  repo-wide rg flooding the pipe; neither run formed a verdict, both
  recorded interrupted). A scope-constrained third run (user-approved;
  brief pinned the exact section and forbade broad greps) returned
  **`#3 OK` — VERDICT: GO** (11.8k tokens).
- **grok**: micro-confirm 1 returned the `loaderSelected` fold OK and one
  PROBLEM on residual (a)'s closers characterization — corrected and
  folded: synthetic repair closers are the trio (missing `tool/result`
  when a call is pending, `step/end` when a step is open, always
  `turn/end`, `session/src/repair.ts:88-96`) and REUSE the last persisted
  event's timestamp (`repair.ts:86-90`), so they attribute to the previous
  row BY TIME and semantics — not a misattribution; residual (a) is now
  three-part (closers / fresh setup-window stamps / no-row constructions)
  (§3.4). Micro-confirm 2: **`#1 OK` — VERDICT: GO** ($0.51/27 turns).

Net status after round 8: **all review seats GO** — internal critic (round
4 + delta confirm), external codex and grok (rounds 5-8: full review, two
delta rounds, micro-confirm). User sign-off pending. Implementation has
NOT started.
