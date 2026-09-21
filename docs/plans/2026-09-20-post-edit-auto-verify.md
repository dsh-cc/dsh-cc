# Post-Edit Auto-Verify: SoL-Pi Action Fusion without a new tool surface

Date: 2026-09-20. Status: **Implemented** — PR #93 (open, pending merge); Phase 3 personal dogfood is a follow-up. Design: two reviews passed with amendments, all baked in. Second
(pre-implementation, code-grounded) review at HEAD 705f586: GO-WITH-AMENDMENTS (shell seam
corrected to the harness ShellExecutor resolve/run contract with value-accept guard,
org-policy-layer read dropped as unreachable, plain-plugin form replacing the Service,
registration checklist added). First (cold) review: GO-WITH-AMENDMENTS, 9 findings (dead
`multi_edit` tool name removed, settings provenance fixed to a direct user-layer read,
verify commands routed through the harness shell service — then miscategorized as the
"cc-shell seam" and corrected by the second review — burst-debounce inversion documented
with an explicit skip marker; all baked in below).

Origin: SoL-Pi (arXiv:2609.20519) Action Fusion — merge a file edit with the build/test
command that customarily follows it into one tool request returning one observation,
saving a full model round-trip (the paper measures 3→2 API calls per edit-verify cycle; it
was the top single-mechanism scorer on Opus 5, +5.3 points over Pi). The paper's own
caveat: commands whose output the agent must inspect to decide the edit stay separate.

## 1. Problem and the fork in the road

The paper implements fusion by changing the *tool request* shape. dsh-cc cannot do that
cheaply:

- CC parity is load-bearing. A new fused tool mutates the capability manifest surface, the
  model-facing tool list, and every prompt that references tool semantics — the most
  invasive kind of change this repo can make.
- dsh-cc already owns the observation-assembly seam. Anything achievable by "run a
  declared verify command after an edit and attach its output to the edit's own tool
  result" achieves the paper's actual win (one fewer model round-trip; one observation
  covers both events) without touching the tool surface.

So the dsh-cc adaptation is **post-edit auto-verify**: after an `edit`/`write` result is
accepted, run a user-declared fast verification command and append its outcome to that
same tool result before the model sees it.

A tempting cheaper path — a CC `PostToolUse` hook returning `updatedToolOutput` — was
checked and rejected on the machinery itself: `updatedToolOutput` **replaces** the whole
content with a single text block and applies only when the downstream decision is a plain
accept with no content (`hooks-claude-code/src/register-events.ts:152-165` — the bridge
constructs a fresh `{ kind: 'accept', content: [replacement] }`, not a spread). It cannot
append, so a verify note delivered through it would *erase* the edit tool's own output.
The bridge also costs a subprocess dispatch per editing tool call. The dsh-cc-side package
composes on the accept decision instead, keeping both outputs.

## 2. Ground facts (verified 2026-09-20 against this checkout; re-verified in review)

Harness-repo anchors are read-only per the harness-repo-readonly directive.

- Observation composition seam: `tools/post-execute`; listeners without `prepend` sit
  inside CCR's prepend'd listener, so appended content is seen by the crusher's router
  (ordering: CCR outermost `await next()` → inner listeners compose → CCR decides on the
  combined text). Our listener registers **without** prepend deliberately; verify output is
  small and benefits from the crusher if anything.
- Accept-decision append is expressible and survives materialization: `PostToolDecision`'s
  accept carries `content?: ContentBlock[]` and the runtime passes decision content through
  verbatim. Exact idiom: when the downstream decision is `kind: 'accept'`, return
  `{ ...downstream, content: [...blocks, verifyBlock] }` where `blocks` come from
  `downstream.content` when present, **falling back to the waterfall `result.content`**
  when the downstream returned a bare `{ kind: 'accept' }` (the edit tool's own output
  lives in the original result argument in that case). A downstream block or replacement
  wins — we passthrough untouched.
  **Guard the value-accept variant**: `PostToolDecision` also has
  `{ kind:'accept'; value: JsonValue; content?: never }`
  (`packages/core/tools/src/tool-types.ts:310-312`); the runtime **throws** if a decision
  carries both `content` and `value` (`runtime-results.ts:67-68`), and a throwing listener
  converts the edit result into `isError`. So compose (append `verifyBlock`) ONLY when the
  downstream accept is content-bearing or bare; if the downstream accept is the value
  variant, pass through untouched (verify skipped, `logger.debug`).
- Editing tool runtime names: `edit` and `write` only. **`multi_edit` does not exist at
  runtime** — CC `MultiEdit` maps onto the harness `edit` tool
  (`packages/core/tools/src/cc-names.ts`). A config entry for `multi_edit` is dead config.
- Subprocess precedence: hooks dispatch runs commands through the injected `ctx.shell`
  (`hooks-claude-code/src/dispatch.ts:124`, wired at `index.ts:58,85`) — the HARNESS
  ShellExecutor (`@deepseek-ai/dsh-shell`). `packages/bundle/cc-shell` is cc-shell-glue
  (MCP/plugin glue, no exec API) and is NOT the seam. `spawnSync('zstd')` in
  `cache-trajectory/src/bin.ts` is an internal trusted binary — NOT a precedent for
  user-authored shell strings. §3.3 therefore goes through the same harness shell seam.
- Session cwd for the child process: `getSessionCwd(exec.agent)` convention
  (`@dsh-cc/session-cwd`), aware of worktrees/entered directories.
- **Settings have no per-source provenance** — settings-cascade explicitly does not record
  which layer supplied a resolved value (`settings-cascade/README.md:56`). "Filter the
  merged scope by provenance" is impossible; §3.4's rule is instead a direct read of the
  user layer only.
- Fail-soft invariant of the seam: any failure returns the downstream decision unchanged
  (CCR precedent).

## 3. Design

### 3.1 Package `packages/interaction/post-edit-verify` (`@dsh-cc/post-edit-verify`)

A **plain plugin, not a cordis Service**: the cc-services group's isolate map is pinned by
`toEqual` on exactly eleven keys (`packages/preset/cc/tests/composition.spec.ts:185-199`),
so a Service would require an isolate entry + test change for nothing. Correct precedent:
tool-use-summary / prompt-suggest — a plain package exporting an `apply(ctx)` function
with `inject = ['shell']` (inject idiom: `packages/hooks/hooks-claude-code/src/index.ts:57`),
no Service class, no isolate key. Injected: `shell` (the harness ShellExecutor, §3.3).
Settings are read from the user layer directly (§3.4), not via the merged namespace.

### 3.2 Trigger conditions (all must hold)

1. tool name ∈ `{edit, write}` (runtime names, §2);
2. downstream decision is accept — compose per the §2 idiom, with the `result.content`
   fallback for a bare accept; never touch blocks/replacements;
3. a verify rule matches the edited path: rules are `{ glob, command, timeout-ms? }`
   entries, first match wins; globs evaluated against the tool input's `file_path`;
4. burst handling (see §3.5);
5. `enabled` and a rule matched.

### 3.3 Execution and attachment

- The shell seam is the injected **harness ShellExecutor** (`@deepseek-ai/dsh-shell`), NOT
  `packages/bundle/cc-shell` (cc-shell-glue; no exec API). API precedent:
  `packages/hooks/hook-protocol/src/runner.ts:70-105` and
  `packages/ui/tui/src/state/driver-types.ts:404-443`. Shape: `resolve(request) → spec`;
  `run(spec) → Promise<ShellRunResult>`. Request:
  `{ command, timeoutMs?, stdoutMaxBytes?, stdin?, signal?: AbortSignal, env?, workdir? }`;
  result: `{ exitCode: number | null, timedOut: boolean, stdout: {text}, stderr: {text} }`.
- run the rule's `command` through that seam, cwd = `getSessionCwd(exec.agent)`, timeout
  per rule (default 60 s, hard cap 120 s);
- the request wires `signal: exec.signal` (the waterfall execution's AbortSignal), so a
  cancelled turn cancels the verify;
- the request passes a large `stdoutMaxBytes` (e.g. 256 KiB — the executor caps output
  itself), so tail+first-line truncation to `max-output-bytes` happens consumer-side with
  full fidelity;
- **timeout semantics are the ShellExecutor's contract** — the request exposes no
  detached/spawn option, so process-group kill on timeout is executor-owned and
  unverifiable from this repo. Phase 1 therefore keeps a behavior-pinning probe test (a
  `node -e "setTimeout(()=>{},10000)"` rule that must time out — assert `timedOut: true`,
  `exitCode: null` — so executor drift fails loudly) instead of a group-kill
  implementation test;
- error surface (verified): non-zero exit = normal return (exitCode set); signal death =
  `exitCode: null`; timeout = `timedOut: true` + `exitCode: null`; spawn/infra failure
  (unusable workdir, missing shell) = `run()` REJECTS — the consumer must catch and
  fail-soft;
- rules are **POSIX shell strings** (the seam's contract); Windows users write
  cmd-syntax — stated in the README, not engineered around;
- capture stdout+stderr; keep at most `max-output-bytes` (default 4 KiB) — always the
  *tail* plus the first line (exit narratives live at the tail);
- append one text block:

```
[auto-verify] <command> — exit <code> (<duration>ms)
<captured output or 'no output'>
```

- exit 0 appends a one-liner with duration unless `verbose-on-success` — success signals
  should be nearly free;
- run() rejection / timeout: append nothing, `logger.debug` the reason; the edit result
  the model sees is exactly today's behavior;
- the listener never throws across `next()` — wrap-then-catch per the seam invariant.

### 3.4 Security: user-layer config only

A project-committed verify command would be repo-controlled code execution on every edit
of anyone cloning it. Rules are therefore read **directly from the user settings layer
file only** — the org-policy-layer read is dropped: policy sub-source paths are
constructor config on SettingsCascadeProvider
(`settings-cascade/src/index.ts:55-59`), never exposed on ctx, so they are unreachable
from a plugin. Concretely: `readUserFile(path)` from the `@dsh-cc/settings-cascade` persist
surface (`settings-cascade/src/persist.ts:151`), with path =
`join(dshHome, 'settings.json')` using the guarded `ctx.dshHomePath` pattern (guard
precedent: `context-crusher/src/index.ts:86-92`). This direct read bypasses the cascade
watcher; rules are **re-read per use** (cheap — a few-KB file), which also gives free hot
reload. Consequence, stated honestly: **project-scope rules are never read — they are
invisible, not "refused"**; the §5 test verifies invisibility ("a rule present only in
project scope produces no verify block"), which is the behavior that actually exists. The
doc-exposed rule is one sentence: *verify rules are a personal productivity setting, not a
project artifact.* This divergence from CC hook behavior is recorded in the manifest entry
(§3.6).

### 3.5 Burst semantics (adopted from review finding)

Leading-edge debounce inverts the paper's win: the *first* edit of a burst triggers
verification against a half-edited tree (guaranteed exit-1 noise for `tsc`-style rules),
and the *final* edit — the one the model is about to reason from — gets nothing.
Trailing-edge debounce cannot work here: the observation window closes when the result
returns. Adopted rule:

- every matching edit runs verification (no debounce skip);
- when a previous verify for the same rule is within `debounce-ms` (default 5 000), the
  block is still appended but labeled
  `[auto-verify] burst — result may overlap edits from <n>ms ago`, so the model can never
  mistake a skipped run for a green run. Absence of a block always means "no rule
  matched", never "verified OK".

Latency/blocking honesty (§6): parallel tool mode means N concurrent matching edits each
spawn a full rule run (no in-flight dedup — N concurrent `tsc -b` is possible; v2 may
share in-flight runs), and each verify **blocks its tool result inside the waterfall**
(postExecute awaits the waterfall), so wall-clock latency per edit includes its verify
run. `debounce-ms` only labels, never skips.

### 3.6 Config — user layer key `cc-post-edit-verify`

```jsonc
{
  "cc-post-edit-verify": {
    "enabled": false,                    // ship dark
    "rules": [
      { "glob": "packages/**/*.ts", "command": "node_modules/.bin/tsc -b --pretty false 2>&1 | tail -5", "timeout-ms": 60000 }
    ],
    "debounce-ms": 5000,
    "max-output-bytes": 4096,
    "verbose-on-success": false
  }
}
```

No `tools` array — runtime names are fixed at `edit`/`write` (§2; a configurable list
whose only valid members are those two buys nothing).

Registration vs. reading: the `cc-post-edit-verify` namespace **is registered** via
`@dsh-cc/settings-ns` `registerNamespaceSafe` + schemastery object schema (convention:
`settings-ns/src/index.ts`; `context-crusher/src/settings.ts:30-45`) — purely so /config UX
and validation see it — but trigger logic always reads the raw user file per §3.4.

Persist-leak warning: settings-ns persist write-through diffs the **merged** section
against the shadow and bakes leaf deltas into the user file, so a project-layer rule
present in the merged section could be copied into the user file on any section write.
Phase 0 must add a test that the persist path never copies project-sourced rules into the
user layer (or document the accepted vector if the test shows it cannot trigger).

### 3.7 Capability manifest

New entry `engine.post-edit-auto-verify` (user-visible in transcripts), anchored to the
preset row, explicitly noting: (a) CC has no equivalent surface — the closest, PostToolUse
`updatedToolOutput`, replaces rather than appends; (b) appended `[auto-verify]` text is a
non-CC transcript element (same divergence class as hook `additionalContext`); (c) the
model may react to a failure tail by re-running the verify command itself via Bash — a
known double-spend mitigation target, documented, not engineered against in v1. Regenerate
parity artifacts in the same commit.

## 4. Phases

- **Phase 0 — rules engine + composition logic**, TDD: glob matching, first-match-wins,
  bare-accept fallback to `result.content`, value-accept passthrough, block/replace
  passthrough, user-layer reading (project-scope invisibility test), burst marker
  labeling, persist-leak pinning (persist path never copies project-sourced rules into
  the user layer).
- **Phase 1 — shell seam runner**: ShellExecutor `resolve`/`run` invocation, the timeout
  behavior-pinning probe from §3.3 (`node -e "setTimeout(()=>{},10000)"` rule → assert
  `timedOut: true`, `exitCode: null`), tail-keeping truncation, worktree cwd via a faked
  `getSessionCwd`, `node -e` rules as the platform-neutral test command.
- **Phase 2 — wiring and registration** (exact items, paths verified):
  1. `tsconfig.packages.json` references entry (pattern: line 101
     `./packages/interaction/prompt-suggest`).
  2. `packages/preset/cc/agent.cordis.yml`: row inside the `cc-services` group after
     tool-use-summary (~line 497), plain plugin, **no isolate key**, comment noting the
     non-prepend listener keeps CCR outermost.
  3. `packages/preset/cc/tests/composition.spec.ts`: **NO isolate-map change** (plain
     plugin); assert row membership + ordering like the handoff-store assertions
     (lines 204-208).
  4. `packages/preset/cc/package.json`: `"@dsh-cc/post-edit-verify": "workspace:^"`.
  5. Manifest: check which of `docs/claude-code-capabilities.yaml` / `.json` is authored
     and edit that one (the other is generated); new entry `engine.post-edit-auto-verify`
     in category id-alphabetical order, with upstream.summary noting CC has no equivalent
     surface (closest: PostToolUse `updatedToolOutput` replaces rather than appends),
     behavioral/ux fields consistent with the divergent-class rules ([I3]: divergent ⇒
     `ux` at most `partial`; [I4]: `mounted: true` + `plane: preset` requires the anchored
     preset-row evidence; [I7]: entries sorted by id within category), and evidence rows
     `{type:'source', path:'packages/preset/cc/agent.cordis.yml',
     anchor:'- id: post-edit-verify'}` plus `{type:'test',
     path:'packages/interaction/post-edit-verify/tests/…'}`. Example row:
     `engine.tool-use-summary`.
  6. Regenerate parity artifacts (`npm run docs:parity` writes matrix + README block +
     capabilities.json) and commit the three generated files together.
  7. README trio: README.md + README.zh.md + README.i18n.yaml in the new package, per
     `docs/plans/2026-09-10-package-readme-trio.md`.
  8. Composition spec lives in `packages/interaction/post-edit-verify/tests/` using
     MockAdapter from `@dsh-cc/agent-loop-mock` (precedent
     `packages/context/context-crusher/tests/composition.spec.ts`) and faked
     `getSessionCwd` (exported from `@dsh-cc/session-cwd`).
- **Phase 3 — composition + dogfood**: real preset assembly with MockAdapter edits (incl.
  the bare-accept and value-accept downstream cases); then a week of personal dogfood on
  this repo (`tsc -b` rule). Feature stays default-off regardless; only documentation
  changes afterwards.

## 5. Verification

- **Unit (repo root, `node_modules/.bin/vitest run packages/interaction/post-edit-verify`):**
  every trigger-condition permutation, bare-accept fallback, value-accept passthrough,
  truncation keeps tail+first line within budget, burst marker text, project-scope rule
  invisibility, persist-leak pinning, timeout behavior probe.
- **Composition:** MockAdapter script: edit → verify exit 1 with tail → model sees a
  single observation containing both edit confirmation and failure tail (round-trip
  saved); blocked-downstream case → no verify spawned at all; bare-accept downstream case
  → verify appended to the tool's own content; value-accept downstream case → passthrough,
  no verify.
- **Observable claim for the commit message:** with a `cc-post-edit-verify` rule matching
  edited files, an Edit's own tool result carries the verification outcome in the same
  observation; failures surface without an extra model round-trip, and a skipped/overlapped
  run is always labeled, never silent.
- Static gates: tsc build, check-spec-deps, file-size budget, manifest+parity, README trio.

## 6. Risks and explicit non-goals

- **Verify command cost lands on the user.** A slow rule taxes every edit; the design
  leans on timeouts + tail-only capture, and the setting stays personal (§3.4) so blame is
  correctly assigned. Latency is honest here: in parallel tool mode, N concurrent matching
  edits each spawn a full rule run (no in-flight dedup; v2 may share in-flight runs), and
  each verify blocks its tool result inside the waterfall — wall-clock latency per edit
  includes its verify run; `debounce-ms` only labels, never skips (§3.5).
- **Observation growth.** The appended block is crusher-eligible downstream (listener
  ordering §2) and bounded by `max-output-bytes`.
- **Model self-re-running verify** after seeing a failure tail is a known inefficiency
  (§3.7c); dogfood watches for it.
- **Non-goals:** true request fusion (one tool call that edits *and* runs) — rejected, see
  §1; running verifications after non-edit tools; streaming verify output; any
  project-scope configuration; Windows-native rule syntax support.

## 7. Review outcomes and residual risks

Critic cold review (2026-09-20): GO-WITH-AMENDMENTS, 9 findings; all blocking/major baked
in above:

1. [blocking→fixed §2/§3.2/§3.6] `multi_edit` is not a harness runtime tool name —
   CC `MultiEdit` maps to `edit`; dead config removed everywhere.
2. [blocking→fixed §3.4/§5] Settings provenance does not exist in the cascade — the design
   now mandates a direct user-layer read, and the test asserts project-scope
   *invisibility* rather than "refusal".
3. [major→fixed §3.3] Raw `child_process.spawn` for user shell strings replaced by the
   shell seam (hooks precedent), with the trust argument documented. (Seam identity
   later corrected to the harness ShellExecutor — second review finding 1.)
4. [major→fixed §3.3] Timeout kills; process-group kill initially proposed, later
   deleted as executor-owned (second review finding 1); POSIX-shell and Windows
   fallback documented.
5. [major→fixed §3.5] Leading-edge debounce inverted the win — replaced by always-run +
   explicit burst label semantics.
6-9. [minor→fixed §2/§3.3/§3.7/§5] Bare-accept `result.content` fallback pinned; POSIX
   note; transcript-parity double-spend note; bare-accept composition case added.

Residual risk handed to the executor: cc-shell's error/exit-code surface (how non-zero
exits and spawn failures are reported) must be read from the shell package before the
§3.3 contract is coded — pin it in Phase 1 tests with both exit-0 and exit-1 rules.
**Resolved by the second review**: the seam is the harness ShellExecutor, whose error
surface is verified and pinned in §3.3 (non-zero exit = normal return; signal death =
`exitCode: null`; timeout = `timedOut: true`; spawn/infra failure = `run()` rejects;
consumer fail-soft). Phase 1 pins it with exit-0, exit-1, and timeout-probe tests.

Second review (2026-09-20, pre-implementation, code-grounded, at HEAD 705f586):
GO-WITH-AMENDMENTS; findings 1-4, 6-8 baked in above (5 folded into finding 1):

1. [major→fixed §2/§3.3] Shell seam is the harness ShellExecutor (`resolve`/`run`
   contract), not cc-shell; group-kill deleted as not implementable consumer-side —
   timeout semantics are executor-owned, pinned by a probe test; `signal: exec.signal`
   and a large `stdoutMaxBytes` added to the request.
2. [major→fixed §2] Value-accept decision variant must pass through untouched (runtime
   throws on content+value; throwing listener turns the edit into isError).
3. [major→fixed §3.4] Org-policy-layer read unreachable from a plugin — dropped; v1 reads
   the user layer only via `readUserFile` + guarded `ctx.dshHomePath`, re-read per use.
4. [minor→fixed §3.1] Plain plugin with `apply(ctx)` + `inject = ['shell']`, not a
   cordis Service (isolate map is pinned by `toEqual`).
6. [minor→fixed §3.6] Namespace registered for /config UX; trigger logic reads the raw
   user file; persist write-through leak vector documented with a Phase 0 pinning test.
7. [minor→fixed §3.5/§6] Latency/blocking honesty: no in-flight dedup; verify blocks its
   tool result in the waterfall.
8. [minor→fixed §4] New-package registration checklist added; Phase-1 group-kill test
   replaced by the timeout probe.
