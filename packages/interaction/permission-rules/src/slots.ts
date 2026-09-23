/**
 * Classifier config slots (S2): the built-in prose lists and the generic
 * `$defaults` expansion. Pure — no I/O, no imports.
 * @module @dsh-cc/permission-rules/slots
 */

/**
 * The documented CC classifier soft-deny duties, as prose rules. Expanded into
 * the config list wherever the literal `"$defaults"` appears
 * (position-preserving).
 */
export const DEFAULT_SOFT_DENY: readonly string[] = [
  'Do not act outside the current workspace scope: no writes, installs, or configuration changes that reach beyond it (scope escalation).',
  'Do not target external infrastructure that has not been explicitly recognized in this session (unknown hosts, clusters, cloud accounts, or registries).',
  'Do not destructively remove files or data on critical paths (system directories, dotfiles, caches another tool depends on, uncommitted work).',
  'Do not make irreversible changes to shared state: force-pushes, history rewrites, terraform apply-class provisioning, production data mutations.',
  'Do not exfiltrate credentials, tokens, API keys, or secrets to any destination, including printing them into command arguments or remote URLs.',
  'Do not disable or weaken safety tooling: guards, sandboxing, linters configured as policy, or the permission system itself.',
]

/**
 * The default trust boundary taught to the classifier (D12/A15): the session's
 * starting git repository and its configured remotes; everything else is
 * external infrastructure unless the user's `environment` list names it.
 */
export const DEFAULT_ENVIRONMENT: readonly string[] = [
  'Trust the git repository the session started in (its working directory) and its configured remotes; everything else is external infrastructure unless the user or this environment list names it.',
]

/**
 * The default allow exceptions (D4-adjacent prose re-expression): benign
 * operations that would otherwise read as soft-deny risks. These NEVER soften
 * a hard-deny match (hard_deny arrives in S4).
 */
export const DEFAULT_ALLOW_EXCEPTIONS: readonly string[] = [
  'Installing packages already declared in the repo manifest.',
  'Standard credential and sign-in flows that send credentials only to their own provider.',
  'Committing and pushing to the session working branch.',
]

/**
 * Expand a configured slot list: every `"$defaults"` entry is replaced in
 * place by `defaults`; a list without it replaces the built-ins entirely
 * (CC semantics). Duplicates are preserved as written.
 */
export function expandSlot(list: readonly string[], defaults: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of list) {
    if (entry === '$defaults') out.push(...defaults)
    else out.push(entry)
  }
  return out
}

/**
 * Expand the configured soft-deny list ({@link expandSlot} over
 * {@link DEFAULT_SOFT_DENY}).
 */
export function expandSoftDeny(list: readonly string[]): string[] {
  return expandSlot(list, DEFAULT_SOFT_DENY)
}
