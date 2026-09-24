# Turn rules: a non-interrupting rule engine that fires only when the model goes off-script

**Status:** **Proposed** — critic cold review round 1 (2026-09-23, design soundness) incorporated; critic cold review round 2 (2026-09-23, implementation-readiness audit, GO-WITH-AMENDMENTS) incorporated: rule-ingestion path pinned to the real loader surface, turn counter redefined on `agent/turn-stopping`, "hidden" wording replaced by attributed source-kind injection with a self-feed denylist, subagent stance fixed to top-level-only, ledger schema/layout committed, three wrong anchors corrected.
**Date:** 2026-09-23
**Worktree:** `.claude/worktrees/oh-my-pi` (branch `worktree-oh-my-pi`) — doc origin; implementation worktree `.claude/worktrees/turn-rules`.

## 1. Problem

dsh-cc ingests rules today (Cursor-plugin `rules/*.mdc`, capability
`plugins.rules`), but a rule has exactly two lives:

- `alwaysApply: true` — its full body rides every request. Ten such rules are a
  permanent per-turn token tax, exercised mostly when nothing is wrong.
- otherwise — it degrades to a name+description in an index; whether the model
  ever reads the body is unobservable and unenforced.

There is no middle path: nothing notices that the model just wrote the pattern
a rule forbids, and nothing delivers that rule at exactly that moment.

oh-my-pi's TTSR (time-traveling stream rules) demonstrates the middle path and
measures well in dogfooding: rules sit dormant, and the harness reacts to a
violation as it happens. Their full implementation couples to stream control
(mid-token abort, partial-message excision, retry from the same point,
`ttsr_injection` session entries) that lives in their agent loop
(`oh-my-pi/packages/coding-agent/src/session/ttsr-coordinator.ts:559-621`,
verified 2026-09-23). In dsh-cc the stream is observation-only
(`packages/preset/cc/agent.cordis.yml:594` documents the cache-health
listener as "detector-only, no request rewriting"), so stream-interrupt is an
upstream proposal, not this doc. What **is** fully dsh-cc-side is the
completion-delivery tier: omp *populates* per-tool reminder matches during
stream-delta matching and *delivers* them when the tool completes
(`oh-my-pi/packages/coding-agent/src/session/ttsr-coordinator.ts:213-260`
afterToolCall prepends a text block to `ctx.result.content`; verified
2026-09-23). dsh-cc cannot rewrite the result content at that seam (the
context-crusher owns composition), so this engine instead matches at
completion — over the completed tool call/result and the user prompt — and
delivers via the non-destructive `additionalContexts` sideband (§4.2). The
behavioral borrowing is "dormant rule → reacts to violation at completion →
advisory reminder"; the transport differs from omp by necessity.

## 2. Goal

A rule engine where a rule carries an optional trigger and behaves as follows:

- Rules without triggers keep today's behavior (alwaysApply rides the system
  prompt; others appear in the index). No parity drift for existing content.
- A triggered rule pays zero context until its trigger matches a completed
  tool call/result or a user prompt; on the first match its body is injected
  as an advisory reminder at that seam — as an `additionalContexts` entry on
  the tool-result accept decision, or as an attributed injected message at the
  prompt seam (§4.2).
- Fired state is per-session, durable across compaction and resume, with
  `once` (default) and `after-gap: N` repeat policies.
- All failure modes fail open with a debug counter; nothing may turn a tool
  result into an error.

## 3. Non-goals

- Mid-stream abort / partial-message excise / retry-from-point (needs
  agent-loop control in the harness; separately proposed, see §8).
- AST-structured triggers against reconstructed edit-tool payloads
  (omp's `astCondition` tier, `oh-my-pi/packages/coding-agent/src/export/ttsr.ts:365-398`). A natural
  phase 2; excluded here to keep the matcher surface small.
- Any enforcement. Injections are advisory to the model by design; this engine
  never blocks a tool call. Blocking on prompts already exists via CC hook
  parity (`hooks.user-prompt-submit`) and stays untouched.
- Changes to `alwaysApply` semantics or to the existing rules index.
- Workspace-root rules directories (`.cursor/rules/*.mdc`, `.claude/rules/*.md`)
  — no code path ingests those today (discovery only scans installed plugins,
  `cc-plugin-loader/src/discovery.ts:101`); see §7 open questions.

## 4. Design

### 4.1 Rule frontmatter extensions

Rule v0 source = **rules shipped by installed+enabled cursor-dialect plugins**
(`rules/*.mdc`). Parsing lives in `packages/compat/cc-plugin-loader/src/rules.ts`;
the rendered system-prompt consumption lives in
`packages/bundle/cc-shell/src/rulesSeam.ts`. Extend the single existing typed
frontmatter path (no second YAML dialect) with four optional keys:

```yaml
---
description: Prefer Arc<str> over Box::leak in production paths
trigger: \bBox::leak\b          # JS regex source; compiled lazily, LRU-cached
triggerOn: [tool-results, user-prompts]   # default: both
repeat: once                    # once | after-gap (default: once)
repeatGap: 10                   # completed turn_stops before re-arm; default 10
---
```

Mechanics (all exact):

- `loadRuleFile` parses the file with `parseCcFrontmatterDocument`
  (`rules.ts:132`, `skill-claude-code/src/frontmatter.ts:210`), whose return is
  `{ data, body }` — `data` is the raw full YAML record, **all** frontmatter
  keys preserved. The loss happens one layer up: `RuleEntry`
  (`packages/compat/cc-plugin-loader/src/types.ts:37`) carries only
  `path/description/alwaysApply/globs/body`, and the module-private
  `loadRuleFile` (`cc-plugin-loader/src/rules.ts:119`) never copies anything
  else off `document.data`. (Unknown-key preservation as a first-class field
  has direct precedent one level down: `parseCcFrontmatter`'s
  `unknown: Record<string, unknown>` at `frontmatter.ts:176`.)
- Extend `RuleEntry` with `trigger?: string`,
  `triggerOn?: readonly TurnRuleChannel[]` (`'tool-results' | 'user-prompts'`),
  `repeat?: 'once' | 'after-gap'`, `repeatGap?: number`. Extend `loadRuleFile`
  to populate them by reading the four keys straight off `document.data`, with
  fail-loud validation: a malformed value (non-string `trigger`, invalid regex
  source, unknown `triggerOn`/`repeat` enum, non-positive-integer `repeatGap`)
  skips the rule with a tally warning — mirroring the existing skip
  conventions in the same file — never a load failure.
- Export the per-file parser (rename `loadRuleFile` → exported
  `parseRuleFile(file, tally, warnings)`, same signature) from
  `cc-plugin-loader/src/rules.ts` and re-export from the package index, so
  consumers can parse rule files without going through the `RulesSeam`.
- Rules without `trigger` are byte-for-byte unaffected: the new fields stay
  `undefined`; the `rulesSeam.ts` renderer only reads
  `alwaysApply`/`globs`/`body` and needs no change.

Quoting warning: a `trigger` regex containing YAML-significant characters
(`:`, `#`, `{`, `[`, leading `-`, etc.) must be quoted in the frontmatter, or
the YAML parser will mangle it.

### 4.2 Rule discovery (turn-rules side)

The turn-rules plugin does **not** consume the `RulesSeam` host (its entries
map lives inside `cc-shell/src/rulesSeam.ts:88` with no service exposure, and
adding a cordis service would touch the twelve-key isolate pin — §4.6 forbids
both). It re-discovers the same corpus from disk at `apply()` time:

1. `discoverCcPluginRoots({})` (exported,
   `packages/compat/cc-plugin-loader/src/discovery.ts:101`) with DEFAULT
   options only (`pluginDirs` absent ⇒ installed ∩ enabled; default
   `claudeHome`; `cwd` defaults to `process.cwd()`). It returns
   `{ root, nameHint }` records (`discovery.ts:21-26`).
2. Per discovered root: `parsePluginManifest` (exported,
   `cc-plugin-loader/src/manifest.ts:35`) yields the flavor
   (`types.ts:106`, defaults to `'cc'` when the dialect marker is absent —
   `:62`) — skip non-`cursor` plugins — then `parseRuleFile` per rule file.
   Corpus-scope note: v0 covers the DEFAULT corpus only. When config sets an
   explicit `pluginDirs` list the boot loader mounts those dirs directly
   (`packages/bundle/cc-shell/src/index.ts:152-154`) and the two views
   diverge — out of scope for v0 (§7).
3. Evaluation order is fully deterministic: (a) discovery order across
   plugins, (b) within a plugin, manifest `rules` path declaration order
   (default `rules/` first, per the append-default-dir convention in
   `rules.ts`), (c) within a declared directory, lexicographic file-path sort
   — readdir order is NOT deterministic, so the sort is mandatory in the
   spec.
4. Compiled regexes ride a small LRU (capacity from `regexCacheSize`, §4.5);
   compile errors can never reach this point (load-time validation above).
- Snapshot semantics: the corpus is read once at `apply()`; plugin
  install/enable changes take effect on next session/preset remount. No live
  watch in v0 (§7). An explicit config `pluginDirs` list makes the boot
  corpus diverge from the rediscovered default corpus — v0 covers the default
  corpus only (`cc-shell/src/index.ts:152-154`; §7).

Rules whose every setting is absent (`trigger` undefined) are dropped by
turn-rules at discovery — the matching engine only ever sees trigger-bearing
rules.

### 4.3 Matching seams

**Tool-result channel.** A `tools/post-execute` listener registered **without
prepend** — mounted after the context-crusher row, mirroring how
tool-use-summary, post-edit-verify and edit-recovery-hint compose (ordering
contract documented at `packages/preset/cc/agent.cordis.yml:398,519,529,538`;
idiom precedent `packages/interaction/edit-recovery-hint/src/wiring.ts:43-82`).

Per event, in order:

1. **Fail-soft shell**: `const downstream = await next()` first, then all work
   inside try/catch; any internal throw degrades to returning `downstream`
   unchanged plus a debug counter — a listener throw would turn the tool
   result `isError`, the explicitly forbidden failure mode.
2. **Guards (any miss ⇒ passthrough `downstream`)**:
   - settings `enabled` re-read per event (raw per-use read of user-layer
     settings — `edit-recovery-hint/src/settings.ts:79-87` idiom; hot-reload
     for free);
   - `downstream.kind === 'accept' && downstream.value === undefined`
     (value-accept guard: the runtime throws on content+value in one decision
     — never compose onto the value variant);
   - `exec.agent !== undefined`; if undefined, no-op + debug counter (do NOT
     persist under `'unknown'` — that would poison `once` across sessions);
   - top-level only: skip when
     `exec.agent.session.header.origin === 'subagent' ||
     (header.delegationDepth ?? 0) > 0` (`memory/src/recall.ts:294` predicate;
     see §4.5 subagent stance);
   - per-session total-injection cap (32, §6) not exhausted.
3. **Match**: build the bounded unit (§4.4), evaluate trigger-bearing rules
   whose `triggerOn` includes `tool-results`, in §4.2 order.
4. **Fire**: the in-memory fired-set gate (§4.6) decides `once`/`after-gap`;
   each newly-firing rule appends one injected `UserMessage` to the accept's
   `additionalContexts` — `[...(downstream.additionalContexts ?? []), ...newReminders]`, new reminders in
   §4.2 order. One ledger write claims all matches of this event (§4.6).
   The accept's `content` is never rewritten.

The injection channel is the dsh-cc-owned `@dsh-cc/tools` surface plugins
already import: `PostToolDecision` accept/block variants carry
`additionalContexts?: UserMessage[]`
(`packages/core/tools/src/tool-types.ts:311-313`; the field also exists on
result types at `:276`,`:288`). Decision merge happens in
`packages/core/tools/src/runtime-results.ts:57-89` (decision contexts merge
onto the result for the loop to buffer; dsh-cc additionally forwards them in
`runtime-execute.ts:281`); final delivery to the model-visible stream is
harness-internal (harness repo `packages/core/tools/src/ptc.ts:567-570`,
`exec.deferContext` post-finalize dispatch — read-only reference; the plugin
never touches it).
Older/foreign accepts may lack `additionalContexts` — treat spread-absent as
construction from scratch, and treat any unexpected decision variant as
passthrough + counter.

**Prompt channel.** The plugin's own `agent/pre-step` listener plus
`agent.inject()` (precedent `packages/memory/memory/src/recall.ts:280-380`):
the listener receives `{ agent, messages, signal }` and
`next(): Promise<PreStepDecision>`; call `next()` first, return the decision
unmodified. Per event:

1. Same guard battery: settings; top-level only (same predicate on
   `agent.session.header`); caps.
2. Candidate text = joined text blocks of `messages` whose `source` is absent
   or whose `source.kind` is NOT in the injected-source denylist (recall.ts
   idiom — "a message with no source is user input"). The denylist MUST
   contain this plugin's own source kind `turn-rules` (self-feed prevention:
   a rule must never match its own reminder body).
3. Per-session dedupe: track `lastPromptText`; if the candidate text equals
   it, skip prompt matching this step entirely (pre-step fires once per
   STEP, several times per turn — recall's `lastQuery` dedupe precedent).
   Update `lastPromptText` only when candidate text is non-empty.
4. On hit (trigger-bearing rules whose `triggerOn` includes `user-prompts`,
   §4.2 order, fired-set gate): `agent.inject(createUserMessage({ content:
   [{ type: 'text', text: reminderText }], source: { kind: 'turn-rules' } }))`
   — one injected message per fired rule, in order; one ledger write claims
   all. `createUserMessage` is imported from `@deepseek-ai/dsh-llm`;
   `UserMessage` from `@deepseek-ai/dsh-session` (edit-recovery-hint import
   precedent).

**"Hidden" honesty**: there is no hidden-flag at `agent.inject` in dsh-cc
(omp hides via a custom message type inside its own loop — not portable).
Injected messages are attributed via `source.kind` and rendered by the TUI
like memory-recall bodies. The doc and UI copy must say "attributed reminder",
never "hidden".

**Multi-rule one unit**: when several rules match the same unit, all matches
are claimed in ONE ledger write and one injected `UserMessage` per matched
rule is emitted, in §4.2 order.

### 4.4 Matching input (exact serialization)

- **Tool channel**: `JSON.stringify(exec.arguments ?? {})` + `'\n'` + the
  concatenation of `{type:'text'}` block texts of the downstream decision's
  `content` (non-text blocks skipped; if the accept carries no `content`
  rewrite, this is the original result content — composition order, §4.3,
  means we match the post-crush text the model will actually receive; CCR
  never rewrites `exec.arguments`, so argument matching is unaffected).
  UTF-8-truncate to the first `maxResultBytes` (200_000) of the combined
  buffer; the regex runs only over the truncated buffer. Tool name,
  `isError`, and call id are NOT part of the matched text in v0.
- **Prompt channel**: the candidate text of §4.3 step 2, same truncation.
- Motivation for including arguments: the class-1 use case is "the model just
  wrote a forbidden pattern" — for `edit`/`write` success results that text
  lives in `exec.arguments`, not the result body.

### 4.5 Subagent stance

Top-level only on both channels, gated by
`session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0`
(recall.ts:294 and tool-use-summary `src/index.ts:67-75` precedents).
Rationale: reminders are scoped to the user's main conversation; letting a
subagent's tool call fire a session-shared rule would mark `once` consumed for
the parent while the reminder lands in the subagent's own context — worst of
both. If demand appears, a per-subagent scope can be added without changing
rule syntax (§7).

### 4.6 Fired-state ledger

Per-session, on disk, so compaction and resume cannot re-fire a `once` rule:

- path `$DSH_HOME/turn-rules/<sessionId>.json` — flat by session id
  (tool-use-summary ledger precedent,
  `packages/compaction/tool-use-summary/src/ledger.ts:86`; session ids are
  globally unique, no projectKey subdir needed). `$DSH_HOME` access is the
  guarded `ctx.dshHomePath?.()` idiom (`edit-recovery-hint/src/wiring.ts`
  `dshHomeOf`; cordis throws on property access itself, so the access itself
  is try/catch-wrapped); `$DSH_HOME` seeding rule per workspace memory
  `plugin-dsh-home-cascade-shipped`.
- schema (exact):
  `{ "version": 1, "turnCounter": <number>, "fired": { "<ruleKey>": <firedAtTurn> } }`.
  `ruleKey` = `<pluginRoot-basename>/<relative-rule-path>` at discovery time —
  rules live inside plugin roots, so basename+relative path is a stable,
  collision-free key; the key is recorded in the entry at parse.
  No `gapArmed` map: re-arm is pure arithmetic, no mutable arming state.
- atomic write: same-directory temp file `${file}.tmp-${hex6}` then rename
  (handoff-store `packages/subagent/handoff-store/src/store.ts:73-76` idiom);
  one write per event that fired ≥1 rule (or per counter increment).
- turn counter: incremented once per `agent/turn-stopping` event for the
  session's top-level agent (precedent `prompt-suggest/src/index.ts:174`;
  top-level gated), persisted in the same ledger write discipline. Pre-step
  fires per STEP and is NOT a turn counter (round-2 review correction).
- `after-gap` re-arm: fires again when
  `turnCounter - firedAt[ruleKey] >= repeatGap` at match time; on re-fire,
  `firedAt` updates to the current counter.
- firing gate: a per-session in-memory
  `Map<sessionId, { fired: Set<ruleKey>, turnCounter: number }>` is the
  authoritative gate against double-fire races (two events in one turn fire
  once); the map is lazily hydrated from the ledger on the session's first
  event. The on-disk ledger is durability only (resume/compaction
  rehydration). No PostCompact consumer — the ledger needs no compaction
  hook.
- Resume: session id follows the resumed session (resume-pins precedent,
  `packages/subagent/resume-pins`), so the ledger just works.

### 4.7 Judged rules (phase 2, flagged, default off)

omp's third trigger class asks a cheap model ("LLM judge", yes-prob ≥ 0.7
gate; `oh-my-pi/packages/coding-agent/src/export/ttsr.ts:365-398`, verified
2026-09-23; judged threshold `JUDGED_RULE_THRESHOLD = 0.7` at
`oh-my-pi/packages/coding-agent/src/export/ttsr.ts:47`).
Design only, not v0: batch all candidate `question` rules for the completed
unit into one cheap-lane call via `resolveAlias(ctx, 'haiku')`
(`packages/compat/cc-model-aliases/src/service.ts:121`); alias missing ⇒ the
feature is silently off *and counted* (never inherit the main route silently —
shunt lesson, workspace memory `dsh-cc-shunt-plugin-pr14`).

### 4.8 Settings

New kebab namespace `cc-turn-rules` (registered idempotently via
`registerNamespaceSafe` from `@dsh-cc/settings-ns`; precedent in
`packages/interaction/post-edit-verify/src/settings.ts:24,110`; kebab rule per
workspace memory `kebab-namespace-settings-delivery`):

- `enabled` (default `true` — zero config means zero trigger-bearing rules
  exist, so enabling is behavior-neutral), `maxResultBytes` (200_000),
  `regexCacheSize` (64), `judged.enabled` (default `false`).

Runtime read is the raw per-use read of the user layer (edit-recovery-hint
`settings.ts:79-87` idiom) — free hot-reload; project scope stays out of v0
unless demand appears.

### 4.9 Packaging

Plain plugin package `packages/interaction/turn-rules`
(`@dsh-cc/turn-rules`), `apply(ctx)` only, no cordis Service — the cc-services
isolate-realm map is pinned by an exact twelve-key `toEqual` in
`packages/preset/cc/tests/composition.spec.ts:188` ("isolates exactly the
twelve cc-services services") and adding a Service means touching that pin
(lesson from PR #93; a plain listener plugin needs none).
Preset row mounted in `packages/preset/cc/agent.cordis.yml` directly after the
edit-recovery-hint row (`:538`, after context-crusher `:398`), no prepend,
with an ordering comment recording that turn-rules mounts after the crusher
("CCR outermost, turn-rules composed after it").

New-package checklist: clone the `edit-recovery-hint` file skeleton
(package.json scripts, tsconfig, tests dir); `tsconfig.base.json` paths needs
NO new entry (workspace link + package exports resolve — edit-recovery-hint
delivery note); any test importing harness/`@dsh-cc/*` packages must declare
them in the new package's devDependencies (CI `check:spec-deps` gate).

### 4.10 Capability manifest impact (implementation PR, same commit)

This extends the CC-compatible surface governed by `plugins.rules` (trigger
semantics on `.mdc` rules). The implementation PR must update
`docs/claude-code-capabilities.yaml` in the same commit (extend
`plugins.rules` deviation notes; add no new top-level id unless the validator
prefers a child entry — decide against validator rules I3/I4/I7 at that time)
and commit `pnpm docs:parity` output.

## 5. Verification

- **Unit specs** (new package `tests/`):
  - regex LRU capacity + byte-cap truncation arithmetic;
  - once/after-gap arithmetic against the turn-stopping-driven counter
    (re-arm exactly at `turnCounter - firedAt >= repeatGap`);
  - ledger round-trip incl. lazy rehydration (simulated resume: fresh
    in-memory map + existing ledger file);
  - in-memory fired-set gate blocks a synchronous double-fire (two events in
    one turn fire once);
  - `RuleEntry` extension parsing: trigger keys populate from the preserved
    `unknown` frontmatter map; malformed regex/enum/gap ⇒ skip + tally
    warning;
  - discovery-order determinism: fixture plugins assert
    discovery→declaration→lexicographic order;
  - denylist exclusion: a message with `source.kind === 'turn-rules'` is never
    matched on the prompt channel (self-feed prevention);
  - `lastPromptText` dedupe: same prompt text arriving on a later step does
    not re-evaluate;
  - value-accept passthrough and `exec.agent === undefined` no-op counters;
  - top-level gate: subagent-origin execs/agents pass through untouched.
- **Preset composition**: existing `composition.spec.ts` must pass unmodified
  (proves no Service leaked into the isolate map); add one text-level ordering
  assertion there reading `agent.cordis.yml` — index of the `turn-rules` row
  must be greater than the `context-crusher` row index (deterministic, no
  boot required).
- **Smoke (spec, in-process)**: clone the real-boot composition harness at
  `packages/context/context-crusher/tests/composition.spec.ts:137` (and the
  sideband assertion at `:225`): boot the cc preset, install a fixture cursor
  plugin carrying one triggered rule (fixture under the new package), drive a
  mock tool whose call arguments contain the forbidden pattern ⇒ the follow-up
  loaded messages include the reminder as an `additionalContexts` entry riding
  the same accept (never a content rewrite); a second identical exec must not
  re-fire under `once`.
- **Dogfood (pre-merge, recorded in PR)**: install the fixture cursor plugin
  into a scratch `$DSH_HOME`, run one `dsh cc-tui` session that violates the
  rule on purpose (make an edit/write whose arguments contain the pattern),
  confirm the attributed reminder renders in the TUI transcript and grep the
  CC-shape transcript mirror for the rule body; run `/compact`, violate again
  and assert `once` stayed suppressed (no second reminder). Attach the
  transcript excerpt.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Regex catastrophic backtracking on huge units | 200 KB cap + LRU + match over truncated buffer only |
| Listener throw poisoning tool results | total try/catch → passthrough + debug counter (§4.3) |
| Reminder noise loops | `once` default; `repeatGap` floor of 1; per-session total-injection cap 32 with debug notice |
| Self-feed (rule matches its own reminder) | `turn-rules` source kind in the prompt-channel denylist; result channel never re-reads injected contexts |
| Value-accept decision corruption | `downstream.value !== undefined` ⇒ passthrough (§4.3) |
| Cache-prefix writes | injections ride the same request via `additionalContexts` — no post-commit rewrite of the tool result content; composition contract documented at the post-edit-verify/edit-recovery-hint rows (`agent.cordis.yml:528-537`) |
| Stale corpus after plugin install/uninstall mid-session | snapshot-at-apply semantics; documented v0 limitation (§7) |

## 7. Open questions

- Workspace-root rules: ingest `.cursor/rules/*.mdc` (the corpus real Cursor
  users own — no code path reads it today) and/or `.claude/rules/*.md` (CC
  itself has no rules dir)? Deferred from v0 to keep discovery identical to
  the existing loader surface; both are additive later without schema change.
- Should `triggerOn` gain `assistant-text` later (matching the model's replied
  prose after the fact)? Cheap to add at the same seams; deferred to keep the
  matching vocabulary tight.
- Per-subagent triggering scopes (§4.5 notes the additive path).

## 8. Related upstream proposal (not this PR)

Stream-level TTSR (abort-in-delta, partial excise, retry-from-point,
`ttsr_injection`-style session entries) requires agent-loop control and a
session-entry type — both harness-owned. This doc's engine is designed so that
tier can be layered on later without changing rule syntax.

## 9. DoD

1. Package `packages/interaction/turn-rules` exists, mounted in the cc preset,
   with the §5 specs green.
2. The smoke spec proves: fixture triggered rule fires exactly once across
   result → compaction → result; the injection renders as an
   `additionalContexts` entry riding the same accept decision (never a content
   rewrite); `RuleEntry` trigger parsing + `parseRuleFile` export land in
   `@dsh-cc/plugin-loader` with spec coverage.
3. Ordering assertion in `composition.spec.ts`: the `turn-rules` row sorts
   after the `context-crusher` row, no prepend ("CCR outermost, turn-rules
   composed after it").
4. `docs/claude-code-capabilities.yaml` updated (`plugins.rules` deviation) in
   the implementation PR; `pnpm check:capabilities` + `pnpm docs:parity` green.
5. Dogfood capture attached to the implementation PR (violation → attributed
   reminder → no re-fire after compaction).
