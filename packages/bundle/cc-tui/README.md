# @dsh-cc/bundle-tui

Surface bundle for the `tui` profile: disable host copies of agent-plane rows
(same list as `dsh-web-app`), insert the agent-preset roster defaulting to
`cc`, and mount `@dsh-cc/tui`.

Does **not** retarget `tools` (cc-shell) or `settings` / `permission-rules`
(cc-permissions). Does **not** start an HTTP server.
