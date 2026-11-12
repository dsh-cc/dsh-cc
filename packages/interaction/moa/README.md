# moa — tiered cascade routing

`@dsh-cc/moa` routes main-conversation turns over the four lane aliases
(`sketch` / `draft` / `blueprint` / `masterplan`): each user turn is classified
by a System One decision call into the cheapest sufficient tier, and an
optional acceptance judge escalates a rejected answer to the next tier up.
**Default OFF** — with `moa.enabled: false` the plugin mounts nothing and
costs nothing. Subagents/forks are never overlaid.

## Configuration (`moa` namespace)

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | arm tiered routing on the main agent |
| `acceptance.enabled` | `false` | run the acceptance judge and act on rejects |
| `acceptance.shadow` | `false` | run the judge, log verdicts only |
| `acceptance.tau` | `0.7` | reject when `P(acceptable) < tau` |
| `max-escalations` | `1` | per-message escalation ceiling (read-time clamp to 3) |
| `judge-route` | alias `gauge` | alias or `{provider, model, protocol}`; unset → the `gauge` lane alias (must resolve to a System One route, else moa stays unarmed) |
| `classify-budget-tokens` | `4000` | classify input budget |
| `call-budget-ms` | `8000` | per-message cascade deadline |
| `context-routing.mode` | `off` | off/shadow/active — context-aware classification v2 (see below) |
| `context-routing.timeout-ms` | `1500` | per-decision timeout in ms (read-time clamp 100..8000) |
| `context-routing.max-input-tokens` | `4000` | budget for routing state + question (read-time clamp 512..16000) |
| `context-routing.max-under-tier-probability` | `0.10` | maximum probability mass tolerated above the selected tier (0..0.5) |
| `context-routing.min-top-probability` | `0.60` | below this top probability, fall back to live selection (0.25..1) |

## Context routing v2

`context-routing` (optional, default `off`) replaces the argmax over the
four-tier answer with a context-aware classification plus a tail-risk tier
policy: the classifier sees a bounded slice of the turn's history (the
current request, the last three user requests, the last assistant answer and
tool names — never arguments, paths or results), and the applied tier is the
cheapest one whose probability mass above it stays under
`max-under-tier-probability`. `shadow` runs alongside the legacy classifier:
the legacy result still decides the model, so shadow accepts a double
classification call; `active` replaces the legacy classifier entirely. Both
require `moa.enabled: true` and a successful arming, and an explicit `/model`
still wins. The escalation retry path and subagent/fork sessions never
classify. Enabling `active` requires the offline evaluation gate
(`moa/eval/context-routing.json`, 120 blind-labeled cases) to pass first;
setting `context-routing.mode` back to `off` is the whole rollback.

## Arming ladder

At arming time moa resolves the four lane aliases through `ccModelRoutes`
(`resolveTiers`, `src/tiers.ts:50`). A lane that does not resolve to a
concrete provider and model refuses to arm. The resolved ladder must be
contiguous runs with at least two distinct routes: a route may repeat only
next to itself (`[A,A,B,C]` arms), a route that reappears after a different
one (`[A,B,A,C]`) refuses because an escalation would hop down, and an
all-identical ladder refuses. Escalation moves to the next distinct tier of
the ladder snapshot taken at arming.

## Truthful model bookkeeping

While moa overlays a tier on the boot selection, two things would otherwise
lie about which model is serving the session:

- **Phantom notices filtered.** The harness re-emits
  `[model changed: …]` notices on nearly every step under the overlay,
  claiming a continuation model the overlay will NOT serve. A co-located
  sanitizer (`@dsh-cc/moa/sanitizer`, registered right after the harness's
  `installModelSelection` in the TUI driver and the ACP model control) drops
  exactly those rows: only when the overlay is active on the boot selection.
  Every other state — moa disabled, disarmed, validation-failed, or no moa at
  all — passes harness notices through byte-identical.
- **`/model` is honored under the overlay (escape hatch).** A mid-session
  `/model` away from the boot selection disarms moa before the next turn is
  classified: the wire serves your selection, no status row is emitted, and
  switching back to the boot selection re-arms moa from the next turn.
  Previously the switch was silently ignored while overlaid.
- **Persona states the effective model.** The moa assemble listener rewrites
  the system-prompt `provider`/`model` variables to the resolved tier pair
  (never an effort field) whenever the overlay applies; on any fail-open
  (classification failure/timeout, off-boot selection, disabled) the
  harness's own selection variables pass through untouched — the prompt and
  the wire always agree.
- **Statusline shows the effective pair.** While an overlay is active the
  statusline renders `<model-id> ◂ <tier-alias>` (e.g.
  `<model-id> ◂ sketch`) instead of the bare tier alias — both in
  the built-in footer and the custom-command payload (`moa: {tier, model}`).
  A true switch-away clears the segment; the plain selection shows whenever
  no overlay is serving.
- **Statusline shows why moa is not armed.** With `moa.enabled: true` but
  arming refused (routes unavailable, degenerate ladder, judge-route window
  failure) the statusline renders `moa:unarmed — <reason>` in the built-in
  footer and carries `moa: {unarmed}` in the custom-command payload, so a
  misconfiguration is visible instead of hiding in a warn line. Arming
  success (or a routed notice) clears it. `moa disabled` — the default-off
  population — renders nothing.
