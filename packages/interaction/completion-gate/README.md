# @dsh-cc/completion-gate

Completion gate: records a hashed receipt for every settled tool execution —
both a session event (`completion-gate/receipt`) and a hash-only JSONL ledger
under `<dshHome>/completion-gate/receipts/` — and nudges once per
session at `agent/turn-stopping` when the final assistant message claims
done-ness ("tests pass", "committed", "pushed", "build succeeded") with no
matching executed evidence since the last genuine user message.

- Default ON since 2026-11-11 (`cc-completion-gate.enabled`: `true`, promoted
  from ship-dark after the production dogfood; opt out with `false`): receipts
  (hashed fields) are always recorded; privacy-scrubbed bash command heads
  (≤200 bytes, six-step scrubber) are captured only while enabled, and never
  reach the ledger file.
- The nudge budget is `nudges-per-session` (default 1). Both keys are
  user-layer only (harness-home `settings.json`), re-read per event.
- **Enforce mode** (opt-in, plan
  `docs/plans/2026-11-17-completion-gate-enforce-mode.md`):
  `cc-completion-gate.mode: 'enforce'` upgrades the one-shot nudge into a
  bounded enforcement loop — a turn whose final assistant message still
  carries unmatched claims is re-opened (same-turn inject) until the claims
  are satisfied by a successful (`outcome: 'ok'`) receipt, the model
  retracts the phrase from its final message, or the window-scoped budget
  (`enforce-max-cycles`, default 3, clamp 1-10) is exhausted. On exhaustion
  the gate records `completion-gate/enforce-exhausted`; at actual
  `turn/end` a reconciliation appends the terminal
  `completion-gate/unverified` marker when the final message still carries
  unmatched claims (deferred microtask append; markers are session-stream
  only — no TUI rendering yet). Retraction is lexical: an apology that
  still contains the claim phrase is not a retraction. The advisory
  `nudges-per-session` budget is independent (enforce nudges carry a
  `cycle` field and never consume it). Enforce-mode satisfaction requires
  successful executions, including lineage-lifted child receipts (the lift
  carries `outcome`). Evaluation fail-opens (compaction in window,
  composite, horizon) skip enforcement AND the terminal marker. Default
  stays `mode: 'nudge'` — enforce is opt-in until dogfood.
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
