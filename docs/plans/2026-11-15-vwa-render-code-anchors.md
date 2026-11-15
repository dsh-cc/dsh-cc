# Code anchors — VWA Autonomous Render Pipeline

Verbatim excerpts of the code the design cites. Evidence markers may only target markdown, so the
design document points its code claims here; every fence below is a byte-for-byte copy of the cited
region at tree `041cfe72`.

Re-verified for the implementation: slices 1–6 of the pipeline changed most of the regions quoted
below, so every fence was regenerated on 2026-11-15 against implementation tree `a93d2ccd` (branch
`worktree-vwa-autonomous`) and every `lines a-b` label is that tree's numbering. The `041cfe72` pin
above is NOT withdrawn — it is the tree this design was written and reviewed against, and the
regions §4.7 says stay unchanged are byte-identical in both trees. Where the implementation
structurally replaced a region, the fence now quotes the new normative text and the anchor heading
says what it shows.

## A1 — Adjudication liveness binds to a dispute cohort (§6.2) 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L20-L48〕

Source: `packages/interaction/vwa-argument/src/delivery-check.ts` lines 84-112 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L20-L48〕

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
  const disputes = new Map(resolveDisputes(snapshot, records).map((dispute) => [dispute.disputeId, dispute]))
  const digest = projectDependencyDigest(snapshot, records)
  return adjudications.filter((a) => {
    const recorded = a.dispute
    if (recorded === undefined ? a.dependencyDigest !== digest : !isLiveDispute(disputes.get(recorded.disputeId), recorded))
      return false
    return current.some(
      (r) =>
        r.stage !== 'extract' &&
        // §4.4 liveness: the marker lives on the detecting run, so a
        // cross-run adjudication counts when EITHER run is current.
        (r.runId === a.overrides.runId || r.runId === a.overrides.supersededRunId) &&
        r.response?.findings.some((f) => f.id === a.findingId),
    )
  })
}
```

## A2 — projectDependencyDigest hashes every non-disagreement record 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L56-L66〕

Source: `packages/interaction/vwa-argument/src/delivery-check.ts` lines 129-139 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L56-L66〕

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

## A3 — The disagreement marker is minted with a random id 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L74-L82〕

Source: `packages/interaction/vwa-argument/src/review-current.ts` lines 66-74 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L74-L82〕

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

## A4 — disagreementFinding mints a random finding id 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L90-L103〕

Source: `packages/interaction/vwa-argument/src/review-run-store.ts` lines 363-376 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L90-L103〕

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

## A5 — Draft-mode bind validates occurrences against the draft text, then renders (§4.2 steps 3–6) 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L111-L130〕

Source: `packages/interaction/vwa-argument/src/artifact.ts` lines 168-187 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L111-L130〕

```
  // Step 3: every occurrence validates against the DRAFT text.
  validateOccurrenceRefs(graph, mutation)
  for (const occurrence of mutation.occurrences) {
    const problem = spanError(occurrence.span, draftText)
    if (problem !== '') reject('SCHEMA_INVALID', `occurrence span invalid: ${problem}`)
    if (draftText.slice(occurrence.span.start, occurrence.span.end) !== occurrence.exactText) {
      reject('SCHEMA_INVALID', 'occurrence exactText does not match the artifact slice')
    }
  }
  validateOutlineRefs(graph, mutation)
  // Step 4–5: render; an occurrence intersecting a removed marker range is rejected.
  const render = stripMarkers(draftText)
  for (const occurrence of mutation.occurrences) {
    if (intersectsRemoved(occurrence.span, render.removed)) {
      reject('SCHEMA_INVALID', 'occurrence overlaps a stripped marker')
    }
  }
  // Step 6: identity splits (§4.4) — contentHash over the render, draftHash over the draft.
  const contentHash = sha256Hex(render.text)
  const draftHash = sha256Hex(draftText)
```

## A6 — The five-stage commit publishes staged files first, then clears the render intent 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕

Source: `packages/interaction/vwa-argument/src/store.ts` lines 486-547 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L138-L199〕

```
  private commit<T>(
    nextSnapshot: ProjectSnapshot,
    head: Head,
    input: TransactionInput<T>,
    applied: { result: T; files?: StagedFile[] },
  ): Result<T> {
    const nextRevision = head.revision + 1
    const graphHash = sha256Hex(stableJson(nextSnapshot))
    // 1. Stage extra files (source snapshots, render intents before the
    //    deliverable they describe, §7.1): temp → fsync → rename (§14.2);
    //    out-of-tree deliverables additionally random-suffix the temp, verify
    //    it on read-back and sweep stale sibling temps (§4.6).
    for (const file of applied.files ?? []) {
      mkdirSync(dirname(file.path), { recursive: true })
      const tmp = file.kind === 'deliverable' ? `${file.path}.${randomUUID()}.tmp` : `${file.path}.tmp`
      this.io.writeTemp(tmp, file.bytes)
      if (file.kind === 'deliverable') {
        let readBack = ''
        try {
          readBack = readFileSync(tmp, 'utf8')
        } catch {
          return fail('STORE_IO_FAILED', 'staged deliverable failed its read-back verification', true)
        }
        if (sha256Hex(readBack) !== file.expectedHash) {
          rmSync(tmp, { force: true })
          return fail('STORE_IO_FAILED', 'staged deliverable failed its read-back verification', true)
        }
        sweepStaleTemps(dirname(file.path))
      }
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
    // §7.1: HEAD adoption consumed this transaction's render intent.
    rmSync(renderIntentFile(this.root, this.projectId, input.requestId), { force: true })
    return { ok: true, projectId: this.projectId, revision: nextRevision, data: applied.result }
  }
}
```

## A7 — The citation whitelist excludes the runtime output tree 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L207-L215〕

Source: `packages/interaction/vwa-evidence/src/verify.ts` lines 25-33 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L207-L215〕

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

## A8 — Source registration accepts any in-workspace UTF-8 file 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L223-L240〕

Source: `packages/interaction/vwa-argument/src/sources.ts` lines 182-199 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L223-L240〕

```
export function readSourceBytes(root: string, path: string): { bytes: Buffer; text: string; hash: string } {
  if (!isAbsolute(path)) throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', 'path must be absolute'))
  let resolved: string
  try {
    const resolvedRoot = realpathSync(root)
    resolved = realpathSync(path)
    if (isRuntimeOutputPath(root, resolved)) {
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

## A9 — VWA state writes default to ASK except batches and draft files 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L248-L276〕

Source: `packages/interaction/permission-rules/src/vwa-state.ts` lines 26-54 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L248-L276〕

```
/** The ask reason surfaced for an unexempted VWA state write. */
export const VWA_STATE_ASK_REASON =
  'writes under .dsh/vwa are authoritative VWA state (use the VWA tools); only .dsh/vwa/batches/** and .dsh/vwa/<projectId>/drafts/** are writable directly'

/** The canonical state root of one workspace root (`realpath(.dsh/vwa)`). */
export function vwaStateRootOf(normalizedRoot: string): string {
  return normalizePath(join(normalizedRoot, VWA_STATE_ROOT))
}

/**
 * The workspace-relative POSIX form of a target inside the state tree, or
 * `undefined` when it is not state at all. Anchored on the canonical state
 * root, so an aliased `.dsh/vwa` still classifies its members (§3.4).
 * @param normalizedTarget - the canonical (realpath-normalized) absolute target.
 * @param normalizedRoot - the canonical workspace root.
 */
export function relativeStatePath(normalizedTarget: string, normalizedRoot: string): string | undefined {
  return relativeToStateRoot(normalizedTarget, vwaStateRootOf(normalizedRoot))
}

/** Shared canonical-path boundary for grant matching and the approval guard. */
export function isCanonicalVwaStateWrite(normalizedTarget: string, normalizedRoot: string): boolean {
  const stateRoot = vwaStateRootOf(normalizedRoot)
  if (!isPathWithin(stateRoot, normalizedTarget)) return false
  const rel = relativeToStateRoot(normalizedTarget, stateRoot)
  // Containment already held, so an unrelativizable path is state, not scratch.
  if (rel === undefined) return true
  return !isVwaBatchPath(rel) && !isVwaDraftPath(rel)
}
```

## A10 — Grant write-path validation rejects VWA state except batches and a drafts prefix 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L284-L296〕

Source: `packages/interaction/permission-rules/src/task-grant.ts` lines 196-208 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L284-L296〕

```
  const writePaths = descriptor.writePaths.map(normalizeWritePath)
  for (const path of writePaths) {
    // The state tree is off limits except its two carve-outs (§3.2/§3.3): the
    // physical batches subtree and a drafts PREFIX that names a well-formed
    // `prj_` project segment. Project authorization is carried by that literal
    // segment (the descriptor has no project-list field), so the ancestor
    // prefixes `.dsh/vwa` and `.dsh/vwa/<projectId>` stay rejected.
    if (!isVwaStatePath(path) || isVwaBatchPath(path) || isVwaDraftPrefix(path)) continue
    throw new GrantValidationError(
      `writePaths: "${path}" is authoritative VWA state; only ${VWA_BATCH_ROOT}/** and ` +
      `${VWA_STATE_ROOT}/<projectId>/drafts/** are writable under a grant`,
    )
  }
```

## A11 — The snapshot path is workspace-relative under the v2 state tree 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L304-L314〕

Source: `packages/interaction/vwa-argument/src/sources.ts` lines 329-339 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L304-L314〕

```
    // Snapshot: exact copied bytes, no added headings (§14.1). The recorded
    // `snapshotPath` is workspace-relative POSIX under the v2 state tree
    // (§8.1); the bytes are staged in this same commit transaction (§14.2).
    const snapshotPath = sourceSnapshotPath(store.projectId, sourceId)
    const absoluteSnapshot = sourceSnapshotAbsolute(store.root, store.projectId, sourceId)
    // A project created before the v2 layout has no `sources/` dir yet (its
    // legacy snapshots stay under docs/vwa-sources/); create the parent so the
    // staged temp file has a home — the snapshot itself is still committed only
    // through `files` below.
    mkdirSync(dirname(absoluteSnapshot), { recursive: true })
    const files: StagedFile[] = [{ path: absoluteSnapshot, bytes: read.bytes }]
```

## A12 — Marker parsing accepts the ws: and gr: vocabularies 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L322-L338〕

Source: `packages/interaction/vwa-evidence/src/marker.ts` lines 148-164 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L322-L338〕

```
export function parseMarkerInner(inner: string): SourceSpec[] | null {
  if (!inner.startsWith('src:')) return null
  const specs: SourceSpec[] = []
  for (const part of inner.slice(4).split(';')) {
    // §5.1 spec alternative: `ws:<posix rel path>#L<a>-L<b>` (v1, live file,
    // whitelist applies) or `gr:<sourceId>#L<a>-L<b>` (v2, a registered
    // project source snapshot). The `ws:` arm stays byte-identical.
    const match = /^(ws|gr):(.+)#L(\d+)-L(\d+)$/.exec(part)
    if (match === null) return null
    const [, scheme, sourceId, a, b] = match as unknown as [string, string, string, string, string]
    const lineStart = Number(a)
    const lineEnd = Number(b)
    if (lineStart < 1 || lineEnd < lineStart) return null
    specs.push({ sourceId: `${scheme}:${sourceId}`, lineStart, lineEnd })
  }
  return specs.length > 0 ? specs : null
}
```

## A13 — The author schema accepts schemaVersion 1 or 2 on read 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L346-L351〕

Source: `packages/interaction/vwa-argument/src/contracts/author.schema.json` lines 336-341 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L346-L351〕

```
      "required": ["schemaVersion", "projectId", "revision", "workspaceIdentity", "contract", "sources", "evidence", "claims", "groups", "arguments", "issues", "searches", "artifacts"],
      "properties": {
        "schemaVersion": { "enum": [1, 2] },
        "projectId": { "$ref": "#/$defs/ProjectId" },
        "revision": { "type": "integer", "minimum": 1 },
        "workspaceIdentity": { "$ref": "#/$defs/Hash" },
```

## A14 — Bound artifacts are keyed by the draft path for draft-backed artifacts 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L359-L387〕

Source: `packages/interaction/vwa-evidence/src/bound-eval.ts` lines 59-87 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L359-L387〕

```
export function boundArtifactMap(
  options: EvaluateTurnOptions,
  _events: readonly EvalEvent[],
  debug: (message: string) => void,
): BoundDiscovery {
  const map = new Map<string, BoundEntry>()
  const excludedDeliverables = new Set<string>()
  const provider = options.deliveryProvider
  if (provider === undefined) return { map, excludedDeliverables }
  try {
    const projectId = readCurrentProject(options.workspaceRoot)
    if (projectId === undefined) return { map, excludedDeliverables }
    for (const artifact of provider.listBoundArtifacts(projectId)) {
      const absolutePath = isAbsolute(artifact.path) ? artifact.path : join(options.workspaceRoot, artifact.path)
      const entry: BoundEntry = { projectId, artifactId: artifact.artifactId, absolutePath }
      if (artifact.draftPath !== undefined) {
        entry.draftPath = isAbsolute(artifact.draftPath) ? artifact.draftPath : join(options.workspaceRoot, artifact.draftPath)
        excludedDeliverables.add(absolutePath)
        if (!map.has(entry.draftPath)) map.set(entry.draftPath, entry)
        continue
      }
      // realpath-unknown here (sync context); the consumer re-resolves.
      if (!map.has(absolutePath)) map.set(absolutePath, entry)
    }
  } catch (error: unknown) {
    debug(`vwa-evidence: bound-artifact discovery failed (citation-check-only turn): ${String(error)}`)
  }
  return { map, excludedDeliverables }
}
```

## A15 — ReviewRecord forbids additional properties 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L395-L402〕

Source: `packages/interaction/vwa-argument/src/contracts/review.schema.json` lines 545-552 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L395-L402〕

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

## A16 — AdjudicationRecord forbids additional properties 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L410-L416〕

Source: `packages/interaction/vwa-argument/src/contracts/review.schema.json` lines 878-884 〔src:ws:docs/plans/2026-11-15-vwa-render-code-anchors.md#L410-L416〕

```
    "AdjudicationRecord": {
      "type": "object",
      "description": "\u00a76 AdjudicationRecord (human adjudication; signer is always 'user').",
      "additionalProperties": false,
      "required": [
        "adjudicationId",
        "findingId",
```
