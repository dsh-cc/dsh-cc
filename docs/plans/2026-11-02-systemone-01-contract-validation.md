# SystemOne request and response contract validation

Status: proposal, not implemented. Feature ID: S1-01. Priority: P0.

Source baseline: `31fb29eb77148e92ca8da365adcbf4994622a31d`. This design is implementable on its own and depends on no other new feature. Design set entry point: [overview](2026-11-02-systemone-00-overview.md).

## Problem and current behavior

[`systemoneDecide`](../../packages/llm-tuning/systemone/src/client.ts) is the native HTTP client shared by permissions, prompt-injection probing and MOA. Today `parseAnswer` only checks JavaScript types of fields; unknown types are dropped and the response succeeds as long as the remaining answers are non-empty. An answer may omit a question that was asked, or name a choice outside the candidate set. A missing usage is treated as zero.

[`gateVerdict`](../../packages/interaction/permission-rules/src/gauge-adapter.ts) returns ask on `choice === 'allow'` only if the matching probability exists and is below the threshold. `{type:'choice',choice:'allow',probabilities:{}}` therefore gets allow out of that function. This conclusion describes that function only; it does not mean the full permission chain necessarily performs an action.

The goal is that a successful client return means: every requested question has a usable, type-matching answer, values are valid, the candidate sets agree, and usage is auditable. Whether a decision is correct remains model evaluation and product policy; this feature neither raises nor lowers the existing probability thresholds.

## Scope and choice

Centralized strict validation in the client, plus an independent guard in the permission allow path. Repeating validation in each caller would drift; trusting server type guarantees cannot cover proxies, protocol drift, or test doubles.

Keep the `SystemOneResult` success/failure union and its four failure tags. Any validation failure is `failure: 'malformed'`. No models, SDKs, runtime dependencies or new settings switches are introduced. Every client call uses strict validation immediately; this is a defect fix, not a new model judgement enabled by default.

## Files and public interface

| Path | Responsibility |
|---|---|
| New `packages/llm-tuning/systemone/src/validation.ts` | Request-aware pure validator and error codes |
| Modify `packages/llm-tuning/systemone/src/client.ts` | Request pre-check, call the validator, return fixed failure message |
| Modify `packages/llm-tuning/systemone/src/index.ts` | Export validation types and functions |
| Modify `packages/interaction/permission-rules/src/gauge-adapter.ts` | Turn missing or invalid allow probability into ask |
| New `packages/llm-tuning/systemone/tests/validation.spec.ts` | Contract boundary matrix |
| Extend existing client, gauge adapter, MOA tests | End-to-end regression and legacy fixture repairs |

```ts
type ValidationCode =
  | 'invalid-request' | 'invalid-envelope' | 'invalid-model'
  | 'question-set-mismatch' | 'answer-type-mismatch'
  | 'invalid-choice' | 'invalid-probabilities'
  | 'invalid-score' | 'invalid-noul' | 'invalid-confidence'
  | 'invalid-usage';

type ValidatedResponse = {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: SystemOneUsage;
};

function validateSystemOneResponse(
  questions: Record<string, SystemOneQuestion>,
  raw: unknown,
): { ok: true; value: ValidatedResponse }
 | { ok: false; code: ValidationCode };
```

`ValidationCode` carries fixed codes only; it may not carry state, prompts, candidate text or the raw server payload. The client reason is fixed to `systemone validation: <code>`.

## Validation rules

### Request pre-check

Runs before any network request; on failure it returns malformed/invalid-request and the fetch call count is zero.

- questions must be a plain JSON object with 1 to 256 own keys. Question IDs are 1 to 128 characters, match `^[A-Za-z0-9_-]+$`, and may not be `__proto__`, `constructor`, `prototype`.
- instructions must be a non-empty string. The current public type is kept; it is not extended to arbitrary JSON instructions here.
- For choice, criteria is a plain object with 2 to 255 options, option IDs under the same limits above, and string descriptions.
- For score, criteria is an array of 2 to 10 non-empty strings ordered lowest to highest.
- For noul, criteria is optional; when present it may contain only the two string keys true and false, and both must be present.
- state must be JSON-serializable; reject cycles, BigInt, non-finite numbers, and values that serialize to undefined. The client catches serialization errors and does not throw them upward.
- model is a non-empty string of 1 to 256 characters. timeoutMs is a finite positive integer. Missing apiKey stays legal, for deployment gateways that do not need it.

### Response envelope and sets

The response must be a plain object, and model a non-empty string of 1 to 256 characters. The response model may differ from the request alias, but a successful result must keep the server model and must not backfill the alias.

answers must be a plain object; its own question keys must equal the request keys exactly. One missing, one extra, an unknown type or a type mismatch rejects the whole response — partial consumption is forbidden. JSON object order does not affect the judgement.

Unknown top-level envelope fields are permitted to exist but are not propagated. Each answer keeps only the fields of the current public return type; unknown fields are not recorded. All maps are built via `Object.create(null)`, so server keys are never written onto a plain object prototype.

### Choice

- choice is a key in the request criteria.
- The key set of probabilities must equal criteria exactly.
- Each probability is a finite number with `0 <= p <= 1`; strings and null are rejected.
- `abs(sum(probabilities) - 1) <= 1e-4`. Out-of-range values are not clipped and a wrong distribution is not renormalized.
- The probability of choice may not fall more than `1e-4` below the maximum probability. On a tie for maximum the server may return any of the tied options; business ranking must not depend on which tied option the server picked.
- confidence must be a finite number in `[0,1]`. confidence and the top option probability are distinct concepts and do not substitute for each other.

### Score

The current public type accepts only a probability map keyed by numeric index. If the rubric has n levels, probabilities must contain the string keys `"0"` through `String(n-1)` and no others. Per-value and sum rules are the same as Choice.

score must be finite and in `[0,n-1]`, and differ from `sum(i * p[i])` by no more than `1e-4`. A non-integer score is allowed. confidence must be in `[0,1]`. The server may return a legend; the client neither depends on nor propagates it.

### Noul and usage

noul must be a finite number in `[0,1]`. Noul does not require confidence. If confidence is returned it too is range-checked; a successful result keeps only noul and type, so non-standard fields are not taken as policy input.

usage must contain both input_tokens and output_tokens, each a non-negative safe integer. A legitimate zero is allowed, but a missing value is never converted to zero. A wrongly typed field, or only one of the two present, rejects the response.

### Independent guard in the permission function

The allow branch of `gateVerdict` must first check `Number.isFinite(pAllow) && pAllow >= 0 && pAllow <= 1`; if it fails, return `{verdict:'ask',reason:'gauge allow probability missing or invalid'}`. Only then evaluate the existing allowThreshold. Rule priority, deny-to-ask, user authorization evidence checks, breaker, and stale checks after a mode change are unchanged.

## Network, failure and compatibility

Keep the client's current behavior: at most two retries on 429, a total retry wait budget of 3000ms, and a Retry-After cap of 2000ms. An HTTP success whose content is malformed is not retried. A caller cancel still takes precedence over its own timeout, and neither is disguised as malformed.

| Input or event | Result |
|---|---|
| Any one requested answer missing | malformed as a whole; other answers are unusable |
| HTTP 200, but JSON cannot be parsed | malformed/invalid-envelope |
| No usage | malformed/invalid-usage |
| Probability 0, 1, or a legal tie | success |
| NaN, Infinity, negative value, sum outside tolerance | malformed |
| Unknown envelope field | ignored, not recorded |
| Caller abort and timeout both observable | cancelled |
| Correct low-confidence result from the server | success; the business layer decides whether to fall back |

Simplified success fixtures in current tests that omit model/usage/probabilities must be completed into legal envelopes; production validation is not relaxed for fixtures. The S1-02 attempt observer may extract metering values satisfying the usage rules before validation, and only that; an invalid response verdict does not make the request free.

## Implementation and acceptance

- [ ] Create the pure validator, adding concrete failure cases first. `{allow:0.7,ask:0.3}` passes when the options are allow/ask; a missing ask, a sum of 0.8, and a string allow all fail.
- [ ] Add completeness cases. Requesting a and b but returning only a, or returning an extra c, fails as a whole; the same set in a different order succeeds.
- [ ] Add Score cases. The three-level distribution `{0:0.25,1:0.5,2:0.25}` succeeds for score=1 and fails for score=2.
- [ ] Wire the client to the validator; confirm a failed pre-check sends no request, malformed triggers no retry, and 429 still honors the existing limits.
- [ ] Gauge regression: allow with empty probabilities, NaN or a negative value all yield ask; a legal allow below the threshold still yields ask; a direct rule rejection never reaches this function.
- [ ] Update existing consumer fixtures, run the commands below, and require exit 0 from each.

```sh
pnpm exec vitest run packages/llm-tuning/systemone/tests
pnpm exec vitest run packages/interaction/permission-rules/tests/gauge-adapter.spec.ts
pnpm exec vitest run packages/interaction/moa/tests
pnpm typecheck
```

Run `pnpm install --frozen-lockfile` as the repo requires before implementing. New test files must declare their direct dependencies in the owning package. Update the systemone README's bilingual contract description; a visible permission behavior fix must update the corresponding evidence in the capability manifest and run `pnpm docs:parity`.

## Release and rollback

Before release, run a contract test against one desensitized real envelope per deployment route, checking Score probability index shape in particular. A route that cannot meet the contract must not be used for new features; fix the gateway adapter first, do not loosen caller policy. This test validates protocol only and claims nothing about semantic reliability.

Roll back the client and its consumers as one commit unit. Even if compatibility forces a rollback of centralized validation, keep the independent gauge fix that turns a missing probability into ask; the behavior where a missing probability means allow must not be reintroduced.
