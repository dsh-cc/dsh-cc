# @dsh-cc/vwa-argument

Verifiable Workspace Agent (VWA) lane-2 argumentation contracts (design:
`docs/plans/2026-10-16-vwa-evidence-argument.md`). Slice 1 (P0) ships the
package face, the JSON Schema contracts, the Ajv validation entry, and the
settings namespace. The feature is **inert and default-off**.

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
- **Plugin face** (`src/index.ts`): plain cordis plugin, `apply(ctx)` only
  registers the settings namespace. No listeners, no tools, no review runs —
  mounting it changes nothing until a later slice (§23)
  〔src:ws:packages/interaction/vwa-argument/src/index.ts#L1-L30〕.

Not in this package: receipt writing (vwa-evidence is the sole writer), the
review runner, tools/commands, the report renderer, and the preset row — all
later slices (§23 P1–P5).
