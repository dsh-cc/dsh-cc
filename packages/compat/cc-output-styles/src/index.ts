/**
 * Claude Code-compatible output style selection for the DeepSeek Harness.
 *
 * A selected output style contributes a system-prompt section (empty for the
 * `default` style), switching through a settings key or the `/output-style`
 * command, and re-emits `system-prompt/change` so the next turn reassembles the
 * prompt.
 *
 * @module @dsh-cc/output-styles
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { join } from 'node:path'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  DEFAULT_OUTPUT_STYLE,
  buildStyleLibrary,
  loadCustomStyles,
  styleSectionText,
  type OutputStyle,
} from './styles.ts'

export type { OutputStyle } from './styles.ts'
export {
  BUILTIN_STYLES,
  DEFAULT_OUTPUT_STYLE,
  REPLACES_CODING_INSTRUCTIONS,
  buildStyleLibrary,
  loadCustomStyles,
  parseCustomStyle,
  styleSectionText,
} from './styles.ts'

/** Cordis plugin name. */
export const name = 'cc-output-styles'

/** The prompt registry and human command registry this plugin contributes to. */
export const inject = ['systemPrompt', 'commands']

/** Name of the system-prompt section this plugin owns. */
export const OUTPUT_STYLE_SECTION = 'cc:output-style'

/**
 * Prompt order of the output-style section. Rendered before the deployment
 * persona (`0`) so the communication contract is among the first text a model
 * reads; harness identity (`-100`) still precedes it.
 */
export const OUTPUT_STYLE_ORDER = -50

/** Settings namespace carrying the selected output style. */
export const OUTPUT_STYLE_SETTINGS_NAMESPACE = 'cc-output-styles' as SettingsNamespace

/** Schema of one resolved settings section for the output style. */
const OUTPUT_STYLE_ENTRY_SCHEMA = z.object({ outputStyle: z.string() })

/** Plugin config: composition-level style selection and custom style sources. */
export interface Config {
  /** Output style name; defaults to {@link DEFAULT_OUTPUT_STYLE}. */
  outputStyle?: string
  /**
   * Project root whose `.claude/output-styles/` directory contributes custom
   * styles. Defaults to the current working directory.
   */
  projectRoot?: string
  /**
   * Harness home whose `output-styles/` directory contributes custom styles.
   * Defaults to the deepseek harness home (`~/.dsh`).
   */
  harnessHome?: string
  /**
   * Explicit custom-style directories, replacing the computed project and
   * harness directories. Later directories override same-named earlier styles.
   */
  dirs?: string[]
}

/** Runtime schema for the output-style plugin config. */
export const Config: z<Config> = z.object({
  outputStyle: z.string().default(DEFAULT_OUTPUT_STYLE),
  projectRoot: z.string(),
  harnessHome: z.string(),
  dirs: z.array(z.string()),
})

/** The custom-style directories contributing to the plugin load. */
function styleDirectories(config: Config): string[] {
  if (config.dirs !== undefined) return config.dirs
  return [
    join(config.projectRoot ?? process.cwd(), '.claude', 'output-styles'),
    join(config.harnessHome ?? defaultDshHome(), 'output-styles'),
  ]
}

/** Render the selectable style list with the current selection marked. */
function renderStyleList(library: Map<string, OutputStyle>, current: string): string {
  const lines = ['Available output styles:']
  for (const style of library.values()) {
    const marker = style.name === current ? '*' : ' '
    lines.push(`${marker} ${style.name} — ${style.description}`)
  }
  return lines.join('\n')
}

/**
 * Register the output-style plugin: load custom styles, wire the settings
 * section covering the selection, register the system-prompt section, and
 * register the `/output-style` command.
 * @param ctx - Cordis context with `systemPrompt` and `commands` mounted.
 * @param config - plugin config carrying the composition selection and dirs.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const library = buildStyleLibrary(await loadCustomStyles(styleDirectories(config)))

  // Composition default, replaced by the user layer while a settings provider
  // is mounted, and written by /output-style when none is.
  let fallback = config.outputStyle ?? DEFAULT_OUTPUT_STYLE
  let source: () => string = () => fallback
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, OUTPUT_STYLE_SETTINGS_NAMESPACE, OUTPUT_STYLE_ENTRY_SCHEMA, { outputStyle: fallback }, {
      setSource: (current) => {
        source = () => current().outputStyle
      },
      onChange: () => {
        // A committed style change must reach the next assembled prompt.
        ctx.emit('system-prompt/change')
      },
    })
  })

  // The section provider reads the live selection at each assembly, so a
  // switch takes effect on the next turn without re-registering.
  ctx.effect(() => ctx.systemPrompt.section({
    name: OUTPUT_STYLE_SECTION,
    order: OUTPUT_STYLE_ORDER,
    text: () => styleSectionText(library.get(source()) ?? BUILTIN_DEFAULT_STYLE),
  }), 'cc-output-styles.section()')

  /** Persist or, without a settings provider, apply the selection in-session. */
  const applySelection = async (selected: string): Promise<void> => {
    const settings = ctx.get('settings')
    if (settings !== undefined) {
      await settings.update(OUTPUT_STYLE_SETTINGS_NAMESPACE, { outputStyle: selected })
      return
    }
    fallback = selected
    ctx.emit('system-prompt/change')
  }

  ctx.commands.register({
    name: 'output-style',
    description: 'view or set the active output style',
    input: { hint: '[<name>]' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const current = source()
      const input = invocation.rawInput.trim()
      if (input.length === 0) {
        return { kind: 'success', text: `Current output style: ${current}\n\n${renderStyleList(library, current)}` }
      }
      if (!library.has(input)) {
        return {
          kind: 'error',
          text: `Unknown output style "${input}".\n${renderStyleList(library, current)}`,
        }
      }
      await applySelection(input)
      return { kind: 'success', text: `Output style set to ${input}.` }
    },
  })
}

/** The always-present default style used when a stored selection names nothing known. */
const BUILTIN_DEFAULT_STYLE: OutputStyle = {
  name: DEFAULT_OUTPUT_STYLE,
  description: 'Default output style',
  prompt: '',
  builtin: true,
  keepCodingInstructions: true,
}
