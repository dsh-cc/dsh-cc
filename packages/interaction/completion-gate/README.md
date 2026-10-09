# @dsh-cc/completion-gate

Completion gate: records a hashed receipt for every settled tool execution —
both a session event (`completion-gate/receipt`) and a hash-only JSONL ledger
under `<dshHome>/completion-gate/receipts/` — and nudges once per
session at `agent/turn-stopping` when the final assistant message claims
done-ness ("tests pass", "committed", "pushed", "build succeeded") with no
matching executed evidence since the last genuine user message.

- Default OFF (`cc-completion-gate.enabled`): receipts (hashed fields) are
  always recorded; privacy-scrubbed bash command heads (≤200 bytes, six-step
  scrubber) are captured only while enabled, and never reach the ledger file.
- The nudge budget is `nudges-per-session` (default 1). Both keys are
  user-layer only (harness-home `settings.json`), re-read per event.
- Delegated work: child-session receipts lift to the top-level session's
  lineage bucket; a window holding delegation receipts with no child session
  witnessed in-process fails open.
- Claims are data (`src/claims.json`), matched per command segment.
- Cross-package obligation: the `completion-gate` injected kind is added to
  the injected-source denylists in `@dsh-cc/memory` (recall),
  `@dsh-cc/turn-rules` (matcher), and `@dsh-cc/advisor-watchdog` (delta) —
  nudge text never feeds recall queries, rule matching, or advisor review
  windows.

Plan: `docs/plans/2026-10-09-runtime-verified-completion.md`
