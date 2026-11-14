# @dsh-cc/bundle-tui

English | [中文](README.zh.md)

Surface bundle for the `tui` profile: disable `hmr`, insert the agent-preset
roster, and mount `@dsh-cc/tui`. The patch also inserts the runtime-scoped
`tool-search` row (`@dsh-cc/tool-search`, a hard dependency of this bundle), so
the tool-deferral registry mounts once per runtime at the bundle layer, outside
every preset standing mount. The host agent-plane rows are vacated by
[`@dsh-cc/bundle-shell`](../cc-shell/README.md), shared with the ACP lane, so
this bundle does not restate that roster. The roster has two presets: `cc` (order 5, the default) and `vwa`
(order 6), both composed from `@dsh-cc/preset-cc` (`cordis.patch.yml` rows
`preset-cc` and `preset-vwa`). The bundle pins the TUI `uiMode` to `fullscreen`.

Does **not** retarget `tools` (cc-shell) or `settings` / `permission-rules`
(cc-permissions). Does **not** start an HTTP server.
