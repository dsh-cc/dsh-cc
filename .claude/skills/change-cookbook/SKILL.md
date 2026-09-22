---
name: change-cookbook
description: >-
  Use when making code or docs changes in the dsh-cc repo: plan → implement →
  verify → open a PR with required Verification fields. Also use before creating
  worktrees, touching Claude Code parity/capability surfaces, or deciding whether
  a change belongs on a worktree branch vs a dirty main checkout.
---

# Change cookbook (dsh-cc)

Short recipe for **shipping a change**. Full orchestration lives in
[`AGENTS.md`](../../../AGENTS.md) — do not treat this skill as a replacement.

## 1. Plan first (when required)

Enter plan mode before: new features, >2–3-file changes, multiple viable
approaches, or refactor / migration / deletion.

The plan must name **files**, **what changes in each**, **order**, and **how to
verify**. Prefer one-pass implementation.

Before leaving plan mode: have `dsh-cc-agents:critic` review the plan cold;
revise; re-review if the plan changed substantially.

High-stakes / irreversible choices: parallel blind review (`critic` + Codex),
then dig into disagreement before deciding.

## 2. Where to work (stop lines)

- **Never commit directly on `main`.** Use a worktree session or a `dev-*`
  branch from a dirty main checkout (see AGENTS.md).
- **Do not create or enter a new worktree mid-session** (`EnterWorktree` /
  `git worktree add` + `cd`). Serena stays bound to the startup cwd.
- Need a worktree but did not start in one? **Exit and relaunch** inside the
  worktree after creating it.
- In a fresh worktree: run `pnpm install --frozen-lockfile` before the first
  pnpm command. Do not invent cross-worktree `node_modules` link hacks.

## 3. Verify before claiming Done

Before verifying, write down:

1. **Behavior** under test  
2. **How driven** (UI / API / CLI / unit test / docs-only)  
3. **Pass / fail criteria**

Then run the check. No observation → no claim.

Prefer: codebase/architecture correctness → static analysis / CI → hooks /
rules → skills → prose style last.

Optional dogfood: user-layer `cc-post-edit-verify` (default OFF) — see
[`docs/dogfood/post-edit-verify.md`](../../../docs/dogfood/post-edit-verify.md).

## 4. Open the PR (Verification required)

Use the repo template [`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md).
Every PR body must fill:

| Field | Meaning |
| --- | --- |
| **How driven** | UI / API / CLI / unit test / docs-only / N/A + reason |
| **Pass criteria** | Observable outcome that means this PR is correct |
| **Command / log excerpt** | e.g. `pnpm --filter <pkg> test` exit 0, CI job URL, or `[auto-verify]` |

A green build alone does **not** prove runtime behavior.

## 5. Capability / parity stop line

If the change alters the Claude-Code-compatible surface (preset composition,
hook bridging, command mounting, settings/permissions, plugin loader, or
user-visible behavior those gate):

1. Update `docs/claude-code-capabilities.yaml` in the **same** PR  
2. Run `pnpm docs:parity` and commit regenerated README / matrix files  
3. Expect `pnpm check:capabilities` and `pnpm check:parity` in pre-commit /
   PreSubmit

Hand-editing generated parity docs will fail CI.

## 6. Quick local gates (common)

- Package tests: `pnpm --filter <pkg> test`  
- README bilingual pair after README edits: `pnpm check:readme --write`  
- Spec dependency declarations: `pnpm check:spec-deps`  
- PreSubmit is the merge gate; fix reds before asking for merge

## Out of scope for this skill

Deep agent routing contracts, MCP/Serena recovery ladders, and release /
publish SOPs — see AGENTS.md, package READMEs, and `docs/release.md`.
