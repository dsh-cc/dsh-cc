# @dsh-cc/bundle-tui

English | [中文](README.zh.md)

Surface bundle for the `tui` profile: disable host copies of agent-plane rows
(same list as `dsh-web-app`), insert the agent-preset roster, and mount
`@dsh-cc/tui`. The roster has two presets: `cc` (order 5, the default) and `vwa`
(order 6), both composed from `@dsh-cc/preset-cc` (`cordis.patch.yml` rows
`preset-cc` and `preset-vwa`). The bundle pins the TUI `uiMode` to `fullscreen`.

Does **not** retarget `tools` (cc-shell) or `settings` / `permission-rules`
(cc-permissions). Does **not** start an HTTP server.
