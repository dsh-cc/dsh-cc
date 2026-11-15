# Code anchors — VWA Autonomous Render Pipeline

Verbatim excerpts of the code the design cites. Evidence markers may only target markdown, so the
design document points its code claims here; every fence below is a byte-for-byte copy of the cited
region at tree `041cfe72`.

## A1 — Adjudication liveness binds to a whole-project digest 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L12-L36〕

Source: `packages/interaction/vwa-argument/src/delivery-check.ts` lines 67-92 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L11-L36〕

```
export function activeAdjudications(
  snapshot: ProjectSnapshot,
  records: ReviewRecord[],
  adjudications: AdjudicationRecord[],
  targets: Id[] = snapshot.claims.map((c) => c.id),
  reviewerConfigHash?: Hash,
): AdjudicationRecord[] {
  const current = currentReviews(
    snapshot,
    records,
    targets,
    reviewerConfigHash,
  ).records
  return adjudications.filter(
    (a) =>
      a.dependencyDigest === projectDependencyDigest(snapshot, records) &&
      current.some(
        (r) =>
          r.stage !== 'extract' &&
          // §4.4 liveness: the marker lives on the detecting run, so a
          // cross-run adjudication counts when EITHER run is current.
          (r.runId === a.overrides.runId || r.runId === a.overrides.supersededRunId) &&
          r.response?.findings.some((f) => f.id === a.findingId),
      ),
  )
}
```

## A2 — projectDependencyDigest hashes every non-disagreement record 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L45-L54〕

Source: `packages/interaction/vwa-argument/src/delivery-check.ts` lines 100-110 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L44-L54〕

```
      claims: snapshot.claims,
      groups: snapshot.groups,
      arguments: snapshot.arguments,
      issues: snapshot.issues,
      searches: snapshot.searches,
      artifacts: snapshot.artifacts,
      records: records
        .filter((r) => r.kind !== 'disagreement')
        .map((r) => sha256Hex(stableJson(r)))
        .sort(),
    }),
```

## A3 — The disagreement marker is minted with a random id 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L63-L70〕

Source: `packages/interaction/vwa-argument/src/review-current.ts` lines 66-74 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L62-L70〕

```
      const disagreement = detectDisagreement(valid, undefined).disagreement
      if (disagreement) {
        const stored = all.find((r) => r.kind === 'disagreement' && r.inputHash === valid[0]?.inputHash)
        const finding =
          stored && stored.stage !== 'extract'
            ? stored.response?.findings.find((f) => f.code === 'REVIEWER_DISAGREEMENT')
            : undefined
        findings.push(finding ?? disagreementFinding(task.targetIds))
      }
```

## A4 — disagreementFinding mints a random finding id 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L79-L91〕

Source: `packages/interaction/vwa-argument/src/review-run-store.ts` lines 360-373 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L78-L91〕

```
export function disagreementFinding(targetIds: Id[]): Finding & { kind: 'disagreement' } {
  return {
    id: `finding_${randomUUID()}`,
    code: 'REVIEWER_DISAGREEMENT',
    targetIds,
    severity: 'major',
    explanation:
      'Review runs over identical inputs produced differing verdicts; aggregated to needs-review pending human adjudication.',
    evidenceIds: [],
    artifactSpans: [],
    repair: 'manual-review',
    kind: 'disagreement',
  }
}
```

## A5 — Bind validates occurrences against the on-disk artifact text 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L100-L115〕

Source: `packages/interaction/vwa-argument/src/artifact.ts` lines 24-40 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L99-L115〕

```
export function applyBindArtifact(graph: GraphContext, mutation: Extract<Mutation, { op: 'bind-artifact' }>): void {
  validateArtifactPath(mutation.path)
  const text = graph.artifactText(mutation.path)
  const contentHash = createHash('sha256').update(text, 'utf8').digest('hex')
  const now = graph.now()
  for (const occurrence of mutation.occurrences) {
    if (!graph.snapshot.claims.some((claim) => claim.id === occurrence.claimId)) {
      reject('REFERENCE_INVALID', `occurrence references unknown claim ${occurrence.claimId}`)
    }
    const problem = spanError(occurrence.span, text)
    if (problem !== '') reject('SCHEMA_INVALID', `occurrence span invalid: ${problem}`)
    if (text.slice(occurrence.span.start, occurrence.span.end) !== occurrence.exactText) {
      reject('SCHEMA_INVALID', 'occurrence exactText does not match the artifact slice')
    }
  }
  for (const section of mutation.outline) {
    for (const claimId of section.claimIds) {
```

## A6 — The five-stage commit publishes staged files first 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L124-L165〕

Source: `packages/interaction/vwa-argument/src/store.ts` lines 458-500 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L123-L165〕

```
  private commit<T>(
    nextSnapshot: ProjectSnapshot,
    head: Head,
    input: TransactionInput<T>,
    applied: { result: T; files?: { path: string; bytes: Buffer }[] },
  ): Result<T> {
    const nextRevision = head.revision + 1
    const graphHash = sha256Hex(stableJson(nextSnapshot))
    // 1. Stage extra files (source snapshots): temp → fsync → rename (§14.2).
    for (const file of applied.files ?? []) {
      const tmp = `${file.path}.tmp`
      this.io.writeTemp(tmp, file.bytes)
      this.io.rename(tmp, file.path)
      this.tick()
      this.io.fsyncDir(dirname(file.path))
    }
    // 2. Immutable revision envelope (parentGraphHash chain, §14.2).
    const fileName = `${nextRevision}-${graphHash}.json`
    const envelope: RevisionEnvelope = {
      schemaVersion: 1, projectId: this.projectId, revision: nextRevision,
      graphHash, parentGraphHash: head.graphHash, operationId: input.requestId, snapshot: nextSnapshot,
    }
    this.writeAtomic(join(this.revisionsDir(), fileName), envelope)
    // 3. Operation record (prepared; committed once HEAD points here, §14.2).
    const op: OperationRecord = {
      requestId: input.requestId, payloadHash: input.payloadHash, status: 'prepared',
      revision: nextRevision, result: applied.result,
    }
    this.writeAtomic(join(this.dir, 'operations', `${input.requestId}.json`), op)
    // 4. Atomic HEAD replace.
    const nextHead: Head = {
      schemaVersion: 1, projectId: this.projectId, revision: nextRevision,
      graphHash, revisionPath: `revisions/${fileName}`, operationId: input.requestId,
    }
    this.writeAtomic(join(this.dir, 'HEAD.json'), nextHead)
    // 5. Read-back verification of HEAD and the revision hash (§14.2).
    const readBack = this.readHead()
    if (!readBack.ok || readBack.data.head.graphHash !== graphHash) {
      return fail('STORE_CORRUPT', 'HEAD read-back verification failed', true)
    }
    return { ok: true, projectId: this.projectId, revision: nextRevision, data: applied.result }
  }
}
```

## A7 — The citation whitelist excludes the runtime output tree 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L174-L181〕

Source: `packages/interaction/vwa-evidence/src/verify.ts` lines 24-32 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L173-L181〕

```
/** Corpus whitelist, frozen (§4.2): `docs/` prefix ∪ `*.md` ∪ `*.mdx` under
 * the workspace — EXCLUDING the runtime's own output tree `.dsh/**` (D22:
 * the report output being rescanned as evidence would create a
 * self-referential evidence loop). */
export function isWhitelistedRel(relPosix: string): boolean {
  if (relPosix === '.dsh' || relPosix.startsWith('.dsh/')) return false
  return relPosix.startsWith('docs/') || /\.mdx?$/.test(relPosix)
}

```

## A8 — Source registration accepts any in-workspace UTF-8 file 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L190-L210〕

Source: `packages/interaction/vwa-argument/src/sources.ts` lines 179-200 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L189-L210〕

```
export function readSourceBytes(root: string, path: string): { bytes: Buffer; text: string; hash: string } {
  if (!isAbsolute(path)) throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', 'path must be absolute'))
  let resolved: string
  try {
    const resolvedRoot = realpathSync(root)
    resolved = realpathSync(path)
    const segments = relative(resolvedRoot, resolved).split(sep)
    if (
      (segments[0] === '.dsh' && segments[1] === 'vwa') ||
      (segments[0] === 'docs' && (segments[1] === 'vwa-sources' || segments[1] === 'vwa-reports'))
    ) {
      throw new VwaFail(
        fail('PATH_OUT_OF_BOUNDS', `path is inside the runtime output tree and cannot be a source (D22): ${path}`),
      )
    }
    if (!resolved.startsWith(resolvedRoot + sep) && resolved !== resolvedRoot) {
      throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', `path escapes the workspace root: ${path}`))
    }
    const statBefore = statSync(resolved)
    if (!statBefore.isFile()) throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', 'path is not a regular file'))
    if (statBefore.size > MAX_SOURCE_BYTES) throw new VwaFail(fail('LIMIT_EXCEEDED', 'source exceeds 8 MiB'))
    const bytes = readFileSync(resolved)
```

## A9 — VWA state writes default to ASK except the batches subtree 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L219-L230〕

Source: `packages/interaction/permission-rules/src/vwa-state.ts` lines 18-30 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L218-L230〕

```
export const VWA_STATE_ASK_REASON =
  'writes under .dsh/vwa are authoritative VWA state (use the VWA tools); only .dsh/vwa/batches/** is writable directly'

/** Shared canonical-path boundary for grant matching and the approval guard. */
export function isCanonicalVwaStateWrite(normalizedTarget: string, normalizedRoot: string): boolean {
  const stateRoot = normalizePath(join(normalizedRoot, VWA_STATE_ROOT))
  if (!isPathWithin(stateRoot, normalizedTarget)) return false
  // The exemption is the physical batches subtree, never a symlink's alternate
  // destination (batches -> prj_1 must not exempt adjudications in prj_1).
  const batchRoot = join(stateRoot, 'batches')
  return !isPathWithin(batchRoot, normalizedTarget)
}

```

## A10 — Grant write-path validation rejects VWA state except batches 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L239-L245〕

Source: `packages/interaction/permission-rules/src/task-grant.ts` lines 106-113 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L238-L245〕

```
function underVwaState(path: string): boolean {
  return path === VWA_STATE_ROOT || path.startsWith(`${VWA_STATE_ROOT}/`)
}

/** Whether a root-relative path is the exempt batch subtree (or the VWA root itself). */
function underVwaBatches(path: string): boolean {
  return path === VWA_BATCH_ROOT || path.startsWith(`${VWA_BATCH_ROOT}/`)
}
```

## A11 — The snapshot path is workspace-relative 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L254-L256〕

Source: `packages/interaction/vwa-argument/src/sources.ts` lines 310-313 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L253-L256〕

```
    // Snapshot: exact copied bytes, no added headings (§14.1).
    const snapshotPath = ['docs', 'vwa-sources', store.projectId, `${sourceId}.md`].join('/')
    const absoluteSnapshot = resolve(store.snapshotDir, `${sourceId}.md`)
    const files: StagedFile[] = [{ path: absoluteSnapshot, bytes: read.bytes }]
```

## A12 — Marker parsing accepts the ws: vocabulary only 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L265-L281〕

Source: `packages/interaction/vwa-evidence/src/marker.ts` lines 146-163 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L264-L281〕

```
export function parseMarkerInner(inner: string): SourceSpec[] | null {
  if (!inner.startsWith('src:')) return null
  const specs: SourceSpec[] = []
  for (const part of inner.slice(4).split(';')) {
    const match = /^ws:(.+)#L(\d+)-L(\d+)$/.exec(part)
    if (match === null) return null
    const [, sourceId, a, b] = match as unknown as [string, string, string, string]
    const lineStart = Number(a)
    const lineEnd = Number(b)
    if (lineStart < 1 || lineEnd < lineStart) return null
    specs.push({ sourceId: `ws:${sourceId}`, lineStart, lineEnd })
  }
  return specs.length > 0 ? specs : null
}

/**
 * Find all markers in prose (the masked text), with spans valid in the
 * original text.
```

## A13 — The author schema pins schemaVersion to the literal 1 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L290-L294〕

Source: `packages/interaction/vwa-argument/src/contracts/author.schema.json` lines 325-330 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L289-L294〕

```
      "required": ["schemaVersion", "projectId", "revision", "workspaceIdentity", "contract", "sources", "evidence", "claims", "groups", "arguments", "issues", "searches", "artifacts"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "projectId": { "$ref": "#/$defs/ProjectId" },
        "revision": { "type": "integer", "minimum": 1 },
        "workspaceIdentity": { "$ref": "#/$defs/Hash" },
```

## A14 — Bound artifacts are keyed by the deliverable path 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L303-L324〕

Source: `packages/interaction/vwa-evidence/src/bound-eval.ts` lines 41-63 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L302-L324〕

```
export function boundArtifactMap(
  options: EvaluateTurnOptions,
  _events: readonly EvalEvent[],
  debug: (message: string) => void,
): Map<string, BoundEntry> {
  const map = new Map<string, BoundEntry>()
  const provider = options.deliveryProvider
  if (provider === undefined) return map
  try {
    const projectId = readCurrentProject(options.workspaceRoot)
    if (projectId === undefined) return map
    for (const artifact of provider.listBoundArtifacts(projectId)) {
      const absolutePath = isAbsolute(artifact.path) ? artifact.path : join(options.workspaceRoot, artifact.path)
      // realpath-unknown here (sync context); the consumer re-resolves.
      if (!map.has(absolutePath)) {
        map.set(absolutePath, { projectId, artifactId: artifact.artifactId, absolutePath })
      }
    }
  } catch (error: unknown) {
    debug(`vwa-evidence: bound-artifact discovery failed (lane-1-only turn): ${String(error)}`)
  }
  return map
}
```

## A15 — ReviewRecord forbids additional properties 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L333-L339〕

Source: `packages/interaction/vwa-argument/src/contracts/review.schema.json` lines 545-552 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L332-L339〕

```
      "type": "object",
      "description": "\u00a76 ReviewRecord.",
      "additionalProperties": false,
      "required": [
        "runId",
        "stage",
        "targetRefs",
        "dependencyDigest",
```

## A16 — AdjudicationRecord forbids additional properties 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L348-L353〕

Source: `packages/interaction/vwa-argument/src/contracts/review.schema.json` lines 872-878 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L347-L353〕

```
    "AdjudicationRecord": {
      "type": "object",
      "description": "\u00a76 AdjudicationRecord (human adjudication; signer is always 'user').",
      "additionalProperties": false,
      "required": [
        "adjudicationId",
        "findingId",
```
