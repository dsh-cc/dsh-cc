# @dsh-cc/pi-tui

Vendored upstream [pi-tui](https://github.com/earendil-works/pi) (`packages/tui`) renderer for the dsh-cc-plugins TUI.

Vendored (not npm-depended) because the surface will need deliberate divergences (markdown wrapping, composer triggers, theme seams) and the repo's pattern is vendor-on-invasive-delta. Source of truth for provenance and local edits: [PORTING.md](./PORTING.md). License: MIT (see LICENSE).

**Rule**: this package must not import `@deepseek-ai/*`, `@dsh-cc/*`, or anything outside its own tree beyond its two declared deps and node builtins. Enforced: `pnpm run check:vendor-purity`.
