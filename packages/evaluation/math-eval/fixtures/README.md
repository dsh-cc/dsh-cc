# math-eval fixtures

Structure only, at this wave. **No benchmark content is checked in and no
model is ever called from this package's CI path.**

Design contract: `docs/plans/2026-11-21-mathematical-research-harness.md` §8.1
and §8.4.

## What lives here

```
fixtures/
  README.md      # this file: license and provenance policy
  <slice>/       # (later wave) ingestion dir per benchmark slice
  gold-set.json  # pinned problem identities + the train/test split
```

Each ingestion directory must carry a record with exactly the §8.1 shape:

```json
{ "source": "…", "license": "…", "fetchedAt": "…", "sha256": "…", "problemIds": ["…"] }
```

`gold-set.json` pins the problem identities for each slice and the
**designated training split** used to build the experience-store snapshot
(§8.3). Test problems are write-blocked: the snapshot must never be built from
them, otherwise the G vs F contrast is contaminated. An empty snapshot makes
`G ≡ F`, and every report says so explicitly.

## License policy (delivery-blocking, §8.1 / §11 risk 8)

- Every slice must record its license before any problem content lands here.
  Ingesting benchmark text without a license record fails `pnpm --filter
  @dsh-cc/math-eval check`.
- Redistribution-forbidding licenses fail CI. The allow-list in
  `scripts/check-math-eval.mjs` (`ALLOWED_LICENSES`) is the machine-readable
  form of that rule; extend it deliberately when a new slice is admitted.
- An empty license value is accepted **only** together with
  `"licenseStatus": "unverified-pending-ingestion"` so the placeholder state is
  visible rather than silently permitted.

Planned slices (§8.1), all pending ingestion:

| slice | size | source | why |
|---|---|---|---|
| miniF2F valid subset | ~48 | miniF2F | broad coverage of olympiad-style statements |
| ProofNet subset | ~40 | ProofNet | three artifacts + reference formalizations natively present — doubles as the M1 fidelity eval set and the trusted-anchor source |
| PutnamBench sample | ~30 | PutnamBench | harder, research-adjacent statements |

## This wave's state

`gold-set.json` has empty `problemIds` arrays everywhere and placeholder
records with `license: ""` + `licenseStatus: "unverified-pending-ingestion"`.
Fixture ingestion, hashing and the license audit of real content are a later
wave; the `check` script validates the *shape* of what ships now.
