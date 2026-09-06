# @dsh-cc/command-doctor

English | [中文](README.zh.md)

Human-facing `/doctor` command: a product-grade **session health report**. One data object, three renderings — default text, verbose text, and a JSON file under `$DSH_HOME`. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/doctor` | Cheap in-process checks. `ok` rows collapse to one line; `warn`/`fail`/`skip`/`info` rows expand with summary and suggested fix. |
| `/doctor --verbose` | Cheap checks plus the slow probes: LLM catalog validation, the `serena-hooks` PATH scan, git worktree facts, and a session-store write probe. Evidence is printed on every row. |
| `/doctor --json` | Collects exactly like `--verbose` and writes the full report to `$DSH_HOME/tui/doctor-report.json` (created with parents, overwritten). The command text is only the path, the summary counts, and the fail/warn check ids — never a JSON blob in the transcript. |

`--verbose --json` together collect verbose and emit JSON. Unknown tokens return the usage text as a success result; checks never run on a parse miss.

## Report shape

`DoctorReport` carries `schemaVersion: 1`, `generatedAt`, `durationMs`, an `env` header (dsh-cc/harness/node/os/arch/cwd), and a `checks` array grouped under `env`, `session`, `models`, `mcp`, `hooks`, `web`, `storage`, `git`, `plugins`, and `seams`.

**Consumer rule (schemaVersion):** adding a check id is **not** breaking — consumers must tolerate unknown check ids and groups. Only a `schemaVersion` bump is breaking.

Every string is scrubbed for secret-like substrings (`sk-`, `ghp_`, `xoxb-`, `Bearer `) before rendering or writing, and evidence values are restricted to primitives.

## Composition

The producer injects `commands`. In the `cc` preset it lives inside the `cc-services` group so it can read `ccModelRoutes`, `mcpConnections`, and `hookBridgeStatus`:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-doctor
  name: '@dsh-cc/command-doctor'
```

Every optional seam is duck-typed via `ctx.get`; an absent seam is a `skip` row, not a failure. Each check group is try/catch-isolated, so a throwing seam degrades to one failing row while the command itself still succeeds.

## Known limits

- **No headless CLI** — `dsh doctor` is Phase 2; the command only runs inside a session.
- **No CC-style mutations** — this is read-only + findings + suggested fix; it never edits CLAUDE.md or skills, and MCP operations stay on `/mcp`.
- **Missing fetch provider is info** — a mounted web seam without a fetch provider reports the known `WEB_PROVIDER_UNAVAILABLE` limit, not a failure.
- **Hook discovery is single-file** — CC layered project/user discovery and live reload are not implemented (reported as an `info` row).

## Model Experience

The slash input and the diagnostic output never enter model requests and consume no model tokens. Presentation text is never logged.
