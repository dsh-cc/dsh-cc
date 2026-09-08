# Auto-mode classifier robustness: token budget, failure attribution, restart-durable breaker, visible fallback, debug channel

- **Date:** 2026-09-05
- **Status:** Implemented — PR #123 (merged 2026-09-05). Reviewed — one cold Staff-review round (deep-reasoner,
  2026-09-05): verdict approve-with-nits. Incorporated: R2 pre-parse abort
  ordering + caller-cancel exclusion (new 'cancelled' tag, never
  breaker-counted); R3 synchronous idempotent seed guard + skip unattributed
  legacy events + documented fail-open undercounting choice; R4
  driver-mapped notice on in-process open transitions only (no transcript
  fold, no log-replay re-shows); R5 2 KiB truncation + `[dsh:classifier:raw]`
  prefix + secrets caveat. Filed as follow-up (not this PR): threading an
  explicit low/no reasoning-effort override for one-shot classifier calls
  through upstream `GenerateOptions` — the observed lane reasons on this
  model id and R1's budget only treats the symptom.
- **Author:** Fable (diagnosis grounded in production audit events from the
  reporter's machine; all claims verified in code at origin/main 1b84b59,
  i.e. after #117 + #122)
- **Scope:** `packages/interaction/permission-rules` only, plus optional
  one-line defaults in the mirrored `autoMode` schemas; no harness changes,
  no new settings keys.
- **Rollback:** git revert. All changes refine failure handling of a
  fail-closed, opt-in stage; nothing here can turn an ask into an allow.

## 1. Problem (production evidence)

With the classifier enabled against `llmbox_ant/deepseek-v4-flash-0731`,
`~/.dsh/sessions/**/session.jsonl.zstd` shows, in one TUI session:

```
{verdict:'ask', failure:'malformed', latencyMs:5006}
{verdict:'allow', failure:null,  latencyMs:1132}
{verdict:'ask', failure:'malformed', latencyMs:5008}
{verdict:'ask', failure:'malformed', latencyMs:5001}
{verdict:'ask', failure:'malformed', latencyMs:5003}
{verdict:'allow', failure:null,  latencyMs:707}
{verdict:'ask', failure:'malformed', latencyMs:5003}
```

Three defects fall out:

- **D1 — the lane runs out of budget, not out of sense.** Successes return in
  ~0.7–1.1s; every failure parks exactly at the 5000 ms timeout boundary.
  The one-shot calls `maxTokens: 256` (`llm-classifier.ts MAX_TOKENS`) on a
  model whose provider applies reasoning: the budget is consumed before the
  verdict text exists, or the timer fires mid-stream; the assembled text is
  truncated and unparseable.
- **D2 — silent truncation is misreported as `malformed`.** The timeout
  controller aborts at the boundary, but the stream adapter
  (`index.ts llmStream`: for-await + `BlockAssembler`) ends the iteration
  quietly instead of throwing; `classify()` then sees a resolved-but-garbled
  string, `parseVerdict` fails, and the failure tag reads `malformed` where
  the honest tag is `timeout`. Audits mislead every future diagnosis (they
  just sent us chasing "model can't output JSON" when the truth is "model
  never got to finish").
- **D3 — the breaker loses state exactly when it matters.** Counters live in
  process memory (`auto-stage.ts` `routeFailures`/`breakerOpen`): every TUI
  restart resets the streak, so a user restart-looping on the symptom gets
  three fresh prompts every launch. And per symptom reports, users cannot
  tell whether fallback happened: the open event only hits `deps.warn`
  (logger), invisible in the TUI, and `transcript` renders nothing for it.

Also: raw model output is unrecoverable when supporting a report like this
one — the digest-only audit contract is right for the log, but it leaves
support blind. We got lucky that latency patterns told the story here.

## 2. Goals / non-goals

Goals:

- G1. Slow-but-sane completions parse: widen the token budget and default
  timeout to cover the observed lane (p95 slow-path ≈ 5s at 256 tokens;
  1024 tokens ≈ 4× budget headroom).
- G2. Honest failure attribution: an abort-boundary silent end reports
  `timeout`, never `malformed`.
- G3. The breaker remembers across restarts **within the same session** (the
  durable `permission/classifier` events already exist — use them), and users
  SEE the fallback once when it happens.
- G4. One env-gated debug channel writes raw model output to the process log
  (never session events), so the next "unparseable" report carries its own
  evidence.

Non-goals:

- N1. No verdict-parser leniency (strictness is load-bearing against
  smuggling, affirmed in the #122 review).
- N2. No new settings keys and no default flip of `enabled`.
- N3. No cross-session/global breaker persistence file — session-log seeding
  (G3) covers the reported symptom; a process/global registry is
  over-engineering.
- N4. No reasoning-effort override: `dsh-llm` `GenerateOptions` is a closed
  shape with no effort field and the harness is read-only; the alias'
  `reasoningEffort` stamps on subagent spawns, not one-shot calls. Configured
  lanes that reason heavily are a deployment choice; G1 widens the budget so
  they fit.

## 3. Design

### R1 — budget and defaults

- `llm-classifier.ts`: `MAX_TOKENS` 256 → 1024.
- Default `timeoutMs` 5000 → 8000 in BOTH schema mirrors
  (`settings-cascade/src/auto-mode.ts` and the plugin-local mirror
  `settings-schema.ts`); docs/READMEs updated. Existing deployments with an
  explicit value keep it.

### R2 — honest timeout attribution

In `classify()`, **immediately after the stream resolves (before
`parseVerdict`)**, check the signals:

- `exec.signal?.aborted` **first** ⇒ the caller cancelled mid-flight: return
  a benign `{verdict:'ask', failure:'cancelled', reason:'classification
  cancelled by caller'}` — a new failure tag that auto-stage NEVER counts
  toward the breaker (user ESC-spam must not trip the lane) and that hosts
  should treat as noise, not a fault.
- else if `timeout.signal.aborted` ⇒ `{verdict:'ask', failure:'timeout',
  reason:'classifier timed out'}` — this is the silent-end production bug:
  the stream resolved with truncation because our timer fired; parse is a
  doomed formality. (Throwing aborts keep their existing catch-path
  attribution, same check order for symmetry.)

Tests: timer fired + silent partial resolve ⇒ 'timeout' (pre-parse, so the
garbage is never parsed); caller-cancelled ⇒ 'cancelled', no breaker
increment; clean resolve ⇒ unchanged.

### R3 — restart-durable breaker (session-log seeding)

`auto-stage.ts`:

- Lazily, on the first `maybeEscalate` for a given session, seed the per-route
  state from the session's durable log:
  - **Synchronous guard (review nit):** the session id enters
    `seededSessions` BEFORE any suspension — concurrent first-calls must not
    double-seed. The fold is over in-memory events, so the whole seeding
    section never awaits.
  - Compute trailing consecutive per-route failure streaks —
    **only events that carry `provider`/`model` attribution count**
    (unattributed legacy events predate route keying; guessing a route for
    them would trip the wrong counter — skip them entirely, review nit).
    malformed/error/timeout count; success resets; streak capped at
    threshold. A restored streak ≥ threshold opens that route in
    `breakerOpen` at seed time (distrust stale history; the R4 notice fires
    on this in-process open).
  - `breakerAudited` pre-joins ONLY sessions whose log already holds a
    'breaker' event (replay never re-audits the same open); seeded-open
    sessions are NOT pre-joined — their first real call audits/warns
    normally.
- Seeding NEVER overwrites a live counter: only seed when the session is
  unseen AND the route counter is 0/absent (in-process accrual is fresher).
  Documented consequence (accepted, review nit): stale logs undercount when
  live accrual outran them — fail-open direction (more modals), never
  fail-allow.
- Tests: fresh process + log with 2 attributed trailing failures on route X
  ⇒ one more X failure trips immediately; log with fail,fail,success ⇒
  streak 0; unattributed legacy events never seed anything; concurrent
  first-calls seed once; log with 'breaker' event ⇒ open at first call, no
  second audit; seeded-open session's first call audits + notices exactly
  once.

### R4 — visible fallback notice

The TUI driver already subscribes `session/event`. Implement as a
**driver-side branch** on the existing session-event handling (NOT a
transcript-fold custom row — cut as speculative infrastructure, review nit):
on a `permission/classifier` event with `failure: 'breaker'`, surface ONE
user-visible notice: "classifier lane failed repeatedly; auto mode continues
without LLM vetting until settings change". Gate on **in-process open
transitions only** — a live trip, or a seeded-open detected at the first
seeded call in this process — never on replayed log events (a resume must
not re-show a notice for a long-fixed lane). Pin with one TUI/driver spec.

### R5 — debug channel

`LlmClassifierDeps` gains optional `debug?: (message: string) => void`.
`index.ts` wires it from a scoped logger when
`process.env.DSH_PERMISSION_CLASSIFIER_DEBUG === '1'`. Per call, log the raw
model output **truncated to 2 KiB** with the prefix `[dsh:classifier:raw]`
(greppable). Nothing enters session events (digest-only contract stands).
Doc note: raw output may echo tool input — including secrets the agent was
about to run — so this stays a deliberately opt-in process-log channel with
no redaction machinery (cut as over-engineering, review nit). Tests:
env-gated passthrough incl. truncation and prefix, default-off silence.

### Manifest/docs

Same commit: `docs/claude-code-capabilities.yaml` auto-mode classifier rows
(breaker durability, visible fallback, debug channel, updated defaults) with
anchors to the new specs; `pnpm docs:parity` regenerated;
`check:capabilities`/`check:parity` green. Lockstep sweep for the R1 default
changes (review nit): schema-default snapshots asserting 5000, any test
asserting MAX_TOKENS 256, README/doc default tables.

## 4. Test plan (TDD)

Per R1–R5 rows above; constraints as in the previous PRs: repo-root
`node_modules/.bin/vitest run packages/interaction/permission-rules`
(+ `packages/ui/tui` for R4 and a combined regression run),
`scripts/check-spec-deps.mjs`, `tsc -b tsconfig.packages.json`,
`check-file-size.mjs`, `pnpm check:capabilities`, `pnpm check:parity`.

## 5. Verification

Manual smoke on the reporter deployment: classifier enabled with the flash
lane — slow completions now parse (no more 5000-boundary malformeds);
`DSH_PERMISSION_CLASSIFIER_DEBUG=1` prints raw outputs to the process log;
forcing three failures, then restarting the TUI on the same session, shows
the route still broken-open and a single fallback notice visible in the
transcript.
