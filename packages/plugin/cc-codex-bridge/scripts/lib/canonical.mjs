/**
 * canonical.mjs — the single arming/derivation source for the
 * codex-rescue-bridge hooks (plan §9 S3, §5 anchor-lint "one source").
 *
 * Every hook (PreToolUse allow, SessionStart context) derives the canonical
 * anchor pair and the refusal/arming verdict through THIS module only; the
 * specs pin that no hook re-implements the derivation.
 *
 * Canonical anchors (§3.1): `realpath(process.execPath)` of the calling hook
 * process plus the realpath of the sibling `scripts/codex-rescue-run.mjs`
 * resolved from the hook's own `import.meta.url`. Refusal set (§3.2-e): the
 * canonicalized session cwd plus the canonical tmp roots, unrealpathable
 * entries skipped.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const safeReal = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** Containment against canonicalized roots (path-boundary aware). */
export const inside = (p, roots) => p !== null && roots.some((root) => p === root || p.startsWith(root + '/'))

/** POSIX single-quote escape: bytes inside the quotes are pure data. */
export const posixSingleQuote = (s) => `'` + String(s).replaceAll(`'`, `'\\''`) + `'`

/**
 * Derive the canonical anchor pair from the CALLING hook's own location
 * (pass that hook's `import.meta.url`). Returns null when either anchor is
 * unrealpathable.
 */
export function deriveAnchors(hookUrl) {
  const node = safeReal(process.execPath)
  const launcher = safeReal(fileURLToPath(new URL('../scripts/codex-rescue-run.mjs', hookUrl)))
  if (node === null || launcher === null) return null
  return { node, launcher }
}

/** Refusal set (§3.2-e): session cwd plus canonical tmp roots. */
export function refusalRoots(cwdRaw) {
  return [safeReal(cwdRaw), safeReal(tmpdir()), safeReal('/tmp')].filter((p) => p !== null)
}

/**
 * Arming predicate with machine-readable reasons. `hookUrl` is the calling
 * hook's `import.meta.url`; `env` defaults to `process.env` (the hooks pass
 * nothing and inherit it).
 */
export function arming(cwdRaw, { hookUrl, env = process.env } = {}) {
  const anchors = deriveAnchors(hookUrl)
  if (anchors === null) return { armed: false, reason: 'anchor-unrealpathable' }
  const cwd = safeReal(typeof cwdRaw === 'string' && cwdRaw !== '' ? cwdRaw : process.cwd())
  if (cwd === null) return { armed: false, reason: 'anchor-unrealpathable' }
  const roots = refusalRoots(cwd)
  if (inside(anchors.node, roots) || inside(anchors.launcher, roots)) {
    return { armed: false, reason: 'anchor-under-writable-root' }
  }
  if (env.BASH_ENV) return { armed: false, reason: 'bash-env-set' }
  if (env.ENV) return { armed: false, reason: 'env-set' }
  return { armed: true, node: anchors.node, launcher: anchors.launcher, cwd }
}

/**
 * The ARMED additionalContext block: the exact canonical invocation to type,
 * both anchor paths POSIX single-quote-escaped so hostile install paths
 * survive as pure data.
 */
export function armedText({ node, launcher }) {
  const q = posixSingleQuote
  return [
    'cc-codex-bridge: the Codex rescue lane is ARMED. Use EXACTLY this canonical invocation for a rescue:',
    `${q(node)} ${q(launcher)} -- 'the rescue prompt, single line'`,
    'For a multi-line prompt, write the text to a file inside this workspace (or the canonical tmpdir), then run:',
    `${q(node)} ${q(launcher)} --prompt-file 'the prompt file path'`,
    'Add --last ONLY when the user explicitly asks to continue the previous rescue (it resumes the most recent rescue thread).',
  ].join('\n')
}

/** The REFUSED additionalContext block: machine reason in plain words. */
export function refusedText(reason) {
  const words =
    reason === 'anchor-under-writable-root'
      ? "the plugin's launcher sits under this session's workspace, expected in dsh-cc repo dev sessions"
      : reason === 'bash-env-set'
        ? 'the ambient BASH_ENV variable is non-empty (shell-function takeover defense)'
        : reason === 'env-set'
          ? 'the ambient ENV variable is non-empty (shell-function takeover defense)'
          : 'the plugin\'s canonical anchors could not be resolved in this environment'
  return [
    `cc-codex-bridge: the Codex rescue lane is NOT armed (reason: ${reason} — ${words}).`,
    'Codex rescue today goes through the normal, approval-requiring path; do NOT guess or construct the bridge\'s canonical bash invocation manually.',
  ].join('\n')
}
