# @dsh-cc/command-auto-mode

English | [中文](README.zh.md)

Human-facing `/auto-mode` command: introspection for the `auto`-mode LLM risk-classifier configuration. The plugin registers one global command through [`ctx.commands`](../../commands/README.md), so every composed command adapter discovers and executes it without a model turn. No model call is made and no token is consumed to answer.

The classifier's policy surface is the `permissions.autoMode` settings section with three slot lists — `soft_deny`, `allow` (exceptions), and `environment` (the trust boundary). Each list supports the literal `"$defaults"` entry, expanded position-preservingly at consumption time. The settings cascade assembles the `autoMode` key from TRUSTED layers only (user, `--settings` flag, managed policy) — project and local (repo-carried) layers are ignored for this key, so a cloned repository can never teach the classifier its own trust boundary.

## Command contract

| Input | Result |
|---|---|
| `/auto-mode defaults` | Print the built-in slot lists (`$defaults`-expanded built-ins only) as JSON, with keys `soft_deny`, `allow`, and `environment`. |
| `/auto-mode config` | Print the effective `permissions.autoMode` slice as the permission-rules engine sees it: the trusted-scoped values, each slot list expanded (`configured` plus `expanded`; `configured: null` means the built-in defaults apply), the resolved classifier sub-config, and the `classifyAllShell` flag. |
| `/auto-mode help` | Render the command help with its subcommand rows. |

An unknown subcommand is a usage error. All output derived from settings text passes through a control-character sanitizer (C0 except newline/tab, DEL, C1), so settings-carried prose cannot smuggle terminal escape sequences into the transcript.

## Configuration

The command takes no `Config` of its own; it reads the live settings section. Configure the classifier through your settings files' `permissions.autoMode` section (`soft_deny`, `allow`, `environment`, `classifyAllShell`, `classifier`) — trusted layers only.
