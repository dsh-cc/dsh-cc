# cc-grok-bridge: an approval-free Grok review lane (structured mirror of codex-rescue-bridge)

**Status:** **Shipped — PR #166 (2026-09-27)**. Five review rounds: critic ×4 (closure all pins applied), grok dogfood lane SHIP-WITH-FIXES; codex ×4 NO-GO (65 findings adjudicated one by one: 61 folded, 4 adjudicated-final with reasons in §8; lane retired by user decision — divergence adjudicated per the project rule, not obeyed infinitely). Probe evidence (§2): executed 2026-09-27 against grok 1.0.41 (`4220f3b224a6`, Mach-O arm64) under the session's dsh `workspace-write` confine, incl. review-triggered P10–P14.
**Date:** 2026-09-27
**Worktree:** `.claude/worktrees/grok-plugin` (branch `worktree-grok-plugin`)
**Reference design:** `docs/plans/2026-09-26-codex-rescue-bridge.md` (shipped as #159/#160/#161). Structural mirror; every deviation is enumerated (§3.1.D) with its grounding (probe vs reasoning).

## 1. Problem

dsh-cc sessions can call Codex as a peer engineer through cc-codex-bridge: one canonical, byte-pinned bash invocation, auto-allowed by a PreToolUse hook, the dsh outer sandbox as the single write boundary, zero interactive approval. The user keeps a working **Grok CLI** (Grok Build 1.0.41) and wants the same lane for Grok, for design/code **review** duties — dispatched from any session without approval prompts and without touching the user's interactive Grok state.

The naive invocation fails twice: (a) Grok writes session state under `~/.grok`, outside every writable root of a `workspace-write` session (P3: `FS_PERMISSION_DENIED`); (b) any ad-hoc bash invocation hits the permission system (worst in `auto`, where `grok`-headed rules never survive the suspender).

The shape of the fix is proven by cc-codex-bridge: relocate the state root into the canonical tmpdir, pre-allow exactly one locked-down invocation shape, outer sandbox stays the write boundary. Grok needs *less* heroics on the sandbox front (no nested-Seatbelt fight — P5) and *more* hygiene on the state front (persistent auto-loaded home surfaces — D14 allowlist sweep) and the lifecycle front (unbounded runs — D15/D18 memoized ordered group-kill).

## 2. Probe evidence (executed 2026-09-27)

"Derived home" = a fresh, workspace-local `GROK_HOME` seeded with `cp -p ~/.grok/auth.json`. Probes never passed `--cwd` (spawn-cwd inheritance is the probed surface). §2 doubles as the re-probe recipe — the compact command list at the end of the section is exact; there is no CI harness for these by design (they consume network + model quota); the standing dogfood item (§6) re-runs them on grok updates.

- **P1 — binary shape.** `~/.local/bin/grok` → `~/.grok/downloads/grok-1.0.41-macos-aarch64` (Mach-O arm64, 139M); realpath outside every writable root → passes the launcher CLI check. `strings` enumerates `GROK_HOME` (supported state-root override) and `GROK_SANDBOX` (env-mapped `--sandbox <PROFILE>`).
- **P2 — headless happy path.** `grok -p 'Reply with exactly: X' --max-turns 1 --output-format json` → one pretty JSON document on stdout: `{text, stopReason, sessionId, requestId, thought, usage{…}, num_turns, total_cost_usd, …}`; stderr silent; exit 0.
- **P3 — sandbox-struck default.** Without `GROK_HOME` redirect: stdout `{"type":"error","message":"Couldn't create session: … FS_PERMISSION_DENIED"}`, stderr human text, exit **1**. Exit-code contract: failures are non-zero; error JSON on stdout + human text on stderr.
- **P4 — relocation + credential seed.** Fresh `GROK_HOME` self-initializes → `Not signed in` (auth = `$GROK_HOME/auth.json`, 0600, plain file, not keychain); seeding it succeeds, exit 0, zero escalation. `grok login --device-code` prints device URL + user_code, exits 0 on approval (verified in-session).
- **P5 — tools under nested confinement (load-bearing).** Derived home + `--permission-mode bypassPermissions`, tool-forcing prompt (write `grok_probe_done` to a workspace file via shell): file landed, exit 0. No EPERM class (contrast `codex exec --sandbox read-only` dying at nested `sandbox_apply`).
- **P6 — default permission mode reads.** Without bypass, reads auto-approved headlessly, exit 0. (`.text` may carry a preamble sentence.)
- **P7 — resume surface.** `-c -p '…'` continues **most recent session for current cwd** (inherited cwd) in the active home: correct recall, same `sessionId`, exit 0. `-c` in a fresh home fails loud (`No session found for current directory`, exit 1).
- **P8 — prompt-file channel.** `grok --prompt-file <abs> --output-format json` is complete headless: P2 JSON, exit 0.
- **P9 — credential alternatives.** Grok's own error names `XAI_API_KEY` as the alternative. Ambient env passes through (minus D10's scrub list). **Not end-to-end probed** (no key on this machine).
- **P10 — sandbox-profile behavior.** `GROK_SANDBOX=<undefined>`: stderr-only warning then **fail closed** (`Refusing to start with its protections missing.`, exit 1; stdout pristine) → D10 scrubs it from the child.
- **P11 — resume + prompt-file.** Seed via `--prompt-file`, continue via `-c --prompt-file`: correct recall, exit 0.
- **P12 — leading-dash inline prompt.** `grok -p '-restart-from-scratch …'` → clap misparse (`a value is required for '--single <PROMPT>'`, exit **2**) → D9.
- **P13 — sweep then resume.** After one seeded run the home contains `auth.json sessions/ .config-init.lock .metadata_version agent_id bundled/ config.toml docs/ grove/ installed-plugins/ logs/ managed_config.lock models_cache.json README.md settings_cache.json worktrees.db`. Sweeping to `{auth.json, sessions/}`: next plain run fully re-initializes (exit 0), and `-c` resume of the pre-sweep session recalls its token (same `sessionId`, exit 0).
- **P14 — `grok usage` lifetime.** Post-sweep, `grok usage <sessionId>` → `Session '…' not found.` (sloppy exit 0). Per-run stderr cost summary is the durable cost channel; `grok usage` is not usable post-hoc and is not documented as such.

**Exact probe recipe** (for §6 re-probes; `<DT>` = `mktemp -d` dir, each seeded with `cp -p ~/.grok/auth.json <DT>/auth.json`):

```bash
grok --version; file "$(which grok)"; readlink -f "$(which grok)"          # P1
GROK_HOME=<DT> grok -p 'Reply with exactly: PROBE_OK' --max-turns 1 --output-format json   # P2
# P3: same without GROK_HOME          (expect FS_PERMISSION_DENIED, exit 1)
# P4: shows fresh-home init + Not signed in; then seeded run (that IS the P2 row)
GROK_HOME=<DT> grok -p 'Write the word X into probe-write.txt here via shell, reply DONE' --permission-mode bypassPermissions --output-format json   # P5/P6 variants as documented
GROK_HOME=<DT> grok -c -p '…' --output-format json                          # P7 (after a P2/P5 seed in <DT>)
GROK_HOME=<DT> grok --prompt-file "$PWD/<file>" --output-format json        # P8
GROK_HOME=<DT> GROK_SANDBOX=bogus-name grok -p 'hi' --max-turns 1           # P10 (stderr closed-form, exit 1)
GROK_HOME=<DT> grok -c --prompt-file "$PWD/<file>"                          # P11
GROK_HOME=<DT> grok -p '-restart-from-scratch now' --output-format json     # P12 (exit 2)
# P13: seed once; rm -rf everything under <DT> except auth.json + sessions; plain run; then -c recall row
GROK_HOME=<DT> grok usage <sessionId>                                       # P14 (post-sweep: not found)
```

Probe artifacts were removed after execution; the worktree held no residue.

## 3. Design

Single deliverable: plugin **`cc-grok-bridge`** under `packages/plugin/cc-grok-bridge/`, mirroring `packages/plugin/cc-codex-bridge/` (launcher + shared parser/lexer + canonical arming module + PreToolUse allow hook + SessionStart context hook + static slash command + tests).

### 3.1 Launcher — `scripts/grok-review-run.mjs`

Grammar (`lexer.mjs` copied **verbatim** — zero lexer changes, and a byte-identity test pins it against the codex package's copy; the grok plugin's `argv.mjs` copy carries D9 + D13):

```
grok-review-run.mjs [--last] -- <single-line prompt>        # first char not '-'; contains no \n or \r
grok-review-run.mjs [--last] --prompt-file <path>
```

Testability seam (codex-R5 #14/#15): the launcher is structured as an exported `runLauncher(argv, deps?)` whose `deps` carries every nondeterministic collaborator (`fs`-level ops, `spawn`, `now`, signal registration, `exitWith`) with production defaults; deterministic/race rows drive injected deps, integration subprocess rows cover the real ones.

Behavior, in order — **`main` wraps steps 4–11 in one whole-region `try/finally` whose finalization is the §3.1-T state machine's `finalize()`** (codex-R5 B1; mirrors codex-rescue-run.mjs's try/finally discipline):

1. **Platform gate:** `process.platform === 'win32'` → die loud. (Arming also refuses win32 — D17.)
2. **Writable roots** = canonicalized `{realpath(cwd), realpath(tmpdir), realpath('/tmp')}` (unrealpathable skipped).
3. **Self-assert:** `realpath(process.execPath)` outside every writable root.
4. **Parse own argv** (shared `parseArgv` + D9/D13, both in the argv copy). Pinned reasons: `dash-leading-inline-prompt`; `control-char-in-prompt` (`\n`+`\r`). Invalid shape → usage on stderr, exit 2.
5. **Shadow state root** (`scripts/lib/home.mjs` — grok variant, D18): `R = realpath(tmpdir)/grok-review-home-<uid>`, `H = R/sha256(realpath(cwd)).hex[0:16]`; mkdir `0700`; lstat-validate R and H; plain-ancestor chain. **Signal handlers are registered at the START of this step, before `acquireLock(H)`** — there is no signal window that could orphan the lock (a handler with no lock/child yet runs a trivially-guarded `finalize()`: best-effort unlink that misses nothing, `release()` that no-ops when unacquired). `acquireLock(H)` (mkdir `H/.lock`, owner nonce, 60s heartbeat, >6h stale reclaim) — **no signal/exit handlers inside home.mjs**; it returns a sync `release()`. **Orphan marker check: if `H/.orphaned` exists, die** `grok-review: previous run left a live child after the reap budget (H/.orphaned) — inspect processes and remove the marker to re-enable this lane`, exit 1 (codex-R5 B3).
6. **Sweep, then credentials, inside the lock** (order closes the planted-destination DoS, codex-R4 #7). Every `.tmp-*` writer below tracks its temp path and unlinks it in its own `finally` — no temp residue, ever. **Ordering invariant (load-bearing): the step-5 `.orphaned` check strictly precedes this sweep, and `.orphaned` is never in the sweep allowlist** — reordering or allowlisting would silently delete the poison marker; §5 pins a test row. Sweep failure of any entry is **fail-closed** (abort the launch, exit 1 — the sweep is a security control, not hygiene):
   - **D14 sweep (allowlist, probe-proven P13):** enumerate `H` children; keep exactly three names: `auth.json`, `sessions`, `.lock`; remove (recursive force) everything else. Kept names are lstat-validated: `sessions` absent-or-real-dir, `auth.json` absent-or-regular-file — symlink/foreign types removed. Durable state = this lane's own transcript store + the freshly synced credential.
   - **Sync (D19):** `os.homedir()/.grok/auth.json` → `H/auth.json`: source lstat regular-file → `O_NOFOLLOW` open → **fstat THAT fd for regular-file again** (codex's own post-open check, kept — codex-R5 #9) → write `H/.tmp-<random>` 0600 → fsync → atomic rename (overwrite). Source errors in `{ENOENT, ENOTDIR, EACCES, EPERM}` ⇒ missing/unreadable class: delete the shadow, warn **only if ambient `XAI_API_KEY` unset**, proceed. Anything else aborts.
7. **Resolve `grok`:** PATH scan + realpath; first hit outside every writable root wins; none → `grok-review: grok CLI not found on PATH outside the writable roots`, exit 1.
8. **Prompt materialization (write-through; only bridge-owned paths reach Grok):**
   - Inline: verbatim as final `-p` argv value.
   - `--prompt-file <path>`: `O_NOFOLLOW` open; fstat regular; **bounded read of at most 262145 bytes** (cap enforced by the read itself: over-cap dies `grok-review: prompt-file exceeds the 262144-byte cap`, exit 1). Bytes → `H/.prompt-current.txt` (`H/.tmp-<random>` 0600 → fsync → rename). Pass `realpath(H/.prompt-current.txt)` to Grok. **Unlinked in `finalize()`** regardless of outcome — prompt bytes never persist. Residual: hook-check→first-open window on the caller path (§4 item 7).
9. **Spawn:** `spawn(grokPath, args, { cwd: realpath(process.cwd()), env, stdio: ['ignore', 'pipe', 'inherit'], detached: true })` — group leader so termination reaches grok + group-resident descendants (escapees: §4 item 7). No `--cwd` flag. Env = `buildChildEnv(process.env, H)`: `{ ...env, GROK_HOME: H }` minus `GROK_SESSION_ID`, `GROK_AGENT`, `GROK_SANDBOX` — pure exported helper, unit-tested; no in-process mutation claims (observable checks only).

   `args` (canonical order, pinned; `-c` only for `--last`; prompt selector last):
   ```
   --permission-mode bypassPermissions --output-format json [-c] (-p <promptText> | --prompt-file <H/.prompt-current.txt realpath>)
   ```
10. **Output contract (formatter pinned per codex-R5 #11/#12/#13):**
    - Stdout capture buffers at most **16 MiB + 1 byte**; the breach byte triggers `terminate('stdout-cap')` and later chunks are **discarded, never appended** (memory stays bounded through teardown). Die `grok-review: grok stdout exceeded the 16 MiB capture cap`, exit 1.
    - Then the formatter, exactly (applies only to a close that carries an exit code — **a null-code signal close bypasses the formatter entirely, nothing of the partial capture is printed**): attempt `JSON.parse` on the captured document (decoded leniently — the captured buffer is used **as-is** for any passthrough; no decode/re-encode of raw passthrough bytes).
      - parse succeeds AND `typeof doc.text === 'string'` (empty qualifies) → print `doc.text` to stdout, appending `\n` iff it doesn't already end with one. (Works identically when the child exit code is non-zero — exit code is always the child's, pinned below.)
      - otherwise (parse failure; primitives/arrays/null; object without string `.text`) → write the **captured buffer verbatim** to stdout.
    - Success-path stderr summary (parse-succeeded cases only): `grok-review: session=<s> cost_usd=<c> turns=<t>` where `<s>` is `doc.sessionId` coerced string, control-chars stripped, capped at 64 chars; `<c>` only if `typeof doc.total_cost_usd === 'number'`; `<t>` only if `typeof doc.num_turns === 'number'`; absent/invalid fields are dropped from the line. The `grok-review:` prefix **marks launcher-authorship by convention, not proof** — the stderr stream is shared with the child (inherited) and genuinely diagnostic only. The line is the durable cost record (P14).
    - Exit-code mapping (the complete table is §3.1-T): child `close` with a code → that code; `close` with null code (signal) → stderr `grok-review: grok terminated by signal <SIG*>` + exit 1; spawn error → exit 1.
11. **Lifecycle / termination (D15+D18) — the whole contract is the §3.1-T table; `finalize()` and `terminate(reason)` are memoized, single-path, exactly-once.**

#### 3.1-T Termination state machine (complete)

States: `INIT` (step 1–8 synchronous region) · `RUNNING` (child spawned) · `TERMINATING` (a reap is in flight) · `DONE` (post-finalize; terminal).
Actions: `killGroup(signal)` = `process.kill(-child.pid, signal)` if a child exists (ESRCH tolerated); `finalize()` = best-effort `unlink(H/.prompt-current.txt)` → `release()` → set state `DONE` → `exitWith(code)` (memoized: second call is a no-op). Timers: reap grace 2 s to SIGKILL, total reap budget 5 s; on budget expiry ⇒ write `H/.orphaned` (0600, content `reap-budget-expired <iso-time>`) and proceed (the survivor joins §4 item 7; step 5's marker check gates the next launch).

| # | Event (from state) | Termination action | Stdout printed | Exit code |
|---|---|---|---|---|
| T1 | sync failure in INIT (parse die, sweep/sync/resolve/materialize throw) | none (no child) | nothing (errors → stderr) | per row: 1 or 2 |
| T2 | normal child `close(code=k)` (RUNNING) | no reap needed (already closed) | formatter result per §10 | **k** |
| T3 | child `close(code=null, signal=SIG*)` without prior terminate (RUNNING) | none needed | nothing for the doc | **1** + signal message |
| T4 | stdout-cap breach (RUNNING) | `terminate('stdout-cap')`: TERM→2 s→KILL→await close ≤5 s budget | nothing | **1** + cap message |
| T5 | signal SIGINT/SIGTERM/SIGHUP in INIT (no child) | none | nothing | **130** (uniform-cancelled, deliberate) |
| T6 | signal in RUNNING | `terminate('signal')` as T4's action | nothing | **130** |
| T7 | second signal while TERMINATING | immediate `killGroup(SIGKILL)`; budget not extended | — | (rule T6's 130) |
| T8 | child spawn `error` event | memoized terminate sees no closed child → group-kill best-effort | nothing | **1** |
| T9 | reap budget expiry (from T4/T6) | write `H/.orphaned`, proceed to finalize | — | the initiating row's code (T4 → 1, T6 → 130) |
| T10 | uncatchable launcher death (SIGKILL etc.) | — (no hook runs) | — | process dies; lock remains → >6 h stale reclaim; `.orphaned` NOT written (nothing observed it) — §4 item 7 |

`finalize()` runs on EVERY path via the whole-region `try/finally` (T1 included — prompt-file safety even when spawn never happens). Signal handlers are **registered at the start of step 5, before `acquireLock`** (no signal can strand the lock: pre-lock signals hit a guarded `finalize()` with nothing to reap/release), and removed in `finalize()`.

#### 3.1.D Deviations from the codex launcher (complete list)

| # | codex-rescue-run.mjs (accurate baseline) | grok-review-run.mjs | Grounding |
|---|---|---|---|
| D1 | `CODEX_HOME` shadow | `GROK_HOME` shadow | P1/P3/P4 (probe) |
| D2 | syncs `auth.json` + `config.toml` | syncs only `auth.json`; user `config.toml` dropped — accepted divergence, README-documented | P4/P13 (probe) |
| D3 | `codex exec --sandbox danger-full-access --cd <cwd> -o <H>/last-message.txt` (absolute), prompt read then handed via stdin `-` | `grok --permission-mode bypassPermissions --output-format json`; `-p` argv / native `--prompt-file`; spawn-option cwd, no `--cwd` flag | P2/P5/P8/P11 (probe) |
| D4 | `--last` → `codex exec resume --last` | `--last` → `grok -c` | P7/P11/P13 (probe) |
| D5 | prints `last-message.txt` | formatter contract (§10) + sanitized stderr cost line | P2/P8/P14 (probe) |
| D6 | stdin prompt; readFileSync-after-fstat cap | bounded cap+1 fd read; inline rides argv (OS arg limits; long content → `--prompt-file`) | reasoning (codex R3 #6) |
| D7 | — | ambient `XAI_API_KEY` passes through; missing-auth warn suppressed when set | P9 (documented, not probed) |
| D8 | no credential write-back (residual) | identical residual | reasoning |
| D9 | leading-dash inline allowed | rejected (`dash-leading-inline-prompt`, exit 2); fallback `--prompt-file`; in ARMED text + review.md | P12 (probe) |
| D10 | child env adds only `CODEX_HOME` | additionally deletes `GROK_SESSION_ID`/`GROK_AGENT`/`GROK_SANDBOX`; `buildChildEnv` helper | reasoning + P10 |
| D11 | prompt bytes reach codex via stdin (no caller path leaves the bridge) | bridge-owned shadow file (grok needs a path); unlinked at finalize; hook-check→first-open window on the caller path remains | reasoning (codex R1 F1, R4 #6/#12) |
| D12 | stderr prefix `codex-rescue:` | prefix `grok-review:` (convention, not provenance) + cost line | naming + codex R3/R4/R5 |
| D13 | `\n` rejected as `prompt-newline` (argv copy) | `control-char-in-prompt` covers `\n`+`\r`; lexer verbatim + byte-identity test | reasoning (codex R3 #14/R4 #15/R5 #17) |
| D14 | no surface reset | sweep-before-sync; allowlist `{auth.json, sessions, .lock}` + lstat type-validation of kept names | P13 (probe) + codex R3/R4 |
| D15 | signals exit the launcher; child fate unspecified | memoized ordered group reap (§3.1-T) + `H/.orphaned` poison marker gating later launches | reasoning (codex R3 B4, R4 #4/#10, R5 B3) |
| D16 | unbounded stdout; no per-run cost line | 16 MiB cap (discard-after-breach) + stderr `session=/cost_usd=/turns=` | codex R3 #6/#12, R5 #11 |
| D17 | arming ignores platform | `arming(cwdRaw, {hookUrl, env, platform = process.platform})` refuses win32 (`platform-win32`) | codex R3 #10 |
| D18 | home.mjs wires signal/exit release internally | grok variant: no handlers; sync `release()`; launcher owns lifecycle | critic R4 F2 |
| D19 | any lstat failure ⇒ missing class; open failures propagate | `{ENOENT, ENOTDIR, EACCES, EPERM}` ⇒ missing class; else abort; post-open fstat recheck kept | codex R3 #12, R4 #14, R5 #9 |
| D20 | inline main() | `runLauncher(argv, deps?)` with injected collaborators for deterministic race/fault rows | codex R5 #14/#15 |

### 3.2 Pre-execute allow listener — `hooks/grok-review-allow.mjs`

Structural copy of `codex-rescue-allow.mjs`:

- Non-Bash tool / non-string command / parse failure / disarmed / match failure → **emit nothing, exit 0**. Never denies.
- Arming via the grok plugin's own copy of `scripts/lib/canonical.mjs` (D17 version): hook-process `realpath(process.execPath)` + sibling `scripts/grok-review-run.mjs` realpath off the hook's `import.meta.url`; both outside `{realpath(cwd), realpath(tmpdir), realpath('/tmp')}`; ambient `BASH_ENV`/`ENV` empty; platform not win32. Per call.
- Byte-exact `matchInvocation(command, {node, launcher})`; **the anchors (argv0/argv1) are expansion-free literal tokens** — the prompt word may carry expansion flags by design (it is data, never executed; codex-R5 #8 wording correction, mirrored grammar); env-assignment heads rejected (`env-assignment-prefix`).
- `--prompt-file` containment: resolved path inside `{cwd, tmpdir}` else silence (checks the caller-facing path; grok sees only the bridge-owned shadow file).
- Match ⇒ one line `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"cc-grok-bridge: canonical review invocation (byte-pinned anchors, expansion-free)"}}`. (Top-level `decision:"allow"` is dropped by the codec — shipped knowledge.)
- **Hook-startup interception note (codex R3 B1 + R4 B1 + R5 B5):** see §4 item 8 — explicitly adjudicated, accepted-with-documentation.

Auto-mode lane legality: hook verdicts are code-level waterfall listeners; the settings-rule suspender does not govern them (same as codex).

### 3.3 Entry surface

**SessionStart context hook — `hooks/grok-review-context.mjs`:** structural copy of `codex-rescue-context.mjs` **including the codex fallback**: missing/non-string `payload.cwd` falls back to `process.cwd()`; true failures (unparseable stdin, derivation throw) ⇒ silent exit 0. Success ⇒ one `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<text>}}` line. Texts (pinned):

ARMED (anchor paths POSIX single-quote-escaped at derivation):

```
cc-grok-bridge: the Grok review lane is ARMED. Use EXACTLY this canonical invocation for a Grok review:
'<node>' '<launcher>' -- 'the review request, single line'
For a multi-line prompt (or any request whose first character is `-` — dash-leading inline prompts are rejected by the launcher), write the text to a file inside this workspace (or the canonical tmpdir), then run:
'<node>' '<launcher>' --prompt-file 'the prompt file path'
Add --last ONLY when the user explicitly asks to continue the previous review (it resumes the most recent review thread for this workspace).
```

REFUSED:

```
cc-grok-bridge: the Grok review lane is NOT armed (reason: <machine-reason> — <plain words>).
Grok review today goes through the normal, approval-requiring path; do NOT guess or construct the bridge's canonical bash invocation manually.
```

refusal texts reuse codex's strings (lane name swapped) plus `platform-win32` → `platform win32 is unsupported — the launcher refuses it too`.

**Slash command — `commands/review.md`:** frontmatter exactly

```
---
description: Run a Grok review through the cc-grok-bridge lane
argument-hint: "[review request]"
---
```

Body: structural copy of codex's `rescue.md` (`$ARGUMENTS` dispatch; SessionStart block verbatim; `--last` only on explicit user ask; inline prompt first character must not be `-`, use `--prompt-file`) EXCEPT the fallback: no stock `/grok:rescue` exists, so the fail-closed sentence is verbatim: *"If the SessionStart block is missing or reports NOT armed, STOP: do not guess or construct any invocation; tell the user the Grok review lane is not armed in this session."* Renders as `/cc-grok-bridge:review …`.

**Marketplace — `.claude-plugin/marketplace.json`** gains, immediately after the `cc-codex-bridge` stanza:

```json
    {
      "name": "cc-grok-bridge",
      "source": "./packages/plugin/cc-grok-bridge",
      "description": "Official dsh-cc plugin: an approval-free Grok review lane — one canonical, locked-down bash invocation auto-allowed via a PreToolUse hook, with Grok's tool approvals bypassed inside the run while the dsh outer sandbox remains the single write boundary."
    }
```

### 3.4 Packaging and gates

- `packages/plugin/cc-grok-bridge/package.json`: `name: "@dsh-cc/plugin-cc-grok-bridge"`, `description`/`version` shared with the plugin manifest (version = codex package's at implementation time), `"type": "module"`, `files: [".claude-plugin/plugin.json", "commands", "hooks", "scripts", "README.md"]`, publishConfig public, repository directory `packages/plugin/cc-grok-bridge`.
- `.claude-plugin/plugin.json`: `name: "cc-grok-bridge"` (unscoped plugin id), same `description` + `version`.
- README trio modeled on codex's: install/usage; auth (`grok login --device-code` → `~/.grok/auth.json`, or ambient `XAI_API_KEY`); `BASH_ENV`/`ENV` disarm **and** startup-interception residual (§4 item 8); shadow-home semantics (D8/D14/D2); capability-tunnel paragraph; **credential-exposure warning** (§4 item 3); cost honesty (**unbounded lane**; durable cost record = the per-run stderr line, `grok usage` unusable post-hoc per P14); **verified version** (probed on 1.0.41; newer grok may drift silently; standing re-probe = §2 recipe).
- Capability row: the complete verbatim yaml lives in this design's §3.4 anchor block below; position between `plugins.foreign-rules` and `plugins.loader` (I7). `pnpm docs:parity` artifacts in the same commit.

```yaml
  plugins.grok-bridge:
    title: Grok review bridge plugin (cc-grok-bridge)
    category: plugins
    plane: host
    upstream:
      summary: >-
        dsh-cc extension with no Claude Code analog: an official marketplace
        plugin providing an approval-free Grok review lane — one canonical,
        byte-pinned bash invocation auto-allowed through a PreToolUse hook,
        with the armed/refused status and the exact canonical command surfaced
        at session start via a SessionStart additionalContext hook and a
        static /review slash command.
      refs: []
    dimensions:
      recognized: true
      mounted: true
      behavioral: full
      ux: full
    evidence:
      - { type: source, path: packages/plugin/cc-grok-bridge/scripts/grok-review-run.mjs, anchor: "GROK_HOME: H" }
      - { type: source, path: packages/plugin/cc-grok-bridge/scripts/lib/canonical.mjs, anchor: "export function arming" }
      - { type: source, path: packages/plugin/cc-grok-bridge/hooks/grok-review-allow.mjs, anchor: "permissionDecision: 'allow'" }
      - { type: source, path: packages/plugin/cc-grok-bridge/hooks/grok-review-context.mjs, anchor: "hookEventName: 'SessionStart'" }
      - { type: source, path: packages/plugin/cc-grok-bridge/hooks/hooks.json, anchor: "SessionStart" }
      - { type: source, path: packages/plugin/cc-grok-bridge/commands/review.md, anchor: "If the SessionStart block is missing or reports NOT armed, STOP" }
      - { type: test, path: packages/plugin/cc-grok-bridge/tests/hook.spec.ts }
      - { type: test, path: packages/plugin/cc-grok-bridge/tests/hook-context.spec.ts }
      - { type: test, path: packages/subagent/task/tests/e2e-grok-bridge.spec.ts }
    deviation:
      kind: divergent
      summary: >-
        First-party dsh-cc plugin (design:
        docs/plans/2026-09-27-grok-review-bridge.md): Grok's session state
        cannot initialize under a dsh workspace-write sandbox (~/.grok is
        outside the writable roots), which the bridge solves by relocating
        GROK_HOME into the canonical tmpdir and seeding auth.json; the
        sandbox-write boundary stays entirely on the dsh side while Grok's
        internal approvals are bypassed inside the run. Opt-in by
        installation; uninstall/disable is the kill switch. In dsh-cc's own
        repo dev sessions arming is refused (launcher under the workspace)
        and the lane degrades to the normal approval-requiring path.
```

- `pnpm-workspace.yaml`: no edit; one `pnpm install` (lockfile update) then `--frozen-lockfile` clean. Root `vitest run` only.
- `.gitignore`: two entries — `!/packages/plugin/cc-grok-bridge/scripts/lib/` after the codex negation, and `/packages/plugin/cc-grok-bridge/tests/.runtime/` next to the codex `.runtime` entry (launcher specs stage the fake `grok` package-locally — a tmp-staged stub trips the launcher's own CLI refusal, codex-R4 #17). Package-shape asserts `git check-ignore` non-match on `scripts/lib/argv.mjs` and match on `tests/.runtime/`.
- `docs/plans/2026-09-27-grok-review-bridge.md`: this doc (Status flips Shipped after merge).

## 4. Security model

Inherited from codex-rescue-bridge §4 where mechanisms genuinely match: anchors outside writable roots; byte-pinned invocation with expansion-free anchors (prompt words are data); `BASH_ENV`/`ENV` disarm; hook never denies; shadow home 0700/uid/lock; credential nofollow+atomic+0600+delete-on-missing (+post-open fstat); **the launcher never widens the outer dsh filesystem sandbox** (it *does* bypass Grok's own approval layer — that is the feature, stated plainly); **outer dsh sandbox = single write boundary**; capability-tunnel opt-in wording (unattended Grok may run any subprocess the outer sandbox permits, networking included).

Grok-specific rows, grounded:

1. **No nested-sandbox class; sandbox config fails closed** (P5/P10); ambient `GROK_SANDBOX` scrubbed (D10); execution model deterministic.
2. **Cross-run injection closed by the D14 sweep** (P13 for config/plugins/caches; `memory/` reasoning-not-probed): durable state = this lane's own transcripts (type-validated; symlink forms swept) + freshly synced credential. **Resume trust class:** `--last` feeds the model this lane's own prior transcripts — model-influenced content by construction, the same trust class as the ongoing conversation itself (codex-R5 B7); it does not widen who/what can inject (only this workspace's own runs write them, under the same lock).
3. **Stated plainly: the reviewee can exfiltrate the shadowed credential.** Any run executes as the user with networking; a hostile prompt (or hostile repo content under review) can read `H/auth.json` (or ambient `XAI_API_KEY`) and POST it out. Same shape as codex's shadow home. Mitigations: upstream token lifetime bounds the shadow's value; sync never writes back; README warns. Accepted — the shipped codex lane's posture too.
4. **Output channel untrusted on both paths** — success prints `.text`; failures print the raw captured buffer; all of it is data. The cost line's fields are type-checked and control-stripped; `grok-review:` marks launcher-authorship by **convention, not provenance** (child stderr shares the stream and can spoof the prefix).
5. **`--last` scope:** per-workspace H keyed on 16 hex digits of sha256(realpath(cwd)) — cross-workspace bleed **collision-negligible**, not impossible. Fresh-home continue fails loud (P7).
6. **Unbounded lane by adjudicated design** (§7 row 4; codex-R5 B6 re-raise adjudicated final in §8): no turn cap; per-run sanitized stderr cost summary is the durable record (P14); group kill bounds cancellation-window cost within the process group.
7. **Accepted residuals, stated:** hook-check→first-open race on the caller prompt path (D11); no credential write-back (D8); process-group escapees (daemonized/new-session descendants outlive the group kill — and the `H/.orphaned` marker stops the next launch from reusing a contaminated home, closing the sweep-race, codex-R5 B3); uncatchable launcher death → lock retained until staleness; `XAI_API_KEY` unprobed end-to-end (P9); same-UID binary replacement outside writable roots (beyond scope).
8. **Hook-startup interception (codex B1-class, raised R3/R4/R5; adjudicated final per codex-R4's own offered disposition):** plugin hooks run through the host shell as `node <hook-path>`; ambient compromise (`BASH_ENV`/`ENV`, writable PATH dir, exported function — functions shadow even absolute paths) can substitute the interpreter and forge the static allow verdict before bridge logic runs. No in-plugin closure exists (plugins only get shell-executed command hooks; non-shell execution / subprocess-layer env scrub is harness-side, §6). The shipped codex lane carries the identical exposure; §6 tracks the port-back. Incremental framing: the attacker must already control a session-ambient startup vector (already arbitrary code on every bash tool call); the bridge's add-on is auto-approval forgery *for this one canonical form*. Accepted, documented here and in README.

## 5. Test obligations

Six spec files (five in-plugin mirroring `packages/plugin/cc-codex-bridge/tests/` + root e2e). Unit seams (`buildChildEnv`, sync/sweep, bounded prompt read, formatter/cost line, the termination machine driven with injected deps) get pure unit rows; subprocess rows cover lifecycle/argv integration (codex-R5 #14/#15).

1. `tests/argv-lexer.spec.ts` — table-driven rows, every negative labeled: `-- -foo` → `dash-leading-inline-prompt`; `\r`/`\n`-bearing → `control-char-in-prompt`; `--last` placement/duplication; prompt-file variants; expansion-flagged prompt word ACCEPTED as data (pins the codex-mirrored semantics); **byte-identity row: this plugin's `lexer.mjs` reads byte-equal to `cc-codex-bridge`'s** (drift fails the suite, codex-R5 #17).
2. `tests/hook.spec.ts` — canonical allow; disarmed (anchors under writable roots, `BASH_ENV`/`ENV`, `platform: 'win32'` injected) → silent; near-miss shapes → silent; prompt-file containment (inside/outside, symlink escape) → allow/silent; hostile stdin → silent exit 0, never deny.
3. `tests/hook-context.spec.ts` — armed/refused payloads + exact texts (incl. `platform-win32` REFUSED); missing/non-string `payload.cwd` → `process.cwd()` fallback (codex mirror); hostile-anchor quoting round-trip; anchor-lint grep-pin.
4. `tests/launcher.spec.ts` — fake `grok` stub staged package-locally under `tests/.runtime/<pid>-<rand>/bin/grok` (never tmp), fake HOME with fake `.grok/auth.json`, never real CLI/home. Minimum rows: exact child argv (±`-c`; no `--cwd`); `buildChildEnv` unit rows (scrub triple; `GROK_HOME` set; `XAI_API_KEY` preserved) + integration child-env diff + caller env-object unchanged; spawn cwd; **formatter table** (parse+text / empty text / newline normalization / malformed / primitive / array / null / object-without-text / valid-text-with-nonzero-exit / `{type:"error"`}+exit-1` raw bytes preserved verbatim); 16 MiB cap (breach byte triggers termination; post-breach chunks discarded; memory-bounded); spawn error → 1; null-code → signal message + 1; cost-line mapping incl. control-strip/64-cap/type drops; `auth.json` sync (happy; ENOENT ± `XAI_API_KEY` warn gating; EACCES class; non-classified abort via injected fault; post-open fstat swap via injected ops; 0600; `.tmp-*` cleanup on write/rename failure); **D14 rows** (unknown file/dir/symlink swept; `sessions` symlink swept vs real dir kept; planted `auth.json` dir removed then synced; sweep-before-sync order); **orphan-marker rows** (`H/.orphaned` present → refusal; absent → normal; marker present + sweepable junk planted → refusal wins and the junk is NOT swept — the step-5-before-step-6 invariant is executable, not prose); prompt write-through (cap+1, growing-file via injected read, shadow 0600, **shadow unlinked on every outcome**); R/H mode/symlink refusal (root-skip guard); lock acquire/stale; **the full §3.1-T matrix T1–T10** (SIGINT/SIGTERM/SIGHUP uniform = 130 + group dead before `.lock` gone; pre-spawn signal; repeated-signal escalation; TERM-ignoring sleeper → SIGKILL at +2 s; cap-vs-close winner; budget expiry → marker written + lock released + next launch refused); grok-absent refusal; grok-under-writable-root refusal; dash-leading → exit 2; invalid argv → exit 2 usage; `grok-review: ` error prefix.
5. `tests/package-shape.spec.ts` — manifest fields; files entries exist + non-empty dirs; plugin.json `cc-grok-bridge` vs package.json scoped name; **three-way `description` lockstep** (package.json / plugin.json / marketplace stanza); version lockstep; capability row presence; `git check-ignore` (non-match on `scripts/lib/argv.mjs`, match on `tests/.runtime/`).
6. `packages/subagent/task/tests/e2e-grok-bridge.spec.ts` — codex-mirror e2e: real mount, real hooks, `HooksClaude` + static `inject = ['shell']` + `LocalBashExecutor`, `commands` recording stub, scriptable adapter; M1–M6 and S1–S3 mirrors (canonical allow → launcher dies loud `grok-review: grok CLI not found …`; downstream deny never flipped; ask downgraded; passthrough; tool-restricted child traverses; toolFilter deny survives; armed block; `/cc-grok-bridge:review` renders → one canonical bash call; near-miss fails closed). Hermeticity: `PATH` = node dir + dedicated bin dir with only the suite's links; preflight fails loud if `grok` resolves under it; `HOME` → temp (missing-source branch by design). (Scope note: production-Bash abort propagation belongs to harness e2e, not this plugin's suite — codex-R5 #14's latter half adjudicated out; the plugin's own signal paths are covered by T-rows with real signaling.)

Gates before green-claim: one `pnpm install` (lockfile) then `--frozen-lockfile` clean; root `vitest run` on the six specs; `node scripts/check-spec-deps.mjs`; `pnpm check:capabilities && pnpm check:parity`; `pnpm check:readme`; `scripts/marketplace.test.mjs`; static battery incl. `node scripts/check-file-size.mjs`; stage new files before any ls-files-materializing spec; parity artifacts with the yaml row.

## 6. Follow-ups (not this PR)

- Port back to cc-codex-bridge: the startup-interception analysis (docs; codex B1 class), the memoized termination ordering with orphan marker (code; D15 class), and where applicable the cap+1 bounded read.
- Upstream harness proposal (shared with codex design §6): scrub `BASH_ENV`/`ENV`/`SHELLOPTS`/`PS4`/`NODE_OPTIONS`/`PYTHONSTARTUP` at the subprocess layer; non-shell execution for plugin command hooks closes B1 structurally.
- `--resume <sessionId>` passthrough; `--max-turns <n>` passthrough — after dogfood data (§7 row 4).
- Standing dogfood: re-run §2's probe recipe per grok auto-update; first-run dogfood list in §9.

## 7. Alternatives considered and rejected

1. **Cross-plugin lib import.** Rejected: plugins are self-contained published artifacts (lexer stays shared via the byte-identity test).
2. **Share the interactive state root.** Fails P3; pollutes `grok sessions`.
3. **`grok agent stdio`.** Undocumented protocol vs documented one-shot JSON.
4. **`--max-turns` default** (raised again as codex-R5 B6; adjudicated final): the lane is honestly unbounded with per-run cost visibility; a cap that terminates mid-review destroys the lane's purpose, and choosing any number pre-dogfood is guesswork. Rejected.
5. **Launcher version gate on grok.** Rejected: auto-updates would flap the lane; silent drift is admitted and carried by the §6 re-probe cadence (codex-R3 #5).
6. **Top-level `decision:"allow"`.** Codec drops it (shipped codex finding).
7. **Credential write-back.** Impossible without leaving confinement (D8).
8. **Caller-path prompt passthrough / rev4 denylist reset.** Superseded (D11/D14).
9. **Grammar-silent dash-leading.** P12 too confusing; D9 names it.
10. **Fresh home per run.** Kills `--last`; sweep keeps it (P13).
11. **In-plugin closure of hook-startup interception (codex B1 class).** None exists; accepted-with-docs per codex's own offered disposition (§4.8) + upstream port (§6). Re-litigated at R5; adjudicated final.
12. **Process-tree containment beyond the process group.** No portable POSIX mechanism; narrowed claims + orphan marker + residuals instead (codex-R4 #3 / R5 B3).
13. **Least-privilege "review profile" (read-only tool subset etc., codex-R5 B4).** The lane's premise is the capability tunnel (the codex design's own §4). Review runs that may need to *reproduce* (run tests/builds) preclude a hard read-only floor; the trust contract is stated, not hidden. Rejected as the feature's premise — adjudicated final.

## 8. Review log

- **rev0 (2026-09-27):** draft from executed probes P1–P9.
- **rev1 round, three lanes blind:** critic SHIP-WITH-FIXES (11) — rev2 folds; grok dogfood lane ($0.55, 25 turns) SHIP-WITH-FIXES (12) — rev2 folds (its `GROK_SESSION_ID`/`GROK_AGENT` session claim verified false, scrub kept as labeled belt); **codex round 1 interrupted** (harness sandbox-runner failure; rollout journal: no verdict; re-run user-approved).
- **rev2 critic confirm:** SHIP-WITH-FIXES (1+3) — rev3 folds.
- **rev3:** orchestrator self-audit — `.gitignore` negation.
- **codex round 2 (131k tokens): NO-GO, 15 findings** — rev4 folds (D10 `GROK_SANDBOX`; D14 reset; D15 ordering; D11/D16; grounding column; version stance; §5 expansions; D17; e2e preflight; plumbing pins; collision wording; D13 `\r`; metadata).
- **rev4 critic verify:** SHIP-WITH-FIXES (6) — rev5 folds (P13; D18 split; cap-kill routing; root-skip wording; reason-string pin; grounding split). **codex round 3 (141k tokens): NO-GO, 13 findings** — rev5 folds (B1 residual+port; B2 allowlist; B3 P13 probe; B4 D15/D18; #5-#13 row-by-row in the rev5 changelog).
- **rev5 critic verify:** SHIP-WITH-FIXES (3+5) — rev6 folds (count fix; `.tmp-*` clause; pre-spawn pin; budget phrasing; D13 attribution; tag split; copy phrasing; exit-130 deliberate).
- **codex round 4 (82k tokens): NO-GO, 19 findings** — rev7 folds (B1 accepted-with-docs per its own offered disposition; B2 lstat-validation; B3 narrowed claims; B4 §3.1-T state machine; B5 complete capability row; #6 shadow unlinked; #7 sweep-before-sync; #8 sanitization; #9/#13 unit seams; #10 lifecycle matrix; #11 re-probe recipe; #12/#13/#15 baseline corrections; #14 D19 row; #16 wording; #17 `.runtime/` staging; #18 cwd fallback; #19 description lockstep).
- **codex round 5 (123k tokens): NO-GO, 18 findings** — **the lane stopped degrading textually and re-opened premise-level items; per the project rule "lane divergence is adjudicated, not obeyed infinitely," the user directed fold-and-close with adjudication.** rev8 (this text) folds 15: B1 whole-region try/finally pin; B2 the complete §3.1-T table; B3 `H/.orphaned` poison marker + next-launch refusal; B7 resume trust-class note (§4 item 2); #8 "expansion-free anchors" wording; #9 post-open fstat re-pinned; #10 `.tmp-*` finally-unlink everywhere; #11 discard-after-breach; #12 formatter contract table; #13 cost-line exact mapping + provenance-wording; #14/#15 `runLauncher(argv, deps?)` injection seam (e2e-abort half adjudicated out — harness e2e's scope, plugin suite covers its own signal paths); #16 exact probe recipe block; #17 lexer byte-identity test.
  **Adjudicated final (4, none folded, reasons recorded):** codex-R5 B4 (least-privilege review profile) — rejects the capability-tunnel premise the design ships honestly; §7 row 13. codex-R5 B5 (hook-startup forgeability) — accepted-with-documentation per codex-R4's own offered disposition + §6 upstream port; §4 item 8 / §7 row 11. codex-R5 B6 (bound max-turns) — §7 row 4; inconsistent with the lane's purpose; cost visibility is the chosen control. codex-R5 B3's "rotate per-run homes" alternative — kills `--last`; the marker half of B3 WAS folded (that's the divergence-respecting middle).
- **rev8 closure round (critic, 2026-09-27):** SHIP-WITH-FIXES, 6 pins, all applied to this text: try-region widened to steps 4–11 (T1 literal); handlers registered at start of step 5 (no lock-stranding signal window); T3's formatter bypass stated in §10; sweep failure fail-closed; T9 exit code resolved; `.orphaned`-before-sweep ordering invariant pinned in prose AND as a §5 test row. **Design review is closed.**

## 9. Implementation slicing (hand-off contract)

One PR (user-directed), one commit chain: (1) plugin tree incl. tests + marketplace stanza + the two `.gitignore` entries + lockfile update; (2) e2e spec; (3) capability row + `docs:parity` regen + this doc (Status flips Shipped after merge). Acceptance: all §5 specs + gates green. Post-merge dogfood (not this PR): marketplace install in a fresh user session → ARMED block → one real review via the canonical form → `--last` follow-up → sanitized stderr cost line verified; then the §6 re-probe cadence stands.

**Implementation notes (executor pass, 2026-09-27):** (i) D9 governs over codex's positive fixture "positional prompt may itself be `--last`" — for the grok copy that row is a negative `dash-leading-inline-prompt` row (any `-`-leading inline prompt is rejected, period); (ii) `commands/review.md` keeps the pinned fail-closed sentence on one line so the §3.4 capability anchor matches literally. Built surface: 165 tests across the six suites — green on the executor's run and on an independent orchestrator re-run; (iii) the two **real-signaling launcher rows are `skipIf(CI)`** — the Linux runner leaked an exited launcher's `ChildProcess` handle past suite completion (the detached stub holds the launcher's inherited stderr pipe), hanging the vitest forks-pool teardown (PR #166 CI evidence; diagnosed via a temporary CI-only handle dump; stream-destroy/unref did not cure it; the §3.1-T machine stays fully covered by the injected-deps rows and the two rows keep running locally).
