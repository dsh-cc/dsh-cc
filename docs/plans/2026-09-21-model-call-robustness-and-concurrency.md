# Model-Call Robustness and Adaptive Concurrency (upstream proposal batch)

Date: 2026-09-21. Status: **Proposed**. Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960). Design-review record: first draft **amended** in cold review
— the structured-output item's "not located" hedge was wrong (validation path found and
anchored), proposals (a) and (b) were split into two separate filings so an AIMD dispute
cannot hold the retry-classification work hostage, the AIMD key-aggregation hazard under
multiplexed gateways was made explicit, and the observation-only signature-hygiene item
was moved out of scope. This document now batches the model-call-layer proposals that
are individually small and share the retry/admission area of the upstream code.

## 1. Problem

The dsh stack's model-call layer is robust at generic transport retry (failure classes,
exponential backoff) but has no concept of (a) provider-specific behavioral failure
shapes, (b) adaptive rate discovery, or (c) structured-output leniency. All three showed
up in ZCode as production-necessary for GLM-class routes.

## 2. Current state and gap

**Per-item state (harness verified; ZCode anchors from the borrow analysis):**

**(a) Empty/length stream classification.** Harness `EMPTY_RESPONSE` is a retryable class
(`llm/src/error.ts:39`); retry replays the same request unchanged. ZCode additionally
classifies `finish_reason=length` + empty text as overflow pressure and retries with
reduced input (compact path:
`packages/core/src/runtime/methods/compact-active-helpers.ts:61-65`), and treats the
stream boundary as "retryable prelude vs committed output" — an empty reasoning delta
stays buffered, only non-empty output commits a stream beyond retry
(`packages/adapters/src/model/stream-retry-boundary.ts`). Verified: no committed-output
boundary exists as a named concept in the harness stream runner.

**(b) Adaptive concurrency / admission.** Parallel tool calls per agent step are a fixed
constant (`DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`,
`core/agent-loop/src/constants.ts:6`); subagent fan-out parallelism is model behavior
(PR #59 finding). There is no per-provider-key rate state and no admission port. ZCode
has a pure, clock-free AIMD state machine per provider key — halve-factor 0.75 (their
note: one 429 does not imply the cap was halved wrong), +1 on four consecutive
successes, idle-forget at 5 minutes (`packages/dynamic-workflow/src/engine/concurrency.ts`), plus
a `ModelRequestAdmission` port where backoff sleeps hold no ticket
(`packages/adapters/src/model/request-admission.ts`).

**(c) Structured-output leniency.** GLM-5.3 via the anthropic-compatible endpoint
frequently returns the `result` field of a structured submit double-encoded (a JSON
document inside a JSON string); ZCode applies a one-shot `JSON.parse` unwrapping
(`packages/dynamic-workflow/src/engine/scheduler-submit.ts:61`). The dsh-cc workflow
`agent({ schema })` validation path, located in design review: the workflow worker
consumes `result.structured` (harness
`packages/workflow/workflow-worker-thread/src/runtime.ts:319-332`), the schema is
enforced via `attachStructuredRuntime`
(`packages/subagent/subagent-in-process-driver/src/structured.ts`,
`validateJsonSchemaValue` from dsh-tools), and tool args are parsed at
`packages/core/agent-loop/src/tool-calls.ts:107` (`parseArguments` preserves bad JSON as
raw text). A double-encoded result therefore fails today with exactly ZCode's
"expected object, got string". The spike below targets this known failure site.

**(d) Reasoning-block signature hygiene (out of scope here).** ZCode washes unsigned
thinking blocks and groups providers by signature compatibility
(`REASONING_PROVIDER_GROUPS`), backfilling `[Thinking removed]` on replay. The harness
profile has adjacent compat slots whose consumers live inside pi-ai and are not visible
from either checkout. dsh-cc's instrument is the reasoning-fold Stage-0 read-only probe
(PR #40); any normalization proposal waits for its evidence, and this doc carries no
work item for it.

## 3. Design

**Two upstream proposals, filed separately** (review finding: (a) is a small
retry-policy + stream-runner change; (b) introduces a new port wired into the agent-loop
scheduler — a dispute over AIMD semantics must not hold (a) hostage). Items (c)/(d) are
dsh-cc-side and stay out of the upstream batch.

*Proposal A — behavioral retry classification + committed-output boundary:*

- **(a)** Add a retry-reason taxonomy level: provider-behavioral failures
  (empty-on-length, prompt-too-long families) are classified separately from transport
  failures and may carry a *request transform* (shrink input) with an attempt budget.
  Add the committed-output boundary to the stream runner: once any non-empty content or
  tool-call delta has been delivered downstream, the attempt is no longer retryable at
  the adapter level (ZCode reference:
  `packages/adapters/src/model/stream-retry-boundary.ts`).

*Proposal B — admission / adaptive concurrency:*

- **(b)** Introduce a `ModelRequestAdmission`-style port: in-flight caps keyed by a
  **configurable admission key** (default: provider key; overridable per route to
  provider+model or base-URL), AIMD-updated from observed 429/success events, no ticket
  held while backing off. The key must be configurable because deployments like llmbox
  multiplex many heterogeneous upstreams behind one provider key — one abusive route's
  429s must not throttle every route sharing the key; conversely idle-reset (ZCode:
  5 minutes) plus slow +1-per-4-successes recovery can flap under bursty load, so the
  proposal states an explicit recovery rule (probe floor; reset on key change) rather
  than relying on "AIMD only lowers within human ceilings" alone (that framing addresses
  overshoot, not mis-aggregation). Wired so the subagent scheduler and the parallel
  tool-call pool *read* the admission decision; the constant stays as the default cap.
  ZCode references: `packages/dynamic-workflow/src/engine/concurrency.ts` (0.75 / +1 per
  4 / 5-min idle-forget), `packages/adapters/src/model/request-admission.ts`.

*dsh-cc-side:*

- **(c) spike**: drive workflow `agent({ schema })` runs on GLM-5.3 and
  GLM-5.3-Flash routes against the failure site named in §2(c); if failures reproduce,
  file the leniency proposal (single unwrap, validated against the schema after unwrap,
  failure stays a validation error including the raw payload preview).
- Reasoning-signature normalization stays out of this batch: it is observation-only
  ledger work with its consumers invisible from both checkouts. One pointer suffices —
  the reasoning-fold Stage-0 probe (PR #40,
  `packages/llm-tuning/reasoning-fold`) is the instrument; any proposal waits for its
  evidence.

## 4. Expected effect

- (a) GLM-class routes stop burning full-size retries on behavioral failure shapes;
  retry telemetry distinguishes transport from behavioral classes (the failure-taxonomy
  layering the repo's error-recovery work already wants).
- (b) 429 storms self-tune instead of clamping at a fixed pool; the
  parallel-session/`spawn` cap pressures seen in production (25-live-children admission
  events) get a principled rate signal rather than a binary refuse — without letting a
  multiplexed provider key throttle unrelated routes.
- (c) Either a confirmed non-problem (spike says clean) or a one-line unwrap that
  removes a structured-output failure class.

## 5. Non-goals and risks

- No off-peak / quota-queue semantics: those are zhipu billing-plan concepts and dsh-cc
  routes GLM behind llmbox; deliberately out of the batch.
- AIMD mis-tuned can throttle below what the deployment would prefer; human-set ceilings
  stay authoritative, and the mis-aggregation caveat in §3(b) is a design requirement,
  not a footnote.
- This doc proposes *upstream* mechanisms for (a)/(b); dsh-cc-side work is the (c)
  spike, and reading whatever lands.

## Acceptance (DoD)

- [ ] Upstream proposals A and B filed separately, each with the ZCode anchors as
      reference behavior and harness anchors as the change surface.
- [ ] (c) spike results committed as an addendum (reproduced against
      `tool-calls.ts:107` JSON preservation / clean); leniency proposal only if
      reproduced.
