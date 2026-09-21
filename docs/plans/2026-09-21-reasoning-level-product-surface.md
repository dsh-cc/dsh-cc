# Reasoning-Tier Reference Surface: `$level` syntax, classifier lane wiring, precedence table

Date: 2026-09-21. Status: **Proposed**. Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960). Design-review record: first draft **rejected** in cold
review — its premise (no effort field, no session selection object) was stale; dsh-cc and
the harness have since shipped most of it. This is the slim rewrite against HEAD,
covering only the verified remainder.

## 1. Problem

Reasoning effort for GLM-5.3-class models is substantially plumbed already. Three real
gaps remain:

1. **The permission classifier cannot force a low/no-reasoning lane.** Its stream seam
   passes exactly `{provider, model, system, prompt, maxTokens, signal}`
   (`packages/interaction/permission-rules/src/auto-stage.ts:114`) — no effort. The
   PR #123 production diagnosis pinned the 5s-timeout/malformed cluster on the
   classifier burning reasoning budget it never wanted; maxTokens/timeout bumps treated
   the symptom. The lever exists upstream; nothing on this seam pulls it.
2. **No non-interactive tier reference.** `/effort` is a TUI picker; agent frontmatter
   carries `effort` (fingerprinted into resume pins). What does not exist is declaring
   the tier *at the model reference* — ZCode's `GLM-5.3-Flash$high` shape — usable from
   settings, spawn options, and workflow `agent()` opts alike.
3. **No written precedence rule.** Tier can arrive via `/effort` session level,
   frontmatter `def.effort`, or (proposed) a `$level` suffix; which wins is currently
   folklore.

## 2. Current state (verified 2026-09-21 post-review against HEAD)

- `GenerateOptions.reasoningEffort?: ReasoningEffortId` exists and flows end-to-end
  (harness `packages/llm/llm/lib/types/types.d.ts:409`; the opaque level values are
  validated against the route profile, `types.d.ts:296`).
- `/effort` slash command: per-model level validation plus `default` reset
  (`packages/ui/tui/src/harness/driver-run-local.ts:258-306`, `slash.ts`); the selection
  is persisted in the harness session selection and re-validated on resume
  (harness `webhook/src/session.ts`).
- **Tier is part of the resume-pin tuple**: drift produces an explicit pin-mismatch
  error (`packages/subagent/resume-pins/src/gate.ts:97`); agent definition `effort` is
  fingerprinted (`resume-pins/src/fingerprint.ts:44`). This doc adopts that semantics
  unchanged — tier is identity-adjacent for pins, by existing deliberate design.
- Cost/pricing keys off model ids (`packages/session/command-cost/src/cost.ts:108-123`,
  three-tier resolvePrice); the auto-mode classifier breaker keys `provider/model`
  route strings (auto-stage.ts). **Invariant consequence**: a `$level` suffix must be
  stripped before any id leaves the parser, or pricing, breakers, and pins all diverge.
- Aux calls (compaction, session-title): no `reasoningEffort` reference located —
  they ride the route default. Stated here so the tier's cost story is honest.

## 3. Design

1. **Classifier lane wiring (local change, no upstream ask).** The classifier's stream
   seam gains an optional `reasoningEffort`, populated from the classifier route's
   lowest declared level (validated against the route profile via the same catalog the
   `/effort` picker uses; absent levels → omit the field, never guess). This closes the
   R1-class gap with the mechanism that now exists.
2. **`model$level` reference syntax (dsh-cc-side parser).** Wherever dsh-cc parses model
   references (alias settings, spawn/frontmatter opts, workflow `agent()` opts), accept
   an optional `$<level>` suffix. Invariants: (a) the suffix is stripped before the id
   leaves the parser (per §2's invariant consequence); (b) unknown levels are rejected
   at validation, never silently dropped; (c) level ids are part of persisted
   selections, so they are immutable once shipped — a rename is a data migration, not a
   policy change (said out loud because ZCode needed `legacy-reasoning-level-renames`
   after renaming shipped tiers).
3. **Precedence table (documentation + one test each).** Explicit `$level` suffix >
   agent frontmatter `def.effort` > `/effort` session selection > alias/route default.
   Higher entries never mutate lower ones; the pin gate keeps comparing the full
   resolved tuple exactly as it does today (gate.ts is not touched).

## 4. Expected effect

- Classifier turns stop spending reasoning budget: the measured symptom class from
  PR #123 (classification timeouts at the old 5s bound, `malformed` reports that were
  really truncations) is expected to drop; the audit trail can confirm via the existing
  debug channel (`DSH_PERMISSION_CLASSIFIER_DEBUG=1`) and audit events.
- Non-interactive tier declaration works uniformly across settings/spawn/workflow —
  per-role routing (the pstack mapping pattern) no longer needs alias clones to change
  effort.
- Precedence is a testable table instead of convention.

## 5. Non-goals and risks

- No change to `/effort` UX, alias schema, pin semantics, or aux-call behavior.
- `$level` parsing must not break route-prefixed ids (PR #24's resolvePrice behavior is
  the witness that id parsing is load-bearing twice over: pricing and pinning).
- Manual tier choice does not guarantee provider adherence end-to-end (pi-ai serializes;
  the last hop is not visible from either checkout) — the observability side expects
  usage `reasoningTokens` deltas, not a contract.

## Acceptance (DoD)

- [ ] Classifier stream seam passes validated low effort; unit test asserts the seam's
      opts on a route with and without declared levels.
- [ ] `$level` parse + strip-before-emit + unknown-level rejection covered by tests;
      parser property tests generated from the alias settings and catalog ids (no
      pre-existing id-corpus fixture — the doc names its sources).
- [ ] Precedence table landed in the relevant README(s); capability manifest and
      `docs:parity` updated for any new settings/syntax surface.
