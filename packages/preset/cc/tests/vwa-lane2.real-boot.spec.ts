/**
 * VWA preset lane-2 real boot (VWA split plan docs/plans/2026-10-16-vwa-evidence-argument.md
 * §13/§16.2, Appendix A): mount the vwa-evidence + vwa-argument rows exactly
 * as agent.vwa.cordis.yml declares them — inside their group, under the
 * group's `isolate` realm — on a host carrying the real dsh-llm, dsh-tools
 * and dsh-jobs-local services, with `vwa-argument.semantic-enabled: true`.
 *
 * Asserts the preset mount gate (no process-global service leak, the same
 * check agent-preset-registry's mountPreset runs), mount-order safety of the
 * vwa-evidence → vwa-argument service read, and an end-to-end lane-2 flow:
 * read → evidence.register → argument.update → argument.review (model faked
 * ONLY at the provider boundary) → vwa-evidence's delivery provider sees the
 * completed review run for the bound artifact.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as VwaEvidence from '@dsh-cc/vwa-evidence'
import * as VwaArgument from '@dsh-cc/vwa-argument'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')
const yaml = createRequire(includePkg)('js-yaml') as typeof import('js-yaml')
const vwaRows = yaml.load(readFileSync(new URL('../agent.vwa.cordis.yml', import.meta.url), 'utf8'), {
  schema: entryListSchema,
}) as any[]

const PLUGINS: Record<string, unknown> = { '@dsh-cc/vwa-evidence': VwaEvidence, '@dsh-cc/vwa-argument': VwaArgument }
const PROVIDER = 'fake-provider'

/** The group row hosting the lane-2 plugins, as declared. */
function lane2Group(): { isolate: Record<string, unknown>; rows: { id: string; name: string }[] } {
  const group = vwaRows.find(
    (row) =>
      row.name === 'cordis:group' &&
      Array.isArray(row.config) &&
      row.config.some((child: { name: string }) => child.name === '@dsh-cc/vwa-argument'),
  )
  if (group === undefined) throw new Error('agent.vwa.cordis.yml mounts @dsh-cc/vwa-argument outside any cordis:group')
  return { isolate: group.isolate ?? {}, rows: group.config }
}

interface FiberLike {
  parent: { fiber: FiberLike }
}

/** Local copy of agent-preset-registry `leakedServices` (cc-shell leaked-services.spec precedent). */
function leakedServices(ctx: Context, mount: FiberLike): string[] {
  const store = ctx.reflect.store
  const rootIsolate = ctx.root[Context.isolate]
  const leaked: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    if (impl === undefined) continue
    let current = impl.fiber as FiberLike
    let within = false
    while (true) {
      if (current === mount) {
        within = true
        break
      }
      const parent = current.parent.fiber
      if (parent === current) break
      current = parent
    }
    if (within && rootIsolate[impl.name] === key) leaked.push(impl.name)
  }
  return leaked.sort()
}

/** Provider-boundary fake reviewer: answers the forced `respond` call from the envelope. */
class EnvelopeReviewer extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const user = options.messages.at(-1) as { content: { type: string; text?: string }[] }
    const envelope = JSON.parse(user.content.map((block) => block.text ?? '').join(''))
    const checks = (id: string) =>
      (envelope.requiredRules ?? [])
        .filter((r: { targetId: string }) => r.targetId === id)
        .map((r: { ruleId: string }) => ({
          ruleId: r.ruleId,
          result: 'pass',
          rationale: 'the supplied source supports this',
          evidenceIds: [],
        }))
    let response: unknown
    if (envelope.stage === 'extract') {
      const unit = envelope.units.find((u: { text: string }) => u.text.includes('The council closed'))
      response = {
        items: [
          {
            span: unit.span,
            exactText: unit.text,
            isQuotation: false,
            atomicClaims: [
              {
                text: unit.text,
                kind: 'fact',
                importance: 'core',
                scope: { subject: 'port', corpus: [], time: 'May', geography: 'unspecified', exclusions: [] },
              },
            ],
          },
        ],
      }
    } else {
      const targets = envelope.targets ?? [{ id: envelope.requiredRules[0].targetId }]
      response = {
        stage: envelope.stage,
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: targets.map((target: { id: string }) => ({
          targetId: target.id,
          checks: checks(target.id),
          ...(envelope.stage === 'support'
            ? {
                support: 'direct',
                adequacy: 'adequate',
                evidenceRelations: envelope.dependencies.evidence.map((e: { id: string }) => ({
                  evidenceId: e.id,
                  support: 'direct',
                  rationale: 'direct',
                })),
              }
            : {}),
          ...(envelope.stage === 'claims' ? { searchSufficiency: 'checked' } : {}),
        })),
        ...(envelope.stage === 'align'
          ? {
              alignment: envelope.items.map((item: { extractedId: string }) => ({
                extractedId: item.extractedId,
                claimIds: [envelope.claims[0].id],
                relation: 'exact',
                rationale: 'same proposition',
              })),
            }
          : {}),
      }
    }
    const args = JSON.stringify(response)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'respond', argumentsDelta: args } as StreamChunk
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1', name: 'respond', arguments: args },
    } as StreamChunk
    yield { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk
  }
}

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
})

async function host(): Promise<{ root: Context; reviewer: EnvelopeReviewer }> {
  const dshHome = mkdtempSync(join(tmpdir(), 'vwa-preset-home-'))
  writeFileSync(
    join(dshHome, 'settings.json'),
    JSON.stringify({ 'vwa-argument': { 'semantic-enabled': true, 'review-alias': 'reviewer' } }),
    'utf8',
  )
  const root = new Context()
  ;(root as unknown as { dshHomePath: () => string }).dshHomePath = () => dshHome
  root.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  root.provide('commands', { register: () => () => {} })
  root.provide('shell', {})
  root.provide('ccModelRoutes', {
    resolve: (alias?: string) => (alias === 'reviewer' ? { provider: PROVIDER, model: 'reviewer-model' } : undefined),
  })
  await root.plugin(LlmRuntime)
  const reviewer = new EnvelopeReviewer()
  root.llm.registerAdapter([PROVIDER], reviewer)
  await root.plugin(ToolRuntime as never)
  await root.plugin(LocalJobRegistry as never, {})
  ;(root as unknown as { jobs: { attachController(name: string): () => void } }).jobs.attachController('tool-jobs')
  ;(root as unknown as { tools: { register(def: unknown): () => void } }).tools.register({
    name: 'read',
    description: 'read',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute(args: { file_path: string }) {
      return { content: readFileSync(args.file_path, 'utf8') }
    },
  })
  disposers.push(async () => {
    await root.fiber.dispose()
  })
  return { root, reviewer }
}

/** Mount the declared group (isolate realm + rows) in the given row order. */
async function mountGroup(
  root: Context,
  order: 'declared' | 'reversed',
): Promise<{ group: Context; fiber: FiberLike }> {
  const { isolate, rows } = lane2Group()
  const ordered = order === 'declared' ? rows : [...rows].reverse()
  let group = root
  for (const key of Object.keys(isolate)) group = group.isolate(key)
  const fiber = await group.plugin({
    name: 'vwa-lane2-group',
    async apply(ctx: Context) {
      for (const row of ordered) await ctx.plugin(PLUGINS[row.name] as never)
    },
  })
  return { group, fiber: fiber as unknown as FiberLike }
}

describe('agent.vwa.cordis.yml lane-2 group (semantic-enabled real boot)', () => {
  it('hosts vwa-evidence and vwa-argument in ONE group isolating the vwa-argument service', () => {
    const { isolate, rows } = lane2Group()
    expect(rows.map((row) => row.name)).toEqual(['@dsh-cc/vwa-evidence', '@dsh-cc/vwa-argument'])
    expect(isolate['vwa-argument']).toBe(true)
    // No lane-2 row is left at top level.
    expect(vwaRows.some((row) => row.name === '@dsh-cc/vwa-argument' || row.name === '@dsh-cc/vwa-evidence')).toBe(
      false,
    )
  })

  for (const order of ['declared', 'reversed'] as const) {
    it(`publishes no process-global service and resolves the provider from the group (${order} mount order)`, async () => {
      const { root } = await host()
      const { group, fiber } = await mountGroup(root, order)
      expect(leakedServices(root, fiber)).toEqual([])
      expect(root.get('vwa-argument')).toBeUndefined()
      const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'vwa-preset-ws-')))
      expect(VwaEvidence.resolveDeliveryProvider(group, workspaceRoot)).toBeDefined()
    })
  }

  for (const stage of ['support', 'all'] as const)
    it(`end to end: real mount -> ${stage} -> delivery provider`, async () => {
      const { root, reviewer } = await host()
      const { group } = await mountGroup(root, 'declared')
      const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'vwa-preset-ws-')))
      const id = `sess-${randomUUID()}`
      const agent = {
        id,
        session: {
          id,
          header: { cwd: workspaceRoot },
          snapshotEvents: () => [],
          requestHeader: () => ({ config: { provider: PROVIDER, model: 'parent-model' } }),
        },
      }
      const tools = (
        root as unknown as {
          tools: { execute(e: unknown): Promise<{ isError: boolean; value?: any; error?: { message: string } }> }
        }
      ).tools
      const exec = async (name: string, args: unknown) => {
        const result = await tools.execute({
          callId: randomUUID(),
          name,
          arguments: args,
          agent,
          signal: new AbortController().signal,
        })
        if (result.isError) throw new Error(`${name}: ${result.error?.message}`)
        return result.value
      }
      const projectId = `prj_${randomUUID()}`
      // The default frozen budget (24k output tokens/run) is now guarded by the
      // Feature C pre-flight feasibility check; this fixture's graph plans 6
      // calls (9 with retry headroom), so init with a roomier budget.
      const init = new VwaArgument.ProjectStore(workspaceRoot, projectId).init(
        {
          question: 'What closed the port?',
          language: 'en',
          domain: 'history',
          requiredQuestions: [{ id: 'q1', text: 'Is the closure documented?' }],
          plannedCorpus: [],
          expectedCoreTopics: ['port'],
          mode: 'draft',
        },
        {
          budget: {
            maxCallsPerRun: 40,
            maxInputTokensPerRun: 160_000,
            maxOutputTokensPerRun: 200_000,
            maxOutputTokensPerCall: 3_000,
            wallMs: 180_000,
            callTimeoutMs: 45_000,
            concurrency: 2,
          },
          maxArtifactChars: 120_000,
          maxContextChars: 48_000,
          claimsBatchSize: 1,
        },
      )
      if (!init.ok) throw new Error(init.message)
      VwaArgument.writePointer(workspaceRoot, projectId, init.data.workspaceIdentity)
      const catalog = (root as unknown as { tools: { schemas(): { name: string }[] } }).tools.schemas()
      const prerequisites = JSON.parse(
        execFileSync(
          process.execPath,
          [
            fileURLToPath(
              new URL('../../../plugin/dsh-cc-agents/skills/vwa-writing/scripts/preflight.mjs', import.meta.url),
            ),
            '--workspace',
            workspaceRoot,
            '--dsh-home',
            (root as unknown as { dshHomePath(): string }).dshHomePath(),
            '--tools',
            catalog.map((t) => t.name).join(','),
          ],
          { encoding: 'utf8' },
        ),
      )
      expect(prerequisites).toMatchObject({
        status: 'ready-for-tools',
        projectId,
        revision: 1,
        reviewerAlias: 'reviewer',
      })
      const text = 'The council voted to close the port on 3 May.\n'
      writeFileSync(join(workspaceRoot, 'minutes.md'), text, 'utf8')
      await exec('read', { file_path: join(workspaceRoot, 'minutes.md') })
      const registered = await exec('evidence.register', {
        projectId,
        expectedRevision: 1,
        requestId: randomUUID(),
        input: {
          path: join(workspaceRoot, 'minutes.md'),
          metadata: {
            title: 'Minutes',
            creators: [],
            publication: 'unknown',
            originalLocator: 'archive://m',
            edition: 'unknown',
            language: 'en',
            origin: 'external',
            material: 'primary',
          },
          excerpts: [
            {
              clientKey: 'e',
              span: { start: 0, end: 44 },
              originalLocation: 'p.1',
              transformation: 'none',
              transformationNote: '',
            },
          ],
        },
      })
      expect(registered.ok, JSON.stringify(registered)).toBe(true)
      const evidenceId = registered.data.evidenceIds[0].evidenceId
      const claimText = 'The council closed the port in May.'
      const updated = await exec('argument.update', {
        projectId,
        expectedRevision: 2,
        requestId: randomUUID(),
        input: {
          op: 'upsert',
          updates: [],
          deletes: [],
          creates: [
            {
              clientKey: 'c',
              type: 'claim',
              body: {
                text: claimText,
                kind: 'fact',
                scope: { subject: 'port', corpus: [], time: 'May', geography: 'unspecified', exclusions: [] },
                importance: 'core',
                stance: 'asserted',
                evaluationCriteria: [],
              },
            },
            {
              clientKey: 'g',
              type: 'group',
              body: {
                targetClaimId: { $new: 'c' },
                evidenceIds: [evidenceId],
                mode: 'all',
                rationale: 'the minutes record it',
              },
            },
          ],
        },
      })
      expect(updated.ok, JSON.stringify(updated)).toBe(true)
      const claimId = updated.data.changedIds[0]
      writeFileSync(join(workspaceRoot, 'report.md'), `${claimText}\n`, 'utf8')
      const bound = await exec('argument.update', {
        projectId,
        expectedRevision: 3,
        requestId: randomUUID(),
        input: {
          op: 'bind-artifact',
          path: 'report.md',
          outline: [],
          occurrences: [{ claimId, span: { start: 0, end: claimText.length }, exactText: claimText }],
        },
      })
      expect(bound.ok, JSON.stringify(bound)).toBe(true)
      const requestId = randomUUID()
      const started = await exec('argument.review', { projectId, expectedRevision: 4, requestId, input: { stage } })
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true, data: { completion: 'started' } })
      const runs = new VwaArgument.ReviewRunStore(workspaceRoot, projectId)
      for (let i = 0; i < 200 && runs.findRunByRequestId(requestId)?.status !== 'completed'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(runs.findRunByRequestId(requestId)?.status).toBe('completed')
      expect(reviewer.calls.map((call) => [call.provider, call.model])).toEqual(
        Array(stage === 'all' ? 5 : 1).fill([PROVIDER, 'reviewer-model']),
      )
      // vwa-evidence's §16.2 lane-2 path, resolved from the group realm for this workspace.
      const provider = VwaEvidence.resolveDeliveryProvider(group, workspaceRoot)
      if (provider === undefined) throw new Error('delivery provider not resolvable from the vwa group')
      const [artifact] = provider.listBoundArtifacts(projectId)
      expect(artifact?.path).toBe('report.md')
      const frozen = await provider.checkForDelivery(projectId, artifact!.artifactId)
      expect(frozen.check.reviewRunIds.length).toBeGreaterThan(0)
      expect(frozen.check.sources).toHaveLength(1)
      if (stage === 'all') {
        expect(frozen.check.eligibleForReviewed).toBe(true)
        expect(frozen.check.checks).toEqual({ mechanical: 'pass', evidence: 'pass', argument: 'pass', audit: 'pass' })
        const rendered = await provider.renderReport(projectId, artifact!.artifactId, frozen.evaluationId, 'markdown')
        expect(rendered.text).toContain(claimText)
        const report = await exec('argument.report', {
          projectId,
          artifactId: artifact!.artifactId,
          format: 'markdown',
          write: true,
        })
        expect(report.ok).toBe(true)
      }
    })
})
