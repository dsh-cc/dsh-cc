# @dsh-cc/vwa-argument

Verifiable Workspace Agent (VWA) lane-2 argumentation (design:
`docs/plans/2026-10-16-vwa-evidence-argument.md`). The package provides contracts, store/graph, review pipeline, author and report tools, the `/vwa` command, v2 receipts, and the report renderer. Semantic quality remains experimental until the human gold set and live-model acceptance are completed; deterministic integration tests do not establish semantic accuracy. Semantic review stays
**default-off** (`vwa-argument.semantic-enabled: false`, §13); when it is
disabled the tools are not registered and the feature is inert.

- **Contracts** (`src/contracts/`, JSON Schema Draft 2020-12):
  - `author.schema.json` — the author-side argument graph (`ProjectSnapshot`:
    sources, evidence, claims, evidence groups, arguments, issues, search
    logs, artifacts; §5) 〔src:ws:packages/interaction/vwa-argument/src/contracts/author.schema.json#L1-L40〕.
  - `review.schema.json` — review records: the per-stage `ReviewResponse`
    discriminated union, `Finding`, `Assessment`, `AdjudicationRecord`,
    `ExtractedAtomicClaim`, `ExtractionRecord`, `MechanicalStatus` (§6, §11.4)
    〔src:ws:packages/interaction/vwa-argument/src/contracts/review.schema.json#L1-L40〕.
  - `receipt-v2.schema.json` — the v2 receipt row (§16.1). The `ReceiptV2` TS
    type is owned by the sole receipt writer `@dsh-cc/vwa-evidence`; this
    package only ships the validating schema
    〔src:ws:packages/interaction/vwa-argument/src/contracts/receipt-v2.schema.json#L1-L20〕.
- **Store and graph** (`src/store.ts`, `src/graph.ts`, `src/sources.ts`,
  `src/dependencies.ts`, `src/policy.ts`): an immutable, chain-hashed
  project graph with atomic recoverable writes (temp + fsync + rename,
  §14); source snapshots are exact byte copies verified against real file
  bytes (D02/D06/D10); dependency digests stale reviews naturally; the
  policy computes artifact grades from the active finding set
  〔src:ws:packages/interaction/vwa-argument/src/store.ts#L1-L40〕.
- **Review pipeline** (`src/review-adapter.ts`, `src/review-runner.ts`,
  `src/review-tasks.ts`, `src/audit.ts`): stage prompts
  (`prompts/sources|support|arguments|extract|align.md`), a budgeted
  background run registered by `argument.review` and returned immediately
  (§14, D14); reviews never modify the body or the author graph; the same
  `requestId` returns the cached run state (D07).
- **Tools** (`src/tools.ts`, mounted only when `semantic-enabled`, §13):
  `evidence.register` (source snapshot + excerpts, runtime-read quotes),
  `evidence.search_log` (1–50 search-log entries, no searching performed),
  `argument.update` (atomic full-graph mutation union), `argument.review`
  (background semantic review over a stage), and `argument.report` (deterministic Markdown/JSON, optional write under `docs/vwa-reports/<projectId>/`; no model calls)
  〔src:ws:packages/interaction/vwa-argument/src/tools.ts#L1-L40〕.
- **Command** (`src/commands.ts`): the closed-grammar `/vwa
  <init|status|import|sign|adjudicate|repair>` command — human-only source
  (D21), non-empty-reason adjudication that never rewrites the model's
  original record, and newest-candidate store repair (§14.2)
  〔src:ws:packages/interaction/vwa-argument/src/commands.ts#L1-L40〕.
- **Report** (`src/report.ts`, `src/report-render.ts`): the four goal
  questions answerable from the report alone (§22.3), with reviewer
  disagreement preserved (D19) and per-finding provenance.
- **Validation** (`src/schema.ts`): Ajv 8 strict on the Draft 2020-12 entry
  point with `coerceTypes:false`, `useDefaults:false`,
  `removeAdditional:false` (§25). UUID/Hash/Span rules are explicit schema
  patterns plus runtime helpers (`isPrefixedId`, `isHash`, `spanError`);
  string limits are UTF-16 code units. `stableJson`/`sha256Hex` are
  re-exported one-way from `@dsh-cc/vwa-evidence` (§3 — the reverse import
  is forbidden and does not exist)
  〔src:ws:packages/interaction/vwa-argument/src/schema.ts#L1-L40〕.
- **Settings** (`src/settings.ts`): namespace `vwa-argument`, flat kebab
  keys per the §13 table. `semantic-enabled` defaults to **false**; all
  review budgets follow §13 and are frozen into `contract.reviewSettings` at project initialization; contract edits preserve these runtime-owned limits. `review-alias` (default `sonnet`) names the
  model ALIAS the reviewer routes through — never a concrete model id. Same dual-half idiom as vwa-evidence:
  `registerNamespaceSafe` for /config UX plus a fail-soft raw hot-read of
  `<dshHome>/settings.json` (`readUserSettingsSync`)
  〔src:ws:packages/interaction/vwa-argument/src/settings.ts#L1-L50〕.
- **Host wiring** (`src/review-host.ts`, `src/capture-wiring.ts`; only when
  `semantic-enabled`): `argument.review` resolves `llm`, `jobs` and the
  `review-alias` route PER CALL (a missing host service answers
  `REVIEW_UNAVAILABLE` with the reason); a `tools/post-execute` listener
  feeds a per-session capture registry from `read`/`write`/`edit`/`web_fetch`;
  bound artifacts are read from the caller's workspace; the `vwa-argument`
  delivery service binds to the caller's workspace via `forWorkspace(root)`
  〔src:ws:packages/interaction/vwa-argument/src/review-host.ts#L1-L20〕.
- **Preset** (`packages/preset/cc/agent.vwa.cordis.yml`): the plugin mounts
  ONLY in the vwa closure — the cc preset deliberately lacks the row — in
  the `vwa-lanes` group together with vwa-evidence, under an `isolate`
  realm covering the `vwa-argument` service.

Not in this package: receipt writing (vwa-evidence is the sole writer) and
the frozen semantic scorer `humanities-scorer@1` with the humanities gold
set (`@dsh-cc/vwa-eval`, §22.2).

## Delivery and validation

A completed call is not a passed review. Delivery selects records matching the current task dependencies, contract, policy, prompt, and effective prepared model configuration. Relevant changes expire old judgments; unrelated author changes do not invalidate independent support tasks. Conflicting same-input judgments remain visible and cannot be erased by a newer pass. Negative support propagates through the weakest required premise; alternative support paths are evaluated independently.

`all` runs sources, support, claims, arguments and full-text extract/align. Every provider schema is self-contained, extraction responses are strictly validated, and alignment requires AUDIT-01 through AUDIT-05. Attempts, including audit calls and repairs, reserve and persist budget before dispatch; interrupted reservations remain charged after restart. Project limits are frozen at init; model routes are resolved per call and their effective prepared options enter review identity.

Mechanical gates inspect the caller's actual workspace files. Optional unavailable style checks are disclosed separately; link checks and used executable-code checks remain required. Snapshot/hash/quote failures block semantic delivery. Reports retain current assessments, explicit warrants and premises, limitations, unresolved issues, and the experimental calibration status. Only presentation of both exact body/report paths with current hashes advances delivery; a report failure cannot produce a success receipt. Signatures require a matching existing receipt from the user's session, and human adjudication expires when its bound inputs change.

See `docs/vwa/lane2-validation.md` for acceptance coverage and the remaining human calibration requirements. The package test suite includes a real Cordis mount through `all`, report/receipt checks, and unpacked npm-package asset loading. The semantic feature remains default-off.
