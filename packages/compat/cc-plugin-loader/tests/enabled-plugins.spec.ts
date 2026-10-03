import { describe, expect, it } from 'vitest'
import { extractEnabledPluginKeys, foldEnabledPluginsRaw } from '../src/enabled-plugins.ts'

describe('foldEnabledPluginsRaw', () => {
  it('folds last-wins across blocks', () => {
    const merged: Record<string, unknown> = {}
    foldEnabledPluginsRaw(merged, { 'a@x': true })
    foldEnabledPluginsRaw(merged, { 'a@x': false, 'b@y': true })
    expect(merged).toEqual({ 'a@x': false, 'b@y': true })
  })

  it('tolerates null/undefined blocks and passes raw values through unchanged', () => {
    const merged: Record<string, unknown> = {}
    foldEnabledPluginsRaw(merged, undefined)
    foldEnabledPluginsRaw(merged, null)
    expect(merged).toEqual({})
    // Manager-side raw fold: non-boolean values pass through untouched.
    foldEnabledPluginsRaw(merged, { 'weird@x': 'yes', 'num@y': 1 })
    expect(merged).toEqual({ 'weird@x': 'yes', 'num@y': 1 })
  })
})

describe('extractEnabledPluginKeys', () => {
  it('keeps only boolean values', () => {
    const target: Record<string, boolean> = {}
    extractEnabledPluginKeys(target, { enabledPlugins: { 'a@x': true, bad: 'yes', n: 1, nul: null } })
    expect(target).toEqual({ 'a@x': true })
  })

  it('tolerates non-object blocks and missing/non-object enabledPlugins', () => {
    const target: Record<string, boolean> = { keep: true }
    extractEnabledPluginKeys(target, null)
    extractEnabledPluginKeys(target, 'nope')
    extractEnabledPluginKeys(target, [1])
    extractEnabledPluginKeys(target, {})
    extractEnabledPluginKeys(target, { enabledPlugins: 'nope' })
    expect(target).toEqual({ keep: true })
  })

  it('drops bare keys with the byte-exact warning when warn is provided', () => {
    const target: Record<string, boolean> = {}
    const warnings: string[] = []
    extractEnabledPluginKeys(target, { enabledPlugins: { 'a@x': true, bare: true } }, msg => warnings.push(msg))
    expect(target).toEqual({ 'a@x': true })
    expect(warnings).toEqual(['cc-plugin-loader: skipping bare enabledPlugins key "bare" (expected name@marketplace)'])
  })

  it('keeps bare keys (no drop) when warn is omitted', () => {
    const target: Record<string, boolean> = {}
    extractEnabledPluginKeys(target, { enabledPlugins: { bare: false } })
    expect(target).toEqual({ bare: false })
  })
})
