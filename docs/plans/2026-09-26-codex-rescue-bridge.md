# codex-rescue-bridge: an approval-free Codex lane via state relocation, not sandbox widening

**Status:** **Design — primed for implementation (PR-2).** Three review rounds across two blind lanes (critic ×3, Codex ×3) converged on SHIP-WITH-FIXES; every finding is folded into this revision (§8 carries the full log). Probe evidence P1–P6 is executed, not claimed (§2).
**Date:** 2026-09-26
**Worktree:** `.claude/worktrees/codex-rescue-approval` (branch `worktree-codex-rescue-approval`)

## 1. Problem

`/codex:rescue` currently fails deterministically in a `workspace-write` + `auto` + `ask` session. The command only spawns the `codex:codex-rescue` subagent, whose contract is a single bash call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...`. That call dies on two independent layers:

- **Permission layer.** `filterAutoAllowRules` (`packages/interaction/permission-rules/src/auto-rule-filter.ts`) suspends, under `auto` mode, every settings `allow` rule whose matcher head starts with an interpreter token (`node`, `python`, …) — exact full-command rules included. The companion invocation therefore can never be auto-allowed by configuration; it falls through to the classifier, and `ask` is a deterministic rejection in delegated child sessions (approval prompts are disabled there; scope is fixed at spawn).
- **Sandbox layer.** `workspace-write` confines writes to the workspace root plus `/tmp` and the platform temp dir — a hard-coded set in harness `packages/sandbox/sandbox/src/roots.ts` (read-only repo). Codex must initialize sqlite state under `~/.codex`, outside that set. Widening requires a user-approved escalation, which child sessions cannot obtain. Result: the observable "the bash call invoking codex-companion.mjs task was denied twice" abort.

Goal: a Codex rescue lane that needs **no human approval ever**, without widening any sandbox globally, without modifying the harness repo, and without patching the marketplace plugin cache (every patch there is erased by plugin updates).

## 2. Probe evidence (2026-09-26, workspace-write session, darwin)

Executed in this session against a seeded probe home under the platform temp dir (auth.json + config.toml copied from `~/.codex`):

- **P1** — `CODEX_HOME=<tmpdir-probe> codex exec --sandbox read-only --cd . "<no-tool prompt>"`: exit 0, zero `[sandbox: file access denied]` markers, correct answer.
- **P2** — after the run, all Codex writes (thread-history sqlite, installation_id, queue, logs, cache, plugin cache) landed inside the redirected home. `CODEX_HOME` redirection is honored end to end (`codex.mjs` `resolveCodexHome()` in the plugin reads `process.env.CODEX_HOME || ~/.codex`; the Codex CLI itself does the same).
- **P3** — a runtime `process.env.X=...` assignment is inherited by subsequently spawned children (node one-liner probe).
- **P4 (overturning)** — same command shape as P1 but with a prompt that forces tool calls: total failure, `sandbox-exec: sandbox_apply: Operation not permitted`. Codex applies its own macOS Seatbelt profile to its tool subprocesses, and a nested `sandbox_apply` inside dsh's Seatbelt confinement is denied. P1 had survived only because its prompt required no tools.
- **P5 (the way through)** — same tool-forcing prompt with `--sandbox danger-full-access`: full success, tools work, package.json read and reported. The outer dsh sandbox still confines writes to workspace + temp areas. `codex exec` is non-interactive with `approval: never` (P1 header), and the CLI itself documents `--dangerously-bypass-approvals-and-sandbox` as "Intended solely for running in environments that are externally sandboxed" — the upstream-blessed shape for exactly our situation. P5 uses `-s danger-full-access`, the equivalent already proven in-process.
- **P6 (companion dead end)** — the companion's `task` lane always passes an explicit sandbox parameter into `runAppServerTurn` (plugin `scripts/lib/codex.mjs`, `runAppServerTurn` at line 1095 in full-file grep), and the value is hard-coded as `request.write ? "workspace-write" : "read-only"` (`codex-companion.mjs` line 491). `config.toml`'s `sandbox_mode` never gets consulted on this lane, so **no env or config can unstick the companion under nesting**. macOS was the probe platform; Linux (Landlock/bwrap) nesting behavior is unverified and the design does not depend on it, since "internal danger-full-access + outer confinement" is valid on every platform (an extra inner layer, where it works, is redundancy, not an error).

Conclusion: the Codex plugin's assumption "the host never confines bash" holds on stock Claude Code and breaks structurally under dsh. The viable shape is: Codex runs with its internal sandbox off, while the dsh outer sandbox remains the single confinement layer — still strictly stronger than stock Claude Code, where neither layer exists.

## 3. Design

One new leaf package, `packages/plugins/cc-codex-bridge`, gated by settings `cc-codex-bridge.enabled` (default **false**; hot reload comes free from the settings cascade). Three components.

### 3.1 Launcher (`scripts/codex-rescue-run.mjs`, shipped in the package, executable bit set)

Exactly one canonical invocation form exists: direct execution of the launcher's absolute path (`#!/usr/bin/env node`; the package ships the exec bit). There is no `node <path>` form and no bare-`codex` form — one form, one anchor (review blocker 1 and T6).

Arguments: `--prompt-file <path>` for multi-line prompts, or `--` followed by a single positional single-line prompt that does not start with `-`; `--last` (resume most recent thread) is the only resume knob in v1.

Procedure, in order:

1. Canonicalize `os.tmpdir()` first (macOS `/var` and `/tmp` are symlinks; literal parent-chain checks misfire otherwise). Prefer the user-private runtime dir `$XDG_RUNTIME_DIR/codex-rescue-home` when it exists and is owned by us; fall back to `<canonical-tmpdir>/codex-rescue-home-<uid>` (a fixed `/tmp` subroot is first-user-squatting and pre-claim DoS on multi-user Linux hosts).
2. `mkdir -m 0700` the subroot `R` and the workspace home `H = R/sha256(realpathSync(cwd)).slice(0,16)`. `lstat`-validate both: owned by `process.getuid()`, not a symlink, mode `0700` — any mismatch is fail-loud. Ownership checks stop at `R`/`H`; parents are checked only for being directories that are not symlinks (a root-owned `/tmp` is normal and must not fail).
3. Acquire the single-flight lock `mkdir H/.lock` **before** syncing (review blocker 2). The lock is held through the spawn, heartbeat-touched, carries an owner nonce, and is released in a `finally` plus signal handlers. Stale = mtime older than 6h. This lock is an accidental-concurrency guard for cooperative callers; it is honest best-effort, not a token-cost ceiling — a same-UID process can always delete it or run `codex exec` directly (§4 states this plainly).
4. Sync credentials **inside the lock**: `~/.codex/auth.json` and `config.toml` are read with `O_NOFOLLOW` after source `lstat` (regular file), written to `H/.tmp-<random>` with mode `0600`, `fsync`ed, and atomically renamed into place. Overwrite always — a tampered residue in `H` survives zero runs. A missing source **deletes** the `H` copy and warns (a revoked token must not live on in the shadow home). Any sync failure aborts the launch.
5. `--prompt-file` handling: the matcher has already contained the path (§3.2 rule e); the launcher re-verifies independently — realpath containment against {session workspace, canonical tmpdir}, open with `O_NOFOLLOW`, `fstat` regular file, read from that same fd with a byte cap (256 KiB). realpath alone is not an information-flow boundary against hardlinks; this channel is documented as data egress into a networked model run, not as equivalent to an ordinary local read.
6. Spawn `codex exec --sandbox danger-full-access --cd <cwd> -o H/last-message.txt` (plus `resume --last` shaping when requested), with `CODEX_HOME=H` in **that child's env only** — the dsh process env is never mutated (probe P3 was needed only to rule out the inherited-env design; the final design is strictly local). stdio is inherited and the exit code passes through; the launcher prints `last-message.txt` at the end.

### 3.2 Pre-execute allow listener

Registered with `{ prepend: true }` (cordis waterfalls compose outermost-first; `prepend` = outermost — the cc context-crusher precedent). Body: `const downstream = await next()` first, then the only transformation is a **downgrade of `ask` or `passthrough` to `allow`** when the matcher hits; `deny` and `allow` pass through verbatim. `next()`-first is a hard safety requirement, not a style choice: the HIGH-risk classifier deny lives in the permission-rules listener body (which returns without calling `next()` on allow/deny/ask), so an outermost listener that decided without consulting downstream would silently skip it. The bypass-immune guard layer (`ctx.tools.guard()`) is monotonic and unreachable by any listener; PR-2 pins that independence with an ordering test.

The downgrade set includes `passthrough` because under `default` mode an unmatched call is `passthrough` (there is no ask without a rule), and passthrough dies just as hard in a child session — passthrough means every deny layer has already cleared. The trade is documented in §4 rather than argued from auto-mode equivalence (review F3).

Matcher (all strict; input is the raw command string):

- a. A mini POSIX-shell lexer resolves the command to **exactly one simple command**. Any unquoted operator (`;` `&&` `||` `|` `>` `<`, newlines, env-assignment prefixes) fails the match; command substitution (`$()`, backticks) fails in **every** quoting context, since bash evaluates those inside double quotes too. Single-quoted metacharacters are fine.
- b. The sole argv[0], resolved through realpath, is byte-equal to the launcher anchor path derived from our own package location (`import.meta.url`) — never from text inside the command.
- c. The anchor realpath must **not** sit under any outer writable root (session workspace, `/tmp`, canonical tmpdir). A pre-allow anchor that agents can rewrite is a privilege amplifier; in dsh-cc's own repo dev sessions the package does sit in the workspace, so the bridge refuses there by construction and degrades to today's manual flow (expected, documented).
- d. Remaining argv: optional `--prompt-file <path>` (realpath contained in workspace or canonical tmpdir at match time too), optional `--last`, then `--` and at most one positional prompt not starting with `-`. Any other token fails the match.
- e. Unknown shapes fail closed into the unchanged existing flow.

### 3.3 Entry surface

v1 ships one slash command `/codex-bridge rescue <text>`, whose template instructs the main agent to make exactly one bash call in the canonical form (multi-line prompts: write the prompt file into workspace scratch first, then pass `--prompt-file`; resume only when the user explicitly asks to continue). Direct natural-language invocation of the launcher by the main agent works through the same seam and is documented.

v1 deliberately does **not** ship a custom subagent: a markdown file dropped into a package does not enter any agent registry (the bundled-agent index or the CC plugin loader are the real seams — Codex round-2 finding C-F2), and the original `/codex:rescue` entry remains as-is (non-goal; §6 follow-ups).

### 3.4 Registration and gates

New-package checklist per house practice: workspace tsconfig reference, preset yml row behind an isolate realm, preset composition assertion bump, package README trio (en/zh), capability manifest row for the new permission seam plus regenerated parity docs in the same commit, deep imports from package roots only.

## 4. Security model (final)

- Zero sandbox widening anywhere. The permission delta is exactly one canonical command form. Deny verdicts are never flipped.
- **Opt-in semantics, honestly worded.** Enabling the bridge means explicitly choosing to drop the human checkpoint for this one command form. The launcher is a **capability tunnel**: unattended Codex may run any subprocess the outer sandbox permits — including actions the dsh permission classifier would otherwise escalate or deny (`git push`, `ssh`, cloud CLIs, outbound data) and unlimited networking (no delta vs. auto-mode bash curl, but a real delta vs. anything tighter). The filesystem write boundary (workspace + temp areas) still holds; nothing else is claimed. Prior revisions' "same blast radius as auto-mode edits" argument was rejected as understated and has been removed.
- Injection surface: the anchor is not forgeable through prompt content (single-command lexing, realpath identity, writable-root refusal). The worst an injection achieves is a repo-confined Codex run — which is precisely the feature being shipped; the lock caps accidental concurrency, not adversarial cost.
- Residuals stated, not hidden: same-UID environment poisoning (e.g. a PATH-poisoned `node` behind the shebang) runs attacker code inside the same outer sandbox — the write boundary is unaffected, and interpreter identity is not part of any security claim. Multi-user-host tmp risks are mitigated per §3.1 (private runtime dir preferred, uid-suffixed fallback). `--resume --last` history is per-workspace and shared across sessions of that workspace; same-repo threat model accepted and documented.
- Platform boundary: Seatbelt nesting verified on darwin. Linux behavior is by construction, not probe.
- Failure modes: matcher drift after a Codex/plugin upgrade degrades into today's approval-requiring behavior (fail-closed direction); launcher spawn failures are fail-loud.

## 5. Test obligations (PR-2)

- Waterfall order matrix: prepend × downstream {deny, ask, allow, passthrough} × guard interaction; classifier-ask downgrade pinned explicitly.
- Hostile matcher matrix: forged launcher paths, compound commands, env prefixes, `$()`/backticks in single and double quotes, quoted `;`/newlines, `--write`-style flag injection, prompt starting with `-` (with and without `--`), symlink/hardlink prompt-file tricks.
- Launcher: ownership/mode validation, XDG-runtime-dir preference and uid-suffixed fallback, lock acquire-before-sync ordering, stale-lock reclaim, signal cleanup, atomic nofollow sync (including source-missing-deletes-copy), prompt-file fd-stable bounded read.
- **Real-child wiring e2e** (the load-bearing assumption): spawn a named tool-restricted child (the background-subagent-start wiring precedent) and assert its bash call traverses the same pre-execute waterfall and is allowed by the bridge listener. Skipping this test ships an unverified premise.
- Slash-command expansion e2e: template → exact argv single call.
- Anchor lint fixture: launcher realpath constant and matcher derive from one source.

## 6. Follow-ups (explicitly out of v1)

- Upstream issue/PR to the openai-codex plugin: nested-confinement detection should map the companion's internal sandbox to the externally-sandboxed shape (P6). When that lands, `/codex:rescue` heals itself; the bridge remains as our own lane.
- A bundled-agent rescue entry (`dsh-cc-agents`-side), once the bundled-agent seam is deliberately extended.
- `--resume <threadId>` grammar; Codex-side execpolicy hardening for the tunneled command set.

## 7. Alternatives considered and rejected

- **Config-only** (chmod the companion script, edit the marketplace agent contract, path-first allow rule): the marketplace cache is refreshed by plugin updates — not durable. Kept as documentation-level fallback notes, not as the design.
- **Inject `bypassPermissions` into the child session at spawn** (`setPermissionMode` is exported): grants full access to an unattended write-capable Codex; relocation-over-widening strictly dominates on least privilege.
- **Main-session forwarding of the existing `/codex:rescue`**: approvals reach the user but prompt once per session — not "permanently approval-free".
- **Fix the companion in place**: P6 shows it needs two upstream changes (invocation shape and nested-sandbox mapping) plus a release cycle. Filed as upstream follow-up instead (§6).
- **`--ignore-user-config` instead of overwrite-always sync** (Codex round-2 suggestion): silently drops the user's model choice and drifts behavior; overwrite-always from the real home keeps semantics and survives no run-to-run tampering.

## 8. Review log

| Round | Lane | Verdict | Findings |
|---|---|---|---|
| 1 | critic (cold) | SHIP-WITH-FIXES | S1–S8: waterfall composition (prepend + next()-first), forgeable shape anchor, home perms, default-tier contradiction, env pollution, home sharing, resume degradation, sync sequencing; Q8(c) upstream-shim question — answered by P4/P6 evidence (upstream needs two changes; bridge ships now and survives `classifyAllShell`) |
| 2 | critic (cold, rev3) | SHIP-WITH-FIXES | F1 tmpdir pre-claim hijack (ownership validation), F2 anchor-writable-under-workspace, F3 passthrough-equivalence argument rejected → rewritten as explicit opt-in, F4 ask-override documented as precedence, F5 lexer-grade matching + prompt-file channel, F6 mtime staleness, F7 resume scope |
| 2 | Codex (companion lane) | partial — quota exhausted mid-run | Recovered findings: C-F1 config.toml persistent tampering → overwrite-always sync (revised with delete-on-missing in round 3), C-F2 package-dropped agent .md enters no registry → entry demoted to slash command |
| 3 | critic (confirm) | SHIP-WITH-FIXES | M-1 source-missing must delete the home copy; L-1 parent-chain ownership check would always fail on Linux /tmp → ownership checks stop at own subroot; L-2 prompt-file containment tightened; L-3 network-equivalence sentence |
| 3 | Codex (confirm, `codex exec` dfa lane) | SHIP-WITH-FIXES | Blockers folded: executable identity (single canonical absolute invocation form, no PATH-routed argv[0]); sync-before-lock and symlink leak (locked, nofollow, atomic rename). Highs folded: prompt-file launcher-side containment + egress labeling; lexer boundary and `--`; lock honesty (best-effort, not a cost ceiling); canonicalized tmpdir + XDG preference. §5 capability-tunnel rewrite applied |

A note on process honesty: the Codex round-2 lane died of account quota mid-review (findings recovered from its rollout file, not its final message — the session had piped stdout through `tail`); both round-3 lanes returned complete verdicts. Reviews were blind: each lane saw only the design input, never the other lane's output.
