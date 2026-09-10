# @dsh-cc/command-release-notes

English | [中文](README.zh.md)

Human-facing `/release-notes` slash command: prints the bundled changelog offline and deterministically — the changelog ships as a TS string constant, so there is no filesystem or network access at call time.

## Usage

The plugin mounts one command (register it on the `commands` service):

```ts
import { apply, name } from '@dsh-cc/command-release-notes'

ctx.plugin({ name, inject: ['commands'], apply })
```

- `/release-notes` — print the full bundled release notes, newest section first.
- `/release-notes <lines>` — trim the output to the first `<lines>` lines (a positive integer; anything else renders the full text).

Like every command wrapped with `@dsh-cc/command-usage`'s `helpable`, `/release-notes help` returns deterministic plain-text help.

## Notes

- The changelog is seeded at author time from the repository's tracked history and README; update the bundled `CHANGELOG` constant when cutting a new version.
- For programmatic use, `./release-notes` exports `CHANGELOG` and `renderReleaseNotes(markdown?, maxLines?)`.
