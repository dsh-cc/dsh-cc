#!/usr/bin/env bash
# mk-harness-pair.sh — create/remove self-contained "pair worktrees" that pin a
# dsh-cc worktree to a specific deepseek-harness version line.
#
# Why pairs: every @deepseek-ai/* link: dep materializes in node_modules as a
# relative symlink climbing six levels out of the package tree, so a checkout
# resolves its harness from the SIBLING directory named `deepseek-harness` next
# to the checkout root. The main checkout and flat .claude/worktrees/* checkouts
# all share that one sibling (the repo-level symlink), so they can only follow
# ONE harness line at a time. A "pair" gives each dsh-cc worktree its own
# private sibling harness checkout, letting worktrees on different harness
# lines (e.g. latest vs next) run in parallel without touching each other.
#
# Layout created by `create`:
#   .claude/worktrees/<pair>/dsh-cc/          <- dsh-cc worktree (branch worktree-<pair>)
#   .claude/worktrees/<pair>/deepseek-harness <- harness checkout, detached at <ref>
# Everything lands under the gitignored .claude/worktrees/, so the dsh-cc repo
# never sees the harness tree; the harness worktree registers in the harness
# repo's own .git/worktrees.
#
# Usage:
#   scripts/mk-harness-pair.sh create <pair> [--ref <sha|version>] [--base <gitish>]
#                                  [--branch <name>] [--skip-harness-build]
#                                  [--skip-dsh-install] [--native]
#   scripts/mk-harness-pair.sh remove <pair> [--delete-branch]
#   scripts/mk-harness-pair.sh list
#
# <ref> accepts anything git rev-parses in the harness repo (sha, tag, branch),
# or a bare version string like 0.2.2-rc.1 which is resolved to the
# `release(dsh): <version>` commit (the canonical pin form; the released
# package.json version is re-checked against <ref> to guard against title-only
# matches). Default ref: the sha currently pinned as DSH_HARNESS_REF in
# .github/workflows/presubmit.yml.
#
# Discipline (see docs/dev.md "Parallel harness lines"):
# - run this from the main checkout BEFORE launching the session that will
#   work in the pair (the AGENTS.md/change-cookbook §2 stop line against
#   creating worktrees mid-session applies — the pair's session should start
#   with its cwd inside .claude/worktrees/<pair>/dsh-cc);
# - after checkout the harness MUST be built (pnpm install + build:lib) before
#   trusting any local gate — stale/absent lib/ is the #1 false-green source;
# - after the line lands in main, fold back: retarget DSH_HARNESS_REF, rebase
#   the shared sibling harness checkout to the new ref, then `remove` the pair.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS_REPO="${HARNESS_REPO:-$REPO_ROOT/../deepseek-harness}"
PAIRS_ROOT="$REPO_ROOT/.claude/worktrees"

die() { echo "mk-harness-pair: $*" >&2; exit 1; }
info() { echo "==> $*"; }

pin_sha() {
  # The harness ref dsh-cc main is currently verified against.
  sed -n 's/.*DSH_HARNESS_REF:[[:space:]]*\([0-9a-f]\{40\}\).*/\1/p' \
    "$REPO_ROOT/.github/workflows/presubmit.yml" | head -1
}

resolve_harness_ref() {
  local ref="$1"
  if git -C "$HARNESS_REPO" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1; then
    git -C "$HARNESS_REPO" rev-parse "$ref^{commit}"
    return 0
  fi
  # Bare version string -> release commit.
  local sha
  sha="$(git -C "$HARNESS_REPO" log --all --grep="release(dsh): $ref" -1 --format=%H || true)"
  [ -n "$sha" ] || die "cannot resolve '$ref' in $HARNESS_REPO (not a rev, no release(dsh) commit)"
  local v
  v="$(git -C "$HARNESS_REPO" show "$sha:package.json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ "$v" = "$ref" ] || die "release commit $sha says version '$v', not '$ref' — refusing"
  echo "$sha"
}

cmd_create() {
  [ $# -ge 1 ] || die "create needs a <pair> name"
  local pair="$1"; shift
  local ref base branch
  ref="$(pin_sha)"
  base="origin/main"
  branch="worktree-$pair"
  local skip_harness_build=0 skip_dsh_install=0 native=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) ref="$2"; shift 2;;
      --base) base="$2"; shift 2;;
      --branch) branch="$2"; shift 2;;
      --skip-harness-build) skip_harness_build=1; shift;;
      --skip-dsh-install) skip_dsh_install=1; shift;;
      --native) native=1; shift;;
      *) die "unknown option: $1";;
    esac
  done
  local pair_dir="$PAIRS_ROOT/$pair"
  [ -e "$pair_dir" ] && die "$pair_dir already exists"
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 \
    || die "base '$base' does not resolve in $REPO_ROOT"
  ref="$(resolve_harness_ref "$ref")"
  local ref_version
  ref_version="$(git -C "$HARNESS_REPO" show "$ref:package.json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  info "pair '$pair': dsh-cc base=$base branch=$branch, harness=${ref:0:10} (v$ref_version)"

  mkdir -p "$pair_dir"
  info "creating dsh-cc worktree at $pair_dir/dsh-cc"
  git -C "$REPO_ROOT" worktree add "$pair_dir/dsh-cc" -b "$branch" "$base"

  info "creating harness checkout at $pair_dir/deepseek-harness"
  git -C "$HARNESS_REPO" worktree add --detach "$pair_dir/deepseek-harness" "$ref"

  if [ "$skip_harness_build" = 0 ]; then
    info "installing + building harness (stale lib/ is the #1 false-green source)"
    (cd "$pair_dir/deepseek-harness" && pnpm install --frozen-lockfile && pnpm run build:lib)
    if [ "$native" = 1 ]; then
      (cd "$pair_dir/deepseek-harness" && pnpm run build:native-system)
    fi
  else
    echo "    (skipped harness install/build by flag — do NOT trust tsc/vitest until built)"
  fi

  if [ "$skip_dsh_install" = 0 ]; then
    info "installing dsh-cc worktree deps (hard-linked from the global store)"
    (cd "$pair_dir/dsh-cc" && pnpm install --frozen-lockfile)
  fi

  # Verify the geometry: node_modules must resolve into THIS pair's harness.
  local probe="$pair_dir/dsh-cc/packages/interaction/permission-rules/node_modules/@deepseek-ai/cordis"
  [ -e "$probe" ] || probe="$pair_dir/dsh-cc/node_modules/@deepseek-ai/cordis"
  [ -e "$probe" ] || die "no @deepseek-ai/cordis link found to verify (did the install run?)"
  local resolved
  resolved="$(cd "$(dirname "$probe")" && realpath "$probe")"
  case "$resolved" in
    "$pair_dir/deepseek-harness"*) info "verified: link resolves into the pair harness: $resolved";;
    *) die "GEOMETRY BROKEN: link resolves outside the pair ($resolved) — do not use this pair";;
  esac

  info "done. Next steps:"
  echo "  cd $pair_dir/dsh-cc   # launch the work session here (serena binds to this cwd)"
  echo "  node_modules/.bin/tsc -b tsconfig.packages.json --force   # after harness build, before trusting green"
  echo "  teardown: scripts/mk-harness-pair.sh remove $pair"
}

cmd_remove() {
  [ $# -ge 1 ] || die "remove needs a <pair> name"
  local pair="$1"; shift
  local delete_branch=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --delete-branch) delete_branch=1; shift;;
      *) die "unknown option: $1";;
    esac
  done
  local pair_dir="$PAIRS_ROOT/$pair"
  [ -d "$pair_dir" ] || die "$pair_dir does not exist"
  info "removing dsh-cc worktree"
  git -C "$REPO_ROOT" worktree unlock "$pair_dir/dsh-cc" 2>/dev/null || true
  git -C "$REPO_ROOT" worktree remove --force "$pair_dir/dsh-cc"
  info "removing harness worktree (registered in the harness repo)"
  git -C "$HARNESS_REPO" worktree remove --force "$pair_dir/deepseek-harness"
  rmdir "$pair_dir" 2>/dev/null || info "pair dir not empty, left in place: $pair_dir"
  if [ "$delete_branch" = 1 ]; then
    git -C "$REPO_ROOT" branch -D "worktree-$pair" || true
  else
    echo "  branch worktree-$pair left in place; delete with: git branch -D worktree-$pair"
  fi
  info "removed pair '$pair'"
}

cmd_list() {
  local found=0
  for pair_dir in "$PAIRS_ROOT"/*/; do
    [ -e "$pair_dir/dsh-cc/.git" ] || continue  # worktree .git is a gitdir FILE, not a dir
    [ -e "$pair_dir/deepseek-harness/.git" ] || continue
    found=1
    local name dsh_head harness_head harness_v
    name="$(basename "$pair_dir")"
    dsh_head="$(git -C "$pair_dir/dsh-cc" log -1 --format='%h %s' | head -c 80)"
    harness_head="$(git -C "$pair_dir/deepseek-harness" log -1 --format='%h (%as)')"
    harness_v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pair_dir/deepseek-harness/package.json" | head -1)"
    echo "pair $name: dsh-cc [$(git -C "$pair_dir/dsh-cc" branch --show-current)] $dsh_head"
    echo "  harness: v$harness_v @ $harness_head"
  done
  [ "$found" = 0 ] && echo "(no harness pairs under $PAIRS_ROOT)"
}

case "${1:-}" in
  create) shift; cmd_create "$@";;
  remove) shift; cmd_remove "$@";;
  list) cmd_list;;
  *) sed -n '2,30p' "$0"; exit 1;;
esac
