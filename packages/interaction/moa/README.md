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
| `judge-route` | `llmbox_systemone/bjev` | alias or `{provider, model, protocol}` |
| `classify-budget-tokens` | `4000` | classify input budget |
| `call-budget-ms` | `8000` | per-message cascade deadline |
