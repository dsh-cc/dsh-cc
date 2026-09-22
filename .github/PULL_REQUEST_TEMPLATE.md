## Summary

<!-- What changed and why (behavior, not only files). -->

## Verification

> Required. Match evidence to the claim. A green build alone does not prove runtime behavior.

- **How driven:** <!-- UI / API / CLI / unit test / docs-only / N/A + reason -->
- **Pass criteria:** <!-- Observable outcome that means this PR is correct -->
- **Command / log excerpt:** <!-- e.g. `pnpm --filter <pkg> test` exit 0, or paste `[auto-verify]` / CI job URL -->

## Checklist

- [ ] I exercised the user-facing path this change affects (or marked N/A above with reason)
- [ ] Nearby conventions inspected; no copy-paste of obsolete workarounds
- [ ] Temporary scaffolding from this work removed
- [ ] Docs / i18n pairs updated together when READMEs changed (`pnpm check:readme --write` if applicable)
- [ ] No silent raise of product defaults (e.g. leaving opt-in flags off unless this PR intentionally changes them)

## Risk / rollback

<!-- Blast radius in one sentence; how to revert. -->

## Out of scope

<!-- Explicit non-goals for this PR. -->
