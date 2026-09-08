# Multi-row custom status line + client-drawn permission-mode row

Status: **Implemented** — PR #124 (merged 2026-09-05). Amends the recorded v1 limitation of
`docs/plans/2026-09-05-statusline-command.md` (§C3 / S6: "v1 renders the
first row only") and the matching `ux.statusline` deviation in
`docs/claude-code-capabilities.yaml`. Reviewed cold as a Staff Engineer
(deep-reasoner, 2026-09-10); revisions folded in.

## Scope

When `statusLine` (type `command`) is active, render up to **3** rows of the
command's stdout (CC renders every row as its own row; dsh-cc caps, recorded
as a deviation), and append one **client-drawn permission-mode row** below the
command output so the mode + key hints survive the custom override. When no
`statusLine` is configured the built-in line stays **byte-identical** to today.

Motivation: CC users point `statusLine.command` at multi-line renderers
(ccstatusline defaults to 2 rows). dsh-cc v1 truncates to the first row
(`statusline-command.ts:135`, `split('\n', 1)[0]`) and loses the
permission-mode/hints segment entirely because mode is a segment of the
built-in line (`statusline.ts:83,99`) that the custom override replaces
wholesale (`driver-hud.ts:185-186`).

Accepted behavioral change for existing v1 single-line users: they gain the
mode row below their output. Recorded in the manifest deviation.

## Non-goals

Payload field gaps (version/cost/worktree…), the 60 s hard run cap, the
64 KiB stdout cap, refreshInterval starvation guardrails,
`hideVimModeIndicator` (parsed, still behaviorally inert — no vim mode) —
all unchanged, still recorded as deviations.

## Verified platform facts (research + review, 2026-09-10)

- `Text` (`packages/ui/pi-tui/src/components/text.ts`) renders multi-line
  content natively: `utils.ts:839` splits on newlines, `:846` word-wraps;
  intrinsic height = rendered row count (`layout.ts:77-79` render-cache
  measure; cache refreshed per frame, `layout.ts:363`). The dock stack hands
  each child `min(desired, available)` rows (`stack.ts:141-153`
  allocateStackSizes → `:95-133` distribute); a 1→3-row statusline shrink-
  squeezes siblings (transcript) automatically. **No pi-tui changes needed.**
- `root.ts:136/160`: statusline docked `{ shrink: 1, minSize: 1 }` as the
  last chrome row; `root.ts:457` re-reads `driver.statusLineIn(width)` on
  every driver emit; `root.ts:455-456` records the known downgrade that a
  resize alone does not recompute the string until the next emit.
- Kill-in-flight/debounce/generation guards in the runner are orthogonal to
  how many rows the settled text carries.
- `check:size` is a plain ≤500 cap (empty baseline). `driver.ts` = 498,
  `driver-types.ts` = 499 — **this plan touches neither**; logic lands in
  `statusline-command.ts` (183), `statusline-wiring.ts` (241),
  `statusline.ts` (106), `driver-hud.ts` (204), plus ~2 lines in `root.ts`
  (must remain ≤500 — assert in implementation).
- ANSI-aware truncation already exists: `truncateToWidth`
  (`pi-tui/src/utils.ts:1053`), `sliceByColumn` (`:1195`).
- Embedded mode row (inside `statusLineOf`) chosen over a separate dock row:
  no new driver surface (driver.ts is capped), no root.ts chrome churn, and
  contiguity with the command output is preserved. (Review-endorsed.)

## Design

### D1 — Runner keeps up to 3 rows (`statusline-command.ts`)

Replace the first-line cut with: split stdout on `\n`, `trimEnd()` every
line (whitespace-only lines collapse to `''`; ANSI untouched), drop trailing
empty lines, cap at `MAX_STATUSLINE_ROWS = 3`, join with `\n`. If **every**
surviving row is empty → `blank()` (empty string), identical to today's
no-output path. Debounce / kill-in-flight / 60 s + 64 KiB caps untouched.

### D2 — Padding applies per content row (`statusline-wiring.override()`)

`' '.repeat(padding)` is prepended to **each** row of the command output
(CC pads the status-line content). The client-drawn mode row is never padded.

### D3 — Mode row appended when custom is active (`driver-hud.statusLineOf`)

Extract a pure `formatModeLine(permissionMode): string` in `statusline.ts`
(`<mode> · shift+tab · /quit`) and refactor `formatStatusLine` to consume it
for its tail segments so formats never drift (built-in output byte-identical —
covered by existing specs).

When the custom override is active:
- blank detection **must trim** (review finding: with `padding > 0`, an all-
  blank settle yields `' '.repeat(padding)`, never `''`): treat
  `custom.trim().length === 0` as blank.
- blank → mode row **alone** (no whitespace row above it). Side benefit:
  starvation/failure now degrades to a visible mode row instead of a fully
  blank statusline (the user-reported "statusline vanished" case).
- non-blank → `custom + '\n' + formatModeLine(mode)`.

Busy state is deliberately **not** duplicated into the mode row — the
`WorkingLine` dock row already renders it (`root.ts:139`).

### D4 — Width clips, never wraps; pad-then-truncate (`driver-hud.statusLineOf`)

`Text` word-wraps long lines, which would inflate row count past the cap. CC
clips at the terminal edge and never wraps; we mirror that:
per row — pad (D2) **then** ANSI-aware `truncateToWidth(row, width)` when a
width is supplied (padding counts toward the width). No-width call
(`statusLine`) leaves rows untruncated (same as custom v1 today).

### D5 — Resize recomputes the string (`root.ts` resize path, ~2 lines)

The v1 "resize does not recompute until next emit" downgrade (`root.ts:
455-456`) is amplified by multi-row (each over-wide row silently wraps into
extra rows on narrow shrink). Fix it at the handler: re-run
`statusline.setText(driver.statusLineIn(width))` on resize, removing the
downgrade comment. If this unexpectedly pushes `root.ts` over the 500-line
cap, drop to the fallback (keep the downgrade, record it for multi-row in the
manifest) — but recompute-on-resize is the intended fix.

Known residual degradation (recorded, not fixed): on extremely short
terminals the shrink algorithm clips the **bottom** rows of the statusline
first, i.e. the mode row disappears before content rows. Acceptable.

### D6 — Permission-mode change re-fires the command (unchanged v1 behavior)

The S1 emit-diff (`statusline-wiring.ts:209-216`) fires the command on every
permission-mode transition; the mode row also re-reads on every emit
(`root.ts:457`). Wording of record: a mode switch BOTH updates the mode row
AND re-fires the command — no claim that one happens without the other.

## Implementation slices

1. **S1 runner**: D1 + runner unit tests (≤3 rows, trailing-empty drop,
   all-empty → blank, per-line trimEnd with ANSI).
2. **S2 formatting**: `formatModeLine` extraction (+ byte-identical built-in
   proof via existing specs), D2 padding-per-row, D3 trimmed-blank predicate
   + mode-row append, D4 pad-then-`truncateToWidth`.
3. **S3 wiring/e2e/layout**: D5 resize recompute; driver-statusline spec
   updates — `:230` full multi-row expectation, `:231` flip
   `.not.toContain('shift+tab')` → mode-row assertion (last row), `:297`
   blank case → `toBe(formatModeLine(mode))`, `:308` deactivation restores
   byte-identical built-in (unchanged); add multi-row driver/wiring cases
   (padding per row, ≤3 cap, mode switch updates row + refires command);
   fullscreen-layout/vt-renderer: 3-row statusline pinned at bottom,
   transcript cedes rows, built-in single-row cases untouched.
4. **S4 manifest/docs**: `ux.statusline` deviation rewrite (rows up to a
   3-row cap; client-drawn mode/hints row appended — payload carries no mode
   field, matching CC where that row is client chrome; resize downgrade
   removed if D5 lands), `pnpm docs:parity` regen, `check:capabilities`
   clean, this plan committed as truth-sync.

## Verification plan

- Behavior spec (what "works" means): with
  `"statusLine": {"type":"command","command":"ccstatusline","padding":0}`,
  the TUI bottom shows ccstatusline's two rows, then
  `<mode> · shift+tab · /quit`; transcript cedes 2 rows. Switching
  permission mode updates the last row (and re-fires the command via the
  existing S1 trigger). Resizing narrower clips each row (no wrap-inflation)
  and recompute happens at resize, not at the next emit.
- How driven: targeted vitest (`statusline-command`, `statusline`,
  `driver-statusline`, `fullscreen-layout`, `vt-renderer`, `resize`,
  `no-polling` unchanged: no new timers); gates: `pnpm check:size` (driver.ts
  /driver-types.ts untouched; root.ts ≤500), typecheck, lint,
  `pnpm docs:parity` + `check:capabilities`.
- Pass criteria: all listed specs green, gates green, and the behavior spec
  above observable in the vt-renderer layout assertions.
- Final visual confirmation happens in a real session after the next
  release (house rule: no observation, no claim).
