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
- Delegated work: child-session receipts lift to the top-level session's
  lineage bucket; an unwitnessed delegation window fails open.
- Claims are data (`src/claims.json`), matched per command segment.

Plan: `docs/plans/2026-10-09-runtime-verified-completion.md`
