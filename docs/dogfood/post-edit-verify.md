# Dogfood: post-edit auto-verify (`cc-post-edit-verify`)

Personal productivity for **dsh-cc** contributors. After an accepted `edit` /
`write`, the `@dsh-cc/post-edit-verify` plugin can run a fast check and append
an `[auto-verify]` block onto **the same** tool result.

**Product default is ON since 2026-11-11**, but the listener is inert until at
least one rule is declared — an empty `rules` array runs nothing. Anything below
is **user-layer only**; opt out with `"cc-post-edit-verify": { "enabled": false }`.

Design: [`docs/plans/2026-09-20-post-edit-auto-verify.md`](../plans/2026-09-20-post-edit-auto-verify.md)  
Package README: [`packages/interaction/post-edit-verify/README.md`](../../packages/interaction/post-edit-verify/README.md)

## Enable (user-layer settings)

Edit **harness-home** `settings.json` (not the repo’s project settings — project
rules are structurally invisible to this feature):

```json
{
  "cc-post-edit-verify": {
    "enabled": true,
    "rules": [
      {
        "glob": "packages/**/*.{ts,tsx}",
        "command": "node -e \"console.error('dogfood intentional fail'); process.exit(1)\"",
        "timeout-ms": 15000
      }
    ],
    "debounce-ms": 5000,
    "max-output-bytes": 4096,
    "verbose-on-success": false
  }
}
```

Restart or start a new dsh-cc session so the plugin re-reads the user file
(it also re-reads per use; a restart is the clearest dogfood step).

### Example rules for this monorepo (after the intentional-fail smoke)

Replace the intentional-fail rule with something useful, first match wins:

```json
{
  "cc-post-edit-verify": {
    "enabled": true,
    "rules": [
      {
        "glob": "packages/interaction/post-edit-verify/**/*.{ts,tsx}",
        "command": "pnpm --filter @dsh-cc/post-edit-verify test",
        "timeout-ms": 120000
      },
      {
        "glob": "packages/**/*.{ts,tsx}",
        "command": "node -e \"process.exit(0)\"",
        "timeout-ms": 15000
      }
    ]
  }
}
```

Keep commands **POSIX `sh`-friendly**. Prefer node one-liners or repo scripts
you already trust; avoid Windows-native shells.

## Observability checklist

### Failure path (must see a failure tail)

1. Enable with the intentional-fail rule above.
2. In a dsh-cc session, `edit` or `write` any file under `packages/` matching the glob.
3. On the **same** tool result, expect a text block containing:
   - `[auto-verify] … — exit 1 …`
   - and the command’s stderr/stdout tail (`dogfood intentional fail`).

Automated coverage (no session required):

```bash
pnpm --filter @dsh-cc/post-edit-verify test
```

See `packages/interaction/post-edit-verify/tests/wiring.spec.ts` (enabled +
non-zero exit appends `[auto-verify] … — exit 1`) and
`tests/compose.spec.ts` (`buildVerifyBlock` failure shape).

### Success path (near-silent ok)

With a rule whose command exits 0 and `verbose-on-success: false`, expect a
single line like:

`[auto-verify] <command> — ok (<n>ms)`

Covered by the same package tests (`wiring.spec.ts` success case;
`compose.spec.ts` one-liner success).

### Default is ON, rules are not

`enabled` defaults to `true` (`DEFAULT_RULES_SETTINGS` / `SettingsSchema`), while
`rules` defaults to `[]` — so a fresh profile verifies nothing until you declare
a rule. Absent or malformed user sections fail soft to those defaults; the
explicit opt-out (`enabled: false`) is honoured.

## Out of scope

- Do not commit rules (or `enabled`) into project settings expecting them to
  apply — project scope is structurally never read.
