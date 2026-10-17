# @dsh-cc/vwa-argument

Verifiable Workspace Agent (VWA) lane-2 argumentation (design:
`docs/plans/2026-10-16-vwa-evidence-argument.md`). The package is complete
as of slice P5: contracts, store/graph, review pipeline, tools, the `/vwa`
command, v2 receipts, and the report renderer. Semantic review stays
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
  (background semantic review over a stage)
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
  review budgets follow §13. Same dual-half idiom as vwa-evidence:
  `registerNamespaceSafe` for /config UX plus a fail-soft raw hot-read of
  `<dshHome>/settings.json` (`readUserSettingsSync`)
  〔src:ws:packages/interaction/vwa-argument/src/settings.ts#L1-L50〕.
- **Preset** (`packages/preset/cc/agent.vwa.cordis.yml`): the plugin mounts
  ONLY in the vwa closure — the cc preset deliberately lacks the row.

Not in this package: receipt writing (vwa-evidence is the sole writer) and
the frozen semantic scorer `humanities-scorer@1` with the humanities gold
set (`@dsh-cc/vwa-eval`, §22.2).
