/**
 * `/provider` overlay box (design doc §4.2–§4.6): the two-section provider
 * list with credential badges, the manage detail view (§4.4), the add /
 * custom / rotate wizard phases (§4.3, §4.6), and the remove double-confirm.
 * The wizard's live text entry is a real pi-tui `Input` owned by the runtime
 * (provider-command.ts) and rendered inside this box when a text step is
 * active; the box itself stays a pure function of the panel state.
 * @module @dsh-cc/tui/components/provider-box
 */
import { Container, Text } from '@dsh-cc/pi-tui'
import type { ProviderPanelView } from '../store.ts'
import type { ProviderRow } from '../provider-flow.ts'
import { defaultTheme, type Theme } from './theme.ts'

/** Badge text for one row's credential state (§4.2). */
function badgeText(row: { credential?: { badge: string; warning?: boolean } }): string {
  const credential = row.credential
  if (credential === undefined || credential.badge === 'missing') return 'key ✗ missing'
  return `key ✓ (${credential.badge})`
}

const CUSTOM_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** Render the live text field's lines inside the box (masked Input shows bullets). */
function renderField(box: Container, field: { render(width: number): string[] } | undefined): void {
  if (field === undefined) return
  for (const line of field.render(100)) box.addChild(new Text(line, 0, 0))
}

/**
 * Provider list box: "Providers" title, then the Configured section (live
 * settings dict, document order) and the Available section (presets), with
 * `●`/`○` current markers, credential badges, model counts, ⚠ on configured
 * routes with models but no key, and the directory tail collapsed under
 * "More providers (…)".
 */
export function createProviderPanelBox(view: ProviderPanelView, theme: Theme = defaultTheme, field?: { render(width: number): string[] }): Container {
  const box = new Container()
  if (view.phase === 'detail') return detailBox(box, view, theme)
  if (view.phase === 'wizard') return wizardBox(box, view, theme, field)
  if (view.phase === 'confirm-remove') return confirmRemoveBox(box, view, theme)

  box.addChild(new Text(theme.bold('Providers'), 0, 0))

  const renderRow = (row: ProviderRow, index: number): void => {
    const focused = view.phase === 'list' && view.cursor === index
    const marker = row.isCurrent ? '●' : '○'
    const models = row.modelCount > 0 ? `   ${row.modelCount} models` : ''
    const warning = row.credential?.warning === true ? '  ⚠' : ''
    const prefix = focused ? '❯ ' : '  '
    box.addChild(new Text(`${prefix}${marker} ${row.route}   ${row.displayName}   ${badgeText(row)}${models}${warning}`, 0, 0))
  }

  // Rows arrive flat (configured block then available block); the section
  // boundary is the first `available` row.
  const split = view.rows.findIndex(row => row.section === 'available')
  const configuredEnd = split === -1 ? view.rows.length : split
  box.addChild(new Text(theme.muted('  Configured'), 0, 0))
  for (let index = 0; index < configuredEnd; index += 1) renderRow(view.rows[index]!, index)
  if (configuredEnd < view.rows.length) {
    box.addChild(new Text(theme.muted('  Available'), 0, 0))
    for (let index = configuredEnd; index < view.rows.length; index += 1) renderRow(view.rows[index]!, index)
  }

  if (view.more.length > 0) {
    box.addChild(new Text(`  … More providers (${view.more.map(m => m.provider).join(', ')})`, 0, 0))
  }
  if (view.message !== undefined) {
    box.addChild(new Text(theme.warning(view.message), 0, 0))
  }
  box.addChild(new Text(theme.muted('j/k move · enter open · n add custom · esc close'), 0, 0))
  return box
}

/** Detail view (§4.4): resolved facts + raw profile JSON + action rows. */
function detailBox(box: Container, view: ProviderPanelView, theme: Theme): Container {
  box.addChild(new Text(theme.bold(`Provider ${view.selected ?? ''}`), 0, 0))
  const detail = view.detail
  if (detail !== undefined) {
    box.addChild(new Text(`endpoint  ${detail.endpoint}`, 0, 0))
    box.addChild(new Text(`protocol  ${detail.api}`, 0, 0))
    box.addChild(new Text(`models    ${detail.modelCount}`, 0, 0))
    box.addChild(new Text(`key       ${detail.credentialLine}`, 0, 0))
    box.addChild(new Text(theme.muted('profile (read-only):'), 0, 0))
    for (const line of detail.profileJson.split('\n')) {
      box.addChild(new Text(theme.muted(`  ${line}`), 0, 0))
    }
  }
  const actions = view.actions ?? []
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!
    const marker = (view.actionCursor ?? 0) === index ? '❯ ' : '  '
    const suffix = action.disabled === true ? `  (unavailable — ${action.reason ?? ''})` : ''
    box.addChild(new Text(`${marker}${action.label}${suffix}`, 0, 0))
  }
  if (view.message !== undefined) {
    box.addChild(new Text(theme.warning(view.message), 0, 0))
  }
  box.addChild(new Text(theme.muted('j/k move · enter select · esc back'), 0, 0))
  return box
}

/** Wizard phases (§4.3/§4.6/rotate): step rail, live field, notes, prompts. */
function wizardBox(box: Container, view: ProviderPanelView, theme: Theme, field: { render(width: number): string[] } | undefined): Container {
  const wizard = view.wizard
  if (wizard === undefined) return box
  const title = wizard.kind === 'rotate'
    ? `Rotate key — ${wizard.route}`
    : wizard.kind === 'custom' ? 'Add custom provider' : `Add ${wizard.route}${wizard.displayName === undefined ? '' : ` (${wizard.displayName})`}`
  box.addChild(new Text(theme.bold(title), 0, 0))
  box.addChild(new Text(theme.muted(wizard.steps.map((step, index) => index === wizard.stepIndex ? `[${step}]` : step).join(' → ')), 0, 0))

  const step = wizard.steps[wizard.stepIndex]
  if (step === 'protocol') {
    for (let index = 0; index < CUSTOM_PROTOCOLS.length; index += 1) {
      const marker = (wizard.selectIndex ?? 0) === index ? '❯ ' : '  '
      box.addChild(new Text(`${marker}${CUSTOM_PROTOCOLS[index]}`, 0, 0))
    }
  } else if (step === 'credential' || step === 'key') {
    box.addChild(new Text(theme.muted(`API key for ${wizard.answers['ref'] ?? wizard.route} — stored in ~/.dsh/.credentials.yaml, never in settings`), 0, 0))
    renderField(box, field)
  } else if (step === 'models') {
    box.addChild(new Text(theme.muted('model ids — one per entry: id | Name | contextWindow | maxTokens'), 0, 0))
    renderField(box, field)
    box.addChild(new Text(theme.muted('tab fetch from endpoint · enter save'), 0, 0))
  } else if (step === 'verify') {
    const verify = wizard.verify
    if (verify !== undefined) box.addChild(new Text(verify.message ?? 'verifying…', 0, 0))
  } else if (step === 'done') {
    const where = wizard.answers['ref'] === undefined ? '' : ` — key in ${wizard.answers['ref']}`
    box.addChild(new Text(`Added ${wizard.route || wizard.answers['route'] || ''}${where}.`, 0, 0))
    box.addChild(new Text(theme.muted('Set as default? enter yes · esc no (/model switches the running session)'), 0, 0))
  } else {
    renderField(box, field)
  }

  if (wizard.note !== undefined) box.addChild(new Text(theme.warning(wizard.note), 0, 0))
  if (wizard.modelErrors !== undefined) {
    for (const error of wizard.modelErrors) box.addChild(new Text(theme.warning(error), 0, 0))
  }
  if (view.message !== undefined) box.addChild(new Text(theme.warning(view.message), 0, 0))
  box.addChild(new Text(theme.muted('enter next · esc back'), 0, 0))
  return box
}

/** Remove double-confirm (§4.4): the unset confirm, then the credential-drop offer. */
function confirmRemoveBox(box: Container, view: ProviderPanelView, theme: Theme): Container {
  box.addChild(new Text(theme.bold(`Remove provider ${view.selected ?? ''}?`), 0, 0))
  if (view.message !== undefined) box.addChild(new Text(theme.warning(view.message), 0, 0))
  if (view.stage === 'drop-credential') {
    box.addChild(new Text('Route removed. Also drop the stored credential?', 0, 0))
    box.addChild(new Text(theme.muted('enter drop · x keep · esc keep'), 0, 0))
  } else {
    box.addChild(new Text(theme.muted('This unsets llm-pi-ai.providers.' + (view.selected ?? '')), 0, 0))
    box.addChild(new Text(theme.muted('enter remove · esc cancel'), 0, 0))
  }
  return box
}
