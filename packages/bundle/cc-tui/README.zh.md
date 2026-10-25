# @dsh-cc/bundle-tui

[English](README.md) | 中文

面向 `tui` profile 的 surface bundle：禁用 agent 平面各行的宿主副本（与 `dsh-web-app` 同一份列表），插入 agent 预设名册，并挂载 `@dsh-cc/tui`。名册含两个预设：`cc`（order 5，默认）与 `vwa`（order 6），均由 `@dsh-cc/preset-cc` 组合（`cordis.patch.yml` 的 `preset-cc`、`preset-vwa` 两行）。本 bundle 把 TUI 的 `uiMode` 固定为 `fullscreen`。

**不会**重定向 `tools`（cc-shell）或 `settings` / `permission-rules`（cc-permissions）。**不会**启动 HTTP 服务器。
