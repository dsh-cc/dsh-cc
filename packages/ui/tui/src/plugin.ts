/**
 * Boot wiring: packaged CC preset, TTY lease, driver, pi-tui mount.
 * @module @dsh-cc/tui/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './index.ts'
import { createDriver } from './harness/driver.ts'
import { printExitTip } from './exit-tip.ts'
import { ensurePackagedPreset } from './packaged-preset.ts'
import { acquireTerminal } from './terminal/lease.ts'
import { buildRoot } from './components/root.ts'

/**
 * Start the TUI inside a dsh process.
 */
export async function mountTui(ctx: Context, config: Config): Promise<void> {
  const packaged = ensurePackagedPreset()
  if (packaged.status === 'conflict') {
    ctx.logger.warn(
      'dsh-cc-tui: ~/.dsh/.agent-presets/cc exists and is not managed by this package; leaving it in place',
    )
  } else if (packaged.status === 'missing-source') {
    ctx.logger.warn(
      'dsh-cc-tui: packaged CC preset files were not found next to the plugin; '
      + 'ensure ~/.dsh/.agent-presets/cc exists (dsh-cc or scripts/sync-cc-preset.sh)',
    )
  }

  const driver = await createDriver(ctx, {
    ...config.cwd === undefined ? {} : { cwd: config.cwd },
    ...config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset },
    ...config.sessionId === undefined
      ? {}
      : { sessionId: config.sessionId },
    ...config.autoResume === undefined ? {} : { autoResume: config.autoResume },
    ...config.continueRequested === undefined ? {} : { continueRequested: config.continueRequested },
    ...config.provider === undefined || config.provider.length === 0
      ? {}
      : { provider: config.provider },
    ...config.model === undefined || config.model.length === 0
      ? {}
      : { model: config.model },
    // /copy hands the OSC 52 sequence to the live terminal (`root` is assigned
    // below, before any command can run — same late-binding pattern as the
    // shutdown closure).
    copyWrite: (sequence) => {
      root.tui.terminal.write(sequence)
    },
    // The driver owns the /quit finalizer (worktree-exit decisions included),
    // so process shutdown hooks here as a late-bound closure — `shutdown` is
    // defined just below and not yet assigned, which is safe because this
    // only runs once a quit decision actually settles.
    onQuit: () => {
      shutdown()
    },
  })

  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
  }

  let shuttingDown = false

  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    // Read before dispose: dispose tears down the agent session.
    const sessionId = driver.currentSessionId
    try {
      root.destroy()
      root.stopForExit()
    } catch {
      // best-effort
    }
    void driver.dispose().finally(() => {
      lease.release()
      // Outside the teardown try/catch: a stopForExit throw must not swallow
      // the tip, which must land in normal-screen scrollback before exit.
      printExitTip({ sessionId })
      process.exit(0)
    })
  }

  const lease = acquireTerminal({
    onSignal: () => {
      shutdown()
    },
  })

  const root = buildRoot(driver, {
    onQuit: shutdown,
    ...(config.uiMode === undefined ? {} : { uiMode: config.uiMode }),
    ...(config.mouse === undefined ? {} : { mouse: config.mouse }),
    ...(config.theme === undefined ? {} : { theme: config.theme }),
  })

  root.tui.start()

  ctx.effect(() => () => {
    lease.release()
    root.destroy()
    void driver.dispose()
  })
}
