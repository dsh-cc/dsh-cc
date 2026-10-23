## Status: Implemented — PR #282 (open, pending merge). Design converged via
three-lane blind review (codex, grok, internal critic: r1 full review, r2
delta, r3 micro-confirmation — all GO; ledger in §7). Fix 6 of the post-lane-2 batch (ships with Fix 5 in one PR for a single identity reset).

All code anchors cite tree `8cf51b13`. Runtime evidence cites the 2026-10-22
reproduction (`run_787893ba` usage ledger, test project `prj_13485f41-…`).

## 1. Problem (P2 leftover)

The input-token reservation overestimates ~6.5×: `run_787893ba` shows a
reserved input of **209,175** against ~32,000 actual input tokens, burning the
cycle's `maxInputTokensPerRun` (160,000) long before actual spend reaches a
third of it. Default-budget projects hit `BUDGET_EXHAUSTED` early for no real
reason.

### 1.1 Root cause

Production wires no tokenizer: `createReviewAdapter({ llm, route })`
(review-host.ts:93) passes no `countTokens`, so `tokenizerAvailable` is false
(review-adapter.ts:122) and the fallback counts **raw UTF-8 bytes as tokens**:

```ts
// review-adapter.ts:238-243 (v1 state)
const bytes = Buffer.from(messages.map((m) => m.content).join(''), 'utf8').length
return { tokens: bytes, method: 'bytes-upper-bound' }
```

The measured envelope averaged ~6.5 bytes/token (English/JSON scaffold);
`bytes` therefore reserves 6.5× the real count. Reservations are durable
(usage ledger `reserved` rows, review-call.ts:133-142) and satisfy the cycle
gate BEFORE dispatch (review-cycle.ts:258-274), so inflated reservations both
lock out subsequent calls and (on failure paths, which keep the reserved
count, review-call.ts:222-228) persist as spend.

### 1.2 Why v1's "bytes/3 upper bound" was wrong (r1 codex NO-GO)

No byte coefficient below 1 byte/token is a universal bound: `齉`×100 is 300
bytes and tokenizes to 300 (cl100k) / 200 (o200k) tokens — codex measured this
with tiktoken; grok confirmed the same direction with DeepSeek's published
~0.3 token/char English ratio (≈3.33 bytes/token, i.e. bytes/3 UNDER-reserves
by ~11%) and cl100k Chinese (~2.2-2.4 bytes/token). Critic's GO verdict
carried the same caveat ("bounded, acceptable"). The claim, not the mechanism,
was the blocker.

## 2. Design

### F6.1 Count `bytes / 3` as an ESTIMATE, with the overshoot bounded and disclosed

```ts
const bytes = Buffer.from(messages.map((m) => m.content).join(''), 'utf8').length
// F6: approximate accounting, NOT an upper bound. Measured against real
// tokenizers (see the calibration table below), reviewer envelopes run ~3.6
// (English prose) to ~6 bytes/token (JSON/code), where bytes/3 is conservative
// (1.0-1.8x the real count); token-dense text (CJK prose ~2.6, rare CJK ~1.3,
// emoji ~1.4 bytes/token) under-reserves by up to ~2.3x. bytes/3 removes the
// reproduction's 6.5x inflation while that bounded under-reserve is disclosed
// and covered by settled actuals plus the runtime budget guard.
return { tokens: Math.ceil(bytes / 3), method: 'bytes/3-estimate' }
```

**Calibration (added after PR #282 review; measured, not assumed).** The
fixture `packages/interaction/vwa-argument/tests/fixtures/input-calibration.json`
carries seven text classes with their UTF-8 byte counts and token counts from
`cl100k_base` / `o200k_base`; `tests/review-input-calibration.spec.ts` pins the
classification:

| class | bytes | estimate `ceil(b/3)` | cl100k | estimate/实际 |
|---|---:|---:|---:|---:|
| English prose | 450 | 150 | 85 | 1.76× |
| JSON envelope | 232 | 78 | 64 | 1.22× |
| TypeScript code | 510 | 170 | 128 | 1.33× |
| mixed (中英+符号) | 117 | 39 | 38 | 1.03× |
| Chinese prose | 189 | 63 | 74 | 0.85× |
| rare CJK glyphs | 90 | 30 | 70 | 0.43× |
| emoji / symbols | 128 | 43 | 90 | 0.48× |

**The input budget is therefore an APPROXIMATE control, not a strict upper
bound.** Worst observed under-reservation is ~2.3× (rare-CJK glyphs, cl100k);
the estimate is never allowed to be treated as a hard bound anywhere in the
code path, and the settle/reconcile machinery (settled actuals, durable
reserved rows, `maxCallsPerRun`-bounded failure accumulation) is what keeps the
error bounded. A class the fixture does not cover must be re-measured the same
way (fixture `text` → tokenizer) before its behavior is quoted.

**Accounting semantics (the part that makes this safe, and the reason the doc
no longer claims a bound):**

- The reservation is an ESTIMATE used for admission only. After every call the
  durable ledger carries an `actual` row, and `settle()`
  (review-tasks.ts:152-157) nets the local tracker to actuals; `loadRequest`
  reconciles persisted totals from the LAST row per attempt
  (review-run-store.ts:125-145), so settled spend is exact and later gates
  reserve against actuals, not estimates.
- **Overshoot exposure has two parts, both bounded (r2 codex correction):**
  1. **In-flight calls**: at most `concurrency` (schema max 4, default 2) calls
     are simultaneously reserved at the estimate; per call the measured
     under-estimate factor is ≤1.2× on the script classes the fixture covers
     (CJK prose 0.85×) and ≤2.33× on rare-CJK/emoji-dense text (calibration
     table above; the earlier "≤1.4×" figure was an unmeasured assumption and
     is superseded).
  2. **Failed dispatches with no provider usage**: on an error path the
     adapter throws without usage, and `ReviewCaller` records the ESTIMATE
     (`result?.inputTokens ?? counted.tokens`, review-call.ts:222-228 — the
     same value `settle()` uses). The ledger's last row per attempt
     (review-run-store.ts:125-145) therefore charges that attempt the estimate
     forever. These are NOT in-flight — they accumulate across the run.
     Bound: at most one such row per failed attempt, ≤ `maxCallsPerRun`
     attempts per run, each under-counting by `actual − estimate` (the model
     did spend something before failing, typically more than the estimate for
     token-dense input and less for ASCII). Accepted and stated, not hidden:
     making failed-attempt spend exact needs provider usage on error
     responses, which the adapter does not receive today (dispatch throws
     before usage is returned, review-adapter.ts:195-211) — obtaining it is a
     separate change, out of scope here.
- The budget is a money guard with bounded slack, not a hard admission
  invariant — this fix makes that explicit instead of pretending byte counting
  was exact.
- **Failure paths** (no provider usage reported) keep the estimate rather than
  the inflated byte count — 1.9× conservative instead of 6.5×
  (review-call.ts:222-228). The residual under-count this implies for those
  attempts is bounded and disclosed in the bullet above; §4.3 pins the
  recorded value so the semantics cannot drift silently.
- **Direction of the trade**: over-reserving breaks the user (premature
  `BUDGET_EXHAUSTED`, the reported P2); under-reserving costs at most the
  bounded overspend described above (in-flight calls plus unknown-spend
  failures) on a budget dimension whose own refusal copy already says
  "Reservation upper bound; actual usage may be lower" (feasibility.ts:163).
  We accept the bounded overshoot and state the numbers.
- Test 3 must therefore assert the arithmetic and the
  ledger/settle semantics — NOT an inequality against a real tokenizer (v1's
  "still ≥ any plausible count" pin would encode the false claim; r1 grok).

### F6.2 Remove the `tokenizer` label from `configFingerprint`

How input was COUNTED is a budget-accounting fact — it changes reservations,
never review content — so by the Fix 5 principle it does not belong in record
identity (review-adapter.ts:234):

- Remove the `tokenizer` key from the fingerprint.
- This makes the F6.1 label change identity-neutral: the recalibration
  invalidates no record by itself.
- Ships in the SAME PR as Fix 5 (one folded one-time identity reset).

### F6.3 Downstream consumers — verified safe (r1)

- **Timeout scaling** (review-call.ts:157-162): `counted.tokens × 2ms`, floored
  at `callTimeoutMs` and capped at 4×; a smaller count only moves the computed
  timeout toward the floor — negligible, safe.
- **Context gate** (review-call.ts:115): compares CHARS, untouched.
- **Reserve/settle** (review-tasks.ts:140-157; review-cycle.ts:258-274): consume
  the count as-is; smaller reservations fit more calls — the intended repair.
- **Method label is typed in TWO places** (r1 critic): the `UsageRow.method`
  union (review-run-store.ts:43) and the `ReviewModelAdapter.countInput`
  return type (review-adapter.ts:95). Both move to
  `'tokenizer' | 'bytes/3-estimate'`. Existing test pins that hardcode
  `'bytes-upper-bound'` / `tokens === 40` (tests/review-adapter.spec.ts:88-89,
  tests/budget-recovery.spec.ts:14/47) are updated in this PR.

## 3. Migration / compatibility

- No settings, schema, or refusal-copy change. Persisted-shape change: the
  `method` string in usage-ledger rows (informational).
- Identity impact is folded into the Fix 5 PR (one-time reset, disclosed
  there).

## 4. Tests (TDD; `packages/interaction/vwa-argument/tests/`)

1. Fallback caliber: 400-byte ASCII message → `ceil(400/3) = 134`,
   `method: 'bytes/3-estimate'`; 300-byte CJK message → 100.
2. **Identity neutrality via the real signal (r1 grok #9: `tokenizerAvailable`
   is a declared-but-shadowed dead option — `tokenizerAvailable` derives solely
   from `options.countTokens !== undefined`, review-adapter.ts:118-122).**
   Two adapters, one with a `countTokens` callback and one without, produce the
   SAME `configFingerprint()` post-F6.2.
3. Reservation semantics pin: an envelope measuring 209,175 bytes reserves
   69,725; a second such call still fits a 160,000-token cycle budget (the
   pre-fix behavior refused it); after `settle` with a 32,000-token actual, the
   tracker and ledger row carry 32,000 (settled actuals govern).
3b. **Failure-path recording pin (r2 codex):** a dispatch that throws without
   provider usage leaves an `error` row carrying the ESTIMATE
   (`counted.tokens`), and a subsequent `loadRequest` reports that attempt at
   the estimate — the documented, accepted semantics of §F6.1 bullet 2, pinned
   so a future change cannot flip it silently.
4. Updated existing pins: `tests/review-adapter.spec.ts:88-89` (label and the
   40-byte count), `tests/budget-recovery.spec.ts:14/47` (label literals).
5. Full battery: `vitest vwa-argument` +
   `packages/preset/cc/tests/vwa-lane2.real-boot.spec.ts` (mandatory).

## 5. Out of scope

- Wiring a REAL tokenizer: the host exposes no token-count face to plugins
  today; when it does, the `tokenizer` path already exists and wins over the
  fallback.
- Restructuring settle/release machinery — it already nets actuals.
- Any promise of a hard `maxInputTokensPerRun` invariant under adversarial
  token-dense input (see F6.1 semantics).

## 6. Implementation order

One PR together with Fix 5 (shared `configFingerprint` change). Fix 4 lands
before, independently.

## 7. Design review ledger (r1)

| seat | verdict | disposition |
|---|---|---|
| codex | NO-GO | Blocker = the false universal upper-bound claim, with tiktoken counterexamples (齉: 300 bytes → 300 tokens). Accepted: v2 drops the bound claim and ships codex's own suggested third option — "explicitly redesign as approximate accounting with accepted overshoot". |
| grok | GO-with-majors | Same substance: bytes/3 under-reserves vs the real reviewer tokenizer (DeepSeek ~3.33 B/token English); dead `tokenizerAvailable` option; two method-label sites; existing pins. All folded (§F6.1 semantics, §4.2, §F6.3, §4.4). |
| critic | GO | "bytes/3 right coefficient, safe for CJK; worst realistic under-reserve bounded and small" — same as v2's §F6.1 framing. |

Verdict-divergence adjudication (per house rule, implement-as-written test):
v1 written as "a safe upper bound that must never under-reserve" would ship a
false invariant → blocker-level, so codex's NO-GO severity is adopted; the
substantive prescription was identical across all three seats and is what v2
implements.

### r2 (delta verification)

- grok: folds 8-11 all OK — `VERDICT: GO` (no new findings).
- codex: fold 12 PROBLEM — "in-flight window only" overshoot claim is
  unsupported because `review-call.ts:222-228` retains the ESTIMATE on failure
  paths, so settled under-counts can accumulate across successive calls.
  FOLDED: §F6.1 now states the two-part exposure (in-flight window + failed
  dispatches without provider usage), bounds the failure part by
  `maxCallsPerRun` attempts, names why exact failure spend is unavailable
  (dispatch throws before usage, review-adapter.ts:195-211), and adds §4.3b to
  pin the documented failure-path recording. `VERDICT: NO-GO` at r2, resolved
  by this fold.
- critic: 10/10 OK after re-spawn (the first instance stalled) — `VERDICT: GO`,
  explicitly accepting the approximate-accounting reframe as "strictly
  stronger" than its r1 GO, and confirming the failure-path fold.

### r3 (micro-confirmation) — codex, single item

`FOLD-12: OK` — §F6.1 bullet 2 discloses both exposure parts, bounds the
persistent-estimate charges by ≤ `maxCallsPerRun` failed attempts per run, and
names the throw-before-usage limitation; §4.3b pins the recording and
reconciliation. `VERDICT: GO`. All three lanes converged GO.
