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

## Usage

1. **Status at session start.** A SessionStart hook fires on every session
   (startup and resume alike) and injects a `cc-codex-bridge:` block stating
   whether the lane is **ARMED** — including the exact canonical invocation to
   type — or **NOT armed** with the machine reason in plain words.
2. **Invoke the rescue** with the plugin command:

   ```sh
   /cc-codex-bridge:rescue review the failing spec
   ```

   The bare `rescue` name may collide with the Codex plugin's command, in
   which case the bare registration is skipped — the scoped name above and the
   always-present SessionStart canonical block keep the lane usable regardless.
3. **Multi-line prompts** go through `--prompt-file`: write the prompt text to
   a file inside the workspace (or the canonical tmpdir) and use the
   `--prompt-file <path>` form from the SessionStart block.
4. **`--last` only on explicit continue**: the resume flag is used only when
   the user explicitly asks to continue the previous rescue.
5. **Fail closed.** If the SessionStart block is absent or reports NOT armed,
   the model must not guess or construct the canonical invocation — the rescue
   falls back to the normal, approval-requiring path (stock `/codex:rescue`).

## Dev-session degradation

In dsh-cc's own repo dev sessions the launcher anchor sits inside the session
workspace, so arming is refused (`anchor-under-writable-root`) and the lane
degrades to the normal approval path. Expected and documented.

## Security model (capability tunnel, stated plainly)

Enabling the bridge means explicitly dropping the human checkpoint for this one
command form. Unattended Codex may run any subprocess the outer sandbox permits —
including actions the permission classifier would otherwise escalate (git push,
ssh, cloud CLIs) and unlimited networking. **Only the filesystem write boundary
holds** (workspace + temp areas); nothing else is claimed. The bridge is opt-in by
installation; **uninstalling or disabling the plugin is the kill switch**.

## Current status

PR-1 shipped the skeleton, PR-2 activated the gate (the PreToolUse hook that
auto-allows exactly the canonical rescue invocation), and PR-3 completes the
entry surface: the SessionStart status/canonical-block hook and the final
`/cc-codex-bridge:rescue` command — the lane is fully usable once the plugin
is installed.

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
