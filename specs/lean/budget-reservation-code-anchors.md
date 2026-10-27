# budget-reservation — code anchors

Verbatim excerpts of every cited model, adapter, corpus, implementation and mutant file,
captured at worktree commit `d709fe3d` on branch `worktree-lean-integration`.
This file exists so citation markers point at an in-repo markdown target (the citation
whitelist admits `*.md` targets only); the authoritative sources are the paths named in
each section heading.

## Model — `specs/lean/budget-reservation/Model.lean` 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L9-L29〕

```lean
namespace Formal

/-- Reject when the prior state is already invalid, otherwise reserve. -/
def reserve (budget reserved amount : Nat) : Except String Nat :=
  if reserved > budget then .error "invalid-state"
  else if amount > budget - reserved then .error "insufficient-budget"
  else .ok (reserved + amount)

/-- Documented API contract as a state step: on success the caller's
reservation becomes the new amount; on rejection it stays exactly as it was. -/
def reserveState (budget reserved amount : Nat) : Nat × Except String Nat :=
  match reserve budget reserved amount with
  | .ok value => (value, .ok value)
  | .error code => (reserved, .error code)

end Formal
```

## Properties — `specs/lean/budget-reservation/Properties.lean` 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L30-L68〕

```lean
import Model

namespace Formal

/-- Success implies the returned reservation stays within the budget. The
premise `r <= b` is stated explicitly so `Nat` subtraction is not saturating. -/
theorem reserve_preserves_bound (b r a : Nat) (h : r <= b) (ha : a <= b - r) : r + a <= b := by
  omega

/-- Success adds exactly the requested amount to the prior reservation. -/
theorem reserve_adds_amount (b r a v : Nat) (h : reserve b r a = .ok v) : v = r + a := by
  unfold reserve at h
  split at h <;> simp_all
  split at h <;> simp_all

/-- Rejection preserves the caller's prior state under the documented API
contract (`reserveState` keeps `reserved` on every error). -/
theorem reserve_rejection_preserves_state (b r a : Nat) (code : String)
    (h : reserve b r a = .error code) : (reserveState b r a).1 = r := by
  unfold reserveState
  simp [h]

theorem reserve_zero (b r : Nat) (h : r <= b) : reserve b r 0 = .ok r := by
  simp [reserve, Nat.not_lt.2 h]

/-- Witness: an explicit, nonempty instance of the success domain. -/
theorem admissible_example : reserve 10 3 4 = .ok 7 := by
  simp [reserve]

/-- Witness: an explicit, nonempty instance of the rejection domain. -/
theorem rejection_example : reserve 10 11 1 = .error "invalid-state" := by
  simp [reserve]

end Formal
```

## Reference — `specs/lean/budget-reservation/Reference.lean` 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L69-L110〕

```lean
import Lean
import Model

namespace Formal

/-- Canonical decimal grammar `^(0|[1-9][0-9]*)$` (design section 15). -/
def canonicalNat? (value : Lean.Json) : Option Nat :=
  match value with
  | .str text =>
    if text.isEmpty then none
    else if !text.toList.all (fun char => char.isDigit) then none
    else if text.startsWith "0" && text.length != 1 then none
    else text.toNat?
  | _ => none

/-- Pure JSON boundary for the domain-specific reference model. -/
def reference (input : Lean.Json) : Except String Lean.Json :=
  match input.getObj? with
  | .error _ => .error "invalid-amount"
  | .ok fields =>
    if fields.size != 3 then .error "invalid-amount"
    else
      let decode (name : String) : Except String Nat :=
        match fields.get? name with
        | none => .error "invalid-amount"
        | some value =>
          match canonicalNat? value with
          | some number => .ok number
          | none => .error "invalid-amount"
      match decode "budget", decode "reserved", decode "amount" with
      | .ok budget, .ok reserved, .ok amount =>
        match reserve budget reserved amount with
        | .ok value => .ok (.str (toString value))
        | .error code => .error code
      | _, _, _ => .error "invalid-amount"

end Formal
```

## Adapter — `specs/lean/budget-reservation/conformance/adapter.mjs` 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L111-L149〕

```js
// Conformance adapter for the shipped budget-reservation model. It binds the
// committed fixture implementation through Node ESM resolution relative to this
// module (never the process working directory) and keeps no second copy of the
// algorithm. Stdout is protocol-only; diagnostics go to stderr (design section 7).
import { reserve } from '../../../../packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/packages/example/src/budget.ts'

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const fail = message => { throw new Error(message) }

const text = await readStdin()
const lines = text.split('\n')
if (lines.at(-1) === '') lines.pop()
const answers = []
lines.forEach((line, index) => {
  if (line.length === 0) fail(`blank line at position ${index + 1}`)
  let parsed
  try { parsed = JSON.parse(line) } catch (error) { fail(`line ${index + 1} is not JSON: ${error.message}`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`line ${index + 1} must be an object`)
  if (Object.keys(parsed).length !== 2 || !('id' in parsed) || !('input' in parsed)) fail(`line ${index + 1} must contain exactly id and input`)
  answers.push(JSON.stringify({ id: parsed.id, result: reserve(parsed.input) }))
})

try {
  process.stdout.write(answers.map(answer => answer + '\n').join(''))
} catch (error) {
  console.error(`adapter: ${error.message}`)
  process.exitCode = 1
}

```

## Corpus — `specs/lean/budget-reservation/conformance/cases.jsonl` (first eight named cases) 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L150-L162〕

```json
{"id":"boundary-exhaustion","input":{"budget":"10","reserved":"3","amount":"7"},"covers":["budget-bound","adds-amount"]}
{"id":"zero-request","input":{"budget":"10","reserved":"3","amount":"0"},"covers":["budget-bound","adds-amount","zero-request"]}
{"id":"above-safe-integer","input":{"budget":"9007199254740993","reserved":"0","amount":"9007199254740993"},"covers":["budget-bound","adds-amount"]}
{"id":"excess-by-one","input":{"budget":"10","reserved":"3","amount":"8"},"covers":["rejection-preserves-state"]}
{"id":"invalid-prior-state","input":{"budget":"5","reserved":"8","amount":"3"},"covers":["rejection-preserves-state"]}
{"id":"malformed-amount","input":{"budget":"10","reserved":"3","amount":"ten"},"covers":["rejection-preserves-state"]}
{"id":"negative-amount","input":{"budget":"10","reserved":"3","amount":"-1"},"covers":["rejection-preserves-state"]}
{"id":"malformed-shape","input":{"budget":"10"},"covers":["rejection-preserves-state"]}
```

## Implementation — `packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/packages/example/src/budget.ts` 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L163-L192〕

```ts
// Fixture implementation bound by the budget-reservation conformance adapter.
// Erasable TypeScript only, so Node imports it directly (design section 7).
// Numeric JSON values are canonical decimal strings converted to BigInt under
// the reviewed grammar `^(0|[1-9][0-9]*)$` (design section 15).
const DECIMAL = /^(0|[1-9][0-9]*)$/

export type Reservation = { ok: string } | { error: { code: string } }

function decode(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  return BigInt(value)
}

export function reserve(request: unknown): Reservation {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return { error: { code: 'invalid-amount' } }
  const fields = request as { budget?: unknown; reserved?: unknown; amount?: unknown }
  if (Object.keys(fields).length !== 3) return { error: { code: 'invalid-amount' } }
  const budget = decode(fields.budget)
  const reserved = decode(fields.reserved)
  const amount = decode(fields.amount)
  if (budget === null || reserved === null || amount === null) return { error: { code: 'invalid-amount' } }
  if (reserved > budget) return { error: { code: 'invalid-state' } }
  if (amount > budget - reserved) return { error: { code: 'insufficient-budget' } }
  return { ok: (reserved + amount).toString() }
}
```

## Known-bad mutant — `packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/mutants/budget-omits-guard.ts` 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L193-L220〕

```ts
// Known-bad implementation mutant (design section 15): it omits the
// `reserved > budget` admission guard, so an already invalid prior state is
// accepted instead of rejected as `invalid-state`.
const DECIMAL = /^(0|[1-9][0-9]*)$/

export type Reservation = { ok: string } | { error: { code: string } }

function decode(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  return BigInt(value)
}

export function reserve(request: unknown): Reservation {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return { error: { code: 'invalid-amount' } }
  const fields = request as { budget?: unknown; reserved?: unknown; amount?: unknown }
  if (Object.keys(fields).length !== 3) return { error: { code: 'invalid-amount' } }
  const budget = decode(fields.budget)
  const reserved = decode(fields.reserved)
  const amount = decode(fields.amount)
  if (budget === null || reserved === null || amount === null) return { error: { code: 'invalid-amount' } }
  if (amount > budget - reserved) return { error: { code: 'insufficient-budget' } }
  return { ok: (reserved + amount).toString() }
}
```
