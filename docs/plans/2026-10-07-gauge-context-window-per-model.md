# gauge context window per-model adaptation (design)

- Date: 2026-10-07
- Status: internal critic passed (2 rounds, round-2 verdict GO after the §7 correction absorbed); user sign-off pending; NOT yet implemented.
- Scope: `packages/interaction/permission-rules` + `packages/settings/settings-cascade` + `packages/interaction/command-auto-mode` + capability manifest. Docs-only PR first; no behavior change for unconfigured deployments.

## 1. Background and problem

gauge (the auto-mode System One classifier/probe lane) previously pointed at
`laya`; it now points at `bjev`. The two models have different context
windows, but the window the client assumes is a **provider-domain** fact:

- `assembleSystemOneBackend` (gauge-backend.ts:67) reads an optional
  `contextWindow` from the `llm-pi-ai` provider record — one record
  (`orchestrix`) serves BOTH model ids, so switching the gauge alias model
  leaves the window stale.
- Absent that field, consumers fall back to
  `DEFAULT_GAUGE_CONTEXT_WINDOW = 1024` (gauge-adapter.ts:35) — a value
  pinned to the laya probe deployment.

The assumed window drives three consumption points (all downstream of
`backend.contextWindow` on the resolved `SystemOneInfo`):

1. **Classifier state budget** — `prepareSystemOneInput`
   (gauge-adapter.ts:112): `window − S1_ENVELOPE_TOKENS(4) − question
   tokens − S1_MARGIN_TOKENS(16)`, middle-elided (`MIN_STATE_TOKENS = 64`
   short-circuit → honest ask).
2. **Probe input window** — the probe-side budget arithmetic (window
   minus envelope/question/margin, head 2/3 + tail 1/3) is in
   `probeNoulOnce` (probe-systemone.ts:56, budget math :67).
3. **Truncation sentinel** — `isTruncated(usage, window)`
   (gauge-adapter.ts:175): `usage.input_tokens >= window` ⇒ degrade to
   ask / fail-open pass, never trust the verdict.

## 2. Measured evidence (2026-10-07 live probe, local orchestrix gateway)

Probe method: `POST http://127.0.0.1:8080/v1/systemone`, body
`{model, state, questions:{verdict:{type:'choice', instructions, criteria:{allow,ask,deny}}}}`,
state = `'x'.repeat(n)`. Probe scripts were session-local (`.scratch/`),
not committed; the numbers below are the durable record.

| model | state (chars) | HTTP | usage.input_tokens | reading |
|---|---|---|---|---|
| laya | 4,000 | 200 | 552 | no truncation |
| laya | 90,000 | 200 | **1024 (pinned)** | silent truncation at 1024 |
| laya | 1,000,000 | 200 | **1024 (pinned)** | replicates the pin |
| bjev | 4,000 | 200 | 551 | no truncation; tokenizer ≈ laya's |
| bjev | 90,000 | 200 | 11,301 | **no pin** — input_tokens tracks the true count |
| bjev | 100,000 | 200 | 12,551 | no pin |
| bjev | 130,000 | 200 | 16,301 | no pin |
| bjev | 135,000 | 200 | 16,926 | no pin |
| bjev | 155,000 | 200 | 19,426 | no pin |
| bjev | 160,000 | 200 (1 of 5) | 20,051 | intermittent |
| bjev | 140k–160k (various) | **500** (persistent across retries+pacing) | — | intermittent server errors |
| bjev | 530,000 | **422** | — | `{"detail":"state exceeds 65536 tokens: 66251"}` |
| bjev | 1,000,000 | **422** | — | `{"detail":"state exceeds 65536 tokens: 125001"}` |
| `llmbox_systemone/bjev` | 4,000 | 200 | 551 | prefixed id accepted, same model |

Findings:

- **F1 (laya)**: silent truncation at exactly 1024 tokens, 200 OK — the
  sentinel's target behavior, replicated today.
- **F2 (bjev)**: NO silent truncation observed anywhere ≤ 20,051
  `input_tokens`; the count tracks the true tokenization (~8 chars/token on
  dense ASCII). Oversized states fail loudly instead: explicit HTTP 422
  above 65,536 tokens ("state exceeds 65536 tokens: N"), and intermittent
  HTTP 500 for states ≳ 17,500 tokens.
- **F3 (bjev)**: both `bjev` and `llmbox_systemone/bjev` are accepted ids
  for the same underlying model → registry lookups must normalize the
  prefix.
- **F4**: bjev's failure modes are fail-closed from the lane's perspective:
  non-ok HTTP maps to `failure: 'error'` in `systemoneDecide` → classifier
  ask / probe fail-open pass. The residual risk of a too-high window is
  500-flake exposure feeding the route breaker (`'error'` is a breaker
  failure tag), not a silent-truncation verdict.

## 3. Failure-mode analysis (why the window must follow the model)

- **Assumed > actual** (dangerous): the gateway silently truncates at the
  LOWER actual window; `input_tokens` pins below the assumed value; the
  sentinel `>= window` never fires → a trusted verdict on partial state with
  no signal. This is the laya-class hazard; it is the class this design
  eliminates for known models.
- **Assumed < actual** (safe): over-elision → more conservative asks,
  fail-closed. Costs decision quality on pathological giant states only
  (real gauge states — tool calls — are typically ≪ 1k tokens).
- Conclusion: the window fact must be keyed by model id, and unknown ids
  must keep today's behavior (no regression for unconfigured deployments).

## 4. Design

### 4.1 Built-in per-model registry

New exports in `gauge-adapter.ts` (next to
`DEFAULT_GAUGE_CONTEXT_WINDOW`):

```ts
/** Measured System One model context windows (2026-10-07 probe; see design doc §2). */
export const GAUGE_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  laya: 1024,   // silent-truncation pin, replicated 2026-10-07
  bjev: 16384,  // no pin ≤ 20,051 tok; 422 hard limit 65,536; 500-flakes ≳ 17.5k tok
}

/** Registry keys are bare ids: `llmbox_systemone/bjev` → `bjev`. */
export function normalizeGaugeModelId(model: string): string

export type GaugeWindowResolution = {
  window: number
  source: 'settings' | 'registry' | 'record' | 'default'
  /** Set when a provider-record value was shadowed by the registry (see §4.3). */
  mismatch?: { registry: number; record: number }
}

export function resolveGaugeContextWindow(
  model: string,
  opts: { settingsOverride?: number; recordValue?: number },
): GaugeWindowResolution
```

`normalizeGaugeModelId` strips everything up to and including the last `/`
(no special-casing of `llmbox_systemone` — any gateway prefix collapses to
the bare id).

### 4.2 Resolution chain (precedence)

1. `permissions.autoMode.gaugeContextWindow` — explicit settings key
   (new, §4.4). The deliberate, model-aware manual override.
2. `GAUGE_MODEL_CONTEXT_WINDOWS[normalizeGaugeModelId(model)]` — the
   built-in measured fact for known models.
3. Provider record `llm-pi-ai.providers.<name>.contextWindow` — legacy
   fallback, applies only to UNKNOWN model ids (registry miss).
4. `DEFAULT_GAUGE_CONTEXT_WINDOW` (1024) — final fallback, unchanged.

Rationale for registry > record (a deliberate behavior change, see §4.3):
the record is provider-scoped and cannot distinguish laya/bjev behind one
gateway — it is exactly the stale-value carrier this design removes from
the decision path for known models. The explicit settings key (level 1) is
the supported way to override a registry value for a specific deployment.

### 4.3 Mismatch warn-once

When level 3 would have supplied a value but level 2 shadows it with a
different number, `assembleSystemOneBackend` emits ONE warn per process:

- key: `permission-rules:gauge-window-mismatch`
- message: `gauge model "<model>" has a known context window <R>; provider record contextWindow=<V> is ignored — set permissions.autoMode.gaugeContextWindow to override deliberately`

`resolveGaugeContextWindow` returns the mismatch structurally
(`mismatch: { registry, record }`); the warn itself lives in the caller so
the pure function stays side-effect-free and unit-testable.

The warn-once key is ONE process-global string shared across models and
both lanes: if two models mismatch differently, only the first warns (and
the classifier's warn suppresses the probe's). This is deliberate —
mismatches are configuration smells, not per-lane facts — do NOT "fix" it
into per-model keys later.

### 4.4 Settings key `permissions.autoMode.gaugeContextWindow`

One key at the `autoMode` level (NOT per `classifier`/`probe` sub-object):
both lanes resolve the SAME gauge alias, so the window is necessarily one
value; two sub-keys would drift and the probe (armed `auto` in this
deployment) would silently miss a classifier-only setting.

- Type: `number`, absence-preserving
  (`z.union([z.number(), z.const(undefined)])` — same idiom as
  `gaugeAllowThreshold`).
- Semantics comment (in both mirrors): the sentinel-blindness direction —
  a value LARGER than the model's real window can silently truncate
  verdict inputs; when in doubt configure low.
- Mirrors to update (all three, same PR):
  1. `packages/settings/settings-cascade/src/auto-mode.ts` — `AutoMode`
     interface + its schemastery `z.object` (the shared definition).
  2. `packages/interaction/permission-rules/src/settings-schema.ts` —
     `AutoModeSettings` interface + `autoMode` z.object (the hand-mirror).
  3. `packages/interaction/command-auto-mode/src/index.ts` — the local
     `autoMode` face type (line ~49 area) + render (§4.6).

### 4.5 Wiring (single seam, per-call resolution)

`GaugeBackendDeps` (gauge-backend.ts:43) gains:

```ts
/** Explicit window override from `permissions.autoMode.gaugeContextWindow`. */
gaugeContextWindow?: number
```

`assembleSystemOneBackend` (gauge-backend.ts:67) replaces the current
record passthrough (`...(typeof record.contextWindow === 'number' ? … : {})`,
line 105) with:

```ts
const resolution = resolveGaugeContextWindow(model, {
  settingsOverride: deps.gaugeContextWindow,
  recordValue: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
})
if (resolution.mismatch !== undefined) {
  deps.warnOnce(GAUGE_WINDOW_MISMATCH_KEY, /* message per §4.3 with resolution.mismatch */)
}
return { provider, model, baseURL, ...(await resolveApiKey(ctx, record)), contextWindow: resolution.window }
```

Type note (first compile error if missed): `assembleSystemOneBackend`'s
declared `deps` parameter is currently the INLINE type
`{ warnOnce: PolicyWarn }` (gauge-backend.ts:70), not `GaugeBackendDeps`.
Widen that inline param to
`{ warnOnce: PolicyWarn; gaugeContextWindow?: number }` (do NOT switch the
whole param to `GaugeBackendDeps` — callers pass smaller objects; the two
resolver entry points keep passing `GaugeBackendDeps`, which structurally
satisfies the widened inline type).

Both call sites construct the deps object per call inside a closure reading
`host.settingsSection()` live (pre-execute.ts:181 classifier, :234 probe):

```ts
gaugeContextWindow: host.settingsSection().autoMode?.gaugeContextWindow,
```

Because backend resolution is per call (not memoized on the slice), the key
hot-applies with NO `readSlice().raw` change — the raw array intentionally
stays untouched (a window change does not need a lane rebuild; the verdict
LRU keys on the rendered state, which naturally rotates when elision
changes).

Downstream consumers (`gauge-stage.ts:102`,
`probe-systemone.ts:63`) already consume `backend.contextWindow` — ZERO
changes there. `DEFAULT_GAUGE_CONTEXT_WINDOW` stays as the level-4
fallback; `isTruncated` semantics unchanged.

### 4.6 `/auto-mode config` render

The render function is `renderConfig` (command-auto-mode/src/index.ts:103).
Pin exactly (the `gaugeAllowThreshold` precedent renders inside
`classifierView` gated on `effective` — it does NOT transfer, because the
new key is autoMode-LEVEL):

- `AutoModeSection` interface (index.ts:43): add
  `gaugeContextWindow?: number` as a sibling of `classifyAllShell`.
- In `renderConfig`'s `payload` object, as a sibling of `classifyAllShell`:

```ts
gaugeContextWindow: autoMode?.gaugeContextWindow ?? null,
```

- Rendered UNCONDITIONALLY (payload level, OUTSIDE both `effective`
  blocks — it is a configured value, not an effective-resolution field,
  mirroring the `classifyAllShell` idiom `=== true`-less plain `?? null`).
- Comment: the resolution chain (§4.2) composes at call time in the
  gauge lane; the command reports the CONFIGURED value only (same
  honesty contract as `gaugeAllowThreshold`). Note the idiom difference
  from `classifyAllShell` (a boolean rendered `=== true`): this key is a
  NUMBER rendered `?? null`, like `gaugeAllowThreshold`'s configured-only
  null default.
- Spec updates: `command-auto-mode.spec.ts` asserts the full rendered
  shape (~:70 configured view, ~:105 default view) — both cases gain the
  `gaugeContextWindow` key (`null` in the default view, the configured
  number otherwise).

### 4.7 Capability manifest

`docs/claude-code-capabilities.yaml`: extend the gauge lane entry (the
2026-09 `classifier.backend` entry block around line 3548) with the new
`permissions.autoMode.gaugeContextWindow` key — settings-key claim WITH its
consumption chain (assembleSystemOneBackend overlay) so the
parsed-but-undelivered audit passes. Regenerate
(`pnpm docs:parity`) and commit the generated matrix in the same PR.

## 5. Explicitly unchanged

- `gateVerdict` / reason strings / τ handling / criteria wording.
- `isTruncated` (sentinel semantics; for bjev it is expected to never fire
  — F2 — but stays as defense for future gateways that truncate silently).
- `prepareSystemOneInput` / `probeNoulOnce` budgets (they take the window
  as a parameter; the change is upstream of them).
- `readSlice` / `readProbeSlice` (per-call resolution makes the key
  hot-apply without lane rebuilds).
- No-config behavior: laya deployments resolve registry 1024 == today's
  default (byte-identical); unknown model ids without a record value
  resolve default 1024 (byte-identical); unknown ids WITH a record value
  keep the record (byte-identical). The ONLY behavior change is known
  model + differing record value (registry now wins, with warn-once) and
  bjev deployments picking up 16384 instead of 1024 — both are the point
  of the PR.

## 6. Implementation checklist (one PR, docs+code or code-first)

1. gauge-adapter.ts: `GAUGE_MODEL_CONTEXT_WINDOWS`,
   `normalizeGaugeModelId`, `resolveGaugeContextWindow` (+ JSDoc citing
   §2 evidence).
2. gauge-backend.ts: `GaugeBackendDeps.gaugeContextWindow`,
   `GAUGE_WINDOW_MISMATCH_KEY` + message,
   `assembleSystemOneBackend` resolution swap (incl. the inline param
   type widening, §4.5).
3. pre-execute.ts: pass `gaugeContextWindow` at both deps construction
   sites (:181 classifier, :234 probe).
4. settings-cascade/src/auto-mode.ts: interface + schema.
5. permission-rules/src/settings-schema.ts: hand-mirror interface +
   schema.
6. command-auto-mode/src/index.ts: `AutoModeSection` face + payload
   render (§4.6).
7. gauge-stage.ts debug channel (gauge-stage.ts:134): extend the
   `[dsh:classifier:raw]` line to
   `gauge ${backend.model} @window=${backend.contextWindow} -> …`
   so the effective window is observable in dogfood (§8).
8. docs/claude-code-capabilities.yaml + `pnpm docs:parity` regeneration
   (run `pnpm check:capabilities` / `check:parity` in the PR — the
   generator's exact key conventions get validated there).
9. Tests (§7).

## 7. Tests

New `resolveGaugeContextWindow` unit spec (permission-rules/tests):

- precedence: settings > registry > record > default, one case each;
- normalization: `llmbox_systemone/bjev` and `bjev` both hit the registry;
  `foo/bar` → `bar` miss → chain continues;
- mismatch struct surfaced when record differs from a registry hit;
  absent when they agree or when the record is absent.

**Existing specs that BREAK and their exact fixes** (verified against the
current tree, round-2 re-verified): no spec asserts record
`contextWindow` passthrough today; instead, the SYSTEMONE-branch
exact-field `toEqual` cases break because their model
`llmbox_systemone/laya` becomes a REGISTRY hit, so `contextWindow`
materializes as `1024` in the resolved object:

- `tests/gauge-backend.spec.ts:67-74` (armed-gauge systemone `toEqual`) —
  expected object gains `contextWindow: 1024`.
- `tests/gauge-backend.spec.ts:130-135` (apiKey-omitted systemone
  `toEqual`) — same addition.
- `tests/systemone-lane-guard.spec.ts:49` (the `toEqual` on the resolved
  backend, model `llmbox_systemone/laya`) — same addition. (The spec's
  :41 is a field of the DEPS object, not the assertion.)

Do NOT touch the chat-branch exact-field `toEqual` cases in
gauge-backend.spec.ts (:165-169 explicit-chat, :195-199
unconfigured-chat, :220-224 haiku-backend) — chat results never carry
`contextWindow`; adding it there would break three passing tests. The
remaining systemone assertions in both files are `toMatchObject` and do
not break.
- The spec harness deps object for `assembleSystemOneBackend` /
  `resolveClassifierBackend` cases (gauge-backend.spec.ts:42-47 area)
  grows `gaugeContextWindow` (set it in the settings-override cases;
  omit elsewhere).

New backend-resolution cases (gauge-backend.spec.ts):

- settings override wins: model `bjev` + `gaugeContextWindow: 9999` →
  `contextWindow: 9999` (source `'settings'`);
- registry for bjev: no override + record WITHOUT `contextWindow` →
  `16384`;
- record passthrough on an UNKNOWN model id (e.g. `llmbox_systemone/xyz`)
  + record `contextWindow: 2048` → `2048` — this is the level-3
  regression case (none exists today);
- mismatch warn-once: model `bjev` + record `contextWindow: 1024` →
  resolution `16384` + one `GAUGE_WINDOW_MISMATCH_KEY` warn.

`resolveProbeBackend` delegates to `resolveClassifierBackend`
(gauge-backend.ts:143-148) — the existing delegation spec covers it; no
separate probe path to test.

command-auto-mode render spec: `gaugeContextWindow` reported when
configured, `null` in the default view (§4.6).

Gate battery: `pnpm -F @dsh-cc/permission-rules test` (root vitest),
`pnpm check:capabilities`, `pnpm check:parity`, `pnpm docs:parity`,
plus the standard presubmit set.

## 8. Verification (observable acceptance)

- All §7 specs green; full presubmit green.
- Dogfood (this deployment, gauge=bjev, probe backend auto): with no
  `gaugeContextWindow` configured, a gauge-armed auto-mode call with
  `DSH_PERMISSION_CLASSIFIER_DEBUG=1` logs
  `[dsh:classifier:raw] gauge bjev @window=16384 -> …` (§6 item 7 adds the
  window to that line — the pre-change line carries neither the window
  nor state length, so this is a prerequisite, not an option). Setting
  `permissions.autoMode.gaugeContextWindow` to another number and
  re-issuing the same call flips `@window=` without any lane rebuild,
  proving the per-call override hot-applies.
- A stale `llmbox_systemone/bjev` provider-record `contextWindow` (any
  value ≠ 16384) produces exactly one process-lifetime
  `gauge-window-mismatch` warning.

## 9. Out of scope / future work

- **R5 runtime auto-calibration** (per (process, model) oversized-state
  probe reading the pin) — deferred. Accepted risk: a deployment swapping
  the backbone under the SAME model id can invalidate the registry value
  (precedent: the 2026-09-30 laya multilingual swap). The explicit settings
  key is the mitigation if that happens.
- **τ / criteria per-model refreeze** (bjev @τ=0.5 corpus FA=11) —
  orthogonal axis; this design fixes verdict TRUST, not verdict QUALITY.
  Switching models still requires a corpus re-freeze (separate work).
- bjev 500-flake hardening (retry classification, breaker immunity) —
  the 16384 window bounds exposure; revisit only if dogfood shows
  breaker trips on giant states.

## 10. Decision points for the user

- **D1**: bjev registry value **16384** (evidence-based: below the observed
  500-flake zone ≳17.5k tokens, comfortably under the 422 hard limit
  65,536). A more conservative 12288/8192 buys flake margin at the cost of
  eliding giant states harder — real gauge states are typically ≪1k
  tokens, so the difference is theoretical for now. Default: 16384.

## 11. Review ledger

### Round 1 (2026-10-07, dsh-cc-agents:critic, cold review)

**Verdict: GO-WITH-CHANGES.** All code anchors, the precedence chain, the
hot-reload claim (verified per-call at auto-stage.ts:339 AND
pi-probe.ts:402 for BOTH lanes), and the mirror list (grep-confirmed: only
the three listed mirrors exist) verified sound. Findings and dispositions:

1. MAJOR — §7's claim about existing specs was factually wrong (no
   record-passthrough spec exists); the REAL breakage is five
   exact-field `toEqual` cases failing because `llmbox_systemone/laya`
   becomes a registry hit. **Absorbed**: §7 rewritten with the named
   cases and the missing level-3 regression case added.
2. MAJOR — §8's dogfood check was unobservable (the debug line carries
   no window). **Absorbed**: §6 item 7 adds `@window=` to the debug
   line; §8 rewritten around it.
3. MAJOR — render placement was a three-way ambiguity
   (`renderAutoModeConfig` vs `renderConfig`, classifier-level vs
   payload-level, gated vs unconditional). **Absorbed**: §4.6 pins
   `renderConfig` + payload-level sibling of `classifyAllShell` +
   unconditional `?? null` + spec updates.
4. MINOR — mismatch warn-once is one process-global key across models
   and lanes. **Absorbed**: §4.3 documents it as deliberate.
5. MINOR — spec harness deps must grow `gaugeContextWindow`.
   **Absorbed**: §7 notes it.
6. MINOR — `assembleSystemOneBackend`'s inline param type vs
   `GaugeBackendDeps`. **Absorbed**: §4.5 type note added.
7. NIT — `probeNoulOnce` line refs. **Absorbed**: §1 corrected.

Reviewer risks noted, dispositions:

- (a) parity-generator key conventions verified only structurally —
  §6 item 8 keeps `check:capabilities`/`check:parity` as in-PR gates.
- (b) probe scripts were session-local → evidence not re-derivable from
  the repo. **Absorbed**: Appendix A commits the probe script verbatim;
  the §2 table plus the script re-derives every number.

### Round 2 (2026-10-07, dsh-cc-agents:critic, delta re-review)

**Verdict: GO** (conditional on one doc correction, absorbed below).
Design §4.1–§4.6 verified implementable zero-question; every code anchor
re-verified. Findings and dispositions:

1. MAJOR — the round-1 absorption of finding #1 was ITSELF wrong at 3 of
   5 cited sites: only `gauge-backend.spec.ts:67-74` and `:130-135`
   (systemone exact-field `toEqual`) plus `systemone-lane-guard.spec.ts:49`
   actually break; `:165-169`/`:195-199`/`:220-224` are CHAT-branch
   `toEqual` cases that never carry `contextWindow` (adding it there
   would break three green tests). **Absorbed**: §7 rewritten with the
   verified breaking set and an explicit do-not-touch note for the chat
   cases; lane-guard assertion re-pinned :41 (deps) → :49 (assertion).
2. MINOR — §1's numbered list skipped item 2 after the round-1 probe-ref
   edit. **Absorbed**: renumbered.
3. NIT — §4.6's wording claimed classifyAllShell renders `?? null` (it
   renders `=== true`). **Absorbed**: reworded as an explicit idiom
   difference.
4. NIT — §9 cited "2026-10-30 laya swap" (postdates the doc date).
   **Absorbed**: corrected to 2026-09-30.

Reviewer noted the §7 error was self-revealing at first test run (only
the real breakers fail, and the fix is correct for each) — recorded here
so the ledger stays honest about the round-1 absorption defect.

## Appendix A — the measurement probe (verbatim, re-derives §2)

```js
// Truncation probe for the System One face: POST an oversized state and
// read where usage.input_tokens pins (silent truncation) or how the
// gateway rejects. Run with `node <file>` against a reachable gateway.
const BASE = 'http://127.0.0.1:8080'
const QUESTION = {
  type: 'choice',
  instructions: 'Judge whether an AI coding agent may run this tool call without asking the user first.',
  criteria: { allow: 'Safe to run unattended.', ask: 'Unclear or writes files.', deny: 'Destructive or irreversible damage.' },
}
async function probe(model, chars) {
  const res = await fetch(`${BASE}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bogus' },
    body: JSON.stringify({ model, state: 'x'.repeat(chars), questions: { verdict: QUESTION } }),
  })
  const text = await res.text()
  console.log(JSON.stringify({ model, chars, status: res.status, body: text.slice(0, 300) }))
}
// §2 ladder — pacing (≥1.2s) between requests; the bjev 500s are
// intermittent, retry a few times before reading a 500 as persistent.
```

Operational notes for re-running: the local gateway has no auth; HTTP 429
(`rate_limit_error`, llmbox shared qpm) requires pacing + backoff; a 500
in the ≳17.5k-token zone is intermittent — a "persistent" reading needs
several spaced retries (§2 marks which rows were persistent across
retries+pacing and which succeeded intermittently).
