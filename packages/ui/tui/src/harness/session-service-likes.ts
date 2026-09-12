/**
 * Structural stand-ins for the session services the /resume picker consumes
 * (`sessionPersistence`, `sessionQuery`). Split out of state/driver-types.ts
 * to keep that file under its size budget. These are deliberately structural:
 * the tui package does not import the harness service types, so the shapes
 * below must be kept verbatim against the harness contracts — drift here is
 * exactly what a structural cast cannot flag (the /resume picker crash of
 * 0.6.3-rc.1).
 *
 * @module @dsh-cc/tui/harness/session-service-likes
 */

/**
 * The 0.1.5 handle-model `sessionPersistence.list()` face: one lightweight
 * snapshot per stored session. The flat fields the picker needs (id, cwd,
 * createdAt, lineage) all live on `snapshot.header`; the snapshot exposes no
 * mtime, so last-activity refinement (`updatedAtMs`) is unavailable at list
 * time and the picker falls back to `createdAt`.
 */
export type PersistenceSnapshotLike = {
  readonly header: {
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
    readonly parentSession?: string
  }
  readonly revision: unknown
  readonly eventCount?: number
  readonly sizeBytes?: number
}

export type PersistenceLike = {
  list(options?: { signal?: AbortSignal }): Promise<readonly PersistenceSnapshotLike[]>
}

/**
 * Structural stand-in for the deployment's `sessionQuery` service: batch
 * title reads for the /resume picker. One result per requested id —
 * operational failures are isolated per id (`status: 'rejected'`), and the
 * fulfilled value carries the session header plus its latest title snapshot.
 */
export type SessionTitleResultLike =
  | {
    status: 'fulfilled'
    /** Requested session id — the join key. Do not use `value.session.id`. */
    sessionId: string
    value: { session: { id: string }; title?: { title: string } }
  }
  | { status: 'rejected'; sessionId?: string }

export type SessionQueryLike = {
  readTitleSnapshots(ids: readonly string[], signal?: AbortSignal): Promise<readonly SessionTitleResultLike[]>
}
