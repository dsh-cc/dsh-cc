# Assistant-History Pollution Detector (offline v1)

- Date: 2026-11-12
- Status: Design — r3 (r1 full review + r2 delta review folded by three seats; pending r3 micro-confirmation)
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

Second CLI inside `@dsh-cc/context-eval` (doc 5's package): `pnpm eval:history-pollution -- <sessionDir | glob>`.

**Ingestion (delta-round correction, all three seats).** The session-forensics package is reused **only for file discovery and decompression** (v4-first location of `<DSH_HOME>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`, v3/legacy fallback — `session-forensics/src/scan.ts:278-295`). Its `parseStream`/`scanSessions` output is **unsuitable** as the event source: they emit ToolRecords only, with no assistant text, no `seq`/`surfaceOp`, and result text head-truncated at 4096 chars (`scan.ts:38,70-81,207-220`). The detector therefore ships its own **raw v3/v4 event iterator** over the decompressed JSONL, preserving every event with seq, full text, assistant messages, and surface operations. The analysis core stays pure and unit-testable.

### Effective-view reconstruction (per session, canonical fold)

Linear replay over raw events, applying `surfaceOp` semantics **positionally, via the actual shadowed set** — not arithmetic seq intervals (codex delta MAJOR: an append's `sourceEventSeqs` is the real shadow set — `core/session/src/surface.ts:419-433,570` in the pinned harness copy — and chained replaces nest fine under this rule):

- On a surface event with `{ op:'replace', ... }`: the replacement enters the effective view; every seq in its `sourceEventSeqs` (falling back to the `[startSeq, endSeq]` interval when the list is absent) is marked shadowed.
- Claims and evidence produced *after* the replace are analyzed against the post-replace view; those produced *before* keep the pre-replace view (keyed by seq).
- Abstain (`inconsistent`) when a replace's range/lists reference unseen seqs (truncated logs).

This deliberately differs from `buildExtractionWindow`: it keeps replacements — the content the model actually saw — and drops the shadow (grok's r1 BLOCKER resolution, retained).

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

Marker → status mapping (explicit, from `progress-rebuild/src/state.ts:76-84`; delta-round fold — it was unspecified): `[exit code: N≠0]` → `failure`; `[killed by signal: …]` → `failure`; `[timed out after …]` → `failure`; `[stopped: …]` → `cancelled`; `[still running after …]` → `unknown`; sandbox denial lines → `failure`; exit-0 renders no marker → `success`.

Linkages: tool-call ↔ result by `callId` (missing pairs ⇒ `unknown`); `turn` from event data where present — **events without a usable `turn` are excluded from turn-clocked rules** (grok delta fold: it was unspecified); duplicate incidents suppressed on (rule, assertSeq, evidenceSeq) equality — overlapping rules fire separately and are counted with an overlap total in the report. Companion fixtures cover rendered failures, cancellations, rewritten (shadowed) evidence, and overlapped claims.

### Detector rules (v1, precision-first; all clocks in **turns** — r1 mixed turns/steps, folded)

Claim-pattern table (EN past/perfective only: "tests (all )?pass", "all green", "fixed", "verified", "confirmed"; ZH: 全部通过 / 已修复 / 已验证 / 已确认) with a speaker-attribution prefix filter (reject matches on "you said…" lines) — lives as data in `rules/pollution-rules.yaml` (`rulesetVersion` pinned in reports), with worked examples in the golden set.

Subject extraction (data-driven, same yaml): path tokens (`/[\w\-./]+\.[a-z0-9]{1,6}/i`, length ≥ 4), or command-head tokens (first non-env-assignment token, length ≥ 3, after canonicalization: strip env assignments and collapse flag blocks). Authoritative command canonicalization strips `FOO=bar` prefixes and folds common flag synonyms. (r1's "token overlap ≥ 1" was too loose; grok + codex fold.)

- **R1 assert-then-fail** — claim at turn T matches the table; a bash result with `outcome.status === 'failure'` arrives at turn ≤ T+3 with subject overlap. **Linkage requires a shared subject path or file-operand token** (a path token or a file operand of the canonical command in both the claim and the failure); **bare command-head equality alone is insufficient** (delta-round fold from both external seats: `pnpm test` vs `vitest` false-linkages, and "I fixed the import" vs an unrelated later failure). When only heads match, the pair is `inconclusive`, not an incident. (The r2 phrase "by command target/execution context" is hereby made concrete.)
- **R1 splits by staleness** (codex fold): if the subject's path(s) had an intervening mutation (edit/write/str-replace tool-call, or a bash redirect touching them) between the claim and the failure, the incident is classified `staled` (checked-in regression — reported separately, informational) rather than `contradicted` (a false-at-assert-time claim — the pollution signal).
- **R2 claim-then-contradicted-observation** — claim asserts content Y in path X ("contains / does not contain"). Evidence qualifies as **authoritative** only when: (a) for a `read`: successful, full-file coverage (or a range including the claimed location when the claim is localized); (b) for a `grep`: successful return with **complete results** for the claimed literal/predicate scoped to X with compatible flags — a no-match result is evidence only if the search provably covered X exhaustively (all lines of X within the grep docs of this repo: no `head`-truncated output, exit semantics compatible; otherwise `inconclusive`); (c) within ≤ 2 turns; (d) **no intervening mutation** of X between claim and evidence (else `inconclusive`, not an incident). A grep tool result with a no-match outcome counts as evidence against "contains" claims (grep is excluded from R1 failure evidence).
- **R3 repeated failing command reported green** — canonical command C fails at turns T1 and T3 (T3 > T1 + 1) with an assistant success claim for C's subject between them.

### Output

Per session `{sessionId, turns, incidents[], rate}`; incidents carry `rule`, `kind: 'contradicted'|'staled'`, `assertSeq`, `evidenceSeq`, `subject`, and content snippets (first 120 chars) for the local audit — report files stay local; the committed aggregate carries hashes + counts only. Aggregate: per-rule totals, per-kind totals, rates distribution, `rulesetVersion`.

### Dogfood protocol (pre-registered, mutually exclusive outcomes)

1. Run over the maintainer's **30 most recent sessions** (local paths, nothing raw committed).
2. Audit: label TP/FP on **all** incidents if ≤ 100, else a seeded **uniform random sample** of 100 incidents (uniform so the pooled Wilson bound in step 3 is valid — codex delta fold: the r2 "stratified sample" broke the confidence calculation unless probabilities were specified).
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

r2 → r3 delta (three seats): effective-view replay switched from arithmetic seq intervals to the **canonical shadowed set** (`surfaceOp.sourceEventSeqs`, `surface.ts:419-433,570`; interval only as fallback) — chained replaces now nest correctly; ingestion narrowed to forensics discovery/decompression + a raw v3/v4 event iterator (the scanner's ToolRecords drop assistant text, seqs, surface metadata and truncate bodies — all three seats); explicit marker→status mapping table; turn-less events excluded from turn-clocked rules; R1 linkage hardened (path/file-operand overlap required; bare head equality → `inconclusive`); R2 grep evidence gated on exhaustive-scope complete results; audit sampling made uniform for a valid pooled Wilson bound.
