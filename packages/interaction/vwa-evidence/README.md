# @dsh-cc/vwa-evidence

Verifiable Workspace Agent (VWA) evidence substrate (design:
`docs/plans/2026-10-12-verifiable-workspace-agent.md` §4): pure-function
modules that turn a markdown artifact into a machine-checkable evidence
receipt.

- **Marker syntax** `〔src:<sourceId>#L<a>-L<b>〕` (full-width brackets),
  recognized only in prose (markdown-it AST masks fenced blocks and inline
  code spans, length-preserving so every span stays a UTF-16 code-unit
  index). v1 sourceId vocabulary: `ws:<posix path relative to workspace
  root>`; multiple sources join with `;`.
- **Corpus whitelist (frozen)**: `docs/**` ∪ `**/*.md` ∪ `**/*.mdx` under
  realpath(workspace); a target whose realpath escapes the workspace is
  out-of-bounds.
- **Claim detection** is a frozen four-regex family pinned by tests:
  numbers with units/percentages, ISO dates, version strings, and
  API/identifier shapes; entity names are out by design. A document with
  no detected claims yields zero claims (abstained upstream).
- **Verification** is mechanical read-back only: whitelisted in-bounds
  path, file exists, line range exists. Semantic checking belongs to the
  judge tier (§4.4) and never enters the mechanical score.
- **Gates** (§4.3): A links/anchors/in-repo paths (pure in-repo checks);
  B style fixed `abstained` at P2 (no runnable ruleset in this repo —
  interface reserved for D3); C executability over the frozen fenced
  language table (bash dry-parse, ts/js minimal `tsc --noEmit` class,
  anything else abstains with detail) with the executor injected (ctx
  wiring lands in P2b). Per-gate timeout (default 30s) => `abstained`;
  any fail => overall fail; `missing` = gate did not run.
- **Receipts** (§4.1): versioned v:1 JSONL rows under
  `<dshHome>/vwa-receipts/<encodeSegment(sessionId)>.jsonl` via sidecar-io
  `appendJsonl(..., {repairTail: true})` with mandatory write-then-read-back
  (the last line must parse and match `artifactHash`). Coverage per §8 =
  marked-ok claims / detected claims, first-release threshold 0.9.

## Turn-stopping plugin (P2b, §4.5)

The package also mounts as a plain cordis plugin (`inject = ['shell']`,
post-edit-verify idiom) in the vwa preset only — the cc preset deliberately
lacks the row (§4.4; `vwa-evidence.enabled:false` is only an off valve
inside vwa). The `agent/turn-stopping` listener:

- **Window anchoring**: from the turn's LAST genuine `user/message`
  (`source.kind = 'user'` whitelist, completion-gate precedent) through the
  `assistant/message` with `data.turn === payload.turn` — never by turn
  boundary. An aborted/errored turn (no matching tail message, or
  `interrupted: true`) produces NO receipt for the round and cannot
  substitute an older turn's tail.
- **Artifact set**: files hit by `edit`/`write` `tool/call` events inside
  the window (post-edit-verify's EDITING_TOOLS set, which is not exported —
  local copy with provenance comment) → realpath-dedup → whitelist ∩
  inside-workspace. Gate C executes through the harness ShellExecutor
  (`ctx.shell`, declared in `inject`).
- **Nudge** (sync inject, `source.kind = 'vwa-evidence'`): overall ≠ pass or
  coverage below threshold. Budgets: per artifact per turn ≤ 1, per turn
  ≤ 2, per session `nudge-budget` (default 4, hot-read). The self-repair
  re-evaluation arises from the same-turn continuation (the nudge message is
  not a genuine user message, so the window anchor stays on the real user's
  message); a still-failing re-evaluation lands its fail/abstained receipt
  and the in-text abstain note stands — NO delivery blocking in v1.
- **Settings hot read** (§4.4): namespace registration via
  `registerNamespaceSafe` is /config UX + validation only; the evaluator
  re-reads the raw `<dshHome>/settings.json` per dispatch
  (`readUserSettingsSync`), so edits take effect on the next turn without a
  restart (completion-gate's dual-half pattern, evaluate-time).
- **Sole writer**: only this evaluator appends to the vwa-receipts ledger.
- **Restart recovery**: pending = session-wide edited paths with no receipt
  row whose `artifactHash` matches the current file (replay sources: the
  session's events and the on-disk ledger); consumed nudge budget is
  recovered from the ledger projection (`nudge.round > 0` rows).
- **Time correlation** (implementation notes, §4.5): row identity follows
  config-snapshot v7's triple — `(artifactPath, event seq)` in the session
  view, the process `bootId`, and the row's `appendedAt` (`ts`) — with the
  "largest `appendedAt` ≤ event time" selection rule for correlating a
  receipt to the event that produced it. The evaluator implements this as
  last-row-per-path selection over the session's monotonic event order
  (`staleAgainst`); no external ledger bookkeeping is added.

This package is vwa-exclusive (absent from the capability manifest by
design §3.2(a)).

Plan: `docs/plans/2026-10-12-verifiable-workspace-agent.md`
