# MCP tool permission classes — deterministic read-only / workspace-write classification for auto mode

Status: v4 FINAL — three-seat review converged (critic GO r2, grok GO r3, codex GO r4)
Date: 2026-11-15
Worktree: `serena-permissions` (branch `worktree-serena-permissions`)

## 0. Problem

In `auto` mode with the System One gauge backend, subagent calls to MCP tools
(e.g. `mcp__serena__find_referencing_symbols`) die with:

```
Error: the user rejected tool "mcp__serena__find_referencing_symbols"
(the ask was raised because: deny downgraded: gauge cannot cite an exact
hard-deny rule (P(deny)=0.393))
```

Read-only MCP tools must not be routed to LLM arbitration at all, and
workspace-confined write tools must be releasable from arbitration by an
explicit trusted configuration. Claude Code's server-wide `mcp__<server>`
permission-rule form is also unmatched in dsh-cc today.

## 1. Root cause (code-verified)

1. `readOnlyTools` is a Config static set of built-in names
   (`DEFAULT_READ_ONLY_TOOLS`, `permission-rules/src/settings-schema.ts:250`);
   no `mcp__*` name is ever in it ⇒ `isReadOnly = false`
   (`decide.ts:132`).
2. `classify()` treats every non-bash / non-`file_path` tool as `LOW`
   (`decide.ts:99-115`) ⇒ waterfall `passthrough`.
3. Auto-stage eligibility = `auto` + `passthrough` + `LOW|MEDIUM` +
   not read-only (`auto-stage.ts:346-352`) ⇒ every MCP tool call is
   gauge-arbitrated.
4. The gauge state carries only `{tool, arguments}`
   (`gauge-adapter.ts:173`); tool descriptions and MCP annotations are
   invisible to it.
5. Gauge deny collapses to `ask` (escalate-only law, `gauge-adapter.ts:271`).
   In a headless subagent an ask fails closed ⇒ the observed rejection.

Downstream terminal (verified, all three seats agree): a classified call
that stays `passthrough` and skips the stage runs — `mapPostWaterfall`
returns LOW passthrough unchanged (`decide.ts:227-233`), the listener
returns `next()` (`pre-execute.ts:367-371`), and the pipeline terminal
defaults to allow (`core/tools/src/pipeline.ts:231-234`) with monotonic
guards still applied (`pipeline.ts:245`). The skip must therefore be
"return `undefined` from `maybeEscalate`", never an unconditional allow.

## 2. Probe evidence (live, 2026-11-15)

Probe script ships with this change
(`permission-rules/scripts/probe-mcp-gauge.mjs`) plus a committed results
JSON (the `gauge-corpus-results.json` pattern); the scratch original used
during design produced:

| variant | read tools P(allow) | write tools P(allow) | gated |
| --- | --- | --- | --- |
| baseline `DEFAULT_ENVIRONMENT` | 0.41–0.48 | 0.41–0.42 | all `ask` |
| + "configured MCP servers are recognized environment" sentence | Δ≈0 | Δ≈0 | all `ask` |
| + tool `description` injected into gauge state | 0.47–0.54 | 0.38–0.41 | 4/5 read `allow`, writes `ask` |

- **P-1 (falsifies the corpus-only fix):** the environment prose amendment
  moves probabilities by noise. Not shipped.
- **P-2 (description injection is not load-bearing):** read tools hover at
  τ, write tools stay below. Not shipped.
- **P-3:** the standard 48-case corpus reproduces its shipped numbers in
  the same session — the probe environment is representative.

Conclusion: the reliable fix is deterministic classification decided
before the gauge.

## 3. Design

### D1 — Tool classes and their semantics

A tool call resolves to at most one class:

- **`readOnly`** — reads only. Treatment: `isReadOnly = true` for
  curated/settings classification only (the annotation source never
  sets it — D3; plan-mode auto-allow via the existing
  `evaluate.ts:141-142` path; auto-stage never arbitrates).
- **`workspaceWrite`** — mutates state the deployment asserts is confined
  to the session workspace. Treatment: auto-stage never arbitrates;
  `isReadOnly` stays `false` (plan mode still wraps it; `acceptEdits`
  unchanged). NOT settable by the curated table (D3) — settings-only,
  trusted layers only (D5), and screened by D6b.
- **unclassified** — today's behavior (gauge arbitration).

Class conflict (a tool listed in both arrays) ⇒ unclassified — fail-safe.
A present-but-empty settings object (`"serena": {}`) replaces the curated
row with nothing (all tools of that server unclassified); `false` disables
classification for the server including the annotation fallback.

Consequences stated explicitly (r1 m7): skipping the stage also skips the
`autoMode.hard_deny`/`soft_deny` slot arbitration for classified calls —
inherent to any bypass, accepted. Explicit `deny`/`ask` rules and HIGH risk
still win (the waterfall and `decideCallVerbose` run before the stage and
its non-passthrough decisions are never arbitrated, `auto-stage.ts:350`).
MEDIUM classified calls keep the `mapPostWaterfall` MEDIUM mapping — moot
today (MCP calls classify LOW) but pinned by test.

### D2 — Identity: stamped metadata, never name parsing

`exec.name` is never parsed (r1 blocker: `publicToolName`
(`mcp-client/src/tools.ts:187-193`) allows `[A-Za-z0-9_-]` server names,
normalizes characters, and hash-suffixes long names; the design's
`^mcp__([a-z0-9-]+)__(.+)$` silently drops `_`/uppercase and cannot
disambiguate `(server=a, tool=b__c)` from `(server=a__b, tool=c)`).

- `mcp-client` `syncTools` stamps on each `ToolDefinition`:
  `mcp?: { readonly server: string; readonly rawName: string }` — the
  bridge's own registration-time identity, executor metadata like
  `timeoutMs` (never model-visible; `projectToolSchema` allowlist pinned
  by regression test).
- **Namespace contract (r2 codex B2 / grok N1 / r3 codex): a public name
  `mcp__<server>__<raw>` decomposes UNIQUELY iff the server segment is
  `__`-free and does not END with `_`, and the raw segment is
  `__`-free.** The excluded case is real:
  `(server=a_, raw=run)` and `(server=a, raw=_run)` both yield
  `mcp__a___run` — segment-internal `__` normalization alone does not
  remove boundary collisions. Three constructor rules in
  `publicToolName`:
  1. normalize `__` to `_` within each segment (alongside the existing
     character normalization);
  2. ANY normalization change — including a `__`-to-`_` rewrite — routes
     through the EXISTING identity-hash suffix path (a raw `evil__run`
     becomes `evil_run_<hash>`, so it cannot collapse onto a genuine
     `evil_run` tool; the hash already disambiguates character
     normalization today);
  3. mount rejects any `serverName` ending with `_` (loud early error;
     server names are config-authored and no known server ends in `_`).
  Under 1+3 the decomposition is provably unique: a collision
  `S+'__'+R = S2+'__'+R2` with both servers valid forces either a
  segment to contain `__` (rule 1) or `S2 = S+'_'` (rule 3). Hashed
  public names keep their server prefix and DO match server-wide rules
  (same server — correct); an exact tool rule matches a hashed name
  only if the user authors the full hashed spelling (r3 codex
  correction of the v3 claim).
- Classification and the annotation fallback resolve the server through
  `definition.mcp.server` (via the executing definition, D4), not through
  the public name.

### D3 — Classification resolution (precedence, per tool)

For an `mcp__*` exec, resolved ONCE in `decideCallVerbose` and carried on
`DecidedCall` as TWO fields (r2 all seats: a single enum cannot express
"skip-only readOnly"):
`mcpClass: 'readOnly' | 'workspaceWrite' | undefined` and
`mcpClassSource: 'settings' | 'curated' | 'annotation' | undefined` —
always co-present (both undefined, or both set).

1. **Settings entry** — `permissions.mcpToolClasses.<server>` (D5):
   present ⇒ replaces the curated entry entirely.
2. **Curated dsh-cc table** — `permission-rules/src/mcp-tool-classes.ts`
   (new). Ships `readOnly` ONLY for serena (§7). The curated table can
   never assert `workspaceWrite` (r1 codex B1: a server *name* is not
   evidence of confinement — the server process, its args and cwd are
   arbitrary (`mcp-config/src/index.ts:30-42`), and locally installed
   serena 2.1.0 permits outside-root symlinks for trusted projects).
   Name-based curated trust is an EXPLICIT accepted decision (r2 codex
   M3): a project-level `.mcp.json` can mount a server *named* `serena`,
   but that server already executes arbitrary code as a process at mount
   and its tools already passthrough-allow in `default` mode today —
   read classification adds no capability a malicious server lacks.
   Hardening server-mount provenance is out of scope (noted follow-up).
3. **Annotation fallback** — `definition.annotations.readOnlyHint ===
   true` ⇒ `mcpClass: 'readOnly'` with source `'annotation'`, ONLY when:
   the section-level `permissions.trustMcpAnnotations === true`
   (default **false**, r1 2-of-3 verdict: server-authored `tools/list`
   must not self-attest into privilege) AND the server has no
   curated/settings entry. Source `'annotation'` NEVER sets `isReadOnly`
   (no plan-mode amplification, r1 grok B3).

`workspaceWrite` (settings only) additionally passes the **D6b protected
screen** before the skip applies.

**Consumption rules (single resolution point):**
- `isReadOnly = deps.readOnlyTools.has(exec.name)
  || (mcpClass === 'readOnly' && mcpClassSource !== 'annotation')`.
- `maybeEscalate` skips arbitration when `mcpClass !== undefined`
  (both `readOnly` origins and `workspaceWrite`).

### D4 — Executing-definition resolution

The resolver looks the definition up through the EXECUTION's own view —
`ctx.tools.get(exec.name, <the execution's scope>, exec.toolSet)` — never
the global view (r1 codex M4: scoped registrations can shadow globals).
Scope/toolSet wiring follows the executor's dispatch resolution; a miss
(when-conditional registration, deferred-but-not-yet-activated, unknown
name) ⇒ unclassified — fail-safe, never throws. The deferred-tool path
registers the definition only on activation
(`mcp-client/src/defer.ts:49-59`); serena (16 tools ≥ threshold 8) IS a
deferred server, so the mechanism test must cover the
activate-then-call sequence explicitly (r1 critic M2).

### D5 — Settings surface and provenance

- New keys on the plugin-local `PermissionSettings` /
  `permissionSettingsSchema()` (`settings-schema.ts`), NOT on the
  CC-shaped `cascade/permissions.ts` `Permissions` interface (r1 grok
  F8: `autoMode` set the precedent — dsh-cc extensions live in the
  plugin-local mirror only):

```jsonc
{
  "permissions": {
    "mcpToolClasses": {
      "serena": { "readOnlyTools": ["find_symbol"], "workspaceWriteTools": ["replace_content"] },
      "untrusted-server": false
    },
    "trustMcpAnnotations": true
  }
}
```

  Schema: `mcpToolClasses: Record<string, { readOnlyTools?: string[];
  workspaceWriteTools?: string[] } | false>` (server keys per D2 contract;
  tool entries are server-local names, no `mcp__` prefix);
  `trustMcpAnnotations: boolean` (default absent = false).
- **Trusted layers only** (r1 codex M3 + grok F5): both keys are
  reassembled exactly like `autoMode`
  (`settings/settings/src/cascade/trusted-scope.ts`
  `reassembleTrustedAutoMode` pattern — user/flag/policy only). A cloned
  repo's project/local layers (`<cwd>/.mcp.json` is itself default
  project-level discovery, `mcp-config/src/paths.ts:53-56`) can neither
  classify tools nor enable annotation trust.
- Schema tests are NEW (r1 codex M6: `settings-idempotence.spec.ts` pins
  double-mount tolerance, not field parity), split by consumer (r2 codex
  m6): the PLUGIN schema validates (`permissionSettingsSchema()` parses
  the D5 matrix; schemastery rejects malformed values; absent values stay
  absent after merge) while the CASCADE schema preserves unknown fields
  untouched — different contracts, tested as such (the cascade spec pins
  passthrough; the plugin spec pins validation).

### D6 — Server-wide permission rules (CC parity) + the protected screen

**(a) Rule matching (PR-1).** Claude Code matches a bare `mcp__<server>`
rule against every `mcp__<server>__*` call. Implementation:

- Unify on the ONE shared matcher: `matchers.ts:15-18` `ruleMatchesTool`
  (exported; consumed by session-allowlist, gauge-allow-evidence,
  task-grant-match, and the guard layer) gains the server-wide form;
  `evaluate.ts:162-165`'s private copy is deleted in favor of the shared
  one (r1 codex M5 / grok F9 — a single matcher keeps the waterfall,
  session grants, and gauge evidence consistent; task grants keep their
  own matcher, below).
- Match rule for `content === undefined` rules: a rule toolName is
  **server-form** iff it starts with `mcp__` AND
  `rule.toolName.split('__').length === 2` (r2 grok N1 / codex M5: with
  `_` in the charset, a 3-segment exact tool name like
  `mcp__serena__find_symbol` must NOT take the prefix branch — the
  segment count is the discriminator, sound because D2's
  both-segments-`__`-free contract makes segment counts well-defined).
  A server-form rule matches
  `call === rule.toolName || call.startsWith(rule.toolName + '__')`.
  Exact tool rules (3 segments) never prefix-match. Hashed public names
  match server-wide rules (same server — correct) and never exact rules.
  Content rules are unchanged.
- `/permissions lint`
  (`packages/interaction/command-permissions/src/lint.ts`, `isKnownTool`
  at :55-57, `unknownTool` at :76-77) treats the `mcp__<server>` form as
  a known tool (currently `unknownTool` noise — r1 codex M5).
- Guard layer: whole-tool bypass-immune rules never fire for calls without
  a subject (`index.ts:408-414` returns early on `subject === undefined`) —
  a pre-existing limitation, documented; the waterfall deny still applies.
- Task grants keep their OWN tool-list matcher
  (`task-grant-match.ts:116-123` `grantAdmitsTool`: exact or dotted
  `prefix.*` entries) — matcher unification does NOT extend server-wide
  rules into task grants (r2 codex; out of scope).
- Auto-mode suspension unchanged (server rules are neither shell nor
  subagent; pinned by a new `auto-rule-filter.spec.ts` case).

**(b) Protected screen (PR-2, r2 codex B1 rewrite).** The v2
substring-over-serialized-JSON screen was unimplementable (the
`protectedFiles` wildcards are anchored whole-string patterns
(`classifier.ts:159-182`) and never match embedded JSON). The v3 screen:

- Runs INSIDE `decideCallVerbose`, in the same resolution step as the
  class (a hit stores `mcpClass === undefined` — no third seam, r2 grok
  N3).
- Recursively collects every string value in the call's arguments and
  tests EACH VALUE with the existing anchored wildcard matcher
  (`protectedMatch`, the same semantics `assessFilePath` uses) against
  the effective `protectedFiles` patterns (defaults at
  `classifier.ts:63-75`, including `.mcp.json`, `.ssh/**`). Per-value
  anchored matching, not substring-over-JSON (r2 codex N-fix). The
  `.dsh/vwa` state guard stays out of the screen (it is a
  file-edit-tool-specific ask guard; `workspaceWrite` classification
  makes no claim of VWA parity — documented divergence).
- A hit ⇒ the classification is dropped AND the decision becomes a
  deterministic `ask` with reason `requires approval: workspaceWrite
  tool arguments match protected pattern <pattern>`, composing like
  `vwaStateGuard` (`decide.ts:186`): a waterfall deny / HIGH risk /
  `bypassPermissions` decision still stands — the screen only replaces
  the classification-skip outcome, never a deny (r3 grok). A session
  grant may convert the ask to allow (`decide.ts:223-225`) — existing
  CC-consistent ask semantics, stated rather than hidden (r3 codex).
  This is deliberately an ASK, not the built-in HIGH deny: MCP arguments
  are not validated paths, and a fuzzy match must not hard-deny
  irrecoverably.
- **Guarantee scope, stated honestly (r3 codex): the screen detects
  protected patterns in argument STRING VALUES.** Project-wide
  classified writes that never name their targets (`rename_symbol`,
  `replace_in_files`) are NOT covered — an explicitly accepted residual
  risk that the deployment author signs off by configuring
  `workspaceWriteTools` at all. This is not full protected-policy parity
  with built-in edits (deny), and does not claim to be.
- False positives merely restore arbitration-equivalent prompting; the
  screen is deliberately conservative.

### D7 — Explicitly not shipped

- The `DEFAULT_ENVIRONMENT` MCP sentence (P-1) and gauge-state description
  injection (P-2).
- Curated `workspaceWrite` (D3 rationale).
- Default-ON annotation trust (D3).
- Per-call path containment beyond the D6b screen.
- Server-wide `'always'`-answer derivation in the TUI approval preview.

## 4. PR split

- **PR-1 (independent): D6a** — shared-matcher unification + server-wide
  matching + the `__` server-name ban in mcp-client + lint + tests +
  capability manifest + parity docs.
- **PR-2 (independent of PR-1; both touch manifest/parity docs so the
  later PR rebases): D1-D5, D6b** — stamped metadata + `annotations`
  (`ToolDefinition`, mcp-client, model-invisibility regression),
  `DecidedCall.mcpClass`, the two consumption seams, curated readOnly
  serena table, plugin-local schema + trusted-scope reassembly,
  `trustMcpAnnotations`, workspaceWrite opt-in + protected screen,
  probe script + results JSON, tests, manifest + parity docs.

## 5. Verification plan

Unit and mechanism tests:

- Resolver precedence matrix: settings > curated > (opt-in) annotation >
  unclassified; `false` disables; `{}` replaces curated with nothing;
  conflict ⇒ unclassified; curated table never yields `workspaceWrite`.
- `DecidedCall` wiring: curated/settings `readOnly` ⇒ `isReadOnly ===
  true`; annotation `readOnly` ⇒ `isReadOnly === false` but skip;
  `workspaceWrite` ⇒ `isReadOnly === false`, `maybeEscalate` returns
  `undefined`, `mapPostWaterfall` + `next()` ⇒ allow (assert the final
  execution outcome, not just "gauge not called" — r1 codex).
- Plan mode: classified `readOnly` allowed; `workspaceWrite` still wrapped.
- Deny/ask rules still win over both classes.
- Annotation path: `trustMcpAnnotations` absent ⇒ annotation ignored;
  ON ⇒ gauge-skip but `isReadOnly === false` (plan mode still denies).
- Mechanism (fake cordis ctx + `ctx.tools.register` of a fake MCP tool):
  definition resolved through the execution's scope/toolSet; a scoped
  shadow does not inherit a global `readOnlyHint`; deferred
  register-then-activate returns the stamped definition; `when`-gated miss
  ⇒ unclassified.
- D6a: `mcp__serena` matches `mcp__serena__find_symbol`; exact rule
  `mcp__serena__find_symbol` does NOT prefix-match
  `mcp__serena__find_symbol__anything` (segment-count discriminator);
  `(server=a_, raw=run)` is unmountable (trailing-`_` rejection) so it
  cannot collide with `(server=a, raw=_run)`; a raw `evil__run`
  normalizes to `evil_run_<hash>` (identity-hash path — cannot collapse
  onto a genuine `evil_run`); a server `serena` mounting a raw tool
  `evil__run` is therefore NOT matched by an exact `evil_run` rule and IS
  covered by a `mcp__serena` rule via its hashed prefix; charset
  `_`/`A-Z`; session-allow / gauge-evidence matching follows; lint
  accepts the form; auto-rule-filter no-suspension pin.
- D6b: a `.mcp.json` string argument value ⇒ deterministic protected ask
  (not the classification skip; a waterfall deny still stands) with
  `mcpClass === undefined`; clean in-workspace path strings ⇒ skip.
- Schema: the plugin schema validates the D5 matrix; the cascade schema
  pins unknown-field passthrough; trusted-scope reassembly drops
  project/local `mcpToolClasses` and `trustMcpAnnotations`.
- `projectToolSchema` does not emit `mcp`/`annotations` (regression).

Gates: `tsc -b --force`, package vitest, `check:size`, `check:capabilities`,
`check:parity`, `pnpm docs:parity`, `node scripts/check-readme.mjs --write`,
`check-spec-deps`.

Live acceptance (post-merge): fresh auto-mode session with serena mounted —
a subagent `mcp__serena__find_symbol` and `mcp__serena__search_for_pattern`
complete without an ask; with user-layer
`mcpToolClasses.serena.workspaceWriteTools` set, a subagent
`mcp__serena__replace_content` completes without an ask while an args-
carrying `.mcp.json` target hits the deterministic protected ask;
`permissions.allow: ["mcp__serena"]` allows an unclassified serena tool
call in auto mode.

## 6. Review-ledger notes on serena confinement

Serena's project-root confinement is real but not absolute (upstream
allows outside-root symlinks for trusted projects; the local install is
2.1.0). That is exactly why `workspaceWrite` is an explicit deployment
assertion (trusted-layers settings), never a dsh-cc default, and always
behind the D6b protected screen.

## 7. Curated serena table (live-pinned 2026-11-15; `readOnly` only)

Server `serena`. Tool names are the server-local segment.

`readOnly`: `initial_instructions`, `find_symbol`,
`find_referencing_symbols`, `find_declaration`, `find_implementations`,
`get_symbols_overview`, `get_diagnostics_for_file`,
`search_for_pattern`, `list_mcp_resources`, `read_mcp_resource`

Deliberately unclassified: `restart_language_server` (process side
effect), and every write tool (`insert_before_symbol`,
`insert_after_symbol`, `replace_symbol_body`, `replace_content`,
`replace_in_files`, `safe_delete_symbol`, `rename_symbol`) — releasable
only by explicit trusted-layer `workspaceWriteTools` configuration.
Absent tools fail-safe unclassified (r1 grok F6: `search_for_pattern`
was missing from v1 — the repo's own executor contract dispatches it).

## 8. Open questions resolved (r1)

- Q1 annotation fallback: **opt-in** (`trustMcpAnnotations`, default off;
  gauge-skip only, never `isReadOnly`). [codex+grok over critic; the
  plan-mode amplification argument is dispositive]
- Q2 placement: **section-level plugin-local** `mcpToolClasses` +
  trusted-scope reassembly. [all three]
- Q3 PI probe: **unchanged** — `workspaceWrite` results are exactly the
  untrusted text it exists to scan. [all three]

## 9. Review ledger

### r1 (2026-11-15, three blind seats)

- critic: GO-WITH-CHANGES (4 Major, 5 Minor) — M1 name-parsing → stamped
  metadata (folded D2); M2 deferred-registration claim corrected (folded
  D4 + tests); M3 confinement unpinned (folded: curated workspaceWrite
  cut, §6); M4 probe script uncommitted (folded §2); m1 DecidedCall field
  (folded D3); m2 plugin-local mirror precedent (folded D5); m3 D6
  prefix semantics (folded D6a); m4 `__trustAnnotations` collision
  (folded: sibling boolean); m5 write-tool live acceptance (folded §5).
- codex: NO-GO (2 Blocker, 4 Major, minor set) — B1 curated write trust
  unsound (folded D3/D6b/§6); B2 prefix crosses identities (folded D2
  + D6a); M3 provenance (folded D5 trusted-scope); M4 scoped resolution
  (folded D4); M5 matcher unification + lint (folded D6a); M6 schema
  tests (folded D5); m7 semantics tightened (folded D1).
- grok: GO-WITH-CHANGES (1 Blocker, 6 Major, 3 Minor) — F3 annotation
  plan-mode amplification (folded D3); F1 DecidedCall (folded); F4
  charset/identity (folded D2); F5 trusted-scope (folded D5); F6 missing
  `search_for_pattern` (folded §7); F8 wrong mirror + overstated
  idempotence pin (folded D5); F9 matcher twin (folded D6a); F7 overlap
  rule (folded D1); F11 cut annotation plumbing — REJECTED in part:
  the plumbing is required by the opt-in fallback we keep; F2 outer
  prepend listeners — noted in D1 (classification is not a global allow;
  same as built-in read-only tools).

### r2 (2026-11-15, delta round; critic GO, grok NO-GO, codex NO-GO)

- critic GO (all 9 findings RESOLVED; residual: mcpClass data shape —
  folded as the class+source two-field shape in D3).
- grok NO-GO — F3 annotation vs isReadOnly single-field contradiction
  (folded D3 two-field shape); N1 server-form regex matched 3-segment
  exact tool names (folded D6a segment-count discriminator); N2 the
  `evil__run` negative test was wrong (folded §5 — such a public name IS
  matched by `mcp__serena`, correctly); N3 D6b third seam (folded —
  screen runs inside decideCallVerbose, hit ⇒ mcpClass undefined); N4
  vwa/protected mixing (folded — vwa stays out, divergence documented);
  N5 lint line numbers (cosmetic).
- codex NO-GO — B1 D6b unimplementable + parity claim (folded: per-value
  anchored matching, deterministic ask, honest non-parity statement);
  B2 `a`/`a_`/`ax` identity collisions + hashed names + invalid negative
  test (folded D2 both-segments normalization + D6a re-claim); M3 curated
  readOnly provenance (folded: explicit accepted name-trust decision with
  the malicious-server-is-already-arbitrary-code argument); M5 predicate
  broadens exact rules (folded segment count); task-grant scope corrected;
  m6 schema-test framing (folded: plugin validates / cascade preserves);
  M8 data shape (folded two-field).

### r3 (2026-11-15, micro-confirm; grok GO, codex NO-GO on 2 items)

- grok GO — all items RESOLVED; cosmetic leftovers (D1 bullet wording,
  live-acceptance phrasing, deny-compose sentence, lint path) folded
  into v4.
- codex NO-GO — item 1 identity: the `a_`/`_run` boundary collision
  (folded v4 D2: trailing-`_` server-name mount rejection completing
  the uniqueness proof; `__`-normalization routed through the existing
  identity-hash path so `evil__run` cannot collapse onto `evil_run`;
  hashed-name exact-rule claim corrected); item 2 protected screen
  overclaim (folded v4 D6b: guarantee explicitly narrowed to argument
  string values, project-wide uncovered writes documented as the
  accepted residual risk of configuring the class at all, ask composes
  below deny/HIGH/bypass, session-grant conversion stated); §5 ax/a_
  test example replaced with the real collision pair; hashed-path test
  row added.

### r4 (2026-11-15, final single-question confirm, codex seat)

- codex GO — item 1 identity RESOLVED (boundary collisions addressed,
  normalization hashing preserved, server-wide vs exact hashed-name
  rules distinguished); item 2 protected screen RESOLVED (guarantee
  narrowed to argument string values, uncovered writes accepted, deny/
  HIGH/bypass preserved, session-grant conversion stated).

**Converged: critic GO (r2), grok GO (r3), codex GO (r4).**