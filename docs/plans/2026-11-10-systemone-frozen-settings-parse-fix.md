# SystemOne decision-arm silence: frozen-section re-admission fix (issue #373)

- **Date**: 2026-11-10
- **Status**: v2.1 (r1: three-seat GWC; r2 delta: grok GWC + codex GWC, doc-level folds applied)
- **Commit slicing** (the landing order): (1)+(2) land as ONE commit — the clone and the reason
  union interleave on the same `parseDecisionSettings` hunks, so the parse seam (clone + reasons +
  warn-once + all parse-side tests) is one reviewable unit; (3) lands separately (`MAX_TIMEOUT_MS`
  raise + README + S1-03 table + long-deadline supersession test).
- **Issue**: #373
- **Impact**: all three SystemOne decision consumers (`memory-recall`, `memory-extraction-gate`, `tool-discovery`) silently never dispatch when the merged `systemone-decisions` section contains a non-empty `routes` dict; memory-recall is additionally silenced by an out-of-range `timeout-ms`.

## 1. Problem statement (verified live)

Two independent defects, both triggered by the same operator settings edit (2026-11-10 ~15:50):

### Defect A — frozen cascade section × mutating schemastery re-admission

The settings cascade read-through (`settings.get(ns)`, the path `registerNamespaceSafe` serves) returns a
**deep-frozen** schema-resolved section (freeze site: `settings-provider/src/provider.ts:188` —
`deepFreeze(resolveValue(...))`; verified live: `Object.isFrozen` true at top level and at `routes`).

`parseDecisionSettings()` (packages/observability/decision-usage/src/settings.ts) re-admits that section
through `SettingsObject(raw)` — a schemastery `z.object` whose `routes` field is a `z.dict`.
Schemastery's dict resolution **reassigns each `routes[<alias>]` entry in place** (the mutation class:
`z.dict` entry reassignment; `z.object` with scalar fields does not write when values are present —
which is why the eleven other packages that re-admit frozen sections through scalar-only
`SettingsObject`s (skill-usage, turn-rules, completion-gate, progress-rebuild, lsp-on-write,
advisor-watchdog, retry-attendant, moa, post-edit-verify, vwa-argument, vwa-evidence — grep audit,
r1) keep working). On a frozen `routes` object the reassignment throws:

```
TypeError: Cannot assign to read only property 'gauge' of object '#<Object>'
```

The throw is caught by `parseDecisionSettings`'s own `catch` (settings.ts:200-202) and mapped to
`{ status: 'invalid' }`. Per the fail-closed policy, `invalid` makes **no route usable** (route.ts /
service.ts `resolveRouteFor`), so `identifyRoute('gauge')` returns `undefined` and every consumer exits
before any reserve: discovery at `runTransaction`, recall at the selector's route resolution,
extraction through the same service.

Determinism (offline, shipped code): a deep-frozen resolved section **with** a non-empty `routes`
dict parses `invalid` (throw); **without** `routes` it parses `valid` — which is why ledger rows exist
until 15:47 and every fresh process after the pin row was added is silent.

The same re-admission pattern exists in:

- `parseExtractionDecisionSettings` (packages/memory/memory-consolidation/src/extraction-settings.ts:157)
  — scalar-only schema, latent today (no dict field), same class.
- `validateRecallDecisionSettings` (packages/memory/memory/src/recall-decision-settings.ts:154-155)
  — the settings provider invokes `validate` inside `resolveValue` **before** freezing, so this site is
  latent today, same class.

### Defect B — out-of-range `timeout-ms` rejects the whole recall namespace

`MAX_TIMEOUT_MS = 5000` (packages/memory/memory/src/recall-decision-settings.ts:86). The operator value
`8000` fails validation; per the whole-section rejection policy the namespace degrades to defaults
(`mode: 'off'`). Silent by design. A rejected **first** registration and an absent namespace are
indistinguishable at the reader — an observability gap noted in §6.

The bound also contradicts the planner it ships with: `timeoutMs` is the **whole-round** deadline
across all admission-planned batches (recall-decision-runner.ts deadline logic; per-batch
`signal.aborted` checks at the runner). Measured live: one 24-candidate batch ≈ 1315 ms; the default
`max-candidates` 96 / `batch-size` 24 planning ⇒ ≈ 5.2 s — above the shipped cap. (Discovery and
extraction are single-shot-ish transactions within their own 5000 caps; their defaults plan up to 8
initial batches — the comparison in v1 that claimed "two batches" was wrong, corrected here.)

### Why tests never caught it

Fixtures feed plain (unfrozen) literals. The live path (frozen cascade read-through with a pin row) is
never exercised. Third instance of the "fixture never walks the real wiring" class (#359, #368, this).

## 2. Goals / non-goals

**Goals**

1. A frozen cascade section parses exactly like its unfrozen deep copy — never `invalid` by mutation
   fault — **for every input that parses today** (no admission change, see 3.1).
2. An `invalid` section (a real rule violation) carries a stable machine reason and is surfaced
   through the decision-usage warn-once sink.
3. `MAX_TIMEOUT_MS` covers the shipped planner's realistic whole-round budget, as an opt-in ceiling.

**Non-goals**

- Changing the whole-section rejection policy (typo ≠ reset stays).
- Changing the freeze behavior of the settings cascade (environment contract).
- Making recall's rejected-first-registration distinguishable from absent at the reader (the settings
  service exposes no rejection status; follow-up, §6).
- Auditing/hardening the eleven scalar-only re-admission sites (no dict ⇒ no reassignment ⇒ not
  affected; covered by rationale in §1, revisit only if a dict field is ever added to one of them).
- The Claude-Code capability manifest: the touched surfaces are dsh-cc-internal SystemOne settings
  namespaces, not a Claude-Code-compatible surface — no `capabilities.yaml` entry covers them, so
  the manifest and the generated parity docs are unchanged by design (verified: both gates green).

## 3. Design

### 3.1 Structure-preserving deep copy (the core fix)

A single helper exported from **`@dsh-cc/settings/ns`** (all three affected packages already declare
it as a dependency; one definition + one property test beats three drifting copies):

```ts
/**
 * Structure-preserving deep copy for values that must survive an in-place
 * mutating pass (schemastery re-admission). Copies plain objects and arrays
 * into fresh mutable containers, preserving own keys exactly — including
 * undefined-valued keys and insertion order — and passes every other value
 * (functions, Dates, class instances, null) through by reference. Never throws;
 * cycle-safe via a seen-map. It is NOT validation: anything a section admitted
 * before is admitted after, byte-for-byte.
 */
export function copyForMutation<T>(value: T): T
```

Contract, precisely:

- Domain bound (codex r2): enumerable string-keyed own properties only — `Object.entries`
  semantics. Symbol-keyed and non-enumerable properties are not copied, and getters are invoked;
  the helper is total over its declared input domain (JSON-shaped cascade sections: string keys, no
  accessors), which is the domain every call site in this incident class feeds it.
- Own-property set, presence (an own `revision: undefined` stays an own `undefined` key), insertion
  order, and values are preserved exactly. Nothing is dropped, nothing is rejected, nothing is cloned
  beyond plain objects/arrays (non-plain values are immutable *inputs* to schemastery anyway — only
  the containers it writes into need to be fresh).
- `Object.prototype`/`__proto__` keys: copied as own data keys via `Object.hasOwn` iteration over
  `Object.entries` semantics — an own `"__proto__"` key is preserved as own data (assignment during
  clone uses `Object.defineProperty`-free plain assignment against a fresh object built with
  `Object.create(null)`? No — **plain `{}` with `Object.defineProperty` for `__proto__`-named keys**,
  matching how `cloneJsonShaped`'s TODO already characterizes this edge; a JSON cascade cannot carry
  it, and the property test pins the chosen behavior).
- Cycles: a `WeakMap` seen-set returns the already-copied container.

Call sites:

1. `parseDecisionSettings` (decision-usage/src/settings.ts):
   `resolved = SettingsObject(copyForMutation(raw))`.
2. `parseExtractionDecisionSettings` (memory-consolidation/src/extraction-settings.ts): same.
3. `validateRecallDecisionSettings` (memory/src/recall-decision-settings.ts):
   `const resolved = SettingsObject(copyForMutation(value))` — and the cross-field checks
   (include/exclude probabilities, fallback ≥ max) read from `resolved`, not from `value`
   (today they read `value` only because the in-place mutation aliased them; with a copy the
   schema-filled defaults must be the source of truth).

**Freeze-equivalence property** (the acceptance invariant): for every input `x` where both terminate,
`parseDecisionSettings(deepCopy(x))` and `parseDecisionSettings(deepFreeze(deepCopy(x)))` (two
independent copies, deep-equal comparison; `deepFreeze` freezes recursively including pin rows)
produce deep-equal results. The property test runs over representative inputs: absent, valid with
non-empty routes, null pin rows, `undefined`-valued keys, extra unknown keys, malformed sibling rows
(judged per-alias, NOT whole-section), rule-invalid quota keys, and a frozen section that is invalid
by rule (freeze must not mask rule violations — both sides invalid with the same reason).

### 3.2 Observability: stable reasons + one warn

`parseDecisionSettings`'s invalid variant gains a **required, stable machine reason**:

```ts
type DecisionInvalidReason =
  | 'not-an-object'        // the section is not a plain object
  | 'quota-key-type'      // a quota key spelled with a non-number
  | 'quota-bounds'         // post-schema integer/limit failures (e.g. 1.5 attempts, retries over cap)
  | 'legacy-capabilities' // leftover retired capabilities table
  | 'routes-shape'        // routes not a plain object
  | 'schema'              // the inner SettingsObject throw
  | 'schema-throw'        // readParsed's outer catch (reader faults)
```

Every invalid return is bound to exactly one code; reason codes are fixed enums — no raw exception
text, no input values. Each code is pinned by an existing invalid-path test. `readParsed()` (service.ts) warns **once** via
the existing `createWarnOnce` + `deps.warn` plumbing:

```
systemone-decisions: section invalid (<reason>) — no decision route is usable
```

Existing tests that assert `toEqual({ status: 'invalid' })` are updated to assert the reason
(v1's "existing tests unchanged" was wrong — folded). Recall/extraction have **no** existing
invalid-settings warn-once (r1 finding; v1 claimed otherwise — wrong, folded): their rejection
happens inside the settings service and their readers cannot distinguish rejected from absent, so a
warn there needs settings-service surface that does not exist; filed as follow-up (§6), not silently
claimed as done.

### 3.3 `MAX_TIMEOUT_MS`: 5000 → 30000 (opt-in ceiling)

- The default stays 1500. The **ceiling** exists so operators can size the whole-round deadline to
  their pool: measured ≈ 1.3 s per 24-candidate batch × 4 default batches ≈ 5.2 s, so the old 5000 cap
  was already below the default planner's realistic need; 30000 covers slower endpoints and larger
  admission plans with margin.
- Consumer effect (stated per r1): recall is fire-and-forget from pre-step (`void maybeRecall`, no
  await in the step path), with per-batch `signal.aborted` checks and current-generation guards in the
  runner — a long deadline cannot stall a step; worst case is a late enrichment that the generation
  check discards. Cancellation is exercised by tests.
- Discovery (100–5000) and extraction (100–5000) caps unchanged: their transactions are bounded by
  their own planners; only recall's planner structurally exceeds its old cap.
- README (`packages/memory/memory/README.md` timeout row) and the S1-03 design table updated in the
  same commit as the constant.

### 3.4 Placement

`copyForMutation` lives in `@dsh-cc/settings/ns` (new export, additive; one property test there).
The three consumers import it — no new package edges (all three already depend on settings-ns).

## 4. Test matrix (TDD)

Tests written first; the frozen-section regression tests fail against unfixed code.

| Test | File | Verifies |
|---|---|---|
| deep-frozen resolved section (incl. frozen pin rows) with non-empty `routes` parses `valid` and resolves the route | decision-usage settings.spec + service.spec | Defect A regression (parse level + service `identifyRoute` level) |
| freeze-equivalence property over the representative input set (§3.1) | decision-usage settings.spec | the acceptance invariant |
| rule-invalid frozen section stays `invalid` with the same reason as unfrozen | decision-usage settings.spec | freeze does not mask rules |
| null pin row / malformed sibling row / unknown extra keys: parse result unchanged by freeze, per-alias judgment preserved | decision-usage settings.spec | no admission change |
| own `revision: undefined` key stays own and keeps the alias unusable | decision-usage settings.spec (route resolution) | presence preservation |
| every invalid path carries a stable reason; existing invalid assertions updated | decision-usage settings.spec | observability |
| `readParsed` invalid → exactly one `deps.warn` with the reason | decision-usage service.spec | warn-once |
| input non-mutation: `parseDecisionSettings` does not write into the caller's object | decision-usage settings.spec | clone actually decouples |
| frozen extraction section parses like unfrozen | memory-consolidation extraction-settings.spec | latent class |
| `validateRecallDecisionSettings` accepts a frozen valid section; cross-field checks read resolved values | memory recall-decision-settings.spec | latent class |
| `timeout-ms: 8000` valid, `30000` valid, `30001` invalid, `4999` valid | memory recall-decision-settings.spec | new bound |
| long-deadline cancellation and stale-result suppression | memory `recall-decision-adapter.spec.ts` (between-batch abort) + `recall-decision-lifecycle.spec.ts` (long-deadline supersession) | 3.3 consumer effect |
| `copyForMutation`: cycles, undefined-valued own keys, insertion order, non-plain values by reference, `__proto__` own-key behavior | settings-ns copy-for-mutation.spec | helper contract |

Live acceptance (post-merge, user-side): `sync-local-profile`, fresh TUI session, one question + one
ToolSearch ⇒ `reserve → dispatch → settle` ledger rows; user-layer
`cc-systemone-memory-recall.timeout-ms` restored to `8000` (now legal).

## 5. Risks / edge cases

- **Behavioral change surface**: parse results change ONLY for inputs that threw on mutation today
  (frozen + dict) — from `invalid` to their rule-based result. A frozen section that is invalid by
  rule stays invalid. Non-JSON values inside `z.any()`-tolerated pin rows keep their per-alias
  judgment (copyForMutation passes them through, never rejects).
- **Clone cost**: sections are tiny (≤ a dozen keys, shallow pin rows); per-dispatch parse already
  ran the schema once.
- **`reason` required**: all invalid constructors/assertions updated in the same commit.
- **settings-ns export**: additive; `check:exports`/package-shape gates cover it.

## 6. Follow-ups (out of scope, filed separately)

- Recall/extraction invalid-vs-absent indistinguishability at the reader (needs settings-service
  rejection surface) — the Defect B observability gap.
- A shared "frozen read-through parses identically" property test wired into every registered
  namespace (the eleven scalar-only sites) once one of them ever grows a dict field.
- `cloneJsonShaped`'s `__proto__` TODO in settings-provider (property-safe construction).
