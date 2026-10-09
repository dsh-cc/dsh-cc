# Session config snapshot event (config-in-trace) (design)

- Date: 2026-10-09
- Status: draft v3 — internal critic GO after 2 rounds; user sign-off pending. NOT yet implemented.
- Scope: new package `packages/observability/config-snapshot`; capability manifest row; preset registration. One new session event type via module augmentation. No harness-upstream dependency; no behavior change for users (append-only transcript data).
- Sources: AHE / Demystifying Evals / Terminal Agents Survey (harness identity must ride the trace or model-vs-scaffold effects confound); Finding the Right Fit (66-config empirical: model rankings *invert* across harnesses); GSME/12227 credit discipline: any future self-modifying feature (threshold recalibration, skill scoring, dream consolidation) needs an attribution substrate first.

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
  version.** The header carries `agentPreset` and transcript-format `version: 4`
  only.

Consequence: across any version/dependency change, dogfood data, threshold
recalibration, and regression forensics cannot attribute behavior deltas to
model vs harness vs plugin configuration. Every planned adaptive feature in the
borrowed set (threshold recalibration, skill scoring, memory consolidation
policies) presumes this substrate, per GSME's "separate proposer from
credit-assigner" rule and 12227's warning that gains measured on the same
traffic they gate are confounded.

## 2. Goals and non-goals

Goal: every session transcript self-describes the configuration that produced
it, at Session construction time, as a typed session event.

Non-goals:

- No per-request route stamping upgrade (change-point `request/context` records
  stay as-is; finer-grained route/effort stamping is a follow-up, §7).
- No upstream change: the harness-version seam does not exist at this pin and is
  recorded as `null` until mounted (§3.3).
- No settings/privacy: the snapshot contains versions and identities only —
  no settings values, no paths beyond plugin `installPath` basenames.
- No basename stripping: `installPath` basenames may embed versions for cache
  installs (`@scope/name-1.2.3`), duplicating the `version` field. Accepted and
  recorded — the duplication is harmless, and dropping the basename would lose
  the install identity that disambiguates cache layouts.

## 3. Design

### 3.1 Package and registration

New package `packages/observability/config-snapshot` (`@dsh-cc/config-snapshot`),
plain cordis plugin (handoff-store precedent: no Service subclass, no isolate
key). Registration: preset service-group row + capability manifest row + README
trio, same commit; composition test pin bumped deliberately.

### 3.2 The event

Listener style: plain `ctx.on('session/created', (session) => …)` — payload is
the live `Session` object (precedent:
`packages/interaction/permission-rules/src/index.ts:294`). We deliberately do
NOT use hook-protocol's `{ global: true }` listener style
(`packages/hooks/hook-protocol/src/invariant.ts:88`): that flag serves hook
protocol invariants (seed per realm scope), not observability. The plugin row's
own lifecycle scope is the intended capture scope. The seam is still clean: the
append target is the payload itself, no handle resolution.

Append one event per `Session` construction — note this fires for child and
subagent sessions too (hook-protocol's own listener at
`invariant.ts:88` is `{ global: true }` and seeds per session, suggesting
session/created fires for every session). The payload therefore carries
discriminator fields (`session.header.delegationDepth`, verified in-repo as a
duck-typed header field at `packages/memory/memory/tests/recall.spec.ts:243`;
`parentSession`, a `SessionHeader` field per
`packages/interaction/command-resume/src/resume.ts:34`):

```ts
session.append('cc-config/snapshot', {
  schemaVersion: 1,
  bootId: `${process.pid}-${Date.now()}`,
  dshCc: string,                 // §3.3 (a) — never null
  harness: string | null,        // §3.3 (b)
  preset: { id: string | null }, // §3.3 (c)
  plugins: [{ id, scope, version, installPathBasename }],  // §3.3 (d), sorted by id then scope
  note?: string,                 // set when plugins data is missing/corrupt (§3.3 (d))
  delegationDepth: number | null,  // session.header discriminator (root vs subagent)
  parentSession: string | null,    // session.header discriminator
})
```

The listener also copies `session.header.delegationDepth` and
`session.header.parentSession` into the appended payload (fields of the same
name) so consumers can partition root vs subagent sessions. Whether the
harness actually fires `session/created` for child sessions is asserted by the
§5 item 4 integration test — TEST-PENDING until it runs.

Type registration by module augmentation in this package's `types.ts`:

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'cc-config/snapshot': ConfigSnapshot }
}
```

Augmentation pattern precedents: `packages/hooks/hook-protocol/src/types.ts:8-9`,
`packages/core/tools/src/types.ts:25`,
`packages/core/tool-workflow/src/types.ts:57`.
`Session.append(type, data)` is the harness session class method used the same
way by CCR's swap (`packages/context/context-crusher/src/defer/swap.ts:131-142`).

Timing note (written for implementers): the listener is fire-and-forget — the
append lands whenever it is ready relative to other boot events; consumers must
join by `session.id`, never by append order (§6). Resume constructs a fresh
`Session` object for the same session id (TEST-PENDING: asserted by the §5 item 4
integration test), so a resumed session accumulates one snapshot per Session
construction — that is a feature (it is exactly the version-change evidence
we want), keyed apart by `bootId`. Do not dedupe.

### 3.3 Field sources (all probe-verified accessors)

(a) `dshCc` — typed `string`, never null. Read this repo's own `package.json`
    version via the existing helper pattern `readOwnVersion()`
    (`packages/interaction/command-version/src/version.ts:26`, fallback constant
    `:14`) — the copy reads THIS package's `package.json` and is correct because
    workspace packages share the release-train version. Copy the ~15-line helper
    into this package (cross-package import of command-version internals is not
    available; deliberate duplication).
(b) `harness` — normalize `ctx.get('harnessVersion')` to a plain `string | null`
    using the SAME duck-typed normalization the in-repo consumers use — accept
    `string | { version: string }` and narrow to `string`
    (`packages/interaction/command-version/src/index.ts:16-24`,
    `packages/interaction/command-doctor/src/checks/env.ts:12-18`); the snapshot
    stores that normalized plain string or null, never the raw wire shape. At
    this harness pin **no provider exists** (probe: zero providers in the
    harness tree), so the value is `null` and the doc requires a code comment
    saying so. The normalization handles both wire shapes, so when a provider
    mounts, recorded values upgrade from `null` to a string with no
    event-schema change.
(c) `preset.id` — `ctx.get('agentPresets')?.defaultId ?? null` (accessor
    precedent: `packages/interaction/command-doctor/src/checks/session.ts:66-70`).
    Per-session preset overrides (`agent-preset/selected` events,
    `headers.agentPreset`) are already in the transcript; the snapshot records
    the process default only.
(d) `plugins` — read `<dshHome>/plugins/installed_plugins.json` via the existing
    loader `loadInstalledPlugins`
    (`packages/compat/cc-plugin-manager/src/state-store.ts:50`; path helper
    `paths.ts:65`). The file shape is `Record<string, InstallEntry[]>` —
    `InstalledPluginsFile.plugins` at
    `cc-plugin-manager/src/types.ts:50` — one plugin id mapping to MULTIPLE
    entries, one per scope. `InstallEntry` (`cc-plugin-manager/src/types.ts:37`)
    has fields `scope`/`installPath`/`version`/`installedAt` (plus
    `lastUpdated`/`gitCommitSha?`/`projectPath?`) and NO `name` field. Emit one
    row per (id × scope): `id` is the map key (the plugin id — NOT an
    InstallEntry field), and each row carries that entry's `scope`. Only the
    *basename* of `installPath` is recorded (privacy: no absolute user paths in
    the transcript; see §2 non-goals on the basename/version duplication).
    Missing/corrupt file ⇒ `plugins: []` plus a `note` field saying why. The
    in-process `ccPlugins` summary is rejected as a source (carries no version —
    `packages/bundle/cc-shell/src/ccPlugins.ts:134`). In-repo preset/plugin
    packages are versioned with the release train, so `dshCc` covers them; the
    array covers marketplace/user installs.

### 3.4 Configuration

One key, kebab namespace convention (`registerNamespaceSafe` family, precedent
import at `packages/interaction/advisor-watchdog/src/settings.ts:23`, call at
`settings.ts:90`):

- `config-snapshot.enabled` — default `true`. This is append-only local
  transcript data with no runtime behavior effect; a kill switch exists for
  minimal-footprint consumers.

### 3.5 Failure discipline

The listener is observability: any exception (unreadable plugins file, augment
mismatch, append validation failure) is caught, logged at debug level, and
swallowed. It must never abort session construction. No waterfall decisions are
touched; there is no passthrough to degrade.

## 4. Failure modes and mitigations

- Fresh install without `installed_plugins.json` ⇒ `plugins: []` + note (not an
  error path).
- Event validation: `SessionEventMap` augmentation keeps the append typechecked;
  a deliberately wrong field type is a compile error, which is the point of
  declaring the event instead of an untyped append.
- Snapshots are small (one per Session construction — N per boot when a session
  spawns subagents; `bootId` + `session.id` join keys keep them apart); no
  retention management.

## 5. Verification plan

1. Unit: with a fake session capture object (permission-rules' own spec
   fixtures are the precedent for session/created listeners), assert event type,
   field set, sorted plugins, `null`-tolerance for harness version.
2. Unit: corrupt/missing plugins file ⇒ `[]` + note, no throw.
3. Unit: an id installed in TWO scopes in the fixture file ⇒ two plugin rows,
   same `id`, distinct `scope`, each row carrying its entry's `version`.
4. Integration (existing testkit pattern): boot a session with the plugin ⇒
   exactly one `cc-config/snapshot` event; resume the session ⇒ a second event,
   same session id, different bootId; spawn a subagent ⇒ the child session also
   carries a snapshot, with `delegationDepth: 1` and `parentSession` set. This
   test settles the TEST-PENDING items (§3.2): child-session firing,
   resume-constructs-new-Session.
5. Repo gates: `pnpm check:capabilities`, `docs:parity` untouched-surface,
   README trio gate, `check:file-size`, preset composition pin.

Dogfood: none needed beyond presence-by-default; first consumer is
session-forensics/regression attribution (§7).

## 6. Consumers that justify the event (so it is not speculative)

Consumer timing note: the snapshot append is fire-and-forget — it lands
whenever it is ready relative to other boot events, so consumers must join by
`session.id` (and `bootId` for per-boot provenance), never by append order or
event adjacency in the transcript.

- Gauge threshold recalibration: join `permission/classifier` rows to the
  snapshot of the same session id → app-version-cohorted calibration instead of
  cross-version soup.
- Dogfood incident forensics: "did this regression appear with the plugin
  update or the model update" becomes answerable with one join.
- Any future self-modifying feature mandated by the A11 discipline gates on
  this attribution substrate.

## 7. Follow-ups

1. Upstream proposal: mount a real `harnessVersion` provider in the harness
   (the consumption seam exists in dsh-cc today; the provider side is the
   upstream patch).
2. Per-request route/effort stamping (graduating `request/context` from
   change-point to per-request, if dogfood shows change-point granularity is
   insufficient).
3. session-forensics views that group by snapshot fields.

## 8. Review ledger

Round 1 (internal critic, 2026-10-09): verdict **GO-WITH-AMENDMENTS**; 4 MAJOR
+ 7 MINOR findings, all adopted into this draft (F1 plugins `Record<string,
InstallEntry[]>` shape + no `name` field; F2 harnessVersion normalization
copied from consumer pattern, false self-upgrade claim deleted; F3 child/subagent
sessions + discriminator fields; F4 plain listener style; F5 `note?` in schema;
F6 `dshCc` typed `string` never null; F7 registerNamespaceSafe anchor fix;
F8 fire-and-forget timing note; F9 `v` → `schemaVersion`; F10 basename-privacy
moved to §2 non-goals). Upstream UNVERIFIABLE items,
all marked TEST-PENDING in text: no harnessVersion provider at this pin;
resume constructs a fresh Session for the same id; session/created firing for
child/subagent sessions — each gated on the §5 item 4 integration test.

### Round 2 (delta confirm) — GO-WITH-AMENDMENTS → folded → GO

- Verdict: GO-WITH-AMENDMENTS with 4 minors (no third review needed per critic):
  discriminator fields added to the schema block; cross-references §5.3/§5.4 →
  §5 item 4 (3 sites); item 4 gained the spawn-subagent assertion; "confirming"
  softened to "suggesting"; ledger F10 wording fixed.
- Folded by orchestrator targeted edits, this same commit.
- Net status after round 2: GO.
