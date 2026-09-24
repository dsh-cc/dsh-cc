# @dsh-cc/tool-manage-skill

English | [中文](README.zh.md)

Model-facing `manage_skill` tool for learned skills (plan
`docs/plans/2026-09-23-learned-skills.md` §4.4). Mounted unconditionally in the
cc-services group of the CC preset; the `cc-learn.enabled` gate is checked at
call time.

## Behavior

- **Actions**: `create` (requires `name`, `description`, `body`), `update`
  (requires `name` plus at least one of `body`/`description`; all other
  frontmatter keys are preserved), `delete` (removes the whole skill
  directory), `list` (one line per learned skill:
  `<name> — <description> (<bytes> B) — <path>`; empty root → "no learned
  skills").
- **Storage**: shared `LearnedSkillStore` from `@dsh-cc/skill-loader`, rooted
  at `$DSH_HOME/learned-skills/`. Writes are atomic (wx create; temp+rename
  update; `rm -r` delete).
- **Gate**: reads `settings.get('cc-learn')` directly; a missing section or
  service falls back to enabled. Gate off → non-error text
  "manage_skill is disabled (`cc-learn.enabled` is false in settings)."
- **Errors**: `isError: true` tool results carrying a stable code word —
  `invalid_name`, `invalid_params`, `too_large`, `shadowed`,
  `already_exists`, `not_found` (with an authored-claimant hint where the
  store adds one).
- **Refresh**: every successful mutation emits the package-private
  `skills/learned-changed` cordis event so the skill registry invalidates its
  collect cache (§4.5); failures never emit.
- **Promotion guidance** (in the tool description): promote only procedural,
  repeatable lessons ("how to do X here"); facts and secrets stay in memory.
