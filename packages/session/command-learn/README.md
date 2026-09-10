# @dsh-cc/command-learn

English | [中文](README.zh.md)

User-facing `/learn` command: distills recurring failure→success corrections from the durable session transcripts into workspace memory, so the same mistakes stop recurring across sessions. Analysis lives in the pure library [`@dsh-cc/session-forensics`](../session-forensics/README.md); this package mounts it as a session-scoped slash command with settings and a memory write path.

## Command contract

| Input | Result |
|---|---|
| `/learn` | Dry-run: scan the session store (current project by default, last 14 days), render the ranked findings and the proposed managed memory block. Writes nothing. |
| `/learn apply` | Write the `session-learnings` memory topic file and upsert the `MEMORY.md` pointer through the real `@dsh-cc/memory` writeback helpers. Empty findings leave existing memory untouched. |
| `/learn all` | Scan every project's sessions instead of the current project only. |
| `/learn days=N` | Override the recency window for this run. |
| `/learn help` | Usage text via the shared `helpable()` helper. |

Memory writes are wholesale-regenerated per run inside a marker-delimited managed block (`<!-- dsh-cc:learn:start -->` … `end`) owned entirely by `/learn`; the topic-file description stays stable so the pointer line does not churn between runs.

## Composition

The plugin injects `commands`, `fs`, and `settings`. A custom app mounts its owner plus this plugin:

```yaml
- id: command-learn
  name: '@dsh-cc/command-learn'
```

## Settings

Namespace `cc-learn` (kebab-case, tolerant absence-preserving schema): `enabled` (default `true` — the command is on-demand, nothing runs unprompted; `false` prints a notice and exits), `days` (default `14`), `min-occurrences` (default `2` — only repeated corrections are written).

## Model Experience

The slash input and command output do not consume model tokens. Dry-run output is presentation-only; `apply` writes workspace memory files, which surface to the model only through the normal memory recall surfaces in later sessions.

## Known Limitations and Deferred Work

- Precision of the deterministic analyzers is unvalidated on real data — a manual 20-finding spot check is the dogfooding gate before trusting `apply` output.
- No LLM summarization pass in v1; findings land verbatim with evidence anchors.
