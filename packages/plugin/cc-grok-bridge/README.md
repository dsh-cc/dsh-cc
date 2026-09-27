# cc-grok-bridge

Official dsh-cc plugin: an **approval-free Grok review lane**. Installing it lets a
dsh-cc session run exactly one canonical, locked-down Grok review invocation —
`node <launcher> [--last] <prompt>` — with no human permission checkpoint, by
auto-allowing that single command form through a PreToolUse hook.

The core trade is **state relocation, not sandbox widening**: Grok's tool
approvals are bypassed inside the run (`--permission-mode bypassPermissions`),
while the dsh outer sandbox remains the single write boundary — workspace plus
temp areas only.

## How it works

- One canonical invocation form, pinned byte-for-byte: the interpreter and launcher
  paths must be expansion-free literal tokens equal to the plugin's canonical
  anchors — no PATH lookup, no symlink trampoline, no `~`/glob/`$VAR` expansion,
  no compound commands, no command substitution outside single quotes.
- A PreToolUse hook downgrades the permission verdict for exactly that form; every
  other shape fails closed into the unchanged, approval-requiring flow.
- Grok's session state lives in a `0700` temp-dir shadow home (`GROK_HOME`),
  swept to a strict allowlist before each run and seeded with `auth.json`;
  the grok CLI itself resolves to a validated absolute path at spawn.
- Inline prompts must be single-line and must not start with `-`; multi-line or
  dash-leading prompts go through `--prompt-file`.

## Usage

1. **Status at session start.** A SessionStart hook fires on every session
   (startup and resume alike) and injects a `cc-grok-bridge:` block stating
   whether the lane is **ARMED** — including the exact canonical invocation to
   type — or **NOT armed** with the machine reason in plain words.
2. **Invoke the review** with the plugin command:

   ```sh
   /cc-grok-bridge:review review the failing spec
   ```

3. **Multi-line (or dash-leading) prompts** go through `--prompt-file`: write the
   prompt text to a file inside the workspace (or the canonical tmpdir) and use
   the `--prompt-file <path>` form from the SessionStart block.
4. **`--last` only on explicit continue**: the resume flag is used only when
   the user explicitly asks to continue the previous review (it resumes the most
   recent review thread for the current workspace).
5. **Fail closed.** If the SessionStart block is absent or reports NOT armed,
   the model must not guess or construct the canonical invocation — the review
   falls back to the normal, approval-requiring path.

## Authentication

- `grok login --device-code` writes `~/.grok/auth.json`; the bridge seeds that
  file into the shadow home per run (never the reverse — nothing is written
  back to `~/.grok`).
- Alternatively an ambient `XAI_API_KEY` passes through to the child; when it
  is set, a missing `auth.json` source no longer warns.

## Shadow-home semantics

The shadow home is per-workspace (keyed on the canonicalized cwd) under the
canonical tmpdir, mode `0700`, single-flight locked. Before every run the home
is **swept to an allowlist** — exactly `auth.json`, `sessions/`, and the lock —
so config, caches, and auto-loaded surfaces from the interactive Grok state
cannot persist into the lane (cross-run injection control); the credential is
then re-synced with `O_NOFOLLOW` + atomic-rename semantics. A missing/unreadable
source deletes the shadow copy (a revoked token must not live on). A previous
run that outlived its reap budget leaves an `H/.orphaned` poison marker that
blocks further launches until a human removes it.

## Dev-session degradation

In dsh-cc's own repo dev sessions the launcher anchor sits inside the session
workspace, so arming is refused (`anchor-under-writable-root`) and the lane
degrades to the normal approval path. Expected and documented. A non-empty
ambient `BASH_ENV` or `ENV` also disarms the lane (shell-function takeover
defense) — and note the residual: plugin hooks themselves run through the host
shell, so an ambient startup-interception vector could in principle forge this
plugin's own hook verdicts; the lane carries that exposure as accepted-with-
documentation (no in-plugin closure exists).

## Security model (capability tunnel, stated plainly)

Enabling the bridge means explicitly dropping the human checkpoint for this one
command form. Unattended Grok may run any subprocess the outer sandbox permits —
including actions the permission classifier would otherwise escalate (git push,
ssh, cloud CLIs) and unlimited networking. **Only the filesystem write boundary
holds** (workspace + temp areas); nothing else is claimed. The bridge is opt-in
by installation; **uninstalling or disabling the plugin is the kill switch**.

**Credential exposure, stated plainly:** any run executes as the user with
networking; a hostile prompt (or hostile repo content under review) can read the
shadowed `auth.json` (or an ambient `XAI_API_KEY`) and exfiltrate it. Upstream
token lifetime bounds the shadow's value; the sync never writes back.

## Cost honesty

The lane is **unbounded by design**: there is no turn cap. The durable cost
record is the per-run stderr line `grok-review: session=… cost_usd=… turns=…`
emitted by the launcher on success (`grok usage <sessionId>` is not usable
post-hoc, so there is no other record). Keep an eye on the line per run.

## Verified version

Probed end-to-end against **grok 1.0.41**. Newer grok releases may drift
silently (no version gate by design); the standing re-probe recipe lives in the
design doc (`docs/plans/2026-09-27-grok-review-bridge.md` §2) and should be
re-run on grok updates.

## Install / uninstall

Install from the dsh-cc marketplace, plugin name `cc-grok-bridge`:

```sh
claude plugin install cc-grok-bridge@dsh-cc
```

Uninstalling (or disabling) the plugin removes the lane entirely:

```sh
claude plugin uninstall cc-grok-bridge@dsh-cc
```
