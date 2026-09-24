# Turn rules: a non-interrupting rule engine that fires only when the model goes off-script

**Status:** **Proposed** — critic cold review round 1 (2026-09-23) incorporated: ordering contract fixed (no prepend, mounts after crusher), injection channel switched to accept-decision additionalContexts, in-memory fired-set gate + plugin-tracked turn counter added, user-prompt channel re-Seamed to pre-step+inject, dead PostCompact consumer removed, anchor corrections.
**Date:** 2026-09-23
**Worktree:** `.claude/worktrees/oh-my-pi` (branch `worktree-oh-my-pi`)

## 1. Problem

dsh-cc ingests rules today (Cursor-plugin `rules/*.mdc`, capability
`plugins.rules`, `docs/claude-code-capabilities.yaml:2691`), but a rule has
exactly two lives:

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
(`packages/preset/cc/agent.cordis.yml:593-594` documents the cache-health
listener as "detector-only, no request rewriting"), so stream-interrupt is an
upstream proposal, not this doc. What **is** fully dsh-cc-side is their
non-interrupting tier: match against *completed* tool calls/results and user
prompts, then inject the rule as a system-reminder at the next natural seam
(`oh-my-pi/packages/coding-agent/src/session/ttsr-coordinator.ts:214-218`
afterToolCall prepend; verified 2026-09-23).

## 2. Goal

A rule engine where a rule carries an optional trigger and behaves as follows:

- Rules without triggers keep today's behavior (alwaysApply rides the system
  prompt; others appear in the index). No parity drift for existing content.
- A triggered rule pays zero context until its trigger matches a completed
  tool call/result or a user prompt; on the first match its body is injected
  as a system-reminder at that seam (as an `additionalContexts` entry on the
  tool-result request, or as a hidden reminder at the prompt seam).
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

## 4. Design

### 4.1 Rule frontmatter extensions

Extend the Cursor-dialect rule parsing (capability `plugins.rules`;
implementation home per PR #72–#74 stack) with three optional keys; unknown-key
preservation already exists in our loaders as precedent:

```yaml
---
description: Prefer Arc<str> over Box::leak in production paths
trigger: \bBox::leak\b          # JS regex source; compiled once, LRU-cached
triggerOn: [tool-results, user-prompts]   # default: both
repeat: once                    # once | after-gap
repeatGap: 10                   # completed turn_stops before re-arm
---
```

Quoting warning: a `trigger` regex containing YAML-significant characters
(`:`, `#`, `{`, `[`, leading `-`, etc.) must be quoted in the frontmatter, or
the YAML parser will mangle it.

Native discovery: the same keys are honored for rules under
`.claude/rules/*.md` if we choose to add that root (optional in v0; see §7
open questions). Rules without `trigger` are byte-for-byte unaffected.

### 4.2 Matching seams (both proven in-repo)

**Tool-result channel.** A `tools/post-execute` listener registered **without
prepend** — mounted after the context-crusher row, mirroring how
tool-use-summary and post-edit-verify compose
(ordering contract documented at
`packages/preset/cc/agent.cordis.yml:388,408,517`; precedent
`packages/context/context-crusher/src/index.ts:4` and
`src/defer/pass.ts:57-64`). On a matching rule:

- match `trigger` against a bounded serialization of the tool result (cap
  200 KB, defends against backtracking blowups; compiled-regex LRU of 64);
- on hit, inject via the harness's purpose-built non-destructive channel:
  the `PostToolDecision` accept carries `additionalContexts?: UserMessage[]`
  (harness `@deepseek-ai/dsh-tools tool-types.ts:310-312`, ferried by harness
  `runtime-results.ts:65-68`; in-use precedent hooks-claude-code
  `index.ts:258-262`). The reminder rides the same request as a tail-positioned
  additional context — the accept's `content` is never rewritten.
  `additionalContexts` may be absent on older accepts; treat that as no-op +
  counter.
- **Pitfall note**: the accept-shape trap — `content` must not coexist with
  `value` (harness `runtime-results.ts:56,67-68`) — applies only if a content
  rewrite is ever used instead; with `additionalContexts` it does not arise.
  The listener still wraps everything in try/catch and converts any internal
  throw into a no-op plus a counter — a listener throw would turn the tool
  result `isError`, which is the explicitly forbidden failure mode.

**Multi-rule one result.** When several rules match the same unit, they are
evaluated in deterministic order (rule discovery/registration order); all
matches are claimed in ONE ledger write; and one injected UserMessage is
emitted per matched rule, in that same order.

**User-prompt channel.** A plugin does not register into the external hooks
bridge. The user-prompt channel is the plugin's own `agent/pre-step` listener
plus `agent.inject()` (hidden reminder message): match `trigger` against the
prompt text and inject the rule body as a hidden reminder at that seam.
Blocking semantics are not used.

### 4.3 Fired-state ledger

Per-session, on disk, so compaction and resume cannot re-fire a `once` rule:

- path `$DSH_HOME/turn-rules/<projectKey>/<sessionId>.json` (projectKey
  derivation and flat-by-id layout follow the handoff-store precedent,
  `packages/subagent/handoff-store`; $DSH_HOME seeding rule per workspace
  memory `plugin-dsh-home-cascade-shipped`);
- content: `{ firedAt: { <ruleName>: <turnCounter> }, gapArmed: {...} }`;
- the turn counter is a plugin-tracked count of user-turn `agent/pre-step`
  events, incremented before match evaluation and persisted in the ledger;
  `after-gap` re-arms when
  `turnCounter - firedAt[name] >= repeatGap`;
- firing gate: a synchronous in-memory `fired` Set per session is the
  authoritative gate against double-fire races; the on-disk ledger is
  durability only (resume/compaction rehydration). No PostCompact consumer —
  the on-disk ledger needs no compaction hook.
- Resume: session id follows the resumed session (resume-pins precedent,
  `packages/subagent/resume-pins`), so the ledger just works.

### 4.4 Judged rules (phase 2, flagged, default off)

omp's third trigger class asks a cheap model ("LLM judge", yes-prob ≥ 0.7
gate; `oh-my-pi/packages/coding-agent/src/export/ttsr.ts:365-398`, verified
2026-09-23; judged threshold `JUDGED_RULE_THRESHOLD = 0.7` at
`oh-my-pi/packages/coding-agent/src/export/ttsr.ts:47`).
Design only, not v0: batch all candidate `question` rules for the completed
unit into one cheap-lane call via `resolveAlias(ctx, 'haiku')`
(`packages/compat/cc-model-aliases/src/service.ts:121`); alias missing ⇒ the
feature is silently off *and counted* (never inherit the main route silently —
shunt lesson, workspace memory `dsh-cc-shunt-plugin-pr14`).

### 4.5 Settings

New kebab namespace `cc-turn-rules` (registered idempotently;
`registerNamespaceSafe` precedent in
`packages/interaction/post-edit-verify/src/settings.ts`; kebab rule per
workspace memory `kebab-namespace-settings-delivery`):

- `enabled` (default `true` — zero config means zero triggers exist, so
  enabling is behavior-neutral), `maxResultBytes` (200_000),
  `regexCacheSize` (64), `judged.enabled` (default `false`).

### 4.6 Packaging

Plain plugin package `packages/interaction/turn-rules`
(`@dsh-cc/turn-rules`), `apply(ctx)` only, no cordis Service — the cc-services
isolate-realm map is pinned by an exact twelve-key `toEqual` in
`packages/preset/cc/tests/composition.spec.ts` and adding a Service means
touching that pin (lesson from PR #93; a plain listener plugin needs none).
Preset row mounted in `packages/preset/cc/agent.cordis.yml` directly after the
context-crusher row (no prepend), near edit-recovery-hint / post-edit-verify,
with an ordering comment recording that turn-rules mounts after the crusher.

### 4.7 Capability manifest impact (implementation PR, same commit)

This extends the CC-compatible surface governed by `plugins.rules` (trigger
semantics on `.mdc` rules). The implementation PR must update
`docs/claude-code-capabilities.yaml` in the same commit (extend
`plugins.rules` deviation notes; add no new top-level id unless the validator
prefers a child entry — decide against validator rules I3/I4/I7 at that time)
and commit `pnpm docs:parity` output.

## 5. Verification

- **Unit specs** (new package `tests/`): regex LRU + byte cap; once/after-gap
  arithmetic against the plugin-tracked turn counter; ledger round-trip incl.
  resume rehydration; in-memory `fired` Set gate blocks a synchronous
  double-fire (two events in one turn fire once); composition order test
  pinning "CCR outermost, turn-rules composed after it"; the
  additionalContexts injection cases from §4.2.
- **Preset composition**: existing `composition.spec.ts` must pass
  unmodified (proves no Service leaked into the isolate map).
- **Smoke (spec, in-process)**: script a session over the cc preset with a
  fixture rule; a mock tool whose result contains the forbidden pattern must
  produce a follow-up request carrying the reminder block as an
  `additionalContexts` entry on the same accept decision;
  a second identical result must not re-fire under `once`.
- **Dogfood (pre-merge, recorded in PR)**: add one triggered rule to a real
  repo (this repo's own dogfood setup), run a session that violates it on
  purpose, capture the reminder injection in the transcript viewer; run one
  compaction, then violate again and assert `once` stayed suppressed.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Regex catastrophic backtracking on huge results | byte cap + LRU + match over truncated buffer only |
| Listener throw poisoning tool results | total try/catch → no-op + counter (§4.2) |
| Reminder noise loops | `once` default; `after-gap` floor of 1 turn; per-session total-injection cap 32 with debug notice |
| Cache-prefix writes | injections ride the same request via `additionalContexts` — no post-commit prefix rewrite of the tool result; the harness keeps the prefix stable (tail-injection invariant documented at `agent.cordis.yml:731`) |

## 7. Open questions

- Native `.claude/rules/*.md` root: add now or wait for user demand (CC itself
  has no rules dir; cursor root may suffice for v0)?
- Should `triggerOn` gain `assistant-text` later (matching the model's replied
  prose after the fact)? Cheap to add at the same seams; deferred to keep the
  matching vocabulary tight.

## 8. Related upstream proposal (not this PR)

Stream-level TTSR (abort-in-delta, partial excise, retry-from-point,
`ttsr_injection`-style session entries) requires agent-loop control and a
session-entry type — both harness-owned. This doc's engine is designed so that
tier can be layered on later without changing rule syntax.

## 9. DoD

1. Package `packages/interaction/turn-rules` exists, mounted in the cc preset,
   with the §5 specs green.
2. A fixture triggered rule injects exactly once across result → compaction →
   result in the smoke harness; the injection renders as a system-reminder
   `additionalContexts` entry riding the same request (never a content
   rewrite).
3. Ordering assertion in the composition spec: the turn-rules listener mounts
   after the context-crusher row, without prepend ("CCR outermost,
   turn-rules composed after it").
4. `docs/claude-code-capabilities.yaml` updated (`plugins.rules` deviation) in
   the implementation PR; `pnpm check:capabilities` + `pnpm docs:parity` green.
5. Dogfood capture attached to the implementation PR (violation → reminder →
   no re-fire after compaction).
