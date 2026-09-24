# Dogfood: advisor watchdog (`cc-advisor`)

Personal opt-in for **dsh-cc** contributors. The `@dsh-cc/advisor-watchdog`
plugin lets a second model (a cheap-lane alias via a one-shot `runSideQuery`)
read the delta of every completed turn and inject severity-tiered advisory
notes (`nit | concern | blocker`) at the next step.

**Product default stays OFF.** This page never asks you to change the shipped
default (`enabled: false`). Anything below is **user-layer only**. Graduation
rule: value correlates inversely with main-model strength — promote to a
default-on discussion only if this dogfood shows real catches (plan §4.6).

Design: [`docs/plans/2026-09-23-advisor-watchdog.md`](../plans/2026-09-23-advisor-watchdog.md)  
Package README: [`packages/interaction/advisor-watchdog/README.md`](../../packages/interaction/advisor-watchdog/README.md)

## Enable (user-layer settings)

Edit **harness-home** `settings.json` (not the repo's project settings —
project scope is structurally invisible to this feature), and make sure the
`haiku` alias is actually configured (the advisor hard-no-inherits: an
unconfigured alias disables the advisor for the session with a journal
`unrouted` entry — it never spends the main route):

```json
{
  "cc-advisor": {
    "enabled": true,
    "alias": "haiku",
    "budget": 2,
    "immune-turns": 3,
    "session-cap": 24
  },
  "model-aliases": {
    "haiku": { "provider": "deepseek", "model": "haiku-class-model-id" }
  }
}
```

Restart or start a new dsh-cc session so the preset remounts (the listener
also re-reads the user file per trigger).

## What to verify by hand

1. **TUI visibility (unverifiable in-repo, plan §5):** after an advisor note
   lands at a turn tail, the re-opened turn should render the
   `<advisory>…</advisory>` user row attributed to the advisor source kind.
   Record whether it renders or is swallowed.
2. **Noise floor:** normal healthy turns should produce `{"notes": []}` —
   zero injected rows. If you see notes every turn, lower `budget` or narrow
   `severities`.
3. **No self-feeding:** an advisory-only re-opened turn spawns no second
   side query (check the journal: no new line for that turn).
4. **No main-route spend:** if you forgot the alias overlay, the journal
   shows exactly one `ok: false, reason: "unrouted"` line and the advisor
   goes silent for the session — it never touches the parent route.

## Observability (journal)

One JSON line per attempted run at `$DSH_HOME/advisor/<sessionId>.jsonl`:

```json
{"ts":0,"turn":0,"alias":"haiku","model":null,"inheritedRoute":false,"ok":true,"durationMs":0,"deltaMessages":0,"deltaBytes":0,"notesIn":0,"notesOut":0,"drops":{"denylist":0,"duplicate":0,"budget":0,"immune":0,"quarantined":0,"stale":0,"malformed":0,"severity":0,"cursorReset":0,"sessionCap":0},"usage":null}
```

`usage` is reserved and always `null` in v0 — `SideQueryResult` surfaces no
token usage yet, so **currency cost is N/A** until the plan §7 follow-up.

## Scoreboard (jq template)

Run these over the accumulated journals (one line per run):

```bash
J="$DSH_HOME/advisor"/*.jsonl

# runs / turn (reviewed turns with a captured delta, per session)
jq -s 'group_by(.turn) | length' $J

# notes / turn
jq -s '[.[].notesOut] | add / length' $J

# severity mix (approximated from notesIn/notesOut ratio per run is not
# per-note; per-note mix requires extending the journal — use drop mix +
# notesOut as the precision proxy for v0)
jq -s '[.[] | select(.notesOut > 0)] | length' $J

# drop mix
jq -s '[.[].drops] | add' $J

# p50 / p95 durationMs
jq -s '[.[].durationMs] | sort | "p50=\(.[(length*0.5|floor)]) p95=\(.[(length*0.95|floor)])"' $J
```

Precision sample: hand-label **50 delivered notes** (`notesOut > 0` runs,
open `<advisory>` bodies from the transcript) as catch / noise, and record
the ratio next to the scoreboard. **Do not discuss defaulting before a
recorded week of this scoreboard plus the label sample.**

Automated coverage (no session required):

```bash
pnpm --filter @dsh-cc/advisor-watchdog test
```
