# Auto-mode Claude-Code parity program

**Status**: **Implemented** — merged 2026-09-23 via the stacked PR stream #121 (this doc) → #122 (S1) → #124 (S2) → #125 (S3) → #126 (S7) → #127 (S4) → #129 (S5) → #130 (S6); presubmit green on every step including the final main-push run. Two blind-review rounds (critic + Codex parallel, then critic delta) — amendments A1–A16 below. Per-slice rebase conflicts with the S1 file-size extractions were resolved while preserving behavior (579/614/644/657/674-test green at each landing).

**Date**: 2026-09-23

**Context**: Anthropic's [auto mode engineering post](https://www.anthropic.com/engineering/claude-code-auto-mode) (2026-03-25) plus the shipped CC docs ([permission-modes](https://code.claude.com/docs/en/permission-modes), [auto-mode-config](https://code.claude.com/docs/en/auto-mode-config)) describe a materially deeper auto mode than dsh-cc's current LLM risk classifier (PRs #117/#122/#123; design doc `docs/plans/2026-09-05-llm-risk-classifier.md`). This document is the implementation contract for closing the gap.

**Product decisions ratified by the user (2026-09-23), not reopenable in review**:

- **Hybrid verdict space**: classifier `deny` exists only with a cited `hard_deny` rule; `soft_deny` matches escalate to `ask`. Denials return in-band with a good-faith instruction; 3-consecutive / 20-total backstop.
- **All three P2 items in scope**: PI probe, subagent handoffs, full-text audit.

## 1. Current state (verified anchors)

The decision pipeline per call (`packages/interaction/permission-rules/`):

1. `decide.ts:79-95` — deterministic risk heuristic, gated by `classifierEnabled` (settings-schema.ts:150, default `true`; wired index.ts:208). Bash: HIGH iff `DEFAULT_DANGEROUS_PATTERNS` matches, else LOW — **no MEDIUM tier** (`classifier.ts:73-84`). File writes: HIGH protected-match, MEDIUM cwd-escape, else LOW (`classifier.ts:94-109`).
2. `decide.ts:113-135` — HIGH ⇒ deny in every mode; **MEDIUM short-circuits to `ask` BEFORE the rule waterfall** (`sessionAllowMatches` consulted only here, decide.ts:128 — the sole call site; session grants never apply to rule-asks today).
3. `evaluate.ts:63-140` — waterfall. Order: bypass-immune deny → whole-tool deny → bypass short-circuit → whole-tool ask (sandbox-bash exempt) → content rules **source outer, behavior inner `['allow','deny','ask']`** (:116-121 — same-source allow beats deny, "F2") → mode allows → whole-tool allow → `passthrough`. Plan wrap: leftover ask/passthrough on non-read-only ⇒ deny (:71-74). NOTE: the module doc's "backs the host UI's rule preview" claim is stale — no live consumer besides decide.ts exists (review A12; clean up in S1).
4. Auto proxy — **F1**: `decide.ts:164-166` converts LOW+`ask` ⇒ `allow` in auto mode, including explicit ask rules; the live listener duplicates it inline at `index.ts:288`. `passthrough` is never proxied (falls to `next()` ⇒ downstream allow).
5. LLM stage (`auto-stage.ts`): eligibility = auto + LOW + (`ask`|`passthrough`) + not read-only (:319-325); verdicts `{allow, ask}` (escalate-only); input = bare tool call, no user messages / tool results; input "4 KiB cap" applies to the PAYLOAD only, before the tool-name + fence wrapper is added (`llm-classifier.ts:130-156`) — anchors must read "payload-capped, wrapper uncapped". One-shot call; fail-open error/timeout/malformed ⇒ `ask`; per-route breaker (3 consecutive) with session-log seeding (:266-285).
6. Delivery paths (reuse, unchanged): deny ⇒ error tool result to the model, turn continues (`packages/core/tools/src/runtime-execute.ts:181-193`); ask ⇒ approval seam (`runtime-code.ts:106-147`); no approval service ⇒ deny `"requires approval (not yet supported)"` (:112-117).
7. Settings: `permissions.autoMode` section; schema declared in TWO mirrored sites — `packages/settings/settings-cascade/src/auto-mode.ts` (schemastery, absence-preserving unions) and hand-mirrors in `permission-rules/src/auto-stage.ts:22-44`. Any key change touches BOTH sites plus assertions in the same commit.
8. Slash commands: cordis `commands.register(helpable(...))` (precedent `@dsh-cc/command-cost`, its src/index.ts:51-56), preset row in `packages/preset/cc/agent.cordis.yml` + preset package.json dep; `CommandResult.text` renders as a status row. `/permissions` already sets auto (`command-permissions/src/modes.ts:10-12`).
9. Post-execute seam: `tools/post-execute` waterfall (`packages/core/tools/src/index.ts:145`; `runtime-results.ts:52-90`): `accept` may replace `content` and/or attach `additionalContexts`. Precedents: context-crusher (prepend-order listener, replaces content), edit-recovery-hint (additionalContexts sideband), hooks-claude-code PostToolUse replacement (register-events.ts:129,174-179 — applies only when the downstream fold is a plain accept WITHOUT content).
10. Session log: `session.snapshotEvents()`; user messages are `user/message` events, `data.content` text blocks, `data.source.kind` distinguishes human vs plugin injection (mode.ts:215-222 injects mode announcements AS user/source-kind-plugin messages — a taint vector, see D7). Registration idiom `(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(TYPE)` (mode.ts:21-29, auto-stage.ts:52-54).
11. CC `Task` rule spelling maps to harness `subagent`/`subagent_fork` (cc-names.ts:74). `PowerShell`/`pwsh` has NO alias entry (cc-names.ts:60,200) — predicates must match authored spellings literally, not via `ccToolAliases` (review A9).
12. **No headless/`-p` path exists** (cc-tui is TUI-only) — CC's headless behaviors are N/A, recorded as such.
13. Capability-manifest invariants I3/I4/I7 live in `docs/plans/2026-09-03-claude-code-capability-manifest.md`, enforced by `scripts/check-capability-evidence.mjs` (review A8 corrected the citation).

Also verified (#123): maxTokens 1024, timeoutMs default 8000, `cancelled` excluded from breaker counts, `DSH_PERMISSION_CLASSIFIER_DEBUG=1` raw channel, breaker TUI notice. Do not regress.

## 2. Design decisions (D1–D13)

- **D1 — Stateless evaluation-time rule suspension.** Rules flow live through the `rules()` closure (decide.ts:142), so in auto mode a pure filter drops broad allow rules at evaluation time. No drop/restore state machine. Verdict parity with CC's enter/exit mechanism without its restore-failure surface. The filter is exposed ONCE via a service-level `effectiveRuleSet(mode)` seam (A7): the listener, `/permissions` display, and any future preview all consume the same seam (in auto, suspended rules are listed as "suspended in auto mode", not silently hidden).
- **D2 — Deny-first content ordering (F2), cross-mode.** Pinned full waterfall order (delta-review Finding 7 — no ambiguity): bypass-immune deny → whole-tool deny → bypass short-circuit → **content deny** → whole-tool ask (sandbox-bash exempt) → **content ask** → **content allow** → mode allows → whole-tool allow → passthrough. Within content rules: behavior outer in that order, sources inner, declaration order preserved within behavior+source. A sandbox-exempt bash call matching a content deny now DENIES (deliberate — deny wins; test added). Applies in every mode, not just auto: userSettings-deny now beats config-allow etc. Flipped existing expectations are enumerated in S1's test list. Session consent is NOT a source-ranked rule — it flows solely through `SessionAllowlist` (verified: decide.ts:128 sole call site); D2 text must not imply otherwise (A5). Grant application sites after this program: (a) MEDIUM+passthrough (status quo), (b) rule-derived asks in any non-plan mode (NEW — without it, F1's restored prompts make "allow for this session" a dead button for rule-asks; matches the grant's evident intent).
- **D3 — F1 removal.** Delete both copies of the LOW+ask→allow proxy. Auto+rule-ask ⇒ prompt (CC: ask rules fall to a prompt). LLM stage stops arbitrating rule-derived asks; eligibility becomes passthrough-class only (see S1/S3 for the MEDIUM arm).
- **D4 — Hybrid deny, structurally enforced.** `deny` verdict requires `rule` = exact string match against an expanded `hard_deny` entry; otherwise downgrade to `ask` (reason records the downgrade). Evaluation ORDER taught in the prompt: hard_deny checked first, then soft_deny, then allow exceptions — allow exceptions NEVER soften a hard_deny match (this resolves the credential-flow contradiction from review A10/C6). Caveat admitted on purpose: citation proves rule identity, not applicability — matching remains model-judged, same residual-risk posture CC documents; near-miss tests (whitespace/case/unicode-quote variants) pin the exact-match behavior.
- **D5 — Backstop, honest semantics (A2/A6 amended).** Audit events gain `callId` and `rule`; `reason` added under D10's cap. Consecutive-deny streak = consecutive `permission/classifier` events with `verdict:'deny'`, reset by any subsequent REAL classifier non-deny verdict — i.e. only events with `failure === undefined` reset; synthetic `unarmed`/`breaker` records (they carry `verdict:'ask'` with no classification behind them) NEVER reset the streak (delta Finding 5: otherwise the streak fails open toward autonomy). Total-deny counter = cumulative per session. Thresholds 3 / 20 (module constants). Trip: inject a PARAMETERIZED notice (origin text "auto mode paused: classifier denial threshold reached", never the "changed by the user" template — mode.ts:215's message gets an origin parameter) + `setMode(agent, 'default')` (mode.ts:182-223 reviewed: no plan conflict, injection is try/catch-wrapped). Deviation recorded: CC pauses-then-resumes after approval; dsh-cc requires manual re-entry (`/permissions auto`), counters reset on re-entry. Counter folds use the seed-once idiom of `seedBreakerFromLog`, not a per-verdict full scan.
- **D6 — Deny-and-continue.** Denials ride the existing deny→error-tool-result delivery; reason is wrapped with a good-faith boundary instruction (prose re-expression, never verbatim CC text — R2).
- **D7 — Transcript window v2 (A3/A9 amended).** Classifier input = bounded `<user_intent>` + `<tool_history>` + `<project_instructions>` + optional `<context>` (enrichment) + `<tool_call>`. Rules: only human-origin `user/message` events (`source.kind === 'user'`; plugin injections filtered — kills the trip-notice feedback loop AND pre-existing taint); ALWAYS keep the first human message (the original task anchor) plus the last 4 (evicting the middle, so a 5-message window can't evict the authorization boundary); per-message cap 400 chars. Tool history: last 10 non-read-only tool calls (name + first 120 chars of subject) folded from session events. Project instructions: session-cwd `AGENTS.md`/`CLAUDE.md` content ≤1024 chars, read once per stage instance (fail-open omit; rebuild picks up changes). Budgets: total assembled input hard-capped at 8192 chars; tool_call payload keeps its 4096 payload cap (codex A-minor: cap/test the FINAL string too).
- **D8 — PI probe (S7), parity scope (A11 amended).** Default scan set = text-carrying results of `read`, `bash`, `web_fetch`, `web_search`, and `mcp__*` tools (CC scans exactly these classes; narrower defaults would leave the classic "malicious content in repo files" vector open). `toolPatterns` overrides the set entirely. Runs only when effective mode is `auto`; enabled by default, cost documented. Probe `reason` capped at 120 chars in audit+warning (secret-echo mitigation). Fail-open + own breaker.
- **D9 — Subagent handoffs (S6), re-sequenced after S7.** Outbound: structural (S1 suspends Task/Agent allow rules → spawns get classified with transcript intent from S3) + prompt-field-first rendering. Return: two-arm — (a) when the child session is resolvable, fold its `permission/classifier` audit (deny/breaker/≥5 asks ⇒ warn); (b) ALWAYS screen the returned final-report text through the S7 probe machinery (a clean-countered but compromised report is the case counters can't see, per Codex #12). Both arms warn via `additionalContexts`; results are never discarded. HARD GATE: a red test proving child-session resolution (registry/ledger seam) BEFORE the listener is written; if the seam doesn't exist, arm (a) ships disabled-by-assertion with the test pinning the no-op, arm (b) still delivers value. Child sessions' own permission-mode behavior is out of scope (observed questions recorded, not redesigned here).
- **D10 — Audit truth.** Classifier/probe audit events stay digest-only by default; `classifier.auditFullText` (S5) adds raw input. `reason` (≤120 chars, control-chars stripped at write) added unconditionally — digest-only only ever protected the input; without reasons no review surface is possible.
- **D11 — Enabled-but-unavailable ⇒ fail-to-prompt (Codex #1, partial; delta Finding 4).** When `classifier.enabled === true` but the stage is unarmable/route-missing/breaker-open, stage-ELIGIBLE calls (passthrough class) return `ask` with an availability reason instead of the legacy `next()` ⇒ allow. When `enabled !== true`, the classifier machinery is simply absent from the pipeline and post-S1 auto mode means **strict-rule auto**: matched ask rules prompt (D3's ratified fix), MEDIUM+passthrough asks, unmatched LOW is allowed downstream. Opt-in arming (classifier absent unless enabled) is a deliberate recorded deviation from CC's always-on classifier.
- **D12 — Trusted-scope autoMode (Codex #2).** The `permissions.autoMode` section is consumed ONLY from trusted scopes (user / managed / flag / CLI-arg layers); project and local (repo-carried) layers are ignored for autoMode — a cloned repo must not rewrite classifier policy. Implemented as a scoped-section read in settings-cascade (S2), with precedence tests per source. Deviation-vs-CC: CC excludes project/local too; we match intent.
- **D13 — secondPass stays default-OFF (disagreement with Codex #10, deliberate).** CC's stage-1 is a single-token filter; ours already emits reasoned JSON (1024 maxTokens) — the designs aren't homologous, and without an offline corpus (R4) defaulting an ask→allow flip lane would manufacture FNR we can't measure. Deviation recorded; revisit after S5 observability ships.

### Fail-open direction table

| Component failure | Behavior | Why |
| --- | --- | --- |
| classifier disabled (`enabled!==true`) | strict-rule auto: rule-asks prompt, MEDIUM+passthrough asks, unmatched LOW downstream-allows (D11) | opt-in arming deviation; no legacy proxy remains after D3 |
| classifier enabled but unarmable / route missing / breaker open | stage-eligible calls ⇒ `ask` (D11) — never silent allow | outage degrades to prompts, not autonomy |
| classifier error/timeout/malformed | `ask` + breaker accounting (existing) | never silent-allow a gated call |
| mode changed mid-flight during classify | discard stage outcome; re-derive under the new mode (S3, A8) | a verdict must apply only under the mode that requested it |
| PI probe error/timeout/malformed/breaker | pass result without warning + audit | input layer is advisory |
| git-status enrichment failure | omit `<context>` | best-effort |
| deny-threshold trip | notice (parameterized) + auto→default | escalate to human; no headless in dsh-cc (N/A) |

## 3. Threat-model coverage map

| CC threat | Coverage |
| --- | --- |
| Overeager behavior | S3 intent window + tool history + first-message pin; S1 F1 (asks unmasked) |
| Honest mistakes | S1 MEDIUM tier + S3 git-status enrichment; S2 environment slot |
| Prompt injection | S7 probe (parity scope) + classifier tool-result blindness (existing) + S6 return screening |
| Misaligned model | not observed in practice (CC's own note); S4 action-level deny is the orthogonal catch |

## 4. Slice S1 — Waterfall parity (deterministic)

**Files**: permission-rules only.

1. `src/auto-rule-filter.ts` (NEW, pure): `filterAutoAllowRules(rules, { classifyAllShell }): PermissionRuleSet`. Suspended from `allow` when mode is auto:
   - whole-tool allow whose aliases include `Bash`;
   - whole-tool allow for toolName spelled `PowerShell`/`pwsh` literally (A9: no alias entry exists);
   - bash content allow whose matcher's literal text before the first unescaped `*` is shorter than 3 chars — covers effectively-blanket forms (`Bash(*)` normalizes to whole-tool at parse time and is caught above; `Bash(cu*)`, `Bash( *)` land here) — delta Finding 2 closed this hole;
   - bash content allow whose first token ∈ `{python, python3, node, nodejs, ruby, perl, php, deno, bun, pwsh, powershell}` (covers `Bash(python *)`, `Bash(python:*)`, `Bash(python)` forms);
   - bash content allow matching `/^(npm run|npm exec|pnpm( run| exec| dlx)?|yarn( run)?|bun run|bunx|npx|uv run|pipx run)\b/`;
   - any allow rule for `Task`/`Agent`/`subagent`/`subagent_fork` spellings;
   - `classifyAllShell === true` suspends EVERY bash+PowerShell allow rule (whole-tool and content). No session-source exemption branch — session rules never enter the rule set (A5).
2. `src/evaluate.ts`: content phase per D2 (behavior outer deny→ask→allow, sources inner, declaration order preserved within behavior+source); content deny moved before whole-tool ask; module doc order statement + the stale "rule preview" clause corrected.
3. `src/decide.ts` restructure (A1/A4 amended):
   - HIGH ⇒ deny (unchanged, runs first).
   - **MEDIUM early-return removed.** New post-waterfall mapping (one shared function consumed by BOTH `decideCall` and the index.ts listener — kills the duplicated inline proxy): given `(decision, risk, mode)`:
     - rule deny ⇒ stands (D2); rule/mode allow ⇒ stands **(behavior change: MEDIUM no longer outranks a matched narrow allow — CC-faithful, called out in PR body + manifest)**;
     - rule ask ⇒ ask, except `mode !== 'plan' && sessionAllowMatches(exec)` ⇒ allow (D2b grant application; also applies to LOW rule-asks — fixes today's dead grant button for rule-asks);
     - passthrough && risk MEDIUM ⇒ (plan ⇒ falls to plan wrap deny — behavior fix, documented; bypass ⇒ allow; auto+armed ⇒ LLM per S3 arm; otherwise ⇒ ask with risk reason), with `sessionAllowMatches` consulted first (status-quo placement);
     - passthrough && LOW: auto ⇒ stage/legacy; other modes ⇒ unchanged;
     - the LOW+ask→allow auto proxy is DELETED (D3).
   - When mode is auto, `deps.rules()` flows through `filterAutoAllowRules` first (classifyAllShell from the autoMode slice).
4. `src/classifier.ts`: `DEFAULT_MEDIUM_PATTERNS` + three-level `assessBashCommand`. Initial list (regex + reason): `git push --force|-f`; `git reset --hard`; `git clean -f|…`; `rm -rf|-fr` non-root/home; `npm|pnpm|yarn publish`; `gh repo delete`, `gh release delete`; `docker rm -f`, `docker system prune`, `docker volume rm|prune`; `kubectl delete`; `helm uninstall`; `terraform apply|destroy`. New `permissions.mediumPatterns` setting (raw regex sources, replace semantics — mirror both schema sites).
5. `src/index.ts`: delete the inline LOW-ask→allow proxy (~:288); listener consumes the shared post-waterfall mapping; expose `effectiveRuleSet(mode)` on the service (D1 seam); session mode transitions observed per call as today.
6. `command-permissions`: `/permissions` listing marks auto-suspended rules (consumes `effectiveRuleSet`).

**Tests** (red→green; names pinned so an executor cannot "fix" code to preserve old semantics): auto-rule-filter (each predicate, `Bash(python)` bare form, pwsh literal, `Bash(cu*)` suspended vs `Bash(npm publish:*)` kept, classifyAllShell full sweep); evaluate.spec FLIPS (named: "higher-priority source decides first" — userSettings-allow vs config-deny ⇒ now deny; content-deny vs whole-tool-ask ⇒ deny; sandbox-exempt bash + content deny ⇒ deny); decide-verbose (auto+rule-ask ⇒ ask INCLUDING whole-tool ask rules; MEDIUM+matched-allow ⇒ allow; MEDIUM+passthrough+grant ⇒ allow; plan+MEDIUM+passthrough ⇒ deny via plan wrap; auto+`Bash(*)` allow + LOW external command e.g. `curl https://example.com` ⇒ passthrough-reaches-stage; MEDIUM asserted separately — MEDIUM+passthrough+auto+armed LLM arm ships in S3, so in S1 the assertion is MEDIUM+passthrough ⇒ ask); grant-on-rule-ask integration; effectiveRuleSet listing marks suspended.

**Manifest**: F1/F2 deviation records flipped to resolved; suspension + classifyAllShell + MEDIUM + D11/deviation rows updated; regenerate via `pnpm docs:parity`.

## 5. Slice S2 — Config slots, trusted scope, /auto-mode

**Files**:

1. Trusted-scope assembly (D12; delta Finding 3 redesign): the merged section cannot be un-merged (settings-cascade merge.ts:112-125 keeps no per-source tags) and permission-rules consumes via `installSectionSafe` — so the fix lives CASCADE-SIDE, with no new consumer API: when computing the published `permissions` section, the cascade assembles the `autoMode` key from trusted sources ONLY (user / flag / CLI-arg / policy layers; project + local layers skipped for this key), replicating the normal merge order within that subset. All other `permissions` keys keep the full merge. Consumers (auto-stage `settingsRead`) stay untouched — project/local autoMode config simply never materializes. Tests: each source combination, precedence within the trusted subset, hot-reload observing a trusted-layer edit.
2. Schema (both sites): `environment?: string[]`, `allow?: string[]` — absence-preserving. (`hard_deny` NOT here — S4.)
3. `src/slots.ts` (NEW, pure): `DEFAULT_ENVIRONMENT`, `DEFAULT_ALLOW_EXCEPTIONS`, generic `expandSlot(list, defaults)` (`$defaults` position-preserving); `expandSoftDeny` re-exported refactor. Defaults (prose re-expressions): environment — trust the session's starting git repo (cwd) + its configured remotes, everything else external until named; allow exceptions — installing packages declared in the repo manifest, standard credential/OAuth flows TO THE CREDENTIAL'S OWN PROVIDER (never overrides hard_deny, D4), committing/pushing to the session's own working branch.
4. `llm-classifier.ts` prompt v2: sections in evaluation order HARD-DENY (from S4; placeholder omitted until then), SOFT-DENY RULES, ALLOW EXCEPTIONS, ENVIRONMENT. Cache key digests all slot lists.
5. New package `packages/interaction/command-auto-mode/` (command-cost layout): `/auto-mode defaults` (built-in lists, `$defaults`-expanded, JSON), `/auto-mode config` (effective merged slice incl. trusted-scope view). Output text sanitized for control characters (shared helper — S5 `review` reuses). Preset wiring: preset package.json dep + agent.cordis.yml row (manifest I4 anchored evidence). README trio per readme gate.

**Tests**: slot expansion, prompt composition per slot, command output on fixture slice (incl. project-scope autoMode being IGNORED), absence-preservation, sanitization.

**Manifest**: command row + slot rows; gates per §11.

## 6. Slice S3 — Transcript-aware classifier

**Files**:

1. `src/transcript.ts` (NEW, pure): `foldClassifierContext(events, { readOnlyTools })` ⇒ `{ userIntent, toolHistory }` per D7: human-only filter on `source.kind === 'user'`; first-message pin + last-4; 400-char caps. Tool history folds `tool/call` events (name + subject extracted from raw args, string-or-object; the fold owns a small per-tool subject extractor — there is no `ToolExecution` here — with `subjectOf`'s semantics for bash/file tools and a JSON-truncate fallback; "non-read-only" filters through the injected `readOnlyTools` set — fold precedent: command-stats/src/stats.ts:83-84). Malformed events skipped.
2. Project instructions loader (in auto-stage): read `<cwd>/AGENTS.md` or `CLAUDE.md` ≤1024 chars at stage build; absent/unreadable ⇒ omit.
3. `llm-classifier.ts`: input assembly per D7 (section order user_intent → project_instructions → tool_history → context → tool_call; total ≤8192 hard cap on the assembled string; tool_call payload cap 4096 unchanged). System prompt gains intent rules (prose: judge whether the action is authorized by what the user actually asked, not merely related to it; questions aren't directives; one earlier approval isn't a pattern — CC admits its own 17% FNR here; we take the same posture deliberately). `classify(exec, { route, context: { userIntent, projectInstructions, toolHistory, siteContext } })`. Cache key = sha256(tool | input | digest(slots) | digest(context parts)).
4. `src/enrichment.ts` (NEW): work-discarding detector (exported table; `git reset --hard`, `git clean -[fdx]+`, `git checkout --`/`restore`, `rm -r|-f`, `rmdir`); runs `git -c status.showUntrackedFiles=all status --porcelain` (cwd session cwd, 1000 ms, ≤512 chars) ⇒ `<context>`; injected runner dep for tests.
5. `auto-stage.ts`: build context bundle per call; eligibility = **passthrough-only** at LOW or MEDIUM risk (`decision.kind === 'passthrough' && risk.level !== 'HIGH'`) — delta Finding 1: post-S1 every waterfall `ask` is rule-derived, so no `ask` arm exists; MEDIUM+passthrough+armed ⇒ LLM, MEDIUM+passthrough+unarmed ⇒ ask (D11). **Mode-epoch revalidation (A8; delta Finding 6)**: `AutoStageDeps` gains `modeOf(exec): PermissionMode` (resolves the fold INCLUDING the defaultMode fallback — auto-stage itself has no defaultMode); capture the mode before classify, re-fold after the await, discard the outcome + audit `failure: 'stale-mode'` (never breaker-counted) when it left `auto`. D11 behavior lives here (enabled-but-unavailable ⇒ ask).
6. `classifier.secondPass?: boolean` default FALSE (D13), both schema sites; implemented but dark: on non-failure ask verdict, one reconsider call (same system+input + reconsider instruction), may only flip ask→allow; audit `secondPass: true`.

**Tests**: transcript fold (plugin-injected filtered — red test pins A3; first-message pin + eviction; malformed skip; readOnlyTools filtering of history), cache-key busting per context field, budget enforcement on assembled string, eligibility matrix (LOW rule-ask NEVER reaches the LLM — pinned; MEDIUM+passthrough reaches it; LOW+passthrough reaches it), enrichment (clean/dirty/timeout/non-git-cwd), stale-mode revalidation (switch to default/plan/bypass mid-flight ⇒ discarded + untagged by breaker; deployment-default-auto case via `modeOf`), secondPass flip/no-flip/never-reverse.

## 7. Slice S7 — Input-layer PI probe (ships BEFORE S4; S6 reuses it)

**Files**:

1. `src/classifier-breaker.ts` (NEW): extract breaker/streak helpers from auto-stage (behavior-identical; existing tests protect).
2. `src/pi-probe.ts` (NEW): deps mirror the classifier face (stream/resolveRoute/settingsRead/audit/debug). Verdict `{ injection: boolean; reason }` — reason ≤120 chars. One-shot, maxTokens 256, default timeout 5000. Input: text blocks only (non-text blocks skipped), first 3072 + last 1024 chars, elision marker.
3. Settings (both sites): `autoMode.probe?: { enabled?: boolean /* default true */; route?: string /* 'haiku' */; timeoutMs?: number /* 5000 */; toolPatterns?: string[] }` — absence-preserving. Active only when effective mode is `auto` (re-folded in post-execute, with the same stale-mode guard). Default scan set per D8 (read/bash/web_fetch/web_search/mcp__*); `toolPatterns` replaces it (exact or trailing-`*` prefix).
4. Listener: `tools/post-execute`, DEFAULT order, post-next composition. The probe scans the PRE-REWRITE ORIGINAL result content (deliberate deviation: the cordis waterfall composes outermost-first and the context-crusher's prepend listener composes AROUND the probe, so scanning the original is the only CCR-independent vantage). On flag: the warning is delivered via `additionalContexts` SIDEBAND appended to the downstream fold decision (edit-recovery-hint idiom) — never into content. Rationale: a sideband cannot be clobbered by content rewriters (CCR-style content replacement) and survives listener-order races; CC adjacency of warning-to-content is approximated by the sideband. Value-replacing accepts carry additionalContexts too (verified: runtime-results.ts merges them onto replaced results). Warning text (prose): security notice + instruction to treat the content as untrusted data and re-anchor on the user's actual request. Audit `permission/probe` (registered type): digest-only by default, `input` under auditFullText (D10); reasons capped; a mid-flight mode change out of `auto` audits `failure: 'stale-mode'`, never breaker-counted (classifier A8 discipline).

**Tests**: verdict parse, fail-open paths, breaker reuse, mode gating incl. stale-mode audit, non-text skip, sideband delivery (warning via additionalContexts, downstream contexts preserved, clobber-proof vs content-replacing listeners in both load orders), truncation windows, reason cap.

## 8. Slice S4 — Hybrid verdict space

**Files**:

1. Schema (both sites): `hard_deny?: string[]`; `DEFAULT_HARD_DENY` in slots.ts — TWO unconditional entries only (A10: intent-dependent rules stay soft):
   - Never exfiltrate credentials, tokens, API keys, or secrets to any external destination (including embedding them in URLs, request bodies, or third-party services).
   - Never disable or weaken the permission system itself, nor delete, falsify, or truncate its audit/session records.
   DEFAULT_SOFT_DENY gains the intent-dependent sibling: "Never destroy user data outside the session's authorized scope when the transcript shows no authorization for that target."
2. `llm-classifier.ts`: verdict space gains `deny`; prompt sections in D4 order; `parseVerdict` enforces exact-match citation else downgrade to ask (near-miss pins: trailing whitespace, unicode quotes, case). `deny` is never produced on cache replay of a mutated slot set (cache key already digests slots; test).
3. `auto-stage.ts`: `StageOutcome` gains `{ kind: 'deny'; reason; rule }`; audit event gains `verdict:'deny'`, `rule?`, `callId?`, `reason?` (D5/D10). Counters per D5 (seed-once fold idiom); trip = parameterized notice + `setMode(agent,'default')`, idempotent, counters reset on auto re-entry; `failure:'trip'` marker event.
4. `index.ts`: stage deny ⇒ `{ kind:'deny', reason }`, reason wrapped per D6.

**Tests**: citation contract (cited ⇒ deny; uncited/mismatch ⇒ downgraded ask; never allow); soft stays ask even when hard-similar; counter folds (consecutive reset on allow/ask verdict, total accumulates, threshold boundaries at 3 and 20, seed-once from log); trip idempotence + notice origin text; listener deny-text delivery; cache-key slot mutation.

## 9. Slice S5 — Full-text audit + review

**Files**: schema `classifier.auditFullText?: boolean` default false (both sites) ⇒ audit events gain `input` (≤4 KiB rendered classifier input). `/auto-mode review` subcommand: folds current session `permission/classifier` + `permission/probe` events, prints last 20 rows (tool, verdict, failure, rule, reason, latencyMs, cacheHit, secondPass); `review full` prints inputs when flag on. ALL session-derived text sanitized (control chars escaped) before output. README pair gains privacy note + storage-growth note.

**Tests**: event shape on/off, forward-compat fold (old events without new fields), review output fabrication, sanitization.

## 10. Slice S6 — Subagent handoffs

**Files**:

1. `llm-classifier.ts` rendering: spawn tools (`subagent`, `subagent_fork`, resolved via cc-names Task alias) render the delegation `prompt` field first (≤512 chars) — field names verified against the tool schema at implementation, pinned by test.
2. Outbound integration test: auto + `Task` allow rule present ⇒ spawn call reaches the classifier (suspended rule), not blanket-allowed.
3. Return check per D9: RED TEST FIRST proving child-session resolution (registry/ledger seam; if absent, arm (a) ships disabled-by-assertion with the no-op pinned). Arm (a): fold child audit ⇒ deny/breaker/≥5-ask ⇒ warn. Arm (b): screen returned final-report text through S7's probe machinery ⇒ warn on flag. Warnings via `additionalContexts` (edit-recovery-hint idiom), warn-only, never discard. Unresolvable child under a resolver that threw ⇒ debug note, no fabricated warning.

**Tests**: rendering, outbound integration, arm (a) benches (clean/deny/breaker/ask-storm/unresolvable), arm (b) flag/no-flag, ordering with CCR + hooks listeners.

## 11. Sequencing, execution, gates

- Order: **S1 → S2 → S3 → S7 → S4 → S5 → S6** (S7 before S4 so S6 reuses the probe; S4 before S5 so `review` covers deny fields; S6 last). Each slice = one PR stacked on latest main; rebase between slices.
- Executor rules per slice: quoted spec sections in the dispatch prompt; red→green first; commit message states the observable behavior change; PR body English conventional-commit with Verification fields; `--body-file`; never hand-edit generated parity docs.
- Gates per PR: package tests, `pnpm typecheck`, `pnpm docs:parity` + `check:capabilities` + `check:parity`, `pnpm check:deep-src-imports` manually (CI-only gate), readme trio gate when packages are added/edited (S2), pre-commit full presubmit with generous timeout.
- Schema mirror discipline: both sites + assertions in the same commit.

## 12. Risks / open questions

- R1 latency: transcript+history+enrichment per gated call; bounded by caps; `latencyMs` audit is the feedback loop.
- R2 originality: all CC prompts/rules re-expressed as prose, never copied.
- R3 upstream gap: `GenerateOptions` lacks effort override (#123) — classify lane can't force no-reasoning; secondPass dark by default (D13).
- R4 no eval harness: CC ships FPR/FNR numbers; we substitute S5 observability + dogfood; harness build is a separate program. Deviation recorded (D13).
- R5 suspension lists are best-effort (CC says the same); `classifyAllShell` is the hard override.
- R6 behavior-widening disclosure: F1 removal widens prompts in AUTO mode only (strict-rule auto per D11); the MEDIUM tier and the D2 deny-first reorder alter outcomes in NON-auto modes as well — deliberate, called out in S1's PR body + manifest.
- R7 (Codex #5 partial): in-project file-edit auto-allow in auto mode (CC Tier 2) — dsh-cc routes LOW passthrough edits to the classifier, paying lane latency on routine edits. Accepted for now (fail-safe direction); a future slice may add the in-scope-edit exemption with protected-path routing. CC's first-read-outside-cwd prompt, PostToolUse `classifierContext` hook field, Monitor-rule suspension (no Monitor tool), and protected-path-writes-in-auto (dsh-cc is STRICTER: HIGH denies in every mode) are recorded deviations, not work items here.

## Review amendments log

- A1 (critic #1 / codex #3): MEDIUM early-return removed; waterfall precedes classifier authority; grants placed post-waterfall. → D2/S1.
- A2 (critic #2 / codex #7): drop "user-approved-ask resets"; seed-once fold; callId/rule/reason added; no-auto-resume deviation. → D5/S4.
- A3 (critic #5 / codex #9): human-source-only filter; first-message pin; parameterized trip notice. → D5/D7/S3.
- A4 (critic #4): probe append-not-clobber; both-load-orders test; non-text skip. → S7.
- A5 (critic #3 / codex #3): session-source dead branch deleted; grants mechanism corrected. → D2/S1.
- A6 (codex #7 shape): 3/20 thresholds kept; semantics simplified in D5.
- A7 (codex #4): single `effectiveRuleSet(mode)` seam + `/permissions` suspended annotation. → D1/S1.
- A8 (codex #8): mode-epoch revalidation after classify awaits. → S3/S7.
- A9 (codex #11): PowerShell matched by literal spelling; alias map untouched. → S1.
- A10 (codex #6): hard_deny defaults narrowed to unconditional; allow exceptions never soften hard; applicability caveat admitted. → D4/S4.
- A11 (codex #13): probe default scope = read/bash/web/MCP (parity); reason cap 120; output sanitization. → D8/S5/S7.
- A12 (critic #8/#9 + codex #14): budgets (assembled-cap 8192, payload 4096), S1 test-contract corrections, I3/I4/I7 citation fix, stale preview-doc cleanup. → §1/S1/S3.

### Round-2 delta review (critic, 2026-09-23) — verdict was NOT-READY, residual findings closed as follows

- A13 (delta #1/#4): S3 eligibility is passthrough-only (the `ask && MEDIUM` arm was a dead-or-contradictory branch post-S1; every waterfall ask is rule-derived); D11's disabled-classifier row re-specified as strict-rule auto; R6 wording corrected (F1 is auto-only). → D11/S3.
- A14 (delta #2): blanket-wildcard bash content allows (`<3`-char literal prefix) suspended; `Bash(*)` whole-tool normalization noted. → S1 item 1.
- A15 (delta #3): D12 implemented cascade-side (trusted-scope assembly of the `autoMode` key at publish time); merge.ts is provenance-lossy, so a post-merge scoped read was impossible — no new consumer API. → S2 item 1.
- A16 (delta #5-#8): deny-streak resets only on real verdicts (`failure === undefined`); `modeOf(exec)` dep with defaultMode resolution for stale-mode revalidation; D2 full waterfall order pinned; tool-history fold owns its subject extractor with injected `readOnlyTools`. → D2/D5/S1/S3.

## Slice ledger

| Slice | PR | Merged | Notes |
| --- | --- | --- | --- |
| S1 waterfall parity | PR #122 | merged 2026-09-23 | plus follow-up extraction of pre-execute.ts for the size gate |
| S2 slots + trusted scope + /auto-mode | PR #124 | merged 2026-09-23 | trusted-scope + shared-guards extracted from cascade index.ts (size gate) |
| S3 transcript-aware classifier | PR #125 | merged 2026-09-23 | context-bundle.ts extracted (size gate) |
| S7 PI probe | PR #126 | merged 2026-09-23 | shipped 4th; sideband delivery per A4 during rebase resolution |
| S4 hybrid verdict space | PR #127 | merged 2026-09-23 | classifier-audit.ts extracted (size gate) |
| S5 full-text audit + review | PR #129 | merged 2026-09-23 | |
| S6 subagent handoffs | PR #130 | merged 2026-09-23 | HARD GATE PASSED — child resolution via `result.value.agentId` + `ctx.agents.get(id)` (one-shot-ledger face); both arms ship enabled |
