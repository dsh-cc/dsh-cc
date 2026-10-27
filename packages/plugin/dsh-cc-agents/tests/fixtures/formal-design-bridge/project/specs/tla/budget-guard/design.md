# Test fixture: budget-guard

Bounded TLC model of atomic budget reservation, used only to exercise the
combined TLA+/Lean bridge contract. Not a production verification claim. The
`Bridge_*` invariants are the derived bridge assertions required by design
section 10; each is checked by one declared case with verified verdict.
