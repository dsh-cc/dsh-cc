# cc-codex-bridge

Official dsh-cc plugin: an **approval-free Codex rescue lane**. Installing it lets a
dsh-cc session run exactly one canonical, locked-down Codex rescue invocation —
`node <launcher> [--last] <prompt>` — with no human permission checkpoint, by
auto-allowing that single command form through a PreToolUse hook.

The core trade is **state relocation, not sandbox widening**: Codex runs with its
internal sandbox off (nested sandboxes cannot stack), while the dsh outer sandbox
remains the single write boundary — workspace plus temp areas only.

## How it works

- One canonical invocation form, pinned byte-for-byte: the interpreter and launcher
  paths must be expansion-free literal tokens equal to the plugin's canonical
  anchors — no PATH lookup, no symlink trampoline, no `~`/glob/`$VAR` expansion,
  no compound commands, no command substitution outside single quotes.
- A PreToolUse hook downgrades the permission verdict for exactly that form; every
  other shape fails closed into the unchanged, approval-requiring flow.
- Codex credentials are synced into a `0700` temp-dir home per run; the Codex CLI
  itself resolves to a validated absolute path at spawn.

## Security model (capability tunnel, stated plainly)

Enabling the bridge means explicitly dropping the human checkpoint for this one
command form. Unattended Codex may run any subprocess the outer sandbox permits —
including actions the permission classifier would otherwise escalate (git push,
ssh, cloud CLIs) and unlimited networking. **Only the filesystem write boundary
holds** (workspace + temp areas); nothing else is claimed. The bridge is opt-in by
installation; **uninstalling or disabling the plugin is the kill switch**.

## Current status

PR-1 ships the skeleton: package layout, marketplace entry, the shared
lexer/argv-parser with its hostile-input fixture table, and a placeholder
`/rescue` command. **Hook activation follows** — invoking Codex rescue today goes
through the normal approval-requiring path.

## Install / uninstall

Install from the dsh-cc marketplace, plugin name `cc-codex-bridge`:

```sh
claude plugin install cc-codex-bridge@dsh-cc
```

Uninstalling (or disabling) the plugin removes the lane entirely:

```sh
claude plugin uninstall cc-codex-bridge@dsh-cc
```

## Known limits

- In dsh-cc's own repo dev sessions the launcher anchor sits inside the workspace,
  so the bridge refuses to arm and degrades to the manual flow (expected,
  documented).
- A non-empty ambient `BASH_ENV` or `ENV` disarms the lane (shell-function
  takeover defense).
- Resume support in v1 is `--last` only.
