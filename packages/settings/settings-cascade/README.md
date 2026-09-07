# @dsh-cc/settings-cascade

English | [中文](README.zh.md)

Claude Code-style five-level settings cascade provider for `ctx.settings`. Five sources merge low-to-high — user settings, project settings, local settings, flag settings, policy settings — under a plugin-default base. The merged raw document feeds the user-settings seam, whose namespace resolution layers schema defaults, the registrant `base`, and this user layer in turn.

## Config

| Field | Meaning | Default |
|---|---|---|
| `userSettingsPath` | User settings file | `settings.json` under the harness home |
| `projectSettingsPath` | Project settings file | `<project>/.claude/settings.json` |
| `localSettingsPath` | Local (gitignored) settings file | git main-checkout root (linked worktree) or git toplevel `.claude/settings.local.json` |
| `flagSettingsPath` | Command-line `--settings` file | none |
| `flagSettingsInline` | Inline `--settings` content, merged over the flag file | none |
| `projectDir` | Seeds the **project** settings path and is the launch directory for the git probe behind the local settings path | current working directory |
| `dshHome` | Harness home for the default user settings path | `$DSH_HOME` or `~/.dsh` |
| `policy.remoteSettings` | Hosted policy settings; highest policy priority | none |
| `policy.systemPath` | System-level managed settings file | none |
| `policy.userPath` | User-writable managed settings file | none |

Defaulting is one explicit `resolveSpec(config)` step.

## Behavior

- **Priority order from low to high.** user < project < local < flag < policy. Sources deep-merge recursively; a higher source fills keys a lower one omitted and replaces the values it does carry.
- **Plugin defaults sit at the bottom.** Registration `base` and schema defaults resolve below every file source, so a missing document resolves exactly as a leaf provider would.
- **Permission arrays union, `deny` wins.** `allow`, `deny`, and `ask` rule arrays concatenate and deduplicate across layers, and the unioned `deny` set is removed from `allow` — a higher-layer deny always beats a lower-layer allow. Empty permission arrays are omitted. Other arrays (for example `additionalDirectories`) let the higher layer override wholesale.
- **Policy is first-source-wins.** The policy layer takes the first non-empty of its sub-sources in priority order: remote > system file > user file. An empty or absent higher source falls through to the next.
- **Flag settings merge file-then-inline.** If both a `--settings` file and inline content are present, the inline content merges over the file within the flag layer.
- **Misconfiguration fails loud.** A present-but-invalid settings document (unparsable JSON, or a non-object root) fails plugin load; an absent source file contributes nothing and is not an error.
- **The provider is writable through the user layer.** `writable` is `true`, so the seam's in-process `update()`/`replace()`/`mutate()` paths are accepted. A write is applied as a surgical delta onto the user-layer settings file (default `$DSH_HOME/settings.json`): only the keys the caller actually changed land in the user file. Values the write did not touch are not copied in, even if they were inherited from a higher layer. The seam still owns validation, revision, and update events; project/local/flag/policy sources remain read-side-only contributors.
- **The local settings file path hoists git-style.** When the launch directory is a git worktree or a subdirectory of a git repo, `.claude/settings.local.json` is read from the git **main checkout root** (worktree) or **toplevel** (subdirectory start), matching Claude Code. Project `settings.json` stays at the launch directory, the session cwd and git operations are unaffected, and paths *inside* the file still resolve against the launch directory. Fallbacks that keep the file at the launch directory: not a git repo, Windows (`win32`), the repo root is `$HOME`, a bare-main hoist target without `.git`, a git probe failure, or ownership of the repo root / `.git` / `.claude` not confirmed as the current user (fail-closed). A worktree-local `settings.local.json` is silently not loaded (merging both is unconfirmed in Claude Code). The hoist resolution itself is boot-time only: entering a worktree mid-session does not re-resolve the local path (file contents still hot-reload — see below).
- **CC camelCase keys alias onto kebab namespaces.** After the five-layer merge (and before publish), a fixed whitelist of Claude Code camelCase top-level keys (`statusLine` → `statusline`) is copied onto its dsh-native kebab namespace. The alias is injected only when the CC key's value is a plain object AND the kebab key is absent from the merged document — a dsh-native key already present wins untouched, and non-object CC values are ignored. No fuzzy matching: the whitelist map is the contract; unknown camelCase keys are never aliased.
- **File sources hot-reload in a running session.** The provider watches the resolved settings file paths — user, project, the git-hoisted local file, the `--settings` flag file, and file-based managed-policy paths — with chokidar, and republishes through the `SettingsProvider` seam, so every registered consumer (permission rules, model aliases, statusline, output styles, plugin loader) re-resolves live; editing `permissions` mid-session takes effect on the very next `decide()`. Watched paths are realpath-canonicalized (symlink-swap updates are caught), not-yet-existent paths are still watched so file creation after boot works, and rapid writes coalesce. A malformed mid-write document keeps the last-good state with a warning and recovers on the fix. Outside hot-reload: inline flag settings, remote policy, `hooks.json` (a separate seam in the hooks bridge), and the boot-time git-hoist probe above.
- **`env` applies in two stages.** A top-level `env` section is split out of the merged document and exposed through `getEnv()` with every value coerced to a string. `applyEnv()` assigns ordinary variables; `applyTrustedEnv()` additionally assigns environment-altering variables (`LD_PRELOAD`, `PATH`, `DYLD_INSERT_LIBRARIES`, and the other `DANGEROUS_ENV_VARS`) and runs only after the user grants trust.

## Permissions schema

The `permissions` field schema (`allow`, `deny`, `ask`, `defaultMode`, `disableBypassPermissionsMode`, `additionalDirectories`, `protectedFiles`, `dangerousPatterns`), matching Claude Code's settings.json, is exported as `PermissionsSchema` (with `PermissionRuleSchema` and `PERMISSION_MODES`) for the permission-rule engine. The optional LLM risk-classifier section is exported as `AutoModeSchema` (delivered as `permissions.autoMode`, not a root-level `autoMode` key — a documented deviation from Claude Code's settings surface).

## Model Experience

Indirectly, through consumers of `ctx.settings`: composition remains the read model, with writes supported through the user layer, and each consumer's own surface documents any model effect.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

- **JSON-only sources.** Sources must be `.json` (the settings.json convention); YAML is deferred.
- **Unsetting an inherited key is not persisted.** Unsetting a key that comes from a lower-priority source (project/local/flag/policy) cannot be persisted to the user file; the unset holds for the running process, but the value reappears on restart. Also, `describe()`'s `user` field reflects the merged section rather than the literal user file, so GUI override markers are approximate (pre-existing behavior).
- **Concurrent writers can lose updates.** Concurrent writes from multiple dsh processes to the same user settings file can silently lose updates — atomic rename prevents file corruption, not lost writes; the stock provider's cross-process lock was dropped for this port. Single-process profiles (the norm) are unaffected.
- **Writes go to the user layer, not the hoisted local file.** `persist()` writes to the user settings file (pre-existing); an always-allow granted in a worktree therefore still does not update the main checkout's `settings.local.json`.
- **No per-source provenance.** The merged result does not record which source supplied each resolved value, and `describe()` cannot mark a field's origin across the five layers the way a single user layer does.
- **Dangerous env is a static allowlist.** `DANGEROUS_ENV_VARS` names a fixed set; deployment-specific variables need an explicit extension point before first use.
