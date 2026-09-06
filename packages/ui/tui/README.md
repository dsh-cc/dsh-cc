# @dsh-cc/tui

Claude Code-style terminal surface for DeepSeek Harness. Mounted by
`@dsh-cc/bundle-tui` on the **`tui`** profile; new sessions compose the
**`cc`** agent preset.

This package is a protocol driver: it observes `session/event` and drives
`Agent.followup()` / `cancel()`. It does not ship CC tools or slash commands —
those stay on `packages/preset/cc`.

## Boot

```sh
dsh plugin --profile tui add @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell @dsh-cc/bundle-tui
dsh --profile tui
```

Do not add this bundle to the `web` profile. Web coexistence is two profiles,
one backend.

## Keys

- Shift+Tab — cycle CC permission modes (`default` → `acceptEdits` → `plan` → `auto` → `bypassPermissions`)
- `1` / `y` — approve once (approval modal); `2` / `n` or Esc — reject; `3` / `a` — always allow: grants the call and persists a permission rule (see [Approval previews](#approval-previews-and-always-allow))
- Esc — interrupt the current turn; over an overlay it closes the usage panel, cancels the open question, rejects the open approval, or exits `!` shell mode without interrupting a running turn
- Ctrl+C — interrupt while a turn is running; when idle, the first press opens a 2s exit window with a hint and a second press inside it exits, so a stray Ctrl+C never kills the session
- Ctrl+S — inject every queued message into the running turn immediately
- Ctrl+T — toggle the todo panel overlay (arrow keys move the highlight; Esc or a second Ctrl+T closes it)
- Ctrl+O — toggle global collapse: thinking blocks and tool output fold to one-line summaries, and pressing it again restores them
- ↑ (empty composer) — recall the most recent queued message into the composer for editing; with a non-empty composer, ↑ walks composer history; in `!` shell mode, ↑/↓ walk the separate bash history
- Tab — complete slash-command arguments after the command name (supported for `/model`, `/effort`, `/permissions`, and `/resume`)
- `!` — run a local shell command (see [Shell mode](#shell-mode-))
- `/quit` — exit
- `/model` — list or switch the live LLM route
- `/resume [id]` — list persisted sessions, or pin the next launch id
- `/export-md [path]` — write the transcript to a Markdown file; an explicit path resolves against the session cwd, and no argument lands under `$DSH_HOME/tui/exports/<sessionId>-<timestamp>.md` (the directory is created on demand)
- `/copy` — copy the most recent assistant reply to the system clipboard via an OSC 52 sequence (terminal must support OSC 52; no reply yet degrades to a notice)
- `/usage` — open the usage panel: a context-occupancy bar, the token totals (input/output/cache buckets), and the system/tools/messages breakdown, all live while open; Esc closes it. Quota data has no source in this stack and is never shown
- `/permissions` — open a picker of the five CC permission modes (`default` / `acceptEdits` / `plan` / `auto` / `bypassPermissions`); `/permissions <mode>` still switches directly. `bypassPermissions` asks for an in-overlay confirmation first. The rule listing is no longer reachable from the TUI bare invocation (browser popupSelect parity)
- other `/commands` — harness catalog (CC preset)
- user-invocable skills from the skills registry also appear in the `/` menu
  (after commands; a name claimed by a command resolves to the command). A
  `/name` that is not a registered command is sent as a normal user prompt —
  when it names a user-invocable skill, the host's pre-step boundary injects
  the skill instructions (the same path as the web client); anything else is
  ordinary prose. Known limitation: because pi-tui drops autocomplete when its
  provider is replaced, an open `/` menu may close at the moment the skill
  catalog arrives.

## Rendering

- File-edit cards render diffs as hunks with gutter line numbers; long
  unchanged runs between hunks collapse to a dim `… N unchanged lines …`
  marker, and oversized diffs clip on hunk boundaries instead of mid-hunk.
- Consecutive completed file reads fold into one `⏺ Read N files` summary
  line; a running, errored, or lone read keeps its own row.
- The footer reports exact context occupancy — `ctx 43% (86k/200k)` — when the
  model's context window is known, dropping the parenthetical when the line
  is too narrow to fit it.
- Notices under the composer are transient: they clear themselves after a few
  seconds instead of lingering.

## Queueing

Messages submitted while a turn is running are parked in an outbox (shown as
`⏵ queued:` chips) instead of being injected into the running turn. The outbox
flushes automatically into a new turn when the current one ends — including
after a failed turn — or immediately via Ctrl+S. Idle submits send directly and
never enter the outbox, so only unsent messages can be recalled with ↑.
Interrupting (Esc or Ctrl+C while busy) clears the outbox instead of flushing
it.

## Approval previews and always-allow

An approval prompt shows a structured preview of what it is about to run,
recovered from the paired tool event: shell-style calls preview the command,
file edits preview per-file diffs rendered with the transcript's diff renderer,
and other tools preview their pretty-printed arguments. When the preview cannot
be recovered, the prompt degrades to the tool name and reason.

Three answers are available: `1`/`y` approves once, `2`/`n` (or Esc) rejects,
and `3`/`a` answers **always allow** — the call is granted like a one-shot
approval and a permission rule is persisted into the settings allow list. For
shell commands the rule is a first-word prefix with a trailing space
(`Bash(npm )` matches `npm install …` but never `npmx …`); every other tool
gets a whole-tool rule. The applied rule is echoed back as a notice. If the
settings write is unavailable or fails, the call still passes once and a
notice says so.

## Modal queue

Approvals and ask-user questions share one FIFO, so exactly one modal is on
screen at a time. The title shows the queue position (`Approval (1 of 3)`); a
lone head keeps the plain `Approve <tool>?` title. Answering or aborting the
head promotes the next entry, and aborting a still-queued entry removes it
without disturbing what is on screen. Approvals raised by subagents queue and
display the same way, and switching sessions settles every parked modal.

## Shell mode (`!`)

A composer line starting with `!` runs as a **local shell command** instead of
being sent to the model — type `!` on an empty composer or paste a `!`-prefixed
line wholesale. Typing `!` flips the editor border to the warning color;
backspacing it away or pressing Esc restores the accent border.

- Commands execute through the mounted shell executor (120s timeout, 64KB
  output budget) and run even while the agent is busy, bypassing the outbox.
- Output renders as status rows — a `$ <command>` echo plus the combined
  output capped at 20 lines — styled as an error on non-zero exit, signal
  death, or timeout. **Nothing reaches the model or the session log.**
- While a command runs, a `⠋ running…` notice parks above the composer and the
  composer swallows input (Ctrl+C still owns interrupt/quit).
- `!` mode keeps its own history: ↑/↓ browse it, and it persists to
  `$DSH_HOME/tui/bash-history.txt`, separate from the composer's message
  history. Esc exits the mode and never interrupts a running turn.

## Theme

The surface's colors are configurable through the plugin's `theme` config
block. Six roles are available — `accent`, `success`, `error`, `warning`,
`muted`, and `highlight` — each accepting either a basic ANSI color name
(`red`, `brightCyan`) or a raw SGR parameter string (`31`, `1;31`,
`38;5;208`). Every role is optional; unknown names, malformed codes, and
non-string values silently fall back to the built-in palette per role, and an
absent block yields the default look exactly.

Override it from your profile patch (`~/.dsh/profiles/tui/cordis.patch.yml`,
applied after every bundle):

```yaml
- id: tui
  config:
    theme:
      accent: brightCyan
      success: '32'
      error: '1;31'
      warning: '38;5;208'
      muted: '2'
      highlight: magenta
```

The roles drive the editor border and autocomplete, transcript rows, diff
cards, overlay boxes, fenced-code highlighting, and the `!` shell-mode border.
