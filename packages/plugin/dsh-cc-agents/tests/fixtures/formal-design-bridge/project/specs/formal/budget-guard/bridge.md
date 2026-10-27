# Bridge: budget-guard

Shared operation contract between the TLA+ `budget-guard` model and the Lean
`budget-reservation` model. This file is hashed, never parsed for authorization.

## JSON-to-TLA+ encoding

Canonical decimal strings are encoded as `Nat` constants `Budget`, `Reserved`,
and `Amount`. A successful reservation encodes `{ "ok": "<n>" }` as
`Reserved + Amount = n`; a rejected request encodes
`{ "error": { "code": "insufficient-budget" } }` as `~AdmitReservation`.
The derived invariant `Bridge_<id>` (hyphens to underscores) asserts the
corresponding expression for the case's declared constants.
