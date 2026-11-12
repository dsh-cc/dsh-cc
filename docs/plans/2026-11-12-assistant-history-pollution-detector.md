# Assistant-History Pollution Detector (offline v1)

- Date: 2026-11-12
- Status: Design — r2 (critic GO-with-minors + grok NO-GO + codex GWC folded; the two hard corrections were surface-reconstruction semantics and the failure-outcome vocabulary)
- Program: context-engineering input governance (doc 8 of 8)
- Depends on: doc 3 (ledger — optional input; the detector's primary source is raw session logs).
- Literature basis: AC3 (2611.00518); Speech-LLM History Interference (2611.05124); Silent Failures (2606.14589).

## Problem

Assistant messages asserting false or went-stale state persist in history and keep influencing later steps. The cited remediation (runtime curation with reset) is rejected upfront for this workload (reset discards tool observations; AC3's own stateful tool-use arm collapses to 0% reward). Version 1 is **detection only**: a deterministic offline detector over session logs, measuring whether the phenomenon exists at meaningful rates in this product, with audit-grade precision — the evidence base for any later runtime design.

## Goals / Non-goals

Goals:

1. A deterministic offline incident detector over real session v4/v3 logs.
2. Pre-registered archive criteria with confidence semantics, executed as a dogfood protocol.
3. An outcome (A: evidence exists → later runtime design; B: closed) that is mutually exclusive and statistically honest.

Non-goals:

- No runtime behavior change, message editing, or model-facing flags (all of that belongs, if ever, to a later design that must cite this detector's evidence).
- No LLM judges inside the detector. (LLM-assisted labeling is allowed in the manual audit only.)
- No reuse of `buildExtractionWindow` from memory-consolidation: it treats any surface-replace-intersecting window as **unreconstructable and never uses the replacement as evidence** (`memory/memory-consolidation/src/extraction-window.ts:352-359`), which would skip exactly the crushed/compacted history the model actually saw (grok's BLOCKER).

## Current behavior (anchors, verified by review)

- Session logs: `<DSH_HOME>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd` (v4-first, v3/legacy behind it) — enumerate via the repo's session-forensics scanner (`session-forensics/src/scan.ts`), not hand-rolled globs of `~/.dsh/sessions/<slug>` (r1 path correction).
- **There is no structured `exitCode` on bash tool results.** The failure vocabulary is the tail-marker family already centralized in `progress-rebuild/src/state.ts:76-84` (`[exit code: `, `[killed by signal: `, `[timed out after `, `[stopped: `, `[still running after `, sandbox denial lines); exit-0 renders **no** marker. Outcome detection parses those markers in the last ~10 lines of the result text.
- Surface rewrites: CCR defer-swap and compaction write `surfaceOp: { op: 'replace', ... }`; the model sees **replacements**, not the shadowed originals. The detector must reconstruct the effective view (below).
- Input-ledger (doc 3) rows can accelerate session discovery but are not required.

## Design

### Home & CLI

Second CLI inside `@dsh-cc/context-eval` (doc 5's package): `pnpm eval:history-pollution -- <sessionDir | glob>`. Reads via the forensics scanner; the analysis core is pure and unit-testable.

### Effective-view reconstruction (per session, sequential replay)

Linear scan over events, applying `surfaceOp` rules: on `{ op:'replace', startSeq, endSeq }` — the replacement event enters the view; all seqs in `[startSeq, endSeq]` are marked shadowed and excluded from evidence and claims produced *after* the replace (claims produced *before* the replace are still analyzed against the pre-replace view, keyed by seq). Abstain (record `inconsistent`, skip) when a replace's range references unseen seqs (truncated logs). This is deliberately not `buildExtractionWindow` — it keeps the replacement, which is what the model actually saw, and drops the shadow.

### Normalized event schema (parsing contract; codex MAJOR fold)

```
NormalizedEvent = {
  seq, ts, turn?, kind:
    | { type:'assistant-text', text, model? }
    | { type:'tool-call', callId, toolName, args }       // bash args.command, read/grep args.path/pattern
    | { type:'tool-result', callId, toolName, text, outcome }
}
outcome = { status:'success'|'failure'|'cancelled'|'unknown',
            markers: string[] }        // parsed from the tail-marker family
```

Linkages: tool-call ↔ result by `callId` (missing pairs ⇒ `unknown`); `turn` from event data where present; duplicate incidents suppressed on (rule, assertSeq, evidenceSeq) equality — overlapping rules fire separately and are counted with an overlap total in the report. Companion fixtures cover rendered failures, cancellations, rewritten (shadowed) evidence, and overlapped claims.

### Detector rules (v1, precision-first; all clocks in **turns** — r1 mixed turns/steps, folded)

Claim-pattern table (EN past/perfective only: "tests (all )?pass", "all green", "fixed", "verified", "confirmed"; ZH: 全部通过 / 已修复 / 已验证 / 已确认) with a speaker-attribution prefix filter (reject matches on "you said…" lines) — lives as data in `rules/pollution-rules.yaml` (`rulesetVersion` pinned in reports), with worked examples in the golden set.

Subject extraction (data-driven, same yaml): path tokens (`/[\w\-./]+\.[a-z0-9]{1,6}/i`, length ≥ 4), or command-head tokens (first non-env-assignment token, length ≥ 3, after canonicalization: strip env assignments and collapse flag blocks). Authoritative command canonicalization strips `FOO=bar` prefixes and folds common flag synonyms. (r1's "token overlap ≥ 1" was too loose; grok + codex fold.)

- **R1 assert-then-fail** — claim at turn T matches the table; a bash result with `outcome.status === 'failure'` arrives at turn ≤ T+3 with subject overlap (path token or canonical command-head). **Linkage is by command target/execution context, not just command head** (codex fold).
- **R1 splits by staleness** (codex fold): if the subject's path(s) had an intervening mutation (edit/write/str-replace tool-call, or a bash redirect touching them) between the claim and the failure, the incident is classified `staled` (checked-in regression — reported separately, informational) rather than `contradicted` (a false-at-assert-time claim — the pollution signal).
- **R2 claim-then-contradicted-observation** — claim asserts content Y in path X ("contains / does not contain"). Evidence qualifies as **authoritative** only when: (a) a successful `read` of X covering the whole file (or a range that includes the claimed location when the claim is localized), or a successful `grep` whose rendered result text is evaluated — a grep listing Y elsewhere in X satisfies "contains Y in X"; (b) within ≤ 2 turns; (c) **no intervening mutation** of X between claim and evidence (else classify `inconclusive`, not an incident). A grep tool result with a no-match outcome counts as evidence against "contains" claims (the sentinel care mirrors R1; grep is excluded from R1 failure evidence).
- **R3 repeated failing command reported green** — canonical command C fails at turns T1 and T3 (T3 > T1 + 1) with an assistant success claim for C's subject between them.

### Output

Per session `{sessionId, turns, incidents[], rate}`; incidents carry `rule`, `kind: 'contradicted'|'staled'`, `assertSeq`, `evidenceSeq`, `subject`, and content snippets (first 120 chars) for the local audit — report files stay local; the committed aggregate carries hashes + counts only. Aggregate: per-rule totals, per-kind totals, rates distribution, `rulesetVersion`.

### Dogfood protocol (pre-registered, mutually exclusive outcomes)

1. Run over the maintainer's **30 most recent sessions** (local paths, nothing raw committed).
2. Audit: label TP/FP on **all** incidents if ≤ 100, else a seeded (commit-hash-seeded) stratified sample of 100 by rule.
3. **Archive criterion (Outcome A)**: overall precision with one-sided 95% **Wilson lower bound ≥ 0.70** AND ≥ 10 TP incidents AND ≥ 0.05 incidents/turn on > 10% of sessions. (r1's bare 0.80 point estimate on 40 items spans ~0.64-0.91 — both seats' statistics fold; also the "or fix FP-dominant rules and archive" escape hatch is deleted: noisy rules are data-changed and re-run, which is Outcome B's path, not archiving.)
4. Held-out rerun: after any ruleset iteration, the final ruleset runs once against the held-out 10 sessions (split 20/10 up front) — the archived numbers come from the held-out set.
5. **Outcome B** (failure of any archive leg): the line closes; the committed aggregate reports the negative result; no runtime design may cite Outcome B data. The committed aggregate always reports Wilson CIs, never bare point estimates.

## Verification

- Unit: each rule over synthetic mini-sessions (TP family + each planned FP family: future-tense false match, quoted-user claims, unrelated-command failure, grep-no-match semantics, intervening-mutation staleness); subject extractor table w/ golden examples; effective-view replay (replace keeps shadowing out on both sides of the replay point); outcome parser over the marker family incl. exit-0-no-marker; `inconclusive` paths.
- Integration: end-to-end over 3 committed synthetic fixtures — per-rule counts, dedupe/overlap accounting, abstain-on-inconsistent-replay.
- Manual: dogfood protocol executed; committed aggregate is the deliverable.
- Repo gates: none (offline tool); no default changes.

## Risks

- Zero-signal outcome is real information — Outcome B closes the line explicitly; the ledger instrumentation remains.
- Pattern-table cultural drift (maintainer's ZH+EN style): the held-out split and the audit's rule-level FPs bound it.
- Multi-model sessions: model stamps are kept for stratification; the detector is model-agnostic.

## Fold ledger

r1 → r2 (critic GO(minors) + grok NO-GO + codex GWC → folded): effective-view apply-replace reconstruction replaces the cited extraction window (grok BLOCKER — the window deliberately never uses replacements as evidence); session path/scanner corrected to `<DSH_HOME>/sessions/<projectKey>/<sessionId>` + forensics scanner; exit-structured `exitCode` deleted — outcome parser over `progress-rebuild/src/state.ts:76-84` tail markers with exit-0-no-marker semantics; one clock (turns); subject/linkage upgraded to path tokens + canonical command-heads with mutation-aware staleness split (`contradicted` vs `staled`) and `inconclusive` class; R2 restricted to authoritative observations with grep-rendered-text semantics; normalized event schema + parsing contract + duplicate/overlap handling; subject extractor and claim patterns moved to data (`rules/pollution-rules.yaml`, `rulesetVersion`); archive criterion rebuilt on one-sided Wilson lower bounds, minimum TP count, seeded sampling, held-out rerun, mutually exclusive outcomes.
