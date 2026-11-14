# @dsh-cc/skill-recommender

English | [中文](README.zh.md)

An advisory, read-only `recommend_skill` tool: given a task description, it returns a few visible skill names with relevance and prerequisite evidence. It is a **consumer** of the `ctx.skills` catalog — it never loads a body, runs a skill, invokes one, changes invocation policy or hides a skill. **Default off** (`cc-skill-recommendation.mode: off`), and mounted by the `cc` and `vwa` presets as a dark row: the tool is present, `off` answers the off result and no runner runs until `mode` is set.

## What it does

- Registers one tool, `recommend_skill`, whose only parameter is `task` (required, non-empty). The caller cannot pass a catalog, path-activation results, invocation permissions or a metering scope.
- Reads the catalog the calling agent can already see (`ctx.skills.list({ cwd, scope })`) and maps each entry to a descriptor: name, description, when-to-use, source, and the catalog's model-invocable flag. `ctx.skills.get()` is never called, so no body is ever read.
- Builds the eligible pool: user-invocable-only skills, model-invocation-forbidden skills, and whole name groups whose name appears more than once are dropped (the consumer does not re-implement source precedence); every remaining skill survives, including ones that share no literal token with the task.
- Asks two questions per skill through the optional decision runtime — a relevance score over a five-row rubric (0..4, expected value) and a prerequisite check (0..1). Batches are packed item by item against the effective token budgets (the settings caps folded with the route's real windows, using the runner's own estimator), all under one deadline. When the deadline expires mid-judgment and the answered prefix covers at least `min-coverage` of the pool, a partial result is published with disclosed `judged`/`eligible` counts; anything below the floor — or any lane error, malformed answer or identity change — still discards the whole recommendation.
- Keeps skills at or above **both** thresholds, orders by relevance descending, prerequisite fit descending, then name ascending, and truncates to `max-recommendations`.
- Returns `status`, the selected names with their two numbers, the runtime's `decisionId`s and `advisory: true`. There is no generated rationale text; the display copy comes from a fixed template and states that explicit instructions still apply.

It does not make a skill invocable that was not invocable before: the normal skill tool remains the only execution entry point and still re-resolves the name and applies the original invocation rules. An empty recommendation cannot override a mandatory rule, and skills named explicitly by the user or by higher-level instructions follow the original flow without needing a score.

## Modes

| `mode` | Behavior |
| --- | --- |
| `off` | Default. Zero runner calls: the tool returns the off result and touches nothing else. |
| `shadow` | Runs the full judgment and records it for audit only; no names are returned to the model, and the catalog is unchanged. |
| `active` | Returns the selected names with their relevance and prerequisite numbers, plus how many of the eligible skills were judged. Advisory only — loading still goes through the normal skill tool. |

`shadow` exists so a deployment can be evaluated before `active` is enabled; nothing in this package promotes a mode on its own.

## Settings

Namespace `cc-skill-recommendation`; raw keys are kebab-case. Every threshold is experimental configuration, not a measured quality guarantee.

| Key | Type, range | Default |
| --- | --- | --- |
| `mode` | `off \| shadow \| active` | `off` |
| `timeout-ms` | integer, 100–10000; shared by all batches | `5000` |
| `max-input-tokens` | integer, 512–16384; per batch, including state and all questions | `8192` |
| `max-candidates` | integer, 1–256; cap on the complete eligible pool | `128` |
| `batch-size` | integer, 1–32; max skills per batch (batches are token-packed to the smaller of this and the token budget) | `16` |
| `max-task-chars` | integer, 64–8192 | `2048` |
| `max-metadata-chars` | integer, 128–8192; per item, description plus when-to-use combined | `2048` |
| `min-relevance-index` | finite number, 0–4 | `3` |
| `min-prerequisites-met` | finite number, 0–1 | `0.8` |
| `max-recommendations` | integer, 1–10 | `3` |
| `cache-entries` | integer, 0–1024; zero disables the cache | `128` |
| `cache-ttl-ms` | integer, 0–300000 | `60000` |
| `min-coverage` | finite number, 0–1; minimum fraction of the pool an answered prefix must cover for a deadline-partial result | `1` |

Values are read live on every call, so a mid-session change applies to the next judgment. An absent section means the defaults. An invalid value disables the judgment entirely: the runner is not called, the result is `unavailable`, and the problem is reported once through the logger rather than on every call.

## Install

The package is published as `@dsh-cc/skill-recommender` and is mounted by the `cc` and `vwa` presets (`packages/preset/cc/agent.shared.cordis.yml`), where `mode` stays `off` until you set it. Any other profile or agent composition mounts it explicitly:

```yml
- id: skill-recommender
  name: '@dsh-cc/skill-recommender'
```

The plugin injects `tools` and `skills`; it stays pending until both services exist. It also needs the optional decision runtime (`ctx.systemoneDecisions`, with the root-realm `ccSystemoneDecisions` bridge as the fallback that S1-02's `decision-usage` plugin publishes). Without that service, a bound actor, a resolvable route or a session watermark, every call is `unavailable` with no model call — the catalog stays fully usable. Mounting enables nothing by itself: `mode` defaults to `off`, and enabling a mode is a separate settings change.

## Cache and coalescing

- One in-process cache per plugin fiber: a bounded LRU (`cache-entries`) with lazy TTL expiry (`cache-ttl-ms`). There is no background sweep, no timer and no persistence — an expired entry is simply absent at read time.
- The key pins project, session, agent, session watermark, task hash, the full scoped catalog hash, the full route identity and revision, the question and policy versions, and every threshold that shapes the judgment. Changing a settings value or the catalog therefore produces a new key instead of a stale hit.
- Only complete, validated judgments are stored; a failed batch, a timeout or an abandoned run stores nothing.
- Same-key requests coalesce: one runner call serves every waiter, each caller cancels independently and publishes nothing on its own cancellation, and the shared request is aborted only when the last waiter leaves.
- Before publishing, the catalog hash, the mode and the caller scope are re-read; any change discards the whole recommendation as `unavailable` and no further model call is made inside that request.

## Privacy

The request carries only the task the model supplied and the visible metadata (name, description, when-to-use, source). Skill bodies, skill files, configuration files, conversation history, path-activation results and other scopes' skills are never sent. Return values contain only status, safe names, two numbers per name, the judged/eligible counts and the runtime's decision ids.

Nothing is persisted: no task, no candidate metadata, no new ledger file, and no change to the existing skill-usage telemetry — a recommendation is not a skill load and is never counted as one. Aggregate evaluation is done offline against explicitly redacted corpora (see below).

## Failure behavior

| Condition | Result |
| --- | --- |
| `off` | `off`, zero runner calls |
| empty eligible pool | `recommended` with an empty list (`judged 0 of 0`), zero runner calls |
| missing service, actor, watermark or route; catalog over bounds; task or metadata over bounds; a route that cannot carry two questions (`route-cap`) | `unavailable` with its machine-readable `reason`, empty recommendations |
| lane error, invalid answer, incomplete batch; deadline exhaustion below `min-coverage` or with nothing answered | `unavailable` with its machine-readable `reason`, empty recommendations |
| deadline exhaustion with coverage at or above `min-coverage` | `recommended` from the answered prefix, with disclosed `judged`/`eligible` counts (never cached) |
| valid judgment below the thresholds | `recommended` with an empty list |
| catalog, scope, mode or route changed during the judgment | `unavailable`, the old result is discarded |
| caller cancellation, plugin unload | `cancelled`, nothing published |

Every one of these leaves the original catalog and the normal skill tool untouched.

## Rollback

- Set `mode: off`: the tool keeps existing but returns the off result with zero runner calls.
- Remove the plugin row: the tool is unregistered, in-flight judgments are aborted and the cache is cleared.
- There is nothing to migrate back: no body, skill file or persistent state is created or rewritten.

## Offline evaluation

The corpus replays the pure policy layer with no model call and no network access — a deterministic fake scorer derived from each case's expectations, exercising the shipped pool, question, batching, threshold and ordering code:

```bash
node packages/skill/skill-recommender/scripts/eval-recommendation.mjs \
  --corpus packages/skill/skill-recommender/tests/fixtures/recommendation-corpus.json \
  --mode replay
```

It covers complementary multi-skill tasks, Chinese task phrasing against English descriptions with zero literal overlap, missing prerequisites, explicitly designated skills, mandatory skills, untriggered path-gated skills (absent from the catalog), user-invocable-only skills, and model-invocation-forbidden skills. The script prints one line per case plus a pass rate and exits non-zero on a failure; it prints case ids and counts only, never task text. The production acceptance numbers (Precision@3, missing-prerequisite share, shadow latency and cost) are release gates that require a live deployment and a human-labeled corpus — the offline fixture validates the pipeline, not those targets.

## Known limitations

- **Advisory only.** The result cannot widen invocation eligibility, cannot replace a mandatory rule, and is not a proxy for a skill load.
- **Metadata-driven.** A skill with a thin description and no when-to-use is still judged, but the judgment has less to work with; no undeclared capability is ever assumed.
- **Optional dependency.** Without the decision runtime the tool is inert (`unavailable`), so this package never degrades the catalog path on its own.
- **Mounted in the default preset as a dark row.** The `cc` and `vwa` presets mount it with `mode` set to `off`; nothing enables the tool or a non-off mode without an explicit settings change.
