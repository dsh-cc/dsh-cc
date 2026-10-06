# PORTING — @dsh-cc/pi-tui

Vendored copy of pi-tui from canonical upstream.

- **Upstream**: https://github.com/earendil-works/pi → `packages/tui`
- **Upstream SHA at vendor time**: `8fa7eebd235355522c8104166b4f1f959b4e2f10` (reproducible: these are canonical bytes of that commit)
- **Vendor date**: 2026-08-26
- **npm cross-check**: `@earendil-works/pi-tui@0.84.3` (published dist of the same line)
- **Excluded**: `native/` (darwin CoreGraphics helper; the JS path stands alone — on macOS some modifier disambiguation falls back), `test/`, upstream build (`tsgo`, `tsconfig.build.json`, `scripts.*`) — this package builds via the repo's root `tsc -b` like every sibling
- **Re-vendor protocol**: update SHA + date above; every local edit must append a numbered entry below before commit
- **Byte-identity gate**: `VENDOR_MANIFEST.json` records the sha256 of every file under `src/` plus the upstream SHA pinned above. `check:vendor-purity` fails on any modified, added, or missing `src/` file, and on a manifest whose upstream SHA disagrees with this file — so an unrecorded local edit to the vendored source cannot pass CI. Regenerating the manifest is a deliberate act: `node scripts/check-vendor-purity.mjs --update-manifest --upstream-sha <new-sha>`, committed together with the new `src/` and the SHA bump above.

## Local divergences

Source is byte-identical to the recorded SHA. Building it under this repo's `tsconfig.base.json` required looser pedantic flags than upstream's own build (`strict: true` only):

- **D1 (build config)**: `packages/ui/pi-tui/tsconfig.json` sets `exactOptionalPropertyTypes: false`, `noUncheckedIndexedAccess: false`, `noImplicitOverride: false`, `noUnusedLocals: false`. Upstream builds with plain `strict: true` (tsgo); the four repo pedantic flags produce only internal type-level errors, none behavioral. Source stays pristine; only the vendored package's own tsconfig differs.
- **D2 (packaging)**: published under the `@dsh-cc/pi-tui` name because the TUI surface ships it as a `workspace:^` dependency; MIT attribution travels via LICENSE and this file. Upstream identity (`@earendil-works/pi-tui`) is the provenance record above, not our package name.
- **D3 (check:size exemption)**: `scripts/check-file-size.mjs` skips this subtree (`VENDOR_EXEMPT`, kept in sync with `PKG` in `scripts/check-vendor-purity.mjs`). Re-vendoring replaces `src/` wholesale, so a local file split would be destroyed on every upstream SHA bump. First-party sources are hard-capped at 500 lines; this package is not.
- **D4 (clipboard image paste)**: `components/editor.ts` gains image-marker support, and `src/index.ts` re-exports its `PastedImage` type. Upstream gates its bracketed-paste branch on `pasteContent.length > 0` (`editor.ts:772` here), so an image paste — which arrives as an EMPTY bracketed paste, `\x1b[200~` immediately followed by `\x1b[201~`, since bracketed paste is a text protocol with no clipboard-type information — is discarded with no user-visible signal. The local edit detects the empty case, calls an injected `EditorOptions.onPasteImage`, and inserts an atomic `[Image #N WxH]` marker, reusing the `[paste #N]` marker grammar (a parallel `isImageMarker`/`isAtomicMarker` pair rather than loosening `PASTE_MARKER_SINGLE`, whose `handleBackspace` branch renumbers only the paste registry). The editor itself never touches the platform or the filesystem: the host injects the reader, exactly as `copySelection` is injected for the write direction. Two behaviors are deliberately NOT upstream's: an empty paste with no `onPasteImage` set still no-ops as before, and an image marker is never expanded by `expandPasteMarkers`/`getExpandedText` (those exist to expand text pastes for external editors).
- **Known stale ledger**: `editor.ts` already carried local edits before D4 that are not recorded here — the tmux CSI-u decode around the key-handling block. The re-vendor protocol says every local edit gets a numbered entry; that one is missing and predates this branch. Recording it here rather than silently leaving the ledger wrong.
