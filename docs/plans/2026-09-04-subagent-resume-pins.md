# Pinned resume descriptors for continuable subagents ("resume pins")

Status: **Implemented** — PR #104 (merged 2026-09-04). Designed — two rounds of dual blind review (deep-reasoner + Codex), all
findings folded. Round 1 replaced tool shadowing with `tools/pre-execute`/
`tools/post-execute` and post-hoc aggregate storage with preallocated per-child
pin files; round 2 folded spawn-degradation (preflight never rejects), explicit
presence/absence semantics, persist-before-deny ordering + shared PinStore cache
coherence, gate-evaluated (non-authoritative) route-current overlays, atomic
selector provenance (`resolveDetailed`), and `PIN_ORPHANED` semantics.

Status: **implemented** (2026-09-04) — all packages landed and green
(`packages/subagent/resume-pins`, `packages/subagent/task` capture, cc preset
row `cc-resume-pins` + cc-shell composition test). This doc remains the design
record; where the text below predates the build, the as-built facts are: the
settings namespace is kebab-case `subagents-resume` (not the dotted
`subagents.resume` sketched in §4.9); the policy-block gate outcomes carry their
own deny codes — `WORKSPACE_CHANGED` (§4.6 step 2 under
`onWorkspaceChanged=block`) and `DEFINITION_CHANGED` (§4.6 step 3 under
`onDefinitionChanged=block`) — alongside the hard-fail codes; production
mounting derives `pinsRoot` at composition time via the loader's `!!js`
expressions (`dshHomePath('sessions', 'resume-pins')`), colocated with the
harness base patch's jsonl session-persistence root.
Date: 2026-09-04
Scope: `packages/subagent/task` (spawn capture), `packages/compat/cc-model-aliases`
(new atomic `resolveDetailed` provenance API), new package
`packages/subagent/resume-pins` (store + gate + overlay), preset/cc-shell mounting
wiring, tests, parity docs. Explicitly out of scope: harness changes
(`@deepseek-ai/dsh-subagent`, pinned at `DSH_HARNESS_REF=b150a551b8`).

## 1. Problem

Background continuable subagents survive process exit through the harness's jsonl
session persistence. On the next `send_message` to an unloaded child, the harness
cold-resumes it: a fresh Activation is materialized from the persisted session plus
the persisted `subagent/descriptor` event. That descriptor restores exactly
`label`, `agentProvider`, `agentModel`, `persona`, `toolFilter`
(harness `descriptor.ts:71-83`); `coldResume` rebuilds `agentOptions` from it alone
(`continuation.ts:981-985`) and `followup` accepts no caller overrides
(`continuation.ts:149-155`). Everything else is silently re-derived from *current*
defaults at resume time:

- `maxTokens` is unconditionally dropped (options-only; omitted from the descriptor
  by design, `descriptor.ts:15-19`).
- `reasoningEffort` is dropped when the alias/route drifted or the value was an
  adapter default (on a same-route resume it *may* be restored from the persisted
  request header, `agent-loop/src/agent.ts:438-445` — do not rely on this).
- Agent definition identity, `maxTurns`, background mode, persona integrity, and
  workspace/worktree identity are persisted nowhere.
- There is no definition-change detection, no model-availability validation (unknown
  model ids pass through verbatim, `resolver.ts:152-158`), no blocked state anywhere
  (agent statuses are `idle|running`; coordinator lists `running|idle|ready`,
  `coordinator/src/index.ts:310`), and no explicit fallback policy.

Net effect today: a resumed agent can silently run with different reasoning effort,
token budget, or even a different effective model than it had when spawned.

## 2. Goals and non-goals

P0 (this PR):

- Persist, at spawn time and outside the closed harness descriptor, a complete
  **resume pin** per continuable background child: definition identity + semantic
  fingerprint, effective `provider`/`model`/`reasoningEffort`/`maxTokens`,
  `maxTurns` (audit-only), sanitized tool filter, background mode, persona hash,
  workspace/worktree identity, provenance of the model selector.
- On cold resume, never re-guess pinned runtime options from current defaults:
  re-apply the pinned effective config on **every** request of the resumed child.
- If the definition's execution-relevant content changed since spawn, surface
  "resumed with changed definition" (never silently).
- If the original provider/model is no longer available, the child enters a
  **blocked** state; nothing is substituted silently.
- Any fallback is an **explicit runtime policy** setting, off by default.
- Acceptance coverage of **spawn → process exit → cold start → `send_message`
  continues**, with assertions on the resumed request config.

P1 (same PR, small): `list_agents` output annotation for blocked /
changed-definition children; defense-in-depth failure any time a blocked child's
request is built through an unmonitored path.

Non-goals: harness descriptor v3 or any harness patch; enforcing `maxTurns`
(equally inert at first spawn today — pinned as metadata only); gating the
coordinator's direct `provider.followup` resume path (coordinator-spawned workers
are never pinned, `coordinator/src/index.ts:193-201`; a pinned child resumed via an
unmonitored path still gets its options via the overlay, plus the P1 throw when
blocked); upstreaming (a harness-side descriptor extension may obsolete the pin's
runtime-config fields later — see §9).

## 3. Verified mechanism ground rules

- The harness descriptor schema is closed (`assertKnownKeys` throws on unknown
  fields, `descriptor.ts:147-152`); the pin therefore lives in dsh-cc-owned storage.
- Option injection: a host-wide `agent/request` waterfall listener sees every agent
  request and may overlay the resolved request config by shallow copy **after**
  `next()` (existing precedent: `packages/compat/cc-model-aliases/src/service.ts:91-94`
  + `effort.ts:27-32`; `buildRequest` deep-freezes its seed, `agent.ts:447-456`).
  The listener receives the `Agent`; its durable session id equals the continuable
  `childId` (resume key) — pin lookup by session id is reliable.
- Tool gating must NOT use same-name re-registration: duplicate registrations on
  one layer throw (`tool-layer.ts:24-27`), and host-plane mounts invert precedence
  against the preset layer. Use the interception pipelines instead:
  `tools/pre-execute` (async gate; `{kind:'deny', reason}` produces a structured
  error result without running the tool body, `runtime-execute.ts:170-194`) and
  `tools/post-execute` (result content replacement for notices/annotations,
  `runtime-execute.ts:306-318`). Precedent: permission-rules, hooks-claude-code.
- Continuable childIds are caller-reservable before materialization
  (`spec.childId`, `continuation.ts:415`; reserved ids get a persisted-snapshot
  `DUPLICATE_CHILD` check, `:448-457`; failures before acceptance roll back the
  Activation and both ids, `:402-403` — so tombstone-on-throw can never orphan a
  live child) — this enables crash-consistent pin pre-creation (verify the exact
  `ContinuableStartSpec` field in Spike S2).
- Availability is checkable: `ctx.llm` exposes mounted-provider listing and
  exact-route validation (`resolveModelInfo` / `resolveCallConfig`,
  harness `llm/src/index.ts:442,646,766`) which also materializes adapter-default
  effort/maxTokens for an exact route.
- `permission/mode` precedent shows dsh-cc persists its own session event types;
  despite that, pins are **not** stored as session events (see §4.1 for why).
- Definition registry is cached for the process lifetime (`registry.ts:29-49`) and
  retains no file bytes; fresh change detection must re-read outside the cache.

## 4. Design

New package `packages/subagent/resume-pins` (`@dsh-cc/subagent-resume-pins`)
with four exports: pin types + `fingerprint` utilities, `PinStore`, `capturePin`
(used by the Task tool), and a cordis `apply(ctx)` plugin (gate + overlay +
settings namespace).

### 4.1 Pin store

- One JSON file per child: `<pinsRoot>/<childId>.json`, written atomically
  (write temp + rename). `pinsRoot` is plugin config; cc-shell wires it next to the
  harness session persistence root; tests point it at a temp dir.
- Per-child files eliminate the read-modify-write race of an aggregate file and
  bound corruption blast radius to one child. No GC hook exists for now — orphan
  pins are looked up only by live `childId`s and are harmless.
- Fail-closed: a pin file that exists but is corrupt or has an unsupported
  `version` resolves to **blocked** (`PIN_UNREADABLE`), never to "legacy
  pass-through". Only a *missing* pin means legacy/foreign child (pass through
  unchanged — coordinator workers, pre-feature sessions).
- Rejected alternative (reviewed): appending a custom `resume-pin` session event
  to the child's own jsonl log. It depends on unverified unknown-event load
  tolerance, cannot be written before the session exists (keeping the
  create-then-append crash window), and complicates fold-on-resume. Per-child
  files have verified fs semantics and enable pre-creation.

### 4.2 Pin schema (`version: 1`, tolerant reader — unknown fields ignored)

```jsonc
{
  "version": 1,
  "childId": "...",                  // preallocated, becomes the session id
  "parentSessionId": "...",
  "label": "...",
  "mode": "continuable-background",  // background mode; constant today
  "createdAt": "2026-09-04T...",
  "definition": {
    "kind": "named",                 // or { "kind": "plain" } for general-purpose spawns
    "agentType": "researcher",
    "source": "project | user | bundled",
    "fingerprint": "sha256:...",     // see 4.4
    "personaHash": "sha256:..."      // sha256 of the persona string forwarded at spawn
  },
  "modelSelector": { "raw": "sonnet", "via": "alias | literal | inherit" },
  "effective": {
    // Complete resolved config — see 4.3. `null` means explicitly ABSENT and
    // absence must be preserved on resume: a later adapter-introduced default
    // must not silently appear (gate step 5 compares field-by-field, absence
    // included). "complete" is false when the spawn-time preflight could not
    // resolve the route (4.3), degrading this pin to explicit-fields-only mode.
    "provider": "deepseek", "model": "...",
    "reasoningEffort": null, "maxTokens": 12345,
    "complete": true
  },
  "toolFilter": { "allow": ["..."], "deny": ["..."] },  // as sanitized+forwarded
  "maxTurns": 30,                    // from definition; audit-only, unenforced
  "workspace": { "cwd": "...", "gitDir": "...", "gitCommonDir": "...", "branch": "..." },
  "resume": { "state": "ok | blocked", "reason": "..." },
  "lastNotice": "..."
}
```

`mode` is constant today but pins the background-mode fact for future
foreground-continuable surfaces. `maxTurns` is audit metadata, not a resume
guarantee (inert at spawn and resume alike).

### 4.3 Capturing the *effective* config (never re-guessed later)

"Parent options overlaid with alias route" is insufficient twice over: adapter-default
`maxTokens`/effort materialize inside `prepareCall`, not in `AgentOptions`; and
`ResolvedRoute` carries no provenance, so recording `modelSelector.via` by a second
resolution would race settings changes.

- **Provenance**: extend `cc-model-aliases` with an atomic `resolveDetailed(selector)`
  returning `{selector, via: 'alias'|'literal'|'inherit', route}` from ONE settings
  snapshot; the Task tool and the gate both use it. (Additive API — no behavior
  change to `resolve`.)
- **Preflight**: resolve the child's explicit route (definition alias →
  `resolveDetailed` → overlaid on the parent's `provider`/`model`/`maxTokens`,
  `child-agent.ts:73-79` semantics), then run it through
  `ctx.llm.resolveCallConfig` to materialize the complete tuple
  `{provider, model, reasoningEffort, maxTokens}`, recording **absence
  explicitly as `null`** (absence is part of the contract: a default that appears
  later is drift, §4.6 step 5). That tuple is what the pin stores and what the
  overlay later re-applies.
- **Preflight failure must never fail the spawn.** The agent loop allows
  `agent/request` middleware to supply provider/model when `AgentOptions` lack
  them (`agent-loop/src/agent.ts:457`), so an unresolvable preflight does NOT
  imply a broken spawn. On preflight failure: proceed exactly as today, write the
  pin with explicit fields only and `effective.complete:false`, and emit a
  spawn-time warning ("resume pin degraded: route not preflightable; only
  explicit options pinned"). Gate/overlay operate on such pins in explicit-only
  mode, and absence-drift detection is unavailable for them (documented limit;
  the common dsh-cc compositions resolve from parent/options and pin complete
  tuples).

### 4.4 Definition fingerprint

A named definition is fingerprinted by hashing the canonical JSON of **all parsed
frontmatter fields plus the persona body** (`parse.ts` field set; persona =
markdown body or `prompt:` override). The rule is parse-level canonicalization:
comment/format-only edits produce no notice, and a change to ANY declared field —
consumed (`model`, `tools`, persona) or currently inert (`maxTurns`, `effort`) —
produces one. Inert fields are included on purpose: they express intent and may
become consumed later. Change detection at gate time bypasses the process-lifetime
registry cache by re-running discovery/parse for the definition directly
(Spike S4 decides the exact helper; the registry exposes `baseDir`/`filename` for
project/user sources, `types.ts:76-88`; bundled definitions are virtual — hash the
parsed fields, no file read needed). An unreadable/deleted definition file is the
"changed definition" class, not an error.

### 4.5 Spawn capture (in `packages/subagent/task/src/tool.ts` background path)

Order, for crash consistency:

1. Preallocate `childId` (UUID) in the tool.
2. Compute effective config (4.3), fingerprint (4.4), workspace identity
   (`cwd`, `gitDir`, `gitCommonDir`, `branch`), write the pin file **first**.
3. Call `startContinuable` **with the reserved childId** (verify field name in S2).
4. If `startContinuable` throws, tombstone the pin (delete file; on delete
   failure, rewrite it with `resume.state='blocked', reason='spawn-aborted'` so it
   can never be mistaken for a live agent).

Only continuable background spawns are pinned. `general-purpose` spawns write a
`kind:'plain'` pin (no definition fields). `fork` is foreground-only and out of
scope.

### 4.6 Resume gate — `tools/pre-execute` listener

Fires on every tool call; acts only when all of: tool is `send_message`; target
`subagent_id` has a pin; child has **no live Activation** (`ctx.agents.get` —
same-epoch followups to a live agent are untouched). The gate **fully
re-evaluates** on every cold resume: a persisted `resume.state='blocked'` never
short-circuits (policy flips and recovered conditions are authoritative; the
stored state is derived, not a decision). Then, in order:

0. **Session exists?** `sessionPersistence.inspect(childId)` finds no persisted
   session → the pin is an orphan of an aborted spawn → deny `PIN_ORPHANED`
   (fail-closed; the child id is unaddressable, so this is unforgeable).
1. **Pin readable?** Corrupt/unsupported → deny `PIN_UNREADABLE` (fail-closed).
2. **Workspace**: pinned `cwd` must exist on disk → else deny `WORKSPACE_MISSING`
   (no fallback exists). Canonical repo identity (`gitDir`+`gitCommonDir`) differs
   → policy `onWorkspaceChanged` (default `resume-with-notice`; `block`
   available). Branch-only drift → notice, independent of policy.
3. **Definition** (named pins only): re-fingerprint (4.4). Mismatch or missing →
   policy `onDefinitionChanged` (default `resume-with-notice`; `block` available).
   The notice states that the child keeps its **pinned persona/tool filter** —
   the harness descriptor restores those, so nothing is re-guessed even when the
   file changed.
4. **Tool filter**: every pinned `allow`/`deny` name must still be in the current
   restrictable universe (`ctx.tools.view(agent).restrictableNames`,
   `sanitize-filter.ts:70-105`). Missing → deny `PINNED_TOOL_UNAVAILABLE`, no
   fallback (pruning a deny entry would widen permissions; pruning an allow entry
   shrinks capability — neither is a safe silent operation).
5. **Model/route availability & drift** (complete pins): pinned provider mounted
   **and** `resolveCallConfig` re-resolution of the pinned route still yields the
   pinned tuple **field-by-field, absence included** (a default the adapter
   introduced since spawn is drift), **and** when `modelSelector.via==='alias'` a
   fresh `resolveDetailed` still resolves the selector to the pinned model (drift
   means the original route is gone). Degraded pins (`complete:false`) run only
   the provider-mounted and alias-drift checks. Failure → policy
   `onUnavailableModel`:
   - `block` (default): deny `SUBAGENT_MODEL_UNAVAILABLE`, name the knob that
     unblocks (`subagents-resume.onUnavailableModel: 'route-current'`; deny codes WORKSPACE_CHANGED/DEFINITION_CHANGED name the policy-block outcomes of steps 2-3).
   - `route-current`: resolve the selector fresh via `resolveDetailed`, overlay
     the resolution onto the calling parent's CURRENT route (`GateEnv.currentRoute`,
     the parent `AgentOptions` at resume time — never the pinned tuple, so
     parent-route drift is honored and an alias that no longer resolves falls
     back to the parent's current default route), and preflight through
     `resolveCallConfig`; if that is itself unavailable or
     yields no valid complete tuple, the fallback is unavailable → `block`.
     Otherwise compute the complete current tuple (provider, model, effort,
     maxTokens swapped **atomically** — a partial swap can yield
     `UNSUPPORTED_REASONING_EFFORT` or an invalid token budget on the fallback
     model), publish it as the pin's gate-evaluated `resume.overlay` **before**
     calling `followup` (durability ordering below), and proceed with the notice
     "original model X unavailable; resumed with current default route Y per
     policy".

**Durability ordering (applies to every step).** Any blocking outcome —
`PIN_ORPHANED`, `PIN_UNREADABLE`, `WORKSPACE_MISSING`, `PINNED_TOOL_UNAVAILABLE`,
a policy-`block` result, `SUBAGENT_MODEL_UNAVAILABLE` — is persisted to the pin
(`resume.state='blocked'`, reason) **before** the deny result returns, so the
overlay listener (§4.8) fails any unmonitored resume of that child visibly
instead of silently substituting. Conversely, an all-passing gate evaluation
clears the stored blocked state. A store WRITE failure is never swallowed: a
pending DENY keeps denying (its reason names the persistence failure) and a
pending PASS/route-current is refused with `STORE_WRITE_FAILURE` — required
durable state is always published before a followup is admitted. Gate
evaluation + persistence + followup admission are serialized per child (a
per-child promise chain), so concurrent sends to one cold child cannot
interleave. Gate and overlay share ONE `PinStore` whose `update` is an atomic
disk rewrite plus **synchronous cache publication**; `read` is read-through —
the disk is re-read on every call (files are tiny) and a failed read
invalidates the cache entry, so a pin file deleted or corrupted out-of-band is
never served stale. A denied gate produces a structured error result and
performs **no** followup — the child stays persisted, unmodified.

### 4.7 Notices and listing — `tools/post-execute` listener

- Prefix gate-computed notices to the `send_message` result content:
  "resumed with changed definition (pinned persona retained)", workspace/branch
  notices, `route-current` notices. Persist the same text to `pin.lastNotice`.
  Pending notices are keyed by the tool EXECUTION identity (`exec.token`, the
  registry-assigned call identity present on both the pre- and post-execute
  payloads), so a failing send can never leak its notice into a later call.
- Annotate `list_agents` result entries for pinned children with `resumeState`
  (`ok|blocked`), `definitionChanged`, and the last notice. (Content-level
  annotation only; we do not replace the harness's structured listing.)

### 4.8 Request-time overlay — `agent/request` listener

Per request: resolve the agent's session id; read through the shared `PinStore`
(every call re-reads `<pinsRoot>/<childId>.json`; miss → passthrough; a corrupt
file → throw, like blocked — the corrupt file IS the durable marker); pin found
→ overlay onto the resolved request after `next()` (shallow-copy pattern,
`effort.ts:27-32`):

- `resume.state === 'blocked'` (or the pin is corrupt) → throw (defense-in-depth:
  an unmonitored resume of a blocked child fails visibly instead of silently
  substituting).
- Complete pin → overlay the whole pinned tuple, with **explicit presence
  semantics**: a pinned non-`null` field is SET on the config; a pinned `null`
  field's key is REMOVED (assigning `null` is not absence — `prepareCall` would
  keep filling its default). Absence pinned at spawn stays absent at resume.
- Degraded pin (`complete:false`) → set only explicitly-present pinned fields;
  never touch absent ones.
- `resume.overlay` present (route-current) → overlay that tuple instead, with
  the same presence semantics. The overlay is a **gate-evaluated cache**:
  recomputed from policy on every gate evaluation (§4.6), never authoritative on
  its own; unmonitored bypass paths apply the last gate-evaluated value
  (best-effort, documented).

This runs on **every** turn of the resumed child regardless of resume trigger,
so options cannot revert to current defaults even on paths that bypass the gate
(coordinator direct `provider.followup`).

Overlay ordering vs the existing model-aliases listener is outcome-safe: at spawn
the pin value equals the spawn-time stamp; after a cold resume the stamp on
`agent.options` is gone, so only the pin overlay fires. A dedicated test pins the
interaction anyway.

### 4.9 Explicit runtime policy — settings namespace `subagents-resume`

Registered with the `settingsNamespace` pattern (precedent
`cc-model-aliases/src/service.ts:40,58-70`). The section schema is a constrained
OBJECT schema — one enum field per knob with explicit defaults — so invalid
spellings are rejected at settings write time (`readResumePolicy` still
tolerates a hand-edited document by falling back per-field). Defaults shown;
every value is an explicit, inspectable choice — there is no silent substitution
anywhere:

```jsonc
{
  "onUnavailableModel": "block",            // block | route-current
  "onDefinitionChanged": "resume-with-notice", // resume-with-notice | block
  "onWorkspaceChanged": "resume-with-notice"   // resume-with-notice | block
}
```

`WORKSPACE_MISSING`, `PIN_ORPHANED`, `PINNED_TOOL_UNAVAILABLE`, and
`PIN_UNREADABLE` always block: no safe fallback exists, and that is itself the
explicit policy. A deliberately deleted worktree is a documented dead-end —
deleting/purging the session (and its pin) is the burial path; there is no
relocatable fallback.

### 4.10 Mounting and wiring

- Register the plugin row in `packages/preset/cc/agent.cordis.yml` (its own row,
  not a duplicate tool registration) and in the cc-shell background composition
  (`packages/bundle/cc-shell`); pass `pinsRoot` (colocated with the session
  persistence root).
- Tests wire `pinsRoot` into the existing `setup()` harness
  (`integration.spec.ts:69-126`).
- If the plugin is absent on a given boot, pins are simply unread and behavior is
  exactly today's legacy behavior — a documented, detectable degradation, not a
  silent one (the pin directory is discoverable on disk).

## 5. Spikes (test-first, before any feature code)

Write each spike as a failing/pending test; land only with a green answer.

- **S1 two-Context cold boot**: spawn background child via real `subagent_fork`
  with `MockAdapter`, natural settle, `waitNoActivation`, dispose Context A, boot
  Context B over the **same** persistence + pin roots and the same parent session
  id, `send_message`, assert a second request materializes. This is the riskiest
  unproven mechanic (in-repo precedent only for single-Context resume; whole-
  Context dispose precedent exists in `cc-shell/tests/background-composition.spec.ts:76`;
  the §4.13 `it.skip` drain-resume gap does not touch the natural-settle path).
- **S2 childId preallocation**: exact `ContinuableStartSpec` field and that the
  descriptor/session land under the reserved id. Also measure the per-spawn
  `listSnapshots` cost of the reserved-id `DUPLICATE_CHILD` check
  (`continuation.ts:448-457` — a full session-store enumeration per pinned
  spawn; harness-owned; note, do not fix).
- **S3 availability APIs**: `resolveModelInfo`/`resolveCallConfig` reachable from a
  dsh-cc plugin; behavior for unmounted provider vs unknown model on a mounted
  provider (unknown literal ids pass through verbatim — "unavailable" is
  operationalized as provider-missing, resolution failure, or alias drift;
  documented, not overpromised).
- **S4 definition re-fingerprint outside the registry cache**.

## 6. Test plan (TDD, in implementation order)

Package unit tests (`packages/subagent/resume-pins/tests/`):

1. Pin schema: round-trip, unknown-field tolerance, version guard.
2. PinStore: atomic write, per-child isolation, corrupt file → blocked (fail-closed).
3. Fingerprint: stable across comment/format edits; changes on `tools`/`model`/
   persona/`maxTurns` edits; `plain` vs `named`.
4. Policy namespace registration + defaults; `resolveDetailed` in
   cc-model-aliases: single-snapshot provenance (`alias|literal|inherit`) across
   configured/unconfigured/inherit/literal inputs.

Integration tests (`packages/subagent/task/tests/`):

5. Capture: background spawn writes a complete pin before materialization
   (fields incl. effective tuple, fingerprint, workspace identity); spawn failure
   tombstones. Includes an **equivalence assertion** that the explicit-route
   build ("parent options overlaid with alias route") matches the harness's own
   `child-agent.ts:73-79` spread semantics, so harness drift is caught; plus a
   degraded case: a route that is unresolvable at preflight (a fake
   `agent/request` middleware supplies it at request time) still spawns, writes a
   `complete:false` pin, and warns — never rejects.
6. **Acceptance (user-mandated)**: spawn (alias-stamped effort + non-default
   maxTokens) → exit (dispose A) → cold start (fresh B, same roots) →
   `send_message` → assert Context B's `MockAdapter.requests` for the child carry
   the **pinned maxTokens + effort + route** (maxTokens is the unconditional-loss
   sentinel; a pinned-`null` absence case asserts the key is REMOVED, not nulled),
   persona/tool filter intact (existing assertions style), turn completes. Must
   not be satisfiable by header restoration alone.
7. Changed definition between boots → notice in `send_message` result +
   `lastNotice`; `block` policy variant denies; comment-only edit → no notice.
8. Provider absent in Context B → blocked: no request issued, `list_agents`
   annotated; flip policy to `route-current` → resumes with the complete current
   tuple atomically + notice, and the FIRST resumed request already carries the
   overlay (cache-coherence assertion). Adapter-default drift variant: Context B's
   adapter newly declares a default `maxTokens`/effort that was absent at spawn →
   treated as unavailable-drift (block; `route-current` variant resumes).
9. Pinned tool removed in Context B → `PINNED_TOOL_UNAVAILABLE` block.
10. Workspace drift cases: deleted cwd → block; `gitCommonDir` drift → per policy;
    branch-only drift → notice.
11. Regression: unpinned/legacy child and live-Activation followups pass through
    untouched byte-for-byte.
12. Crash-window: pin exists, session never created (aborted spawn) → gate step 0
    denies with `PIN_ORPHANED` (blocked, not legacy pass-through).

CI gates: declare every new spec import in the owning package's `devDependencies`
(`scripts/check-spec-deps.mjs`); root `pnpm test`, `pnpm typecheck`; worktree-local
full-suite runs use the `.verify/node_modules` vitest-config trick (repo sandbox
blocks vite's temp dir under the symlinked root `node_modules`).

## 7. Docs

Update the deviation row at `docs/cc-parity-matrix.md:47`: pinned config restored
on cold resume; blocked/fallback semantics documented. The harness-owned contract
summary in `docs/plans/2026-09-03-background-agent-runtime.md:129-140` keeps
describing harness behavior; this doc supersedes the "accepted deviation" stance.

## 8. Risks

- S1 may reveal the harness blocks a second Context over one root → fall back to
  the single-Context `waitNoActivation` convention for CI **plus** a real two-process
  e2e in the TUI shell; acceptance bar change must be re-approved before landing.
- Waterfall interop with `buildRequest`'s fork-seed header restore
  (`agent.ts:438-445`) — the pinned tuple overlay after `next()` always wins by
  construction; test 6 guards it.
- `agent/request` overlay throwing for blocked pins converts exotic bypasses into
  an error turn on the child; acceptable (visible > silent), P1.

## 9. Forward path (not in this PR)

If the harness later grows a descriptor v3 carrying the runtime tuple plus a
followup option hook, the pin's `effective` field and the overlay become
upstreamable; the pin keeps definition fingerprint, workspace identity, policy
state, and notices, which are dsh-cc concepts either way.
