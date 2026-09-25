import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { collect } from '../src/collect.ts'
import type { AliasInspection, ModelRoutesSeam } from '../src/checks/models.ts'
import { CLOCK, fakeInvocation } from './helpers.ts'

/** Build a duck-typed ccModelRoutes with per-name inspection answers. */
function routes(answers: Record<string, AliasInspection>): ModelRoutesSeam {
  return { inspect: (name: string) => answers[name] ?? { kind: 'inherit', via: 'builtin' } }
}

function idsOf(checks: { id: string }[]): string[] {
  return checks.map(check => check.id)
}

describe('models checks', () => {
  it('skips the group when ccModelRoutes is not mounted', async () => {
    const ctx = new Context()
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(report.checks.find(check => check.id === 'models.routes')).toMatchObject({
      status: 'skip',
      summary: 'ccModelRoutes not mounted',
    })
  })

  it('renders the six peer-deduped rows with inherit as info', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', routes({
      haiku: { kind: 'route', route: { provider: 'deepseek', model: 'm-lite' }, via: 'configured' },
    }))
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    const ids = idsOf(report.checks.filter(check => check.group === 'models'))
    expect(ids).toEqual([
      'models.alias.haiku', 'models.alias.sonnet', 'models.alias.opus',
      'models.alias.fable', 'models.alias.architect', 'models.last-request',
    ])
    const haiku = report.checks.find(check => check.id === 'models.alias.haiku')
    expect(haiku).toMatchObject({ status: 'ok' })
    expect(haiku?.summary).toContain('haiku (+ sketch + gauge)')
    expect(haiku?.summary).toContain('deepseek/m-lite')
    expect(report.checks.find(check => check.id === 'models.alias.architect')).toMatchObject({ status: 'info' })
  })

  it('adds an extra row for an independently configured lane', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', routes({
      haiku: { kind: 'route', route: { provider: 'deepseek', model: 'm' }, via: 'configured' },
      sketch: { kind: 'route', route: { provider: 'other', model: 'x' }, via: 'configured' },
    }))
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    const ids = idsOf(report.checks.filter(check => check.group === 'models'))
    expect(ids).toContain('models.alias.sketch')
    expect(ids.filter(id => id === 'models.alias.haiku')).toHaveLength(1)
    // The cheap lane adds no extra id of its own.
    expect(ids).not.toContain('models.alias.haiku-lane')
  })

  it('reports the last request from a request/header event with effort', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', routes({}))
    const events = [{
      type: 'request/header',
      data: { header: { config: { provider: 'deepseek', model: 'm1', reasoningEffort: 'high' } } },
    }] as never[]
    const report = await collect(ctx, fakeInvocation({ events }), CLOCK)
    const check = report.checks.find(entry => entry.id === 'models.last-request')
    expect(check).toMatchObject({ status: 'ok', summary: 'Last request: deepseek/m1' })
    expect(check?.detail).toContain('effort high')
  })

  it('skips the last request when no header exists', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', routes({}))
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(report.checks.find(entry => entry.id === 'models.last-request')).toMatchObject({
      status: 'skip',
      summary: 'no request/header in this session',
    })
  })

  it('verbose catalog: warns when the model is missing from listModels', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', routes({
      haiku: { kind: 'route', route: { provider: 'deepseek', model: 'ghost' }, via: 'configured' },
    }))
    ctx.provide('llm', {
      listProviders: async () => [{ id: 'deepseek' }],
      listModels: async () => [{ id: 'real' }],
    })
    const report = await collect(ctx, fakeInvocation(), { ...CLOCK, verbose: true })
    const catalog = report.checks.find(entry => entry.id === 'models.catalog.haiku')
    expect(catalog?.status).toBe('warn')
    expect(catalog?.summary).toContain('ghost')
  })

  it('verbose catalog: awaits async listModels / resolveModelInfo and reads {id} efforts', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', routes({
      haiku: {
        kind: 'route',
        route: { provider: 'deepseek', model: 'm-lite', reasoningEffort: 'high' },
        via: 'configured',
      },
    }))
    ctx.provide('llm', {
      listProviders: async () => [{ id: 'deepseek' }],
      listModels: async () => [{ id: 'm-lite' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
    })
    const report = await collect(ctx, fakeInvocation(), { ...CLOCK, verbose: true })
    expect(report.checks.find(entry => entry.id === 'models.catalog.haiku')).toMatchObject({
      status: 'ok',
      summary: 'deepseek/m-lite in catalog',
    })
  })

  it('verbose catalog: fails when the provider is missing from listProviders', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', routes({
      haiku: { kind: 'route', route: { provider: 'nope', model: 'm' }, via: 'configured' },
    }))
    ctx.provide('llm', { listProviders: () => [{ id: 'deepseek' }] })
    const report = await collect(ctx, fakeInvocation(), { ...CLOCK, verbose: true })
    expect(report.checks.find(entry => entry.id === 'models.catalog.haiku')?.status).toBe('fail')
  })

  it('verbose catalog is absent on the default path', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', routes({
      haiku: { kind: 'route', route: { provider: 'deepseek', model: 'm' }, via: 'configured' },
    }))
    ctx.provide('llm', {
      listProviders: () => [{ id: 'deepseek' }],
      listModels: () => [{ id: 'm' }],
    })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(report.checks.some(entry => entry.id.includes('catalog'))).toBe(false)
  })
})
