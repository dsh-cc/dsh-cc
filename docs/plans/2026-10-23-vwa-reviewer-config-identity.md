## Status: Implemented — PR #282 (open, pending merge). Design converged via
three-lane blind review (codex, grok, internal critic: r1 full review, r2
delta, r3 micro-confirmation — all GO; ledger in §7). Fix 5 of the post-lane-2 batch (ships with Fix 6 in one PR for a single identity reset).

All code anchors cite tree `8cf51b13`. Harness anchors cite `dsh` 0.2.0-rc.2
(`deepseek-harness` @ `c1b47e41fc`), whose `LlmCallConfig` is the closed shape
verified below. Runtime evidence cites the 2026-10-22 reproduction (revisions
31→37 of test project `prj_13485f41-…`).

## 1. Problem (Issue 8, P1)

`set-review-settings` promises (review-settings-revision.ts:25-29,
`REUSE_STATEMENT`): "review-record identity excludes review settings". Fix 3
stripped `reviewSettings` from the CONTRACT hash (`semanticContractHash`,
review-contract.ts:17-23), yet the 2026-10-22 reproduction shows revising
`budget.maxOutputTokensPerCall` 12k→16k→12k invalidating ALL completed
semantic-stage records twice (continue estimate `plannedCalls` all-0 → all-1).

### 1.1 Root cause (verified; narrower than the issue's speculation)

The budget value re-enters identity through the ADAPTER fingerprint:

1. `prepareContinuePreCheck` (review-continue.ts:230-245) calls
   `adapter.initialize(budget.maxOutputTokensPerCall, …)` BEFORE planning.
2. `initialize` → `freeze(maxTokens)` → `llm.prepareCall({ provider, model,
   maxTokens })` and stores the FULL call config, **including `maxTokens`**,
   as `effectiveConfig` (review-adapter.ts:125-135).
3. `configFingerprint()` (review-adapter.ts:229-237) returns
   `{ provider, model, promptTemplates, tokenizer, effectiveConfig }`.
4. Every identity surface hashes that fingerprint — five surfaces, verified
   exhaustive on `8cf51b13`:
   - `cacheKey` → `reviewerConfigHash` (review-run-store.ts:261-285);
   - `auditInputHash` (audit-reuse.ts:57);
   - the runner's record writes (review-runner.ts:207-208, computed AFTER
     initialize);
   - continue planning (review-continue.ts:110 via `planningContext`);
   - `host-delivery.ts:38-39` (`initialize` then hash `configFingerprint`)
     — the surface the v1 doc missed.

The host config shape is CLOSED and small: `LlmCallConfig` is exactly
`provider, model, reasoningEffort?, temperature?, maxTokens?, stop?`
(`dsh-llm` `call-config.ts:23-31`, verified at the pinned harness commit).
The adapter always passes `maxTokens` (review-adapter.ts:127) — the ONLY
budget-derived key we contribute.

### 1.2 Why this must be fixed, not merely disclosed

With Fix 4 in place, the author-facing escape from a single-unit truncation is
"raise `maxOutputTokensPerCall`". If raising it destroys all completed
records, the author chooses between two un-runnable states. Identity must
honor the principle F3.1 already claims.

## 2. Design

### F5.1 Strip the budget key from `configFingerprint`

```ts
configFingerprint() {
  // F5: budget facts are not review semantics (same principle as
  // semanticContractHash, F3.1). The mid-run drift check in freeze() keeps
  // comparing the FULL config.
  const { maxTokens: _budget, ...semanticConfig } = effectiveConfig ?? {}
  return {
    provider: options.route.provider,
    model: options.route.model,
    promptTemplates: TEMPLATE_VERSION,
    ...(effectiveConfig ? { effectiveConfig: semanticConfig } : {}),
  }
}
```

**Denylist, not allowlist — deliberately (r1 critic asked for an allowlist;
this is the safer failure direction).** An allowlist would SILENTLY DROP any
future config key the harness adds (under-invalidation → stale records reused
as current). A denylist hashes unknown keys (over-invalidation → extra
re-computation, never a wrong reuse). To make that direction explicit, add a
**config-shape tripwire test** (§4.5) asserting `effectiveConfig` keys ⊆
`{provider, model, reasoningEffort, temperature, maxTokens, stop}` at the
pinned harness line; when the harness adds a key, the tripwire fails and the
implementer classifies it (budget → deny, semantic → keep).

- Only the top-level `maxTokens` key is removed: it is the key the adapter
  itself derives from the review budget (review-adapter.ts:127). `provider`,
  `model`, `reasoningEffort`, `temperature`, `stop` remain — those genuinely
  change model behavior and MUST keep invalidating records.
- The mid-run drift check is unchanged: `freeze()` (review-adapter.ts:130-132)
  still compares the full config including `maxTokens` and throws
  `ReviewConfigDriftError` on change.
- Production builds a fresh adapter per tool invocation (review-host.ts:75-104
  factory closure; tools.ts:334), so cross-request drift is not a production
  concern; the check remains for intra-run safety.
- Fix 6 (separate doc) removes the `tokenizer` accounting label from the same
  function; the two MUST ship in one PR (§4).

### F5.2 What identity contains after this fix

A semantic-stage record `inputHash` = sha256 over `{ stage, targetRefs,
requiredRules, dependencyDigest, contractHash (semantic), policyHash,
reviewerConfigHash (provider, model, promptTemplates, semantic
effectiveConfig), promptHash }`; audit adds `resultVersion, artifactHash,
coreClaimIds, unitChars` (audit-reuse.ts:44-61). No budget field appears.
`claimsBatchSize` remains identity-relevant — correct: it reshapes task
decomposition into `targetRefs`, which is semantic (and `REUSE_STATEMENT`
already describes the claims-shape exception). `maxContextChars` remains
identity via `unitChars` and is already refused by revision
(review-settings-revision.ts:48-51). Any future hash-field addition must be
checked against this list (grep `cacheKey(` / `auditInputHash(` call sites).

## 3. Migration / compatibility

- **One-time invalidation of existing records.** The fingerprint output
  changes, so every stored `reviewerConfigHash` differs from post-upgrade
  values. Consequences, all accepted, ALL disclosed in the PR body:
  - completed semantic-stage records stop matching → next `continue`
    re-executes them once; reuse resumes under the new identity;
  - records drop out of `currentReviews`/delivery checks
    (review-current.ts:20, delivery-check.ts:174) until re-reviewed —
    claim freshness may temporarily regress; records are never deleted;
  - **existing delivery receipts become un-signable**: commands.ts:367-373
    rejects a receipt whose `reviewerConfigHash` no longer matches the freshly
    computed hash (r1 critic);
  - audit records written after Fix 4 are included in the reset
    (auditInputHash includes `reviewerConfigHash`, audit-reuse.ts:57) — the
    Fix 4 PR body cross-references this.
- No sound migration exists (the old identity was wrong); this is the same
  class as a policy/prompt version bump.
- Post-fix, records written under different budgets hash identically; continue
  reuse picks the latest `endedAt` (review-continue.ts:203-206), so a
  higher-cap record silently replaces a lower-cap one — consistent with the
  principle, noted for the record (r1 critic minor).

## 4. Tests (TDD; `packages/interaction/vwa-argument/tests/`)

1. **Fingerprint stability — TWO adapter instances (r1 codex + grok + critic:
   the v1 single-adapter pin is impossible).** `initialize` is `pending ??=`
   (review-adapter.ts:155-157) and the first `prepareReviewCall` consumes
   `pending` without a config comparison (:159-161), so one adapter cannot
   exhibit two caps. Assert: adapter A initialized at 12,000 and adapter B at
   16,000 (both driven through a `prepareCall` fake that echoes
   `{...config, temperature}` like the real client, cf. review-adapter.spec.ts:50)
   produce the SAME `configFingerprint()` AND their prepared configs actually
   contain DIFFERENT `maxTokens` (proves the strip is what equalizes them).
2. **Drift guard staging (r1 codex).** `initialize(12_000)` → one
   `prepareReviewCall` at 12,000 (consumes pending) → second
   `prepareReviewCall` at 16,000 rejects with `ReviewConfigDriftError`.
3. **Kept keys still invalidate (r1 grok):** differing `temperature` (or
   `reasoningEffort`) → different fingerprint; differing `maxTokens` → same.
4. **The Issue-8 repro as an end-to-end pin — via the REAL adapter, not the
   fake (r1 grok #6: `tests/review-helpers.ts:127-129` returns a constant
   fingerprint with no `effectiveConfig`, so extending
   `review-identity-pin.spec.ts` stays green without the fix).** Complete the
   semantic stages under cap 12,000 using `createReviewAdapter` with an
   echoing `prepareCall`; `set-review-settings` → 16,000; continue estimate
   `plannedCalls` all 0 for completed stages; revise back to 12,000 → still 0.
5. **Config-shape tripwire:** a test pins the observed `effectiveConfig` key
   set against `{provider, model, reasoningEffort, temperature, maxTokens,
   stop}` (the pinned harness `LlmCallConfig`); a new harness key fails this
   test loudly.
6. **Migration pins:** continue reuse works across the two budget values
   (test 4); audit reuse works post-fix across a budget revision; a delivery
   check computed pre-fix against a post-fix hash reports the receipt
   mismatch (encode the commands.ts:367-373 behavior as an expected refusal,
   not a silent pass).
7. Full battery: `vitest vwa-argument` +
   `packages/preset/cc/tests/vwa-lane2.real-boot.spec.ts` (mandatory).

## 5. Out of scope

- Making the uninitialized-adapter fingerprint (no `effectiveConfig` key at
  all) equal the initialized one — the continue path always initializes first
  (review-continue.ts:237) and the fresh path never matches records.
- Persisting which budget a record ran under (diagnostics only, not identity).
- Fixing the stale comment at review-plan.ts:37 (says the task envelope
  includes a budget; it does not) — one-line cleanup may ride along, no
  behavior change.

## 6. Implementation order

Fix 4 lands first (independent). Fix 5 and Fix 6 land together in ONE PR so
the single one-time identity reset covers both; this doc's PR contains the
`configFingerprint` change above plus Fix 6's removal of the `tokenizer` label
from the same function.

## 7. Design review ledger (r1)

| seat | verdict | majors folded |
|---|---|---|
| codex | GO-with-majors | single-adapter identity pin impossible / drift staging wrong (→ §4.1/4.2); one-key denylist sufficiency unproven (→ verified closed `LlmCallConfig` + §4.5 tripwire + denylist-safety rationale) |
| grok | GO-with-majors | vacuous existing identity pin (fakeAdapter constant, → §4.4 real-adapter pin); kept-key pins; two-instance pin |
| critic | GO-with-majors | edge identity surface `host-delivery.ts` (→ §1.1); receipt invalidation disclosure (→ §3); allowlist recommendation (adjudicated to denylist + tripwire, rationale in §F5.1) |

Divergence note: critic recommended an allowlist; codex/grok verified the
one-key strip sufficient against the closed `LlmCallConfig`. Adjudicated to
denylist + shape tripwire because a denylist fails toward over-invalidation
(recompute) while an allowlist fails toward stale reuse.

### r2 (delta verification)

- codex: folds 8-11 + 13-14 all OK — `VERDICT: GO` (no D2 problems; no new
  findings).
- grok: folds 5-7 + 10-11 all OK — `VERDICT: GO` (no new findings).
- critic: 10/10 OK after re-spawn (the first instance stalled) — `VERDICT: GO`;
  explicitly accepted the denylist + config-shape-tripwire adjudication on the
  failure-direction argument (a wrong reuse is strictly worse than recompute;
  the tripwire forces classification of any future harness key). No new
  findings.

All three lanes converged GO on this document with no open item; Fix 5 shares
its PR with Fix 6, whose single r2 problem was folded and confirmed at r3.
