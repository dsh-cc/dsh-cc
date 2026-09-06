# @dsh-cc/skill-loader

English | [中文](README.zh.md)

Claude Code skill-format compatible provider for the `ctx.skills` registry.

This package discovers `SKILL.md` skills in Claude Code's directory layout (managed, project, user, and additional roots), parses the full Claude Code frontmatter spec, and serves them through `@deepseek-ai/dsh-skill`. It is a compatibility provider: the harness can consume skills written for Claude Code without copying the runtime that executes them. The registry remains in `@deepseek-ai/dsh-skill`; the session catalogs and loader remain in `@deepseek-ai/dsh-tool-skill`.

## Plugin

Requires `ctx.skills` (`inject: ['skills']`).

### Config

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `claude-code` | Unique name used to register this provider on `ctx.skills`. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home resolved by [`@deepseek-ai/dsh-home-paths`](../../util/home-paths/README.md); scans `skills` under this directory as the user root. |
| `managedDir` | — | Optional managed policy root scanned before all defaults. |
| `additionalDirs` | `[]` | Additional skill roots appended after project and user roots. |

## Discovery

Roots are discovered in this precedence order (lower rank wins name conflicts):

| Rank | Source | Path |
|---|---|---|
| 100 | managed | `config.managedDir` |
| 200 | project | `<projectRoot>/.claude/skills` |
| 300 | user | `<dshHome>/skills` |
| 400 | additional | each `config.additionalDirs` |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. Skills are directory bundles `<name>/SKILL.md`; legacy `.claude/commands/*.md` files are also loaded and marked `deprecated` in their metadata. Discovery deduplicates by the real path, so a symlinked or overlapping file is served once.

## Skill Format

`SKILL.md` is parsed as a YAML frontmatter document split from a Markdown body. The provider reads every known Claude Code field and tolerates unknown fields; a known field with an invalid value fails loudly at load rather than silently mis-activating.

Supported fields: `description`, `name`, `allowed-tools`, `argument-hint`, `arguments`, `when_to_use`, `version`, `model` (including `inherit`), `user-invocable`, `disable-model-invocation`, `context` (including `fork`), `agent`, `effort`, `shell`, `hooks`, and `paths`. Names must be kebab-case to register on the registry.

## Semantic translation

The provider parses and serves Claude Code fields unchanged; for most fields applying them to harness seams is the consumer's job at activation time (`paths` is the exception — see [Conditional activation](#conditional-activation), which the provider wires itself). The package exports the translators:

- `ccRestriction(allowedTools)` — turns `allowed-tools` into an allow-only `tools.restrict()` filter (a `*` or empty list yields `undefined`, so the skill inherits the caller's surface).
- `ccPathMatcher(patterns)` / `registerPathActivator(ctx, ...)` — the low-level primitives behind conditional activation (see below).
- `ccInvocation(parsed)` — resolves `disable-model-invocation` and `user-invocable` into the registry's invocation policy.
- `context: fork` — surfaced as `metadata.executionContext`; consumers route the skill to `ctx.subagents.start()` with its rendered body.

## Conditional activation

A skill whose frontmatter declares `paths` is a *conditional* skill matching Claude Code's semantics: it is not served until a Read/Write/Edit tool touches a file that matches one of its gitignore-style project-relative `paths`. The provider wires this itself at `apply()`:

1. `list()` parses every candidate; a `paths`-gated skill is **excluded from the catalog** until activated.
2. On `fs/observed`, a `read`/`write`/`edit` actor touching a matching path inside the project activates that skill (once — repeat touches are idempotent), then calls the provider control's `invalidate()`. Consumers refetch the catalog via `skills/change` and the skill now appears.
3. `get()` serves the activated skill normally.

This is `registerPathActivator` wired onto the provider's live per-project conditional catalog (the helper's static `projects` shape cannot model per-skill dynamic patterns, so the provider owns the listener while reusing `ccPathMatcher`). Skills already in the catalog never re-notify.

## Bundled skills

The provider ships a portable subset of Claude Code's own bundled skills as in-package `SKILL.md` documents, served directly (no disk extraction). Current subset: `debug`, `simplify`, `batch`. They are provided with `source: 'bundled'`, `rank = BUNDLED_SKILL_RANK` (600), and bodies available via `get()`. Because 600 is the highest rank in this package's range, any managed (100), project (200), user (300), or additional (400) skill of the same name wins the name conflict — matching Claude Code's precedence where local skills override built-ins.

CC's `verify` and `stuck` bundled skills are **not** ported: both are `USER_TYPE === 'ant'`-only, and `verify`'s companion body/examples are absent from the Claude Code build surface, so they cannot be reproduced faithfully.

## Rendering

`renderSkillBody` substitutes `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n`, named `$name` placeholders, and `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}`, and segments inline-shell `` !`...` `` commands for the caller to execute (guarded by `allowInlineShell`, which MCP-sourced skills must force off). `estimateFrontmatterTokens` counts only name, description, and `when_to_use` — the body is never counted during discovery.

## Known Limitations and Deferred Work

- **Most semantic translation is consumer-side** — `allowed-tools`, `context: fork`, and `argument-hint` are surfaced as metadata and helpers and applied by the consumer, because a provider has no agent reference at load time. `paths` conditional activation is the exception and is applied by this provider.
- **Inline shell is not executed by this package** — commands are extracted and returned; execution is the caller's responsibility.
- **One-level discovery** — only `<root>/<name>/SKILL.md` and legacy top-level `.claude/commands/*.md` are recognized.
- **Bundled subset is partial** — `verify` and `stuck` are omitted (ant-only / missing content); `batch`'s and `debug`'s runtime-injected values (tool names, log paths) are kept as authored literal placeholders rather than resolved at invocation.
