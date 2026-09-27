# Gauge approval-rate L1/L2: shell segment evaluation and suspension recalibration

- Date: 2026-09-27 (v6, review complete)
- Status: **Reviewed — both lanes green** (critic SHIP at round 5; codex SHIP WITH FIXES at
  round 5, its single fix folded verbatim). Pending implementation PRs per D7.
- Adjudication ledger: §9.
- Input evidence: production session-audit decomposition 2026-09-20 → 27 (5,626
  `permission/classifier` events; gauge lane 395, ask rate 83.5%; ≈2% allow at steady
  τ=0.5; bash calls ≈88% of gauge asks), workspace memory `gauge-approval-round2-decomposition`.
- Precursors: `docs/plans/2026-09-25-gauge-approve-rate-fixes.md` (#148); criteria-sweep
  negative result (#149) — the model side (P(allow) mass 0.35–0.45 vs. adversarial floor
  0.475) is closed as not-fixable-by-wording; this document fixes the RULE layer instead.

## 1. Problem

Read-only-ish bash work (`ls`, `cd x && ls`, `tail -30 f | grep …`) reaches the
classifier (gauge lane) in auto mode, and the gauge cannot allow it at any safe threshold.
Meanwhile the user's escape hatch is broken three ways:

1. **Suspended grants.** The "always allow" answer persists a first-word prefix rule
   (`Bash(ls )`). In auto mode `auto-rule-filter.ts` suspends interpreter heads, package
   runners, whole-tool bash, and **any fixed head shorter than 3 characters** — `ls`, `cd`,
   `wc` die by length. Production probe over the operator's real settings: 388 allow rules,
   57 suspended (22 whole-tool, ~34 interpreter/package-runner, ~10 short-head writers).
   Granting again silently re-fails; there is no notice.
2. **Tail laundering & deny evasion.** Rules match the whole command string by raw
   `startsWith` prefix (`parser.matchContent`: content without a wildcard is a prefix
   matcher). `Bash(npm )` admits `npm i && rm -rf x`; conversely a content *deny*
   `Bash(rm )` is evaded by `ls && rm -rf x` because the command does not start with `rm`.
3. **No first-run relief.** There is no shipped default rule surface (probed: `slots.ts`
   `$defaults` fills classifier *question* slots only; rule config enters via user/local/
   project settings or deployment Config). This document deliberately does NOT invent one
   (D9).

Reference corpus (frozen at 2026-09-27T11:00+08:00 event time — earlier probe runs drifted
as this worktree's own session kept appending events; only the frozen run is the reference):
284 distinct production bash asks ⇒ opaque 58 (heredoc/subshell), tainted 69
(redirection/substitution), coverable-by-existing-user-rules-after-D4 44, pure-reader
chains without any rule 7, classifier-bound by design 106 (interpreter-heavy).

## 2. Goals / non-goals

Goals:
- G1 Segment atomicity: a content rule only ever matches ONE complete shell segment;
  every segment must earn the command's verdict (all modes).
- G2 Grant-loop repair: reader-headed short grants (`Bash(ls )`, `Bash(cd)`) survive in
  auto mode once G1 makes short heads non-laundering — with exact token-boundary matching
  so `Bash(ls)` admits `ls`/`ls -la` and never `lsof` (D4).
- G3 Visibility: the "always allow" answer reports when the persisted (or covering) rule is
  suspended under auto mode (L2). Ships first as PR-2.
- G4 Never weaker for denies: content deny becomes segment-aware (fixes evasion) and stays
  fail-closed on opaque commands, which can never gain a content allow (D2-opaque).
- G5 Never weaker for assignment-bearing commands: leading assignments define the launch
  environment (`PATH=/x …`), so content allow never matches the assignment-stripped
  subject — only the raw segment (D2 phase 7, codex round-2 F1).

Non-goals: N1 model-side changes (τ, wording, second-pass); N2 shipped default allow
rules (D9, explicit product decision deferred); N3 interpreter/package-runner exemptions —
still suspended, heredoc/`python3 -` stays classifier-bound (supersedes the old "exact
full-command exemption" P2); N4 session-allowlist segment-awareness (whole-subject stays;
follow-up); N5 `classifyAllShell` semantics unchanged; no PowerShell segmentation.

## 3. Design

### D1. Segment grammar — `shell-segments.ts` (new module, package-internal by default)

```ts
export type ShellSegment = {
  readonly raw: string            // trimmed top-level source slice, continuations applied
  readonly subject: string        // raw minus leading assignment words, trimmed
  readonly first: string          // first whitespace token of subject (quotes consumed)
  readonly tainted: boolean       // substitution or writing redirection inside this segment
  readonly assignmentOnly: boolean
}
export type OpaqueWhy = 'quote' | 'grammar' | 'heredoc' | 'subshell' | 'group' | 'reserved'
  | 'too-many'
export type SegmentResult =
  | { readonly kind: 'segments'; readonly segments: readonly ShellSegment[] }  // ≥1 always
  | { readonly kind: 'opaque'; readonly why: OpaqueWhy }
```

Single linear scan with explicit state (quote state, substitution/parameter depth, escape
flag). Grammar rules (each is an R/D8 test row):

- **Quotes.** `'…'` hard-quoted (nothing active inside; backslash is literal).
  `"…"` soft-quoted: backslash escapes only `\"` `\\` `` \` `` `\$` and the `\`-newline
  continuation; active `$(`/backquote inside double quotes TAINTS the enclosing segment
  (command substitution executes there). ANSI-C `$'…'` is its own state: backslash consumes
  the following character for delimiter recognition (so `\'` does not close it); no
  parameter or command expansion occurs inside. Unterminated quote state (any kind) ⇒
  `opaque:'quote'`.
- **Escapes outside quotes.** Backslash consumes the next character verbatim; escaped
  operators (`\;` `\&` `\|` `\<` `\>` `\(` …) never split or taint. Backslash-newline is a
  line continuation: removed from segment text. A terminal unpaired backslash ⇒
  `opaque:'quote'`.
- **Separators** (top level, outside quotes and substitution/parameter depth): `&&`, `||`,
  `|&`, `|`, `;`, newline, `&` — each ends the current segment. Disambiguation: `&&`/`||`
  are recognized before single `&`/`|`; fd-duplication `2>&1` is recognized as a
  redirection (below) before background `&`.
  Operand integrity: `&&`, `||`, `|`, `|&` require commands on BOTH sides — a missing
  operand (`ls &&` at EOF, `| ls`, `&& ls`, `ls ;; ls`) ⇒ `opaque:'grammar'`. `;` and `&`
  may terminate a preceding nonempty command at EOF but may not begin one. Leading blank
  lines and trailing newlines are ignored; repeated newlines and a newline following `;` or
  `&` create no segments. While awaiting the RIGHT operand of `&&`, `||`, `|`, or `|&`,
  intervening newlines and comment-only lines are layout (no empty segments); the command
  becomes `opaque:'grammar'` only if EOF or an incompatible operator occurs before a
  nonempty right operand. Empty or comment-only input ⇒ `opaque:'grammar'`.
- **Comments.** An unquoted `#` that begins a word (start of segment or after whitespace)
  starts a comment to end-of-line; `#` inside a word (`a#b`) is literal.
- **Substitution tracking.** `$(` and backquote substitution open whenever outside single
  and ANSI-C quotes — including inside double quotes and inside parameter expansions. Their
  balanced contents carry nested quote/escape state; separators inside never split the
  outer command; their presence taints the enclosing segment. `${…}` parameter expansion
  tracks its own balanced brace depth: its braces are NOT group tokens, separators within
  do not split, nested command substitutions still taint. Unbalanced state ⇒
  `opaque:'quote'`. A `(` or `)` not belonging to a `$(` substitution ⇒
  `opaque:'subshell'`; an unquoted `{` or `}` not belonging to `${…}` ⇒ `opaque:'group'`.
- **Redirections** (recognized inside segments, outside quotes): descriptor duplication and
  close forms `[n]>&m`, `[n]<&m`, `[n]>&-`, `[n]<&-` are inert — no taint, no split. Only
  `n` is optional; the target `m` is required and must end at EOF, shell whitespace, or a
  recognized operator; both descriptors may be multi-digit. A leading descriptor `n` is
  recognized ONLY when the complete unquoted token immediately preceding `>` or `<`
  consists solely of digits: `2>&1` duplicates fd 2, while in `ls x2>&1` the word `x2`
  stands and `>&1` duplicates the default output descriptor (both forms are inert).
  Everything else redirection-shaped TAINTS its segment: `>`, `>>`, `>|`, `&>`, `&>>`,
  `>&file`, `<`, `<>`, and unrecognised forms. Heredocs `<<`, `<<-`, `<<<` ⇒
  `opaque:'heredoc'` for the whole command.
- **Reserved words.** If a segment's first token (after assignment stripping) is one of
  `if then elif else fi for select while until do done case in esac function time coproc !
  [[ ]]` ⇒ `opaque:'reserved'`.
- **Assignment stripping** (D5 shared helper): `subject` = the segment's `raw` with
  leading `NAME=value` words removed repeatedly; NAME matches `[A-Za-z_][A-Za-z0-9_]*`; the
  value is one lexically complete shell word (quotes/escapes respected). A segment whose
  `subject` is empty (`H=/tmp/x` alone) is `assignmentOnly: true`.
- **Caps.** >64 segments ⇒ `opaque:'too-many'`. The scanner is O(command.length), uses no
  regex, never throws.

### D2. Evaluator integration — one internal entry point, opaque fail-closed

`evaluate.ts` gains ONE package-internal entry point (NOT re-exported from `index.ts`;
unit-tested directly, integration-tested through `evaluatePermission`/`decideCall`):

`evaluateShell(input: EvaluationInput, result: SegmentResult): PermissionDecision`

returning the FINAL post-plan-wrap decision. It splits into two private helpers.

**Segmented helper** (`result.kind === 'segments'`) preserves the existing global waterfall
phase order; content phases loop over segments:

1. bypass-immune deny across segments (raw OR subject; source-priority outer, then segment
   order, then rule declaration order) ⇒ deny
2. whole-tool deny ⇒ deny
3. `bypassPermissions` short-circuit ⇒ allow (unchanged; ordinary denies stay bypassed)
4. content deny across segments (raw OR subject) ⇒ deny
5. whole-tool ask ⇒ ask (sandboxed-bash exemption intact)
6. content ask across segments (raw OR subject) ⇒ ask
7. content allow ⇒ allow only when EVERY segment is admissible:
   - tainted segments are never admissible (they remain deny/ask-visible above);
   - an `assignmentOnly` segment is admissible ONLY when untainted AND its `raw` matches a
     content allow rule — it is NOT neutral (codex R2-F1: `PATH=/attacker && ls` must not
     inherit `Bash(ls)`), and never via its (empty) subject;
   - a segment with leading assignments is allow-matched against `raw` ONLY (never
     `subject` — assignments define the launch environment); a literal-prefix rule whose
     own fixed head contains leading assignment words additionally enforces the conjunctive
     executable-token boundary (D4-extension): `contentMatches(matcher, raw) &&
     commandToken(stripLeadingAssignments(raw)) === commandToken(stripLeadingAssignments(head))`
     — so `Bash(FOO=1 ls)` matches `FOO=1 ls` and `FOO=1 ls -la` but not `FOO=1 lsof`;
     when the rule's head strips to an EMPTY executable token (assignment-only rule,
     e.g. `Bash(FOO=1)`), the boundary degenerates: such a rule matches an assignment-only
     segment ONLY when the candidate raw text exactly equals the rule content (verbatim),
     never by prefix (R16); wildcard/regex matchers always retain their authored semantics;
   - a segment without assignments is matched against its text (raw === subject); an
     exempted short-head rule additionally enforces the token boundary (D4);
   unresolved ⇒ the phase contributes nothing (falls through)
8. mode phases (acceptEdits/plan) ⇒ as today
9. whole-tool allow ⇒ allow
10. passthrough

**Opaque helper** (`result.kind === 'opaque'`), fail-closed for content allows:
bypass-immune raw deny ⇒ whole-tool deny ⇒ `bypassPermissions` short-circuit ⇒ content
deny on the raw whole subject ⇒ whole-tool ask (sandbox exemption intact) ⇒ content ask on
raw ⇒ **content allow skipped entirely** ⇒ mode phases ⇒ whole-tool allow ⇒ passthrough.
(An opaque command's structure is unknown; prefix approval must not launder heredocs,
substitutions, subshells, group syntax, or control flow — R2/R7/R12.)

The plan-mode wrap applies ONCE, inside `evaluateShell`'s return path for the segmented/
opaque evaluation, and `evaluatePermission` retains its existing wrap for its existing
callers; `decide.ts` applies no second wrap. `decideCallVerbose` calls `evaluateShell` for
bash-shaped execs and `evaluatePermission` for everything else.

`index.ts registerGuards`: for bash-shaped execs, deny when ANY segment's `raw` OR
`subject` matches (segmented results) and keep the existing raw whole-subject fallback for
opaque results; non-bash execs (file paths, WebFetch hostnames) keep whole-subject
`ruleMatches` unchanged.

`sessionAllowMatches` unchanged (whole-subject), recorded as N4 follow-up.

### D3. Scope

All permission modes (uniform command identity; deny evasion is mode-independent — codex
Q1/critic Q1 agree). Non-bash tools unchanged. Bash spelling aliases resolve through the
existing `ccToolAliases` path. PowerShell content rules: no segmentation, current behavior,
`classifyAllShell` plumbing unchanged.

### D4. Suspension recalibration (`auto-rule-filter.ts`)

`SAFE_SHORT_HEADS = ['cd', 'ls']` — these are the ONLY heads shorter than 3 characters that
the `<3` exemption admits (`wc` and every write-capable head stay suspended; `pwd`/`echo`/
`true`/`date`/`which`/`whoami`/`uname`/`basename`/`dirname` are ≥3 chars and were never in
scope). Exemption eligibility — ALL of:
1. bash content rule whose fixed head trims to <3 chars;
2. matcher is a non-wildcard **prefix** matcher (wildcard heads and the `:*` legacy form
   are NOT eligible);
3. the fixed head, whitespace-trimmed, equals exactly one entry of `SAFE_SHORT_HEADS`
   (case-sensitive; no colon-stripping, no lowercasing).

Safe-head matching (segmented content-allow phase only) is CONJUNCTIVE with the existing
matcher:
`contentMatches(rule.matcher, candidate) && commandToken(candidate) === safeHead`
where `candidate` is the string the rule matched per D2 phase 7 and `commandToken` is its
first whitespace-delimited token. The check supplements, never replaces, the original
matcher: `Bash(ls)` matches `ls` and `ls -la` but not `lsof`; `Bash(ls )` keeps its
trailing-space prefix requirement and does NOT newly match bare `ls`. Longer heads retain
current matching semantics bit-for-bit.

Unchanged: whole-tool bash suspension; interpreter heads; package-runner heads; subagent
tools; `classifyAllShell`.

D4-extension (same conjunctive mechanism, different trigger): a LITERAL-PREFIX content
allow rule whose fixed head itself begins with assignment words gets the executable-token
boundary — see D2 phase 7 and R15/R16. Wildcard and regex matchers are out of scope for
the extension and keep their existing semantics; longer non-assignment-headed rules remain
bit-compatible.

### D5. Shared derivation/evaluation normalization (`approval-preview.ts` side)

New export from `permission-rules` (re-exported via `index.ts`, consumed by both sides so
grant-derivation and evaluation never drift):
`stripLeadingAssignments(text: string): string` — case-permissive names, quoted values,
repeated application.

Derivation (`allowRuleOf`, PR-3) — decision order pinned (codex R3-F1):

1. If the raw shell segment BEGINS with one or more assignment words: persist a raw
   assignment-bearing prefix (verbatim text through the first command token), with a
   trailing space iff the original segment had arguments after the first command token —
   `FOO=1 ls` ⇒ `Bash(FOO=1 ls)`, `FOO=1 ls -la` ⇒ `Bash(FOO=1 ls )`. The D2-extension
   conjunctive boundary makes the no-space form safe against `FOO=1 lsof`. An
   assignment-ONLY command (`FOO=1` with nothing after) has no command token: persist its
   exact raw form (`Bash(FOO=1)`), which per D2's degenerate-boundary rule matches only
   verbatim (R16).
2. Otherwise (no leading assignment): repeatedly consume supported wrappers
   (`sudo `, `npx `, `yarn `) AND any wrapper-local assignment arguments from left to right
   (`sudo FOO=1 ls` ⇒ first word `ls`). Persist the inner-command rule WITHOUT requiring it
   to match the raw wrapper-bearing command (the current raw-prefix fallback is removed for
   this branch). Argument-free inner commands persist the bare form (`sudo ls` ⇒
   `Bash(ls)`, `sudo FOO=1 ls` ⇒ `Bash(ls)`); argument-bearing ones persist the trailing-
   space form (`sudo ls -la` ⇒ `Bash(ls )`) — both covered by D4's boundary conjunction.

The persisted inner rule (e.g. `Bash(ls)`) matches wrapper-free segments (`ls`,
`ls -la`, `cd x && ls`) but NOT a literal wrapper-bearing segment (`sudo ls`) —
accepted asymmetry, R13 (users grant the inner command; `sudo` breadth is theirs to
grant separately).
Deny/ask/immune matching receives the segment's `raw` alongside `subject`, and content
allow receives both candidates per the D2 phase-7 policy, so existing raw-text rules
(e.g. `Bash(FOO=x rm )` deny) cannot become weaker.

### D6. L2 — always-grant suspension notice (PR-2)

- `auto-rule-filter.ts` gains:
  `autoSuspendedReason(rule: PermissionRule, opts: { classifyAllShell: boolean }): SuspensionCategory | undefined`
  with `SuspensionCategory = 'whole-tool' | 'short-head' | 'interpreter' | 'package-runner'
  | 'subagent' | 'classify-all-shell'` (more specific categories take precedence over
  `'classify-all-shell'` when both apply).
- `index.ts` re-exports the pure function AND adds to `PermissionRulesService`:
  `autoSuspensionReason(ruleText: string): SuspensionCategory | undefined` — parses the
  serialized rule with the canonical `parseRule` and consults the LIVE resolved
  `classifyAllShell` setting. The TUI never substitutes `classifyAllShell: false` (that
  false-negative gap was rejected in round 1).
- TUI `driver-approvals.ts writeAllowRule`: mode gate = `rt.state().permissionMode === 'auto'`;
  the service is resolved through the same seam as `driver.ts` (`ctx.get('permissionRules')`).
  - Success branch with suspended derived rule ⇒
    `Always allow: <rule> — note: auto mode suspends this rule class (<category>); it will keep asking there. The "session" answer works today.`
  - Already-covered branch where the COVERING rule is suspended and the derived rule is
    effective: PR-3 persists the narrower rule anyway and notices
    `Always allow: <rule> — overrode covering rule <covered-by>, which auto mode suspends.`
    PR-2 (pre-PR-3 behavior) keeps the swallow but notices
    `Already covered by <covered-by> — note: that rule is suspended under auto; it will not apply there.`
  - Persistence truth table (codex R3-F3 + R4-F2, disjoint cells):
    - No covering rule: persist the derived rule; warn if the derived rule is suspended
      (notice names the DERIVED rule's suspension category).
    - Effective covering rule: persist nothing; retain the current `Already covered`
      behavior with NO suspension warning (the grant genuinely applies).
    - Suspended covering rule + effective derived rule: persist the narrower derived rule
      and report the override (PR-3; PR-2 keeps the swallow but notices the covering
      rule's suspension).
    - Suspended covering rule + suspended derived rule: persist nothing extra; report that
      auto mode suspends the applicable rules (both categories named).
- Tests mirror all four persistence cells:
  1. no covering + suspended derived ⇒ persist and warn;
  2. effective covering + suspended derived ⇒ `Already covered`, no suspension warning;
  3. suspended covering + effective derived ⇒ PR-3 persists narrower and reports the
     override; PR-2 retains the rule and warns;
  4. suspended covering + suspended derived ⇒ persist nothing extra and report both
     categories.
  Non-auto notices remain absent; effective post-D4 `cd`/`ls` rules receive no suspension
  suffix.

### D7. Files / PR slicing / merge order

- PR-1: this document (design record, including both adjudication rounds at §9).
- PR-2 (L2): `auto-rule-filter.ts` (`autoSuspendedReason`, classifyAllShell-aware; no
  behavior change to `filterAutoAllowRules`), `index.ts` re-export + service method,
  `driver-approvals.ts` notices, tests (`auto-rule-filter.spec.ts`,
  `driver-approval.spec.ts`), capability manifest + `pnpm docs:parity`.
- PR-3 (L1, stacked on PR-2): `shell-segments.ts`; `evaluate.ts` `evaluateShell` +
  plan-wrap hoist; `decide.ts` bash routing; `index.ts registerGuards` bash-only segment
  deny + opaque fallback + `stripLeadingAssignments` re-export; `auto-rule-filter.ts` D4
  carve-out (same PR as segmentation, never alone); `approval-preview.ts` derivation rework
  (D5) + spec rows; `driver-approvals.ts` suspended-covering repair;
  `scripts/replay-segment-coverage.mjs` (offline reference-table refresh); manifest +
  parity; package README if the permission-rules waterfall section is rendered there.
- **Merge order: PR-1 → PR-2 → PR-3.** PR-3 stacks on PR-2 (codex F10: not
  code-independent — both touch `auto-rule-filter.ts`/`index.ts`/`driver-approvals.ts`).

### D8. Verification plan

Unit:
- `shell-segments.spec.ts`: every D1 bullet ≥1 row — quoting incl. ANSI-C escape
  (`$'a\'b'`), escapes + terminal unpaired backslash, continuations, env prefixes
  (upper/lower-case, quoted values), comments, dup-fd forms vs writing redirects with the
  digit-run rule pinned BOTH ways (`2>&1` dup; `x2>&1` = word `x2` + default-stdout dup), `$(`/backquote nesting incl. inside double quotes and inside
  `${…}`, `${a:-b}`/, heredocs, reserved words, subshells, groups, operand integrity
  (`ls &&`, `| ls`, `ls ;; ls` ⇒ opaque; `ls;\nnext` ⇒ two segments; newline-as-layout
  while awaiting a right operand: the single-line strings `ls &&` + LF + ` next` and
  `producer |` + LF + ` consumer` each yield two segments), 64-cap, CJK pass-
  through, `ls "a && b"` never splits, `` cmd `echo "a"` `` and `echo $(printf 'a)b')`
  stay segments (state-inside-substitution rows).
- `evaluate.spec.ts` (segmented path via `evaluateShell`): phase-order rows (composed deny
  beats whole-tool ask; whole-tool ask beats composed ask; tool allow after failed content
  allow); composition rows incl. assignment policy (R14: `PATH=/x && ls` NOT allowed by
  `Bash(ls)`; `FOO=1 ls` not allowed by `Bash(ls )`; assignment-only untainted matched on
  raw; all-assignment commands never vacuous-allow; tainted assignment-only always fails
  content allow); taint blocks allow not deny (R8); opaque content-allow suppression (R12:
  `Bash(ls )` + `ls <(x)` ⇒ passthrough); token boundary (R10: `Bash(ls)`+`lsof` ⇒
  passthrough, `Bash(ls)`+`ls -la` ⇒ allow, `Bash(ls )` does not newly match bare `ls`);
  assignment-headed rule boundary (R15: `Bash(FOO=1 ls)` matches `FOO=1 ls` and
  `FOO=1 ls -la`, never `FOO=1 lsof`; `Bash(FOO=1 ls )` does not newly match bare
  `FOO=1 ls`).
- `auto-rule-filter.spec.ts`: `cd`/`ls` exempted; `rm`/`mv`/`fd`/`wc`/`sh` stay suspended;
  interpreter/package-runner/whole-tool/classifyAllShell unchanged; wildcard/colon heads
  ineligible.
- Guards: bash-only segment-aware deny; opaque raw fallback; WebFetch/file paths unchanged.
- Derivation (`approval-preview.spec.ts`): decision-order rows (assignment-first rule —
  `FOO=1 ls` ⇒ `Bash(FOO=1 ls)`; `FOO=1 ls -la` ⇒ `Bash(FOO=1 ls )`; assignment-only —
  `FOO=1` ⇒ `Bash(FOO=1)` matched verbatim-only (R16 rows: vs `FOO=1`, `FOO=10`,
  `FOO=1 BAR=2`); wrapper branch — `sudo FOO=1 ls` ⇒ `Bash(ls)`; `sudo ls -la` ⇒
  `Bash(ls )`; bare `ls` ⇒ `Bash(ls)`).
Integration (`listener-auto-stage`-adjacent): existing user rules `Bash(cd )` + `Bash(ls )`
auto-allow `cd x && ls` in auto mode; only `Bash(ls )` ⇒ passthrough; `cd x && ls; rm -f y`
⇒ passthrough / denied by a matching `Bash(rm )` rule.
Offline evidence (not a gate): frozen operator-state replay — same user-rule snapshot as
§1's frozen corpus — ≥44/284 command shapes auto-allowed after the change; script output
table lands in the PR-3 body.
Manifest: `pnpm check:capabilities` + `pnpm docs:parity` green in each PR (rows:
`permissions.rules` engine evidence + user-visible evaluation behavior change).

### D9. Deferred (explicit product decisions required)

Shipped default reader rules (auto-allow `ls …` out of the box — departs from CC default
first-prompt parity); session-allowlist segment-awareness; `<`-input-redirect fine-tuning;
interpreter exact-command grants. Each a follow-up issue, not part of this program.

### R. Adversarial register (merged from both lanes, rounds 1–5)

- R1 quoted operators (`'a && b'`, `"a | b"`, ANSI-C, escaped operators) — spec'd D1.
- R2 substitution inside double quotes executes ⇒ taints its segment (both lanes).
- R3 parameter expansion is not re-scanned by the shell; assignments are NOT neutral (see
  R14 — this replaces round-2's rejected neutrality premise).
- R4 `wc` excluded from the exemption (codex policy argument won — §9 ledger of round 1).
- R5 segment text trimmed before matching (composition rows pin it).
- R6 fd-dup grammar: `[n]>&m` family only, `n` optional / `m` required. A leading
  descriptor is recognized only when the complete preceding unquoted token consists of
  digits: in `x2>&1` the word `x2` stands and `>&1` duplicates default stdout (both inert).
  `&>`/`&>>`/`>&file` taint; `&` backgrounding is a separator.
- R7 control-flow/reserved words, heredocs, subshells, groups ⇒ opaque. `if true; then
  rm x; fi` never splits into grant-eligible segments.
- R8 taint blocks allow only; `Bash(rm )` deny still fires on `ls > /tmp/x && rm y`.
- R9 scanner O(n) with no regex; existing regex-backed matchers retain their existing
  complexity characteristics (≤64 segment passes over the merged set).
- R10 bare-short-prefix identity: `Bash(ls)` ⇒ conjunctive token boundary; `lsof`/`lsattr`
  pass through; `Bash(ls )` does not newly match bare `ls` (both canonical forms pinned in
  D8 derivation rows).
- R12 opaque commands are fail-closed to content allows (`ls <(danger)`, heredoc bodies).
- R13 wrapper asymmetry (adjudicated, codex horn): wrapper-only derivation persists the
  inner-command rule without raw verification; a literal wrapper-bearing segment does not
  match it. Users grant the inner command.
- R14 assignment environment attacks (codex R2-F1): `PATH=/attacker && ls` fails content
  allow under `Bash(ls)`; `LD_PRELOAD=/x.so ls` likewise; tainted assignments block;
  all-assignment commands never vacuously allow.
- R15 assignment-headed rule identity (codex R3-F1): a persisted assignment-bearing prefix
  gets the same conjunctive executable-token boundary at evaluation, so it can never widen
  into a different executable (`FOO=1 lsof`). Literal-prefix matchers only; wildcard/regex
  keep authored semantics.
- R16 assignment-only degenerate boundary (codex R4-F1): `Bash(FOO=1)` matches `FOO=1`
  verbatim only — never `FOO=10`, never `FOO=1 BAR=2`.

## 9. Adjudication ledger (honest attribution)

**Round 1.** critic: SHIP WITH FIXES (4 must-fixes: double-quote taint wording; env-strip
alignment premise false; control-flow opacity; D2 splice spec) — all absorbed/subsumed.
codex: NO-GO (findings 1–10) — all absorbed or ruled on: F1 opaque fail-closed; F2 single
internal evaluator, no public `evaluateCore`; F3 token identity; F4 grammar completeness;
F5 raw+subject dual matching; F6 classifyAllShell-aware predicate + covering branch table;
F7 integration-test impossibility; F8 bash-only guards; F9 R9 wording; F10 PR stacking.
Divergence of round 1, ruled not picked: `wc` EXCLUDED (critic wanted in) — the
carve-out's load-bearing criterion is "no content read"; `wc` violates it.
Q1 uniform all-modes (both lanes agree); Q2 `wc` out; Q3 package-internal entry only; Q4
shared strip helper (the doc's original alignment premise was FALSE — refuted by critic
finding 2 and codex F5).

**Round 2.** critic: SHIP WITH FIXES — 3 must-fixes folded (`${…}` closing depth ⇒ merged
into D1 substitution tracking; derivation-verification contradiction ⇒ resolved by codex's
horn, see below; plan-wrap ownership ⇒ codex F2's `evaluateShell` text), minors folded
(OpaqueWhy enum, digit-gluing pin, `"…"` typo, D5's allow-path wording, substitution-state
test rows). codex: NO-GO — 9 findings, all accepted verbatim as replacement text: F1
assignment-environment bypass (CRITICAL, new — kills assignment neutrality; R11 reversed
into R14); F2 single entry point + opaque phase order; F3 lexical-state precision; F4
operand integrity + fd target wording; F5 `SAFE_SHORT_HEADS=['cd','ls']` + conjunctive
boundary; F6 service method takes ruleText + covering-repair only when derived effective;
F7 derivation rework incl. raw-prefix for assignment-bearing calls and
`stripLeadingAssignments` re-export; F8 R9 matcher wording; F9 replay-fixture wording.
Round-2 divergence, ruled not picked: critic proposed verifying stripped derivation against
the first segment's `subject`; codex proposed no-verify-for-wrappers + raw-prefix for
assignment-bearing — codex's version is adopted because only it composes with F1's
raw-only allow policy for assignment-bearing segments (verifying `Bash(ls )` against the
stripped subject of `FOO=1 ls` would persist a rule the evaluation side can never honor).

**Round 3.** critic: SHIP (all 9 round-2 folds confirmed by quote-back; zero new
contradictions; two pre-existing fail-closed coverage losses noted as deferrable: unquoted
brace expansion `ls a{b,c}` ⇒ opaque, comment-only input ⇒ opaque). codex: NO-GO with 4
fold-introduced text-level findings — all adopted verbatim: assignment-bearing derivation
representation + boundary generalization (F3 refold — see note), digit-run tokenization
wording (both `2>&1` and `x2>&1` forms pinned), D6 persistence truth table, layout
newlines after binary operators. Round-3 divergence, ruled not picked: critic confirmed
round-2 F7 as folded while codex refuted the same fold with a mechanistic `startsWith`
truth table (`Bash(FOO=1 ls)` matches `FOO=1 lsof`) — codex's demonstration is verified
against `parser.matchContent` prefix semantics and wins; the fix rides the generalized
boundary (R15) rather than another derivation special-case.

**Round 4.** critic: SHIP (all four round-3 folds quote-verified; two non-blocking
one-word ambiguities noted and carried: notice names the DERIVED rule's category; D6 table
made disjoint). codex: NO-GO with 5 findings — all adopted verbatim: assignment-only
degenerate boundary (verbatim-equality matching, new R16); disjoint D6 four-cell truth
table (the "derived suspended + covering exists" cell no longer collides with the
effective-covering cell); D4-extension domain pinned to literal-prefix matchers; R6 stale
sentence replaced; register heading + D8 wrapper-row labels refreshed. Round-4 divergence,
ruled not picked: critic suggested the boundary clause apply to wildcard/regex matchers
inclusive ("boundary applies after contentMatches"); codex demanded wildcard/regex retain
existing semantics — codex wins: the boundary's purpose is protecting naive prefix rules,
regex content has no defined executable-token surface, and narrowing user-authored wildcard
rules would be a bit-incompatible behavior change.

**Round 5.** critic: SHIP (five folds quote-verified at every referencing site; the three
boundary regimes partition the prefix space without gaps or overlaps; doc closed under a
fresh implementer read). codex: SHIP WITH FIXES — one MEDIUM folded verbatim: D6's test
shorthand replaced by the four-cell test list. No further doc rounds; both lanes green.
