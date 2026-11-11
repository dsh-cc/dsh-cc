# @dsh-cc/version-info

Single owner of the "read my own `package.json` version" idiom.

## Why this package exists

Three packages — `@dsh-cc/command-version`, `@dsh-cc/config-snapshot` and
`@dsh-cc/cc-acp` — each carried a byte-identical `readOwnVersion()` plus its own
`FALLBACK_VERSION` constant. The duplication was deliberate (the repo's
`check:deep-imports` gate forbids cross-package `src/` imports), which left
`scripts/release.mjs` responsible for rewriting every copy in lockstep. One copy
had already drifted four releases behind.

This package is the recorded home for that idiom: consumers re-export from here,
and the release script rewrites exactly one constant.

## API

```ts
import { FALLBACK_VERSION, readOwnVersion } from '@dsh-cc/version-info'

const version = await readOwnVersion()          // this package's manifest
const version2 = await readOwnVersion('0.0.0')  // explicit fallback
```

`readOwnVersion` reads the manifest next to the compiled module and returns the
fallback when the file is missing or unreadable — a bundled deploy without a
`package.json` still reports a version instead of throwing.

Every package in this workspace shares the release-train version, so reading this
package's manifest answers the same question for every caller.

## Contracts

- **Total**: never throws; unreadable manifest degrades to the fallback.
- **Offline**: one local file read, no network, no clock.
- **Single rewrite point**: `scripts/release.mjs` updates `FALLBACK_VERSION` here
  and nowhere else.
