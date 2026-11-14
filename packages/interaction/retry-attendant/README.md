# @dsh-cc/retry-attendant

English | [中文](README.zh.md)

Verify-before-retry attendant: a post-execute listener for **mutating tool calls** whose outcome is ambiguous (timeout, sandbox denial, partial write, git/package/MCP mutation failures). It does two things (design doc [docs/plans/2026-10-09-verify-before-retry.md](../../../docs/plans/2026-10-09-verify-before-retry.md)):

- **M1 — ambiguous-outcome guidance**: on a classified ambiguous outcome, appends a one-line class-specific advice as an `additionalContexts` entry (source kind `retry-attendant`) — "verify the intended postcondition before re-running". The advice is appended only for a fresh digest: while a live entry for the same digest exists in the session, the guidance is deduped and not appended again.
- **M2 — identical-retry escalation**: records the call's effect digest per session for every classified class except `mcp-mutation`, which stays M1-only and never escalates; an identical retry (same effect fields, ignoring reworded `description`/`timeoutMs`) within `expire-minutes` is escalated to a permission **ask** instead of passing through. A designated read-only check marks the matching entry resolved and rewrites the ask reason to name that check: `git status`/`log`/`diff`/`show` resolves a pending `git-mutation` entry, and a `read` of the recorded path resolves a pending `write-partial` entry. When no approval seam is mounted, the escalation bit is released and the downstream decision is kept: a downstream ask stands unchanged, and an allow or passthrough becomes an allow with the class guidance injected directly.

**Default ON** since 2026-10-16 (`retry-attendant.enabled: true`; promoted from ship-dark after the production dogfood).

## Settings (user layer only)

Key `retry-attendant` in the user-layer `settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master flag (default ON since 2026-10-16). |
| `guidance` | `true` | M1 advice lines. |
| `escalate` | `true` | M2 identical-retry asks. |
| `expire-minutes` | `10` | Digest-map expiry. |

## Status

Implemented. Failure-class table (`src/classes.json` + `classify`), effect-fields digest projection, pre-execute identical-retry escalation, and M1/M2 wiring are all in place, with composition pins in `packages/preset/cc`. Promoted to default ON on 2026-10-16 after the production dogfood cleared the design doc §5 gate; the escalation/observe split can be tuned via the `escalate` key.
