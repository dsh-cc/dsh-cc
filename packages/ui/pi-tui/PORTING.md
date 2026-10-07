# PORTING — @dsh-cc/pi-tui

Vendored copy of pi-tui from canonical upstream.

- **Upstream**: https://github.com/earendil-works/pi → `packages/tui`
- **Upstream SHA at vendor time**: `7c10bd4337495ee613f2224843ecdf349b80d1df` (reproducible: these are canonical bytes of that commit)
- **Vendor date**: 2026-11-13
- **npm cross-check**: `@earendil-works/pi-tui@1.0.4` (published dist of the same line)
- **Excluded**: the adjacent `native/` directory (sibling of `src/`; darwin/linux/win32 native helpers for clipboard and modifier detection — `src/native-platform.ts` loads them fail-soft and returns undefined when a `.node` prebuild is absent, and `getNativePlatformHelper` only loads on darwin/win32; the JS path stands alone), `test/`, upstream build (`tsgo`, `tsconfig.build.json`, `scripts.*`) — this package builds via the repo's root `tsc -b` like every sibling
- **Re-vendor protocol**: update SHA + date above; every local edit must append a numbered entry below before commit
- **Byte-identity gate**: `VENDOR_MANIFEST.json` records the sha256 of every file under `src/` plus the upstream SHA pinned above. `check:vendor-purity` fails on any modified, added, or missing `src/` file, and on a manifest whose upstream SHA disagrees with this file — so an unrecorded local edit to the vendored source cannot pass CI. Regenerating the manifest is a deliberate act: `node scripts/check-vendor-purity.mjs --update-manifest --upstream-sha <new-sha>`, committed together with the new `src/` and the SHA bump above.

## Local divergences

Source is byte-identical to the recorded SHA. Building it under this repo's `tsconfig.base.json` required looser pedantic flags than upstream's own build (`strict: true` only):

- **D1 (build config)**: `packages/ui/pi-tui/tsconfig.json` sets `exactOptionalPropertyTypes: false`, `noUncheckedIndexedAccess: false`, `noImplicitOverride: false`, `noUnusedLocals: false`. Upstream builds with plain `strict: true` (tsgo); the four repo pedantic flags produce only internal type-level errors, none behavioral. Source stays pristine; only the vendored package's own tsconfig differs. Re-verified at v1.0.4: all four relaxations are still required (92/126/1/1 type errors respectively when each flag is turned on).
- **D2 (packaging)**: published under the `@dsh-cc/pi-tui` name because the TUI surface ships it as a `workspace:^` dependency; MIT attribution travels via LICENSE and this file. Upstream identity (`@earendil-works/pi-tui`) is the provenance record above, not our package name.
- **D3 (check:size exemption)**: `scripts/check-file-size.mjs` skips this subtree (`VENDOR_EXEMPT`, kept in sync with `PKG` in `scripts/check-vendor-purity.mjs`). Re-vendoring replaces `src/` wholesale, so a local file split would be destroyed on every upstream SHA bump. First-party sources are hard-capped at 500 lines; this package is not.
