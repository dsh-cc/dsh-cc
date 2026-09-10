# Bilingual README convention

## The trio

Every workspace package (`packages/<group>/<pkg>/`) carries three files:

- `README.md` — English documentation
- `README.zh.md` — Chinese documentation
- `README.i18n.yaml` — pairing record pinning the git blob hash of each README
  as of the last confirmed-consistent state

Both languages carry equal authority. After editing either side, bring the
other along, then re-record the pair hashes and commit the record together
with the README edits:

```
pnpm check:readme --write
```

## Gate wiring

`check:readme` runs in three places:

- `.husky/pre-commit` — local, before every commit
- `.github/workflows/presubmit.yml` — every PR
- `.github/workflows/publish.yml` — before any release

## Record semantics

`README.i18n.yaml` contains one 40-hex sha1 git blob hash per side:

```
README.md: <40-hex>
README.zh.md: <40-hex>
```

The pin proves both sides were re-confirmed together at that exact state.
It does **not** prove the translation is semantically in sync — that remains
a human responsibility. The gate only catches "one side changed since the
last confirmation".

`--write` is atomic: it validates every package has both README sides before
writing anything, so a partial re-record (some packages updated, others not)
can never happen.

## Exemptions

Exemptions are a hard-coded pin map in `scripts/check-readme.mjs`. Currently
only `packages/ui/pi-tui` is exempt — a vendored upstream copy that is never
modified locally; its `README.md` hash is pinned so accidental local edits
fail the gate.

To add an exemption, extend the `EXEMPTIONS` map with a reason and the
pinned hash, in a PR.

## Format constraints

The 40-hex format assumes a sha1 git repository. `git hash-object` hashes the
raw working-tree bytes — with CRLF checkouts the hash would differ from CI.
This repo has no `.gitattributes`, so contributors are expected to work on
LF platforms and keep LF endings.

## Gotcha: working tree, not the index

The gate hashes the working tree, not the git index. A re-recorded
`README.i18n.yaml` that is never staged passes locally (the working tree
matches) but fails on the PR head in CI (the committed tree doesn't).
Run `git status` before pushing and make sure the record is committed
together with the README edits.
