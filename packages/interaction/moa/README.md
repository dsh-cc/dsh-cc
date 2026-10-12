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
  `deepseek-v4.1-flash ◂ sketch`) instead of the bare tier alias — both in
  the built-in footer and the custom-command payload (`moa: {tier, model}`).
  A true switch-away clears the segment; the plain selection shows whenever
  no overlay is serving.
