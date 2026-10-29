/** Conservative command shapes for automatic markdown-only authorization. */
import { splitShellCommand } from './shell-segments.ts'
import { parseTaskGrantGitInvocation } from './task-grant-git.ts'

/** Fail closed when the checked index/ref would differ from the executed command. */
export function scopedCommandShapeViolations(command: string, branch: string | null): string[] {
  const split = splitShellCommand(command)
  if (split.kind !== 'segments') return ['cannot determine scoped command shape']
  const invocations = split.segments.map(parseTaskGrantGitInvocation)
  if (invocations.some(invocation => invocation.kind === 'unsupported')) return ['unsupported Git invocation under markdown-only scope']
  for (const invocation of invocations) {
    if (invocation.kind !== 'git' || !['commit', 'push'].includes(invocation.subcommand)) continue
    // Segmentation discards separators, including trailing background operators.
    // Exact source equality admits one foreground command only.
    if (split.segments.length !== 1 || command.trim() !== split.segments[0]!.raw) {
      return ['scoped commit/push must be one foreground command']
    }
    if (invocation.subcommand === 'push') {
      const [remote, refspec, ...extra] = invocation.args
      if (branch === null || remote !== 'origin' || extra.length !== 0
        || (refspec !== branch && refspec !== `${branch}:${branch}`)) {
        return ['scoped push requires exactly origin and the granted branch refspec']
      }
      continue
    }
    for (let index = 0; index < invocation.args.length; index += 1) {
      const arg = invocation.args[index]!
      if (arg === '--allow-empty' || arg === '--allow-empty-message') continue
      if (arg === '-m' || arg === '--message') {
        if (++index >= invocation.args.length) return ['commit message option has no value']
        continue
      }
      if (arg.startsWith('--message=') || (arg.startsWith('-m') && arg.length > 2)) continue
      return [`unsupported scoped commit argument: ${arg}`]
    }
  }
  return []
}
