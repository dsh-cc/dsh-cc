#!/usr/bin/env bash
# Mirror this repo's @dsh-cc/* packages into a dsh profile's node_modules so
# an unpublished local build boots exactly like the published bundles would.
#
# Why copies, not symlinks: Node resolves modules from a package's realpath.
# A symlinked package would realpath back into this repo, where every
# `import '@deepseek-ai/...'` resolves through our devDep link: into the
# sibling deepseek-harness checkout — a second cordis instance per process.
# Flat copies under the profile instead resolve @deepseek-ai/* through the
# installer-maintained ~/.dsh/profiles/node_modules symlink fallback, which is
# precisely how published bundles share the installation's single cordis
# (README "How the loading works", point 4).
#
# Usage:
#   pnpm run build                       # emit lib/ first
#   bash scripts/sync-local-profile.sh [profile]     # default: web
# then register the two bundles in <profile>/package.json
# dsh.profile.bundles (after the in-box bundles; do NOT add dependencies
# entries — the dsh plugin reconciler never touches bundles that aren't
# dependencies, so hand-registered entries survive).
#
# Re-run after every `pnpm run build` and restart dsh to pick up code changes.
# (Only patch layers are hot-reloaded; plugin code is read at boot.)
set -euo pipefail

profile="${1:-web}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
profile_dir="$dsh_home/profiles/$profile"
dest="$profile_dir/node_modules/@dsh-cc"

if [ ! -d "$profile_dir" ]; then
  echo "profile $profile not found at $profile_dir — boot it once (dsh --profile $profile) or pass another name" >&2
  exit 1
fi

mkdir -p "$dest"
synced=()
missing_lib=0
for pkg_dir in "$repo_root"/packages/*/*/; do
  manifest="$pkg_dir/package.json"
  [ -f "$manifest" ] || continue
  name="$(node -p "require('$manifest').name")"
  case "$name" in @dsh-cc/*) ;; *) continue ;; esac
  # A package whose entry point lives under lib/ must have been built, or the
  # profile will fail to mount it at boot.
  if node -e "
    const p = require('$manifest');
    const fs = require('fs');
    process.exit(p.main?.startsWith('lib/') && !fs.existsSync('$pkg_dir/lib') ? 0 : 1);
  "; then
    echo "warning: $name has no lib/ — run pnpm run build first" >&2
    missing_lib=1
  fi
  rsync -a --delete --exclude=node_modules "$pkg_dir" "$dest/${name#@dsh-cc/}/"
  synced+=("${name#@dsh-cc/}")
done

# Prune copies of packages that no longer exist in the repo (renames/removals),
# otherwise a stale copy keeps resolving under its old name at boot.
for dest_dir in "$dest"/*/; do
  short="$(basename "$dest_dir")"
  found=false
  for kept in "${synced[@]}"; do
    [ "$kept" = "$short" ] && { found=true; break; }
  done
  [ "$found" = false ] && { rm -rf "$dest_dir"; echo "pruned stale $short"; }
done

# Plain-npm runtime dependencies of any synced @dsh-cc package must also reach
# the profile: the dsh plugin reconciler never touches packages that are not
# profile dependencies, and @deepseek-ai/* peers resolve through the
# ~/.dsh/profiles fallback — but third-party deps (tui's highlight.js) and
# deps dsh-base does not carry (historical example: the retired fetch-http
# wrapper's dsh-web-fetch-http, which rc.1's dsh-base now carries itself)
# resolve only via Node's upward node_modules walk.
#
# The copy must be TRANSITIVE: pnpm's strict layout never nests a dep's own
# deps inside the dep (they sit as siblings in the .pnpm container), so
# copying @modelcontextprotocol/sdk alone boot-crashed on its sibling-only
# ajv. BFS below: every copied dep enqueues its own declared dependencies,
# resolved as siblings of its pnpm realpath, onto the profile root.
profile_nm="$(dirname "$dest")"  # .../$profile/node_modules
REPO_PACKAGES="$repo_root/packages" PROFILE_NM="$profile_nm" HARNESS_ROOT="$(cd "$repo_root/.." && pwd)/deepseek-harness" node <<'NODE'
const fs = require('fs')
const cp = require('child_process')
const path = require('path')

const PACKAGES = process.env.REPO_PACKAGES
const PROFILE_NM = process.env.PROFILE_NM
const HARNESS = fs.realpathSync(process.env.HARNESS_ROOT)

// Seeds use `dependencies` only — a @dsh-cc package's peers are host-provided by
// contract (@deepseek-ai/* via the profiles fallback, @dsh-cc/* as synced
// copies). Recursion into npm packages adds peer deps that pnpm actually
// satisfied as container siblings (e.g. the MCP SDK's non-optional zod peer).
const manifestDeps = (manifestPath, includePeers) => {
  const p = require(manifestPath)
  return Object.entries(includePeers ? { ...(p.dependencies || {}), ...(p.peerDependencies || {}) } : (p.dependencies || {}))
    .filter(([, range]) => !range.startsWith('workspace:') && !range.startsWith('link:'))
    .map(([dep]) => dep)
}

// link: devDeps resolve into the sibling harness WORKSPACE; materializing one
// would smuggle a second cordis into the profile (the reason the header of
// this script warns against copies). Registry artifacts live under this
// repo's own node_modules — realpath is the discriminator.
const isLinkedHarnessCopy = (src) => fs.realpathSync(src).startsWith(HARNESS + path.sep)

// Queue items are { dep, nm, includePeers }: `nm` is the directory CONTAINING
// dep (a node_modules dir: initially <pkg>/node_modules, afterwards the pnpm
// .pnpm container).
const queue = []
for (const g of fs.readdirSync(PACKAGES)) {
  for (const p of fs.readdirSync(path.join(PACKAGES, g))) {
    const dir = path.join(PACKAGES, g, p)
    const mf = path.join(dir, 'package.json')
    if (!fs.existsSync(mf)) continue
    const name = require(mf).name || ''
    if (!name.startsWith('@dsh-cc/')) continue
    for (const dep of manifestDeps(mf, false)) queue.push({ dep, nm: path.join(dir, 'node_modules') })
  }
}

const done = new Set()
while (queue.length) {
  const { dep, nm, includePeers = true } = queue.shift()
  if (done.has(dep)) continue
  done.add(dep)
  const src = path.join(nm, dep)
  if (!fs.existsSync(src)) {
    console.error(dep + ' (runtime dep closure) missing near ' + nm)
    process.exit(1)
  }
  if (isLinkedHarnessCopy(src)) continue
  const target = path.join(PROFILE_NM, dep)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  cp.execFileSync('rsync', ['-aL', '--delete', src + '/', target + '/'])
  fs.rmSync(path.join(target, '.bin'), { recursive: true, force: true })
  // pnpm co-locates a package's deps as siblings of its real path inside the
  // .pnpm container's node_modules — walk up to that dir to recurse.
  let container = fs.realpathSync(src)
  while (path.basename(container) !== 'node_modules') container = path.dirname(container)
  for (const next of manifestDeps(path.join(fs.realpathSync(src), 'package.json'), includePeers)) {
    // Only the SEED seed-step copies @deepseek-ai-@scope packages (the
    // historical case was a dsh-cc runtime dep absent from dsh-base; none
    // exists today, but the rule stands for the next one). When recursing FROM an @deepseek-ai package, its own
    // @deepseek-ai deps must stay unpicked: they belong to the host plane and
    // materialize via the healed profiles fallback (copying schemastery here
    // would fork cordis's schema runtime into a shadow instance).
    if (dep.startsWith('@deepseek-ai/') && next.startsWith('@deepseek-ai/')) continue
    if (next.startsWith('@dsh-cc/')) continue
    if (fs.existsSync(path.join(container, next))) queue.push({ dep: next, nm: container })
  }
}
if (done.size) console.log('synced @dsh-cc runtime deps (dereferenced, transitive): ' + done.size)
NODE

# The vendored pi-tui renderer has RUNTIME npm deps (marked,
# get-east-asian-width) that must resolve inside the profile copy. The main
# loop above excluded node_modules for every package (other packages' nm
# symlink into the sibling deepseek-harness via link: devDeps — materializing
# those would duplicate cordis). pi-tui's deps are plain npm tarballs, so
# re-copy it once WITH dereferenced node_modules, then drop nested junk.
pi_tui_src="$repo_root/packages/ui/pi-tui"
if [ -d "$pi_tui_src" ]; then
  rsync -aL --delete "$pi_tui_src/" "$dest/dsh-cc-pi-tui/"
  rm -rf "$dest/dsh-cc-pi-tui/node_modules/.bin" "$dest/dsh-cc-pi-tui/node_modules/@deepseek-ai"
  echo "synced dsh-cc-pi-tui runtime deps (dereferenced)"
fi

echo "synced ${#synced[@]} packages into $dest"
[ "$missing_lib" -eq 0 ] || exit 1

# The runtime reads the cc preset composition from the per-user
# .agent-presets copy, NOT from the synced package — keep the two in lockstep
# so a package-only sync can never boot a stale composition.
bash "$repo_root/scripts/sync-cc-preset.sh"
