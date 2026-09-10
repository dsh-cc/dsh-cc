# @dsh-cc/bundle-tui

[English](README.md) | 中文

面向 `tui` profile 的 surface bundle：禁用 agent 平面各行的宿主副本（与 `dsh-web-app` 同一份列表），插入默认为 `cc` 的 agent 预设名册，并挂载 `@dsh-cc/tui`。

**不会**重定向 `tools`（cc-shell）或 `settings` / `permission-rules`（cc-permissions）。**不会**启动 HTTP 服务器。
