# Permission grant synthesis + rule hygiene

- Date: 2026-09-23
- Status: approved (critic round 2: approve-with-changes, all edits applied)
- Worktree branch: `worktree-permission-per-tool-capability-grants`

## Background

Design question: should dsh-cc move from command-string rules to a per-tool
capability-grant model? Two independent blind reviews (critic + Codex)
converged: **no**. The engine is already per-tool (`PermissionRule{toolName,
content?, matcher, behavior, source}`; prefix/wildcard/domain matchers; 8
source tiers). The pain is in **grant synthesis** (what gets persisted on
"always allow") and **rule hygiene** (no dedup beyond exact string, no GC, no
management surface). This plan fixes those without touching the CC-compatible
rule format or evaluation semantics.

## Verified defects to fix

1. **Env-prefix mismatch** (`approval-preview.ts allowRuleOf` vs
   `matchers.ts subjectOf`): synthesis strips `FOO=bar` / `sudo ` / `npx ` /
   `yarn ` before deriving the first-word prefix rule, but evaluation matches
   the **raw** command — `FOO=bar npm install` persists `Bash(npm )`, which
   never matches the producing call.
2. **WebFetch silent broadening**: synthesis parses the **display preview**
   (only the `args` preview kind is truncated, 500-char slice,
   `approval-preview.ts:67,75`; the Bash `command` preview is already full),
   and falls back to whole-tool `WebFetch` on parse failure — narrow intent
   becomes a broad permanent grant (current tests
   `approval-preview.spec.ts:~157-166` assert this fallback; deliberate
   behavior change).
3. **No write-time hygiene** (`driver-approvals.ts writeAllowRule`): only
   exact-string dedup; covered narrower rules pile up forever.
4. **No rule management surface**: `/permissions` reports counts only.

## Non-goals (explicitly NOT building)

- No capability schema / second persisted permission model / second
  precedence system.
- No change to rule-string format or evaluation order (parity surface).
- No auto-expiry / unattended deletion of persisted rules.
- No cross-tool-spelling subsumption, no wildcard minimizer — prefix-vs-prefix
  and exact duplicates only (provably decision-preserving).

## Key design constraint discovered in review (BLOCKER fix)

`settings.replace(ns, section)` persists by diffing the **merged** section
against the shadow and applying whole-array leaf ops onto the **user file**
(`settings-cascade/src/index.ts:265-350`). Writing a merged-minus-removals
allow array **smears higher-layer rules into `~/.dsh/settings.json`** (and
desyncs the shadow). All removal paths (write-time dedup, `/permissions lint
--apply`) MUST therefore edit the **raw user layer** through a new
cascade seam (step 2), never via `describe().user` + `replace`.

## Changes by file (in order)

### 1. `packages/interaction/permission-rules/src/subsumption.ts` (new, pure, browser-safe)

- `parseRuleSafe(rule: string, behavior, source): { toolName, content?, matcher? } | undefined`
  — parse or undefined (never throws; for linting untrusted persisted
  strings). Returns the parser shape; behavior/source are caller-supplied
  context, NOT derived from the string.
- `contentSubsumes(a: ContentMatcher, b: ContentMatcher): boolean` —
  conservative: prefix A subsumes prefix B iff `B.startsWith(A)`; equal
  wildcard/domain values subsume; else false. Compares **unescaped matcher
  values** (post-`unescapeRuleContent`), never raw rule strings, or
  escaped-content pairs silently fail to dedup. Whole-tool (no content) does
  NOT subsume content rules: content rules evaluate before whole-tool rules
  (`evaluate.ts:116-133`), so removing a content allow under a whole-tool
  allow can flip a decision.
- `ruleSubsumes(a, b): boolean` — requires **equal behavior AND equal source
  AND equal toolName (exact authored spelling; alias-folding is a non-goal)**
  && both content rules && contentSubsumes. (Without behavior equality an
  allow would "subsume" a deny and deletion would flip decisions.)
- Subsumption soundness (verified in review): under per-source
  allow→deny→ask first-match evaluation, deleting allow B covered by
  same-source same-behavior allow A is decision-preserving. Legacy
  `Bash(grep:*)` parses to prefix `grep:` and is subsumed by `Bash(grep)`.
- Export from `index.ts`. Tests: `tests/subsumption.spec.ts`.

### 2. `packages/settings/settings-cascade` — raw user-layer edit seam (new API)

- New method on the cascade provider, e.g.
  `editUserSection(ns, edit: (rawSection) => rawSection | undefined): Promise<void>`:
  reads the **raw user file** (`documentPath`, `index.ts:228`), applies the
  edit to that file's own section for `ns`, writes atomically
  (`writeJsonAtomic` + optimistic re-read retry, mirroring `persistSection`),
  then republishes the re-merged document (`publish(await load())`) so the
  in-memory merged view and shadow stay consistent. Runs inside the existing
  exclusive `operations` queue so it serializes with watcher reloads.
- `editUserSection(ns, edit)` semantics: `edit` returning `undefined` =
  no-op (return without write). On optimistic retry the edit callback is
  re-applied to the FRESH root (edits may be non-idempotent).
- Known interplay (documented, not blocking): `persist()` freezes its diff
  base at capture time; an `editUserSection` landing between a persist's
  capture and execution leaves that persist diffing a stale base — a
  `replace()` whose section was derived pre-edit can resurrect a just-deleted
  user rule. Same class as the existing watcher/reload interplay.
- Degrades loud (throws) when no userSettings source is configured
  (`documentPath` already throws).
- Tests: `settings-cascade/tests/edit-user-section.spec.ts` — edit lands only
  in the user file, project-layer entries are NOT smeared, merged view
  republished, concurrent-edit retry, queue serialization with reload.

### 3. `packages/ui/tui/src/harness/approval-preview.ts` (+ `driver-approvals.ts`, `driver-modal.ts`)

- **Untruncated args for synthesis (WebFetch-only fix)**: capture the restored
  args on the `ApprovalEntry` at push time (`driver-approvals.ts:79-86`;
  `driver-modal.ts` ~126 lines has headroom); `answerApproval` already holds
  the entry. Do NOT extend `ModalAnswerDeps`/deps construction in `driver.ts`
  (exactly 500 lines, at the `check:size` hard cap). Display preview stays
  truncated. Do not widen the store `ApprovalView`.
- **Bash verify-match with raw-prefix fallback** (CC behavior): derive the
  stripped first-word rule as today, then verify it content-matches the RAW
  command (`parseRuleString` + `contentMatches`). On mismatch (env prefixes,
  stripped wrappers), fall back to the raw prefix = the original command
  sliced from offset 0 through the end of the stripped first word, plus a
  trailing space (`sudo FOO=bar npm x` becomes `Bash(sudo FOO=bar npm )`),
  which matches by construction (subject is the raw command, `matchers.ts:35`;
  prefix match is `startsWith`, `parser.ts:167`). Return underivable only
  when nothing usable remains (blank).
- **WebFetch**: hostname from the untruncated args; on unparseable/missing
  URL return underivable — NO whole-tool persistent fallback.
- **Tagged result** so callers distinguish deliberate-never-persist
  (EnterWorktree, `approval-preview.ts:125` — CC v2.1.206 parity) from
  underivable: e.g. `{kind:'rule'|'never-persist'|'underivable'}`.
- **Notices live inside `writeAllowRule`/`addSessionRule`** (one place covers
  both always and session): underivable → "could not derive a safe persistent
  rule — allowed once"; never-persist → silent (today's behavior).
- **Invariant test** (new, `approval-preview.spec.ts`): corpus of
  (toolName, args) pairs — every derived rule matches its producing call via
  parser+matcher semantics. Update the WebFetch whole-tool fallback
  assertions (~:157-166) AND the env/sudo/npx/compound assertions
  (~:180-195) — under verify-match+fallback those now yield raw-prefix rules
  like `Bash(FOO=bar npm )`.

### 4. `packages/ui/tui/src/harness/driver-approvals.ts` `writeAllowRule` dedup

- Use step 2's `editUserSection` on the **raw** user `allow` list: drop
  entries subsumed by the new rule (same tool/behavior/source); skip the
  write when an existing entry already subsumes it (`Already covered by
  <rule>` notice). Notice reports replacements: `Always allow: Bash(git ) —
  replaced N narrower rules`.
- Keep the existing degrade-to-notice behavior when the provider/seam is
  absent. Tests in `approval-preview.spec.ts` merge suite.

### 5. `packages/interaction/command-permissions` — `/permissions lint` (new `src/lint.ts`)

- **Probe first**: verify the preset command ctx can reach
  `ctx.get('settings')` and `ctx.get('permissionRules')` from the command
  plane; on absence degrade with the existing friendly-message pattern.
- Data seams: cross-source **report** from the permission engine's rule set
  (rules carry `.source`); **apply** via step 2's `editUserSection` (user
  layer only — project/policy/session layers are never written).
- Report, grouped by source/behavior/tool: malformed rules (parse throws),
  exact duplicates, prefix-subsumed rules (same source+behavior only), bare
  whole-tool `Bash` allow (flagged broad), unknown tool names (known names
  via `ccToolAliases` from `@dsh-cc/tools`).
- `/permissions lint` is read-only and prints a proposed before/after diff;
  `--apply` performs it. New module `src/lint.ts` keeps `index.ts` (194
  lines) under the 500-line `check:size` cap.
- Tests: `command-permissions.spec.ts` additions per finding class; apply
  mutates only the user layer.

### 6. Capability manifest + parity docs

- `docs/claude-code-capabilities.yaml`:
  - `permissions.rules` row: deviation summary — verified-matching synthesis,
    no silent whole-tool WebFetch broadening, write-time subsumption dedup;
    new evidence anchors.
  - `commands.permissions` row: lint extension in
    `dimensions.behavioral.notes` + evidence (kind stays `none`).
  - settings-cascade seam: note under the settings hot-reload row (packages/
    settings/** is manifest-gated).
- Validator rules: lexicographic order in category; `ux: full` requires
  `behavioral: full`. Run `pnpm docs:parity`; commit regenerated
  matrix/README/capabilities.json.

### 7. 存量清理 runbook（用户本机 `~/.dsh/settings.json`，非仓库交付物）

1. 备份：`cp ~/.dsh/settings.json ~/.dsh/settings.json.bak-2026-09-23`。
2. `/permissions lint` 产出清理提案：预期被 `Bash(grep:*)`、`Bash(find:*)`、
   `Bash(git:*)`、`Bash(python3:*)` 等包含的精确命令规则；legacy 转义残影
   （`\\;` 形式）；畸形/未知工具规则。
3. 人工过目 diff 后 `--apply`（只动 user 层，经 step 2 seam）。
4. 验证：settings 热加载（PR #127）下一次 decide 即生效；跑几条此前靠
   精确规则放行的命令（grep/find/git）确认不再弹审批。

## Execution order / delegation

1. executor: step 1 (subsumption helpers + tests).
2. executor: step 2 (cascade editUserSection seam + tests).
3. executor: steps 3+4 (TUI synthesis + write-time dedup; depends on 1, 2).
4. executor: step 5 (/permissions lint; depends on 1, 2).
5. orchestrator: step 6 (manifest + docs:parity + gates), commit(s), PR.
6. orchestrator + user: step 7 (存量清理; needs user confirmation + sandbox
   escalation for `~/.dsh`).

Steps 1+2 are independent and can run as parallel executors; 3 and 4 follow.

## Verification (planned up front)

- Behavior: derived grants always match the producing call; no silent
  broadening; user allow list shrinks on broader grant without smearing
  other layers; lint reports accurate, apply is user-layer-only.
- How driven: unit tests —
  `node_modules/.bin/vitest run` from repo root with path filters
  (permission-rules, settings-cascade, tui approval-preview/driver-approvals,
  command-permissions). `pnpm -F <pkg> test` is a no-op in this repo.
- Gates: `node_modules/.bin/tsc -b tsconfig.packages.json`,
  `pnpm check:capabilities`, `pnpm check:parity`, `pnpm check:spec-deps`,
  `pnpm check:size` (hard 500-line cap; driver.ts is at exactly 500/500 and
  driver-types.ts at 485/500 — do not grow driver.ts), `pnpm check:exports` (needs
  `pnpm bundle:client` first for command-permissions `lib/client.js`).
- Pass criteria: all gates green; step 7 smoke shows no re-prompt for
  previously-ruled commands.
- Env gotchas: fresh worktree → `pnpm install --frozen-lockfile` first; git
  writes from a worktree need danger-full-access escalation (orchestrator
  commits, not executors); commit via `git commit -F <unique-file>` (verify
  `head -1` first — stale /tmp message files are a known incident class);
  explicit-path `git add` only, never `git add -A`.
