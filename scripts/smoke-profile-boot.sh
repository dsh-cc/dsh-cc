#!/usr/bin/env bash
# smoke-profile-boot.sh — boot the production tui bundle set against a FRESH,
# throwaway DSH_HOME and prove the plugin tree mounts. Zero LLM calls.
#
# Guards two incident classes that both shipped as "merged green, broken for
# every end user" (v0.4.1 tui boot crash, 2026-09-04):
#
#   A. A publishable package whose `lib/` is never emitted (e.g. missing from
#      tsconfig.packages.json) mounts as `Cannot find module .../lib/index.js`.
#      `check:exports` is the cheap static filter; this boot is the proof.
#   B. A runtime import declared as a peer that the host install does NOT carry
#      (`@deepseek-ai/dsh-base`'s npm closure lacks
#      `@deepseek-ai/dsh-web-fetch-http`, and profiles install with
#      `autoInstallPeers: false`) mounts as `Cannot find package ...`.
#      Only a boot with a user-grade resolution pool catches this.
#
# How the pool gets user-grade fidelity: we never pre-create
# $DSH_HOME/profiles/node_modules. The CLI's own prepareProfile() runs
# healProfilesModuleFallback(INSTALL_ANCHOR), materializing the shared
# fallback from the harness CLI's install tree — same composition as the
# published npm `@deepseek-ai/dsh` dependency closure, and therefore exactly
# the pool a real user's plugins resolve against. The @dsh-cc/* copies come
# from scripts/sync-local-profile.sh (built lib/ + plain-npm runtime
# `dependencies` copied into the profile root node_modules).
#
# Pass criteria (deliberately fail-closed):
#   1. the pty transcript is NON-EMPTY (an empty log proves nothing about
#      boot and would make signature checks vacuous),
#   2. the log contains `dsh cc-mode` — the TUI's first rendered frame, which
#      can only appear after the FULL plugin tree (bundles + cc preset incl.
#      cc-services: serena-first, web-fetch-http-cc) has mounted,
#   3. the log has no loader-failure signatures.
#
# Two runs: a warm-up (loose budget, unasserted) lets the one-time fallback
# heal happen outside the timed window, so a slow cold-cache heal never
# masquerades as a boot regression. Each run polls the transcript once per
# second and kills the boot as soon as the marker is seen — a healthy gate
# finishes in ~10-15 seconds, not at the budget.
#
# The pseudo-TTY comes from python3's pty.spawn (stdlib): `script(1)` exits
# immediately when it has no controlling terminal on macOS and loses its
# transcript file when watchdog-killed — both verified 2026-09-04. pty.spawn
# gives the child its own controlling terminal regardless of how this script
# is invoked (CI step, pipe, hook), on macOS and Linux alike. python3 is
# already a repo tool (test:e2e).
#
# Known fidelity gap (accepted): the layout is workspace copies, not the npm
# tarballs. A `files:` whitelist that forgets lib/ or a tarball-level exports
# mistake is not exercised here — that remains check:exports' job (presubmit +
# publish both run it before this smoke).
#
# The harness CLI is expected pre-built at <repo>/../deepseek-harness/apps/cli
# (override with DSH_HARNESS_DIR); presubmit/publish build or cache it first.
# Local convenience: when the sibling checkout exists but its lib/ is only
# half-built, an npm-global dsh (what end users actually run) is used instead,
# with a note on stderr. CI runners have no global dsh, so a bad harness build
# can never silently reroute there.
# Local: `pnpm smoke:profile-boot`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
harness="${DSH_HARNESS_DIR:-$repo_root/../deepseek-harness}"
cli="$harness/apps/cli/lib/bin.js"
profile=cc-smoke

# Preflight probe: resolve packages the bundles mount through the CLI's own
# resolution chain (the anchor healProfilesModuleFallback materializes the
# profiles fallback FROM). A not-fully-built harness pool would fail the boot
# with confusing ERR_MODULE_NOT_FOUND on @deepseek-ai/*/lib.
pool_ok() {  # $1 = cli path
  [ -f "$1" ] || return 1
  # Stage 1: the base bundle must import via the CLI's chain. Stage 2: what
  # dsh-base mounts sits in its OWN nested node_modules (bundle-pinned
  # subgraph, invisible from apps/cli directly) — resolve from the bundle's
  # resolved location, which is where the healed fallback links point.
  node --input-type=module -e "
    import { createRequire } from 'node:module'
    import { pathToFileURL } from 'node:url'
    const req = createRequire(pathToFileURL('$1'))
    let baseJson
    try { baseJson = req.resolve('@deepseek-ai/dsh-base/package.json') } catch (err) {
      console.error('  pool probe failed: @deepseek-ai/dsh-base from ' + '$1' + ' — ' + String(err && err.message || err).split('\n')[0])
      process.exit(1)
    }
    const reqBase = createRequire(pathToFileURL(baseJson))
    for (const probe of ['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-gateway']) {
      try { reqBase.resolve(probe) } catch (err) {
        console.error('  pool probe failed: ' + probe + ' from ' + baseJson + ' — ' + String(err && err.message || err).split('\n')[0])
        process.exit(1)
      }
    }
  "
}

if ! pool_ok "$cli"; then
  npm_g="$(npm root -g 2>/dev/null)/@deepseek-ai/dsh/lib/bin.js"
  if [ -f "$npm_g" ] && pool_ok "$npm_g"; then
    echo "smoke:profile-boot: sibling harness pool incomplete ($harness) — using npm-global dsh: $npm_g" >&2
    cli="$npm_g"
  else
    echo "smoke:profile-boot: harness pool incomplete — cannot resolve mountable lib from $cli" >&2
    echo "  build it: npm --prefix $harness run build:lib (CI's build:lib step does this before this gate)" >&2
    exit 1
  fi
fi

dsh_home="$(mktemp -d "${TMPDIR:-/tmp}/dsh-smoke-home.XXXXXX")"
log_warmup="$dsh_home/boot.warmup.log"
log="$dsh_home/boot.log"

cleanup() {
  # A watchdog-killed pty relay can orphan the node child holding the pty.
  pkill -f "bin.js --profile $profile" 2>/dev/null || true
  rm -rf "$dsh_home"
}
trap cleanup EXIT

# 1. Profile manifest mirrors the production tui bundle set: @deepseek-ai/dsh-base
#    plus the launcher's own BUNDLES list, so the smoke tracks the product
#    definition instead of a hand-copied snapshot. Empty dependencies: the
#    dsh plugin reconciler never touches hand-registered bundles (documented
#    in scripts/sync-local-profile.sh).
mkdir -p "$dsh_home/profiles/$profile"
node --input-type=module -e "
  import { writeFileSync } from 'node:fs'
  import { BUNDLES } from '$repo_root/packages/launcher/tui/bootstrap.mjs'
  const pkg = {
    name: 'dsh-profile-cc-smoke',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...BUNDLES] } },
  }
  writeFileSync('$dsh_home/profiles/$profile/package.json', JSON.stringify(pkg, null, 2) + '\n')
"

# 2. Sync built packages + plain-npm runtime deps + the cc preset.
DSH_HOME="$dsh_home" bash "$repo_root/scripts/sync-local-profile.sh" "$profile"

# 3. Boot under a pseudo-TTY (the TUI's apply() refuses a non-TTY stdout).
#    Poll the transcript each second: marker seen → TERM the boot and return
#    success immediately; process died first → return its exit code; budget
#    blown → kill and return 1.
run_boot() {
  local budget="$1" out="$2"
  DSH_HOME="$dsh_home" python3 - "$cli" "$profile" <<'PY' >"$out" 2>&1 &
import os, pty, sys

cli, profile = sys.argv[1], sys.argv[2]
os.environ['TERM'] = 'xterm-256color'
st = pty.spawn(['node', cli, '--profile', profile])
os._exit(os.waitstatus_to_exitcode(st) if st >= 0 else 1)
PY
  local pid=$!
  local waited=0 status=0
  while true; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || status=$?     # boot exited on its own
      break
    fi
    if grep -q 'dsh cc-mode' "$out" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null            # first frame rendered — done
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    if [ "$waited" -ge "$budget" ]; then
      kill -TERM "$pid" 2>/dev/null; sleep 5; kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null || true
      return 1                                 # marker never came
    fi
    sleep 1; waited=$((waited + 1))
  done
  return "$status"
}

fail() {
  echo "smoke:profile-boot FAIL: $1" >&2
  echo '--- boot log tail ---' >&2
  # NOTE: `2>/dev/null >&2` would bind stdout to the ALREADY-redirected
  # stderr (/dev/null) and print nothing — order matters; route stdout first.
  tail -c 4000 "$log" >&2 2>/dev/null || true
  exit 1
}

# Warm-up: fallback heal (possibly network-bound on cold cache) happens here,
# outside the pass/fail window.
run_boot 180 "$log_warmup" || true

status=0
run_boot 90 "$log" || status=$?

[ -s "$log" ] || fail 'pty transcript is empty — cannot prove anything about boot'
if grep -Eq 'plugin tree failed to load|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND' "$log"; then
  fail 'loader failure signature in boot log'
fi
grep -q 'dsh cc-mode' "$log" \
  || fail 'positive marker missing: TUI first frame (dsh cc-mode) never rendered'
[ "$status" -eq 0 ] \
  || fail "boot process exited $status without rendering the first frame (crashed boots exit fast and non-zero)"

echo "smoke:profile-boot OK — plugin tree mounted, TUI first frame rendered"
