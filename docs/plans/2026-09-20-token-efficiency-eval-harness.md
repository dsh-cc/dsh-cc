# Token-Efficiency Eval Harness: frozen gates, Pareto acceptance, held-out discipline

Date: 2026-09-20. Status: design — critic cold review passed with amendments (9 findings:
replay tier rebuilt on committed sanitized fixtures with honest gate semantics, freeze rule
mechanized in presubmit, baseline refreshed with metrics.ts changes, counter folding moved
upstream into feature packages; all baked in below).

Origin: the methodological core of SoL-Pi (arXiv:2609.20519), which the paper itself claims
matters more than its four retained mechanisms: a broad-to-deep search funnel whose value
came entirely from **selection discipline** — metrics and tolerances frozen *before*
search, capability held within pre-declared tolerance while efficiency must improve on at
least one declared axis, Pareto-non-dominated retention, held-out evaluation that never
flows back into search, and one-shot isolated lineages per direction so failures cannot
couple across candidates.

## 1. Problem

dsh-cc's harness changes (CCR, cache-health, microcompact, this batch's reducer/deferral/
cost-gate/auto-verify) are gated by correctness batteries (vitest, parity, manifests) but
by **nothing that measures their actual purpose**: token traffic and dollars. Prior art the
repo already paid for once — the cache-diagnosis work (PR #59) discovered grok's
single-slot cache and llmbox zero-accounting only through one-off forensics; the
startup-boot optimization measured 8.8s→1.2s through ad-hoc instrumentation. Every future
efficiency PR currently re-derives its own measurement, and any two PRs' numbers are not
comparable.

What we need is small and borrowable: a fixed corpus + frozen acceptance file + a runner +
a comparator. The paper's discipline, scaled down to something a repo can afford to run.

## 2. Ground facts (verified 2026-09-20 against this checkout; re-verified in review)

- **Offline usage replay exists.** `analyzeSessionCache(events)`
  (`packages/test-support/cache-trajectory/src/session-log-analysis.ts:120`) folds a
  session log into per-request cache patterns purely from `SessionLogEvent[]` — no
  network, no composition boot. Session log reading incl. zstd framing:
  `cache-trajectory/src/bin.ts:134-139` (`zstd -dc` shell-out, `DSH_ZSTD_BIN` override;
  zstd is preinstalled on GitHub ubuntu runners).
- **Cost folding exists.** `foldCost(events, table)` (`command-cost/src/cost.ts:151`) and
  `resolvePrice` three-tier match (`cost.ts:108-131`). **Wrinkle:** `foldCost` consumes
  typed `SessionEvent`; raw replay logs are loosely-typed `SessionLogEvent`. Phase 0
  includes one small adapter + test bridging the two shapes rather than assuming a
  frictionless handoff.
- **Deterministic assembly exists.** `mountAgentLoopTestDependencies` boots the real
  preset against a scripted MockAdapter (precedent:
  `packages/context/context-crusher/tests/composition.spec.ts:12`).
- **Live-run bootstrap exists.** cache-trajectory's bin already provisions a real session
  (`--trajectory/--report-only/--provider/--model/--api-key/--base-url/--no-cc-plugins`);
  §3.1 imports this machinery rather than re-deriving a runner.
- **Session log layout:** `<sessionsRoot>/<projectKey>/<sessionId>/session*.jsonl.zstd`
  (`session-forensics/src/scan.ts`).
- **Live observation of token traffic:** `llm/stream` observe-only listeners; usage split
  via `foldUsage` (`cache-health/src/report.ts:66`).

## 3. Design

### 3.1 Package `packages/test-support/token-efficiency` (`@dsh-cc/token-efficiency`)

test-support placement keeps it out of the shipped bundle and the parity manifest.
**Import vs. write-new inventory:**

| imported from cache-trajectory | written new here |
|---|---|
| `readSessionEvents` (incl. zstd seam), `analyzeSessionCache`, live bootstrap machinery | corpus loader (`corpus.ts`), gate comparator (`gate.ts`), metric folding (`metrics.ts`), thin `bin.ts` |

The new surface is three modules + a bin (`run`, `check`), not a parallel harness.

### 3.2 Corpus — and what replay actually measures

A task descriptor is one YAML file under `corpus/`:

```yaml
id: reducer-fires-on-vitest-fail
kind: replay | mock-script | live
fixture: fixtures/reducer-vitest-fail.sanitized.jsonl   # replay: committed blob
prompt: "..."                                           # mock-script / live
oracle: { type: file-exists, path: ... }                # live / mock-script only
counters: { expect: { "reducer.applied": ">=1" } }       # mock-script: wiring assertions
tags: [reducer, logs]
```

**Replay fixtures are committed sanitized blobs, not references.** Raw logs live in
`~/.dsh/sessions` and contain system prompts, tool output, and repo content — committing
them raw is a secret/licensing hazard, and absolute-path references are unusable in CI.
Phase 0 ships a redactor that strips message/tool bodies and keeps exactly the events the
metrics fold: request/usage/route/ledger-adjacent fields. The sanitized output is reviewed
like any fixture and committed under `fixtures/`.

**Honest gate semantics** (this restatement is the heart of the review amendments):

- **replay tier = metric-definition regression suite.** Vectors are a deterministic
  function of (fixed blob, current `metrics.ts`). A replay vector change means the metric
  definitions changed — it can never evidence a feature's savings, and a green replay tier
  must never be read as "savings proven." The only replay failure mode is parse/fold
  error; replay vectors carry no `capability` field.
- **mock-script tier = feature-wiring regression suite.** MockAdapter-scripted runs assert
  that features *fire* (or correctly don't) and that metric folding records the traffic.
  Two scripts per feature: a fires-case and a doesn't-fire control — one flaky script per
  feature would otherwise blind it.
- **live tier = the only home of improvement claims.** Held-out, per-PR, run by hand;
  results are attached to the PR as evidence and are never fed back into tuning the same
  candidate (one-way valve, per the paper).

### 3.3 Metric vector and the frozen gate

```ts
interface MetricVector {
  task: string;
  capability?: { ok: boolean };          // live/mock-script only — absent for replay
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  costUsd?: number;                      // when deployment table resolves
  counters: Record<string, number>;      // folded via feature-owned foldCounters (§3.4)
}
```

`eval-gate.yaml` at package root:

```yaml
baseline: { ref: main@<sha>, vector: <blob-path> }
tolerance:
  capability: 0                    # any oracle regression fails; no tolerance at v1
require-improvement-on: [tokens.total]   # live tier only — see §3.2 semantics
```

**Freeze discipline, mechanized:** a presubmit check fails when a PR modifies
`eval-gate.yaml` *and* any `packages/**/src/**` in the same change — the frozen-acceptance
rule enforced by the workflow (~20 lines), not by reviewer vigilance. Baseline rules:
refreshes land as their own PR with the new vector attached; **any PR touching
`metrics.ts` must also refresh the baseline** (candidate and baseline must be folded by
the same metric definitions — this is the rot rule).

Comparator: Pareto over token axes — no axis regresses beyond tolerance and a declared
axis improves — evaluated where the semantics allow it (§3.2). `pnpm
check:token-efficiency` runs replay + mock-script tiers and exits non-zero on parse
failures, capability regression, or stale-baseline detection.

### 3.4 Trigger counters — feature-owned folds, never foreign parsing

Each efficiency feature package exports a tiny typed `foldCounters(events):
Record<string, number>` over its own ledger/marker shapes (CCR rows, reducer verify
outcomes, deferral swaps, cost-gate rows, auto-verify attach rows). token-efficiency
**imports** those folds — format drift becomes a compile error instead of a silently
wrong regex in a test-support package. Convention recorded in each feature's README; a
feature PR that changes its ledger shape without updating its fold fails typecheck.

### 3.5 Discipline rules (binding, in package README)

1. `eval-gate.yaml` changes land alone — enforced by the presubmit check in §3.3.
2. Live-tier results never tune the candidate they measure.
3. Baseline refreshes are their own PRs; `metrics.ts` changes force a refresh.
4. Every efficiency-claiming PR runs the tiers and pastes the report head line into the PR
   description (evidence convention, same role as the README trio).

## 4. Phases

- **Phase 0 — replay tier + redactor + presubmit freeze check.** Fixture redactor with
  reviewable sanitized output; `metrics.ts` (incl. the SessionLogEvent→SessionEvent
  adapter test); `gate.ts`; corpus of ≥5 sanitized logs spanning compaction-heavy,
  subagent-heavy, editing-heavy axes; presubmit freeze-rule wiring; CI as an optional
  workflow, promoted to required after two green weeks.
- **Phase 1 — mock-script tier + counter folds.** Two scripts per feature in this batch
  (fires/control); feature packages gain `foldCounters` exports; the tier becomes the
  acceptance evidence for reducer/deferral/cost-gate/auto-verify PRs.
- **Phase 2 — live tier.** Manual runs via the imported cache-trajectory bootstrap;
  corpus-growth conventions; nightly sketch only after ≥3 hand runs.

## 5. Verification

- **Unit:** `metrics.ts` folds synthetic event streams into exact vectors (cache splits,
  foldCost adapter present/absent); `gate.ts` table — regress/improve/no-op per axis,
  freeze-file schema validation, replay vector has no capability field; redactor leaves a
  byte-stable, body-free fixture.
- **Composition:** one mock-script task end-to-end through the real preset with CCR
  enabled; the vector records crusher fires via CCR's own `foldCounters`.
- **Observable claim:** `pnpm check:token-efficiency` prints one line per task with the
  tier-appropriate result vs baseline and exits non-zero on regression; green replay tier
  is documented as metric-definition stability, never savings evidence.
- Static: file-size budget; no new runtime deps; manifest untouched (test-support scope —
  the validator passing unchanged is the proof).

## 6. Risks and explicit non-goals

- **Tier semantics being misread** is the main product risk; §3.2's wording and the report
  footer both carry it.
- **Fixture rot** in mock-scripts: scripts live beside the features they assert and are
  part of that feature's PR contract.
- **Corpus breadth** matters only for mock-scripts (≥2 per feature); replay corpus size is
  coverage of metric definitions, not behavior (a fixed log folds deterministically).
- **Non-goals:** scaling-law claims about corpus size; multi-backend matrices (recorded as
  a corpus tagging convention — tasks record the backend they were captured on, per the
  paper's multi-backend finding); replay blobs of raw sessions (sanitized-only, §3.2).

## 7. Review outcomes and residual risks

Critic cold review (2026-09-20): GO-WITH-AMENDMENTS, 9 findings; all blocking/major baked
in above:

1. [blocking→fixed §3.2] "Fixture reference, not blob" replay tier was unimplementable in
   CI and a secret hazard — now committed sanitized fixture blobs produced by a Phase-0
   redactor.
2. [major→fixed §3.2/§3.3] Headline Pareto gate sat on a tier that cannot move — gate
   semantics restated honestly per tier; improvement claims live only in the live tier.
3. [major→fixed §3.3] Baseline rot ungoverned — `metrics.ts` changes now force a baseline
   refresh in the same PR.
4. [major→fixed §3.3] Freeze discipline was prose — now a presubmit check rejecting
   `eval-gate.yaml` + `packages/**/src/**` co-modification.
5. [major→fixed §3.3] `capability.ok` was undefined for replay — the field is now absent
   on replay; parse failure is the only replay failure mode.
6. [major→fixed §3.4] Cross-package ledger parsing replaced by feature-owned typed
   `foldCounters` exports.
7-9. [minor→fixed §3.1/§3.2/§4] Import-instead-of-rebuild inventory vs cache-trajectory;
   mock-script control cases (2 per feature); ground-fact drift (`foldCost` at
   `cost.ts:151`, composition spec path, full bin flag list) corrected.

Residual risk handed to the Phase-0 author: the `SessionLogEvent`→`SessionEvent` adapter
(§2 wrinkle) must be pinned by a real sanitized log — if any usage-bearing event in real
logs deviates from the typed shape, the adapter must fail loudly (parse error, the one
allowed replay failure mode), not silently fold wrong numbers.
