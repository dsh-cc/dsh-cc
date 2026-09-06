/**
 * Pure LLM catalog formatting and choice parsing for `/model`.
 * @module @dsh-cc/tui/model-catalog
 */

export interface CatalogEntry {
  provider: string
  id: string
  name: string
}

export interface ModelRoute {
  provider: string
  model: string
}

/**
 * Render advertised models, starring the live route.
 */
export function formatModelCatalog(
  catalog: readonly CatalogEntry[],
  current: ModelRoute | undefined,
): string {
  if (catalog.length === 0) return 'No models are advertised by the mounted LLM adapters.'
  return catalog.map((entry, index) => {
    const key = `${entry.provider}/${entry.id}`
    const star = current !== undefined
      && current.provider === entry.provider
      && current.model === entry.id
    const mark = star ? '*' : ' '
    return `${mark} ${index + 1}. ${key} — ${entry.name}`
  }).join('\n')
}

/**
 * Resolve a `/model` argument: 1-based index, `provider/id`, or a unique id.
 */
export function parseModelChoice(
  raw: string,
  catalog: readonly CatalogEntry[],
): ModelRoute | undefined {
  const token = raw.trim()
  if (token.length === 0) return undefined
  if (/^\d+$/.test(token)) {
    const index = Number.parseInt(token, 10) - 1
    const entry = catalog[index]
    return entry === undefined ? undefined : { provider: entry.provider, model: entry.id }
  }
  const slash = token.indexOf('/')
  if (slash > 0) {
    const provider = token.slice(0, slash)
    const model = token.slice(slash + 1)
    const entry = catalog.find(item => item.provider === provider && item.id === model)
    return entry === undefined ? undefined : { provider: entry.provider, model: entry.id }
  }
  const matches = catalog.filter(item => item.id === token)
  if (matches.length !== 1) return undefined
  const only = matches[0]!
  return { provider: only.provider, model: only.id }
}
