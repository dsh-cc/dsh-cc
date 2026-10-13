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

This package is vwa-exclusive (absent from the capability manifest by
design §3.2(a)); turn-stopping wiring, artifact-set derivation, settings
registration and nudge limits land in P2b.

Plan: `docs/plans/2026-10-12-verifiable-workspace-agent.md`
