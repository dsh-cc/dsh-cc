# @dsh-cc/session-title-provider

English | [中文](README.zh.md)

CC host-plane first-prompt session-title provider: mirrors the stock `session-title-first-prompt-llm` plugin, but stamps the auxiliary model route from the CC model-alias cheap lane — `resolve('haiku')` — before the shared `generateSessionTitleWithLlm` call.

## Route resolution

Order of precedence for the auxiliary title request:

1. **Explicit `provider`+`model` config pair** on this plugin's YAML row (both fields together) wins outright.
2. **The configured `haiku` alias** — resolved via `ccModelRoutes` when the service is mounted, otherwise read live from the `model-aliases` settings overlay (the read never re-registers that namespace; `settings.register` throws on duplicates). A string-form alias (`haiku: deepseek-v4-flash`, model only) inherits the missing provider from the logged main-request route.
3. **Inherit** — with neither, the request's logged main-request route is used (the shared library's behavior).

An unconfigured builtin alias also inherits, so mounting this plugin with no `haiku` configured is behaviorally identical to the stock plugin.

## Composition

cc-shell mounts this host-plane row by disabling the stock `session-title-llm` plugin and inserting this one into its bundle patch (`cordis.patch.yml`, row `session-title-llm-cc`) with the default framing policy (`targetWords: 5`, `targetCjkCharacters: 10`, `maxInputBytes: 4096`, `maxOutputTokens: 64`, `timeoutMs: 60000`).

The plugin injects `sessionTitle`, `llm`, and `sessions`; it registers one provider with `automatic: 'first-prompt'`, so titles generate from the first human prompt of a session. Generated titles are accepted, logged, and folded by the host session-title service — this package owns only route stamping and message selection (the first human message).

## Known Limitations and Deferred Work

- **First prompt only** — unlike CC, later prompts do not re-title the session (`all-prompts` cadence is not enabled).
- **No `/rename` here** — user rename goes through the `command-rename` command plugin; the title service pins user titles itself.
