# @dsh-cc/command-commit-split

English | [中文](README.zh.md)

Advisory dry-run `/commit-split` command: it reads the working-tree change (status + staged + unstaged) through the shell service, asks the deep-reasoning lane (model alias `blueprint`, via [`@dsh-cc/side-query`](../../llm-tuning/side-query/README.md)) for an ordered atomic-commit split plan, and renders it. It **never commits** — the user (or the model, explicitly asked) executes the proposals one by one.

## Command contract

| Input | Result |
|---|---|
| `/commit-split` | Rendered split plan: ordered groups of `{ message, files, dependencyEdges }`, with the declared dependency heuristic in the footer. When the `blueprint` alias is unconfigured, a visible note reports the inherited main-model route. |
| `/commit-split help` | Canonical help text (trailing-`help` support via `@dsh-cc/command-usage`). |

Error sections (no plan emitted): `error: model output did not match the plan schema` for non-conforming model output, and `error: dependency cycle among groups: a → b → a` when the returned dependency edges are cyclic. Cycle detection runs in the command, never in the model.

## Data and model seams

Git data is collected exclusively through `ctx.get('shell')`'s `run` (or `exec`) with a 5s timeout, using exactly three read-only commands: `git status --porcelain`, `git diff --cached --numstat`, `git diff --numstat`. All reads complete before the side query is awaited. The command never runs the model's Bash tool.

Dependency heuristic (declared in the output footer): shared top-level directory plus textual import-reference overlap between changed files, ranking source > test > docs. Lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`) are excluded from model groups into a trailing `chore(deps)` group; a lockfile-only change skips the model entirely.

## Composition

The plugin injects `commands`. A custom app mounts the owner plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-commit-split
  name: '@dsh-cc/command-commit-split'
```

## Model Experience

The slash input and output are absent from model requests. The split query is a one-shot side query on the `blueprint` lane (falling back to the inherited parent route with a visible note); the plan text returned to the user is presentation-only.

## Known Limitations and Deferred Work

- **Advisory only** — no staging, committing, or rewriting is performed; proposals may be imperfect when imports are dynamic or files are generated.
