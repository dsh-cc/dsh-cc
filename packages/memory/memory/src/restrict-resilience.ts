/**
 * REMOVED (rc.5 subagent migration): `startWithFilterResilience` and the
 * warn-once toolFilter-retry logic lived here. The helper's only trigger was
 * a `tools.restrict()` throw on a `toolFilter` passed through
 * `subagents.start` — as of the rc.5 seam no caller passes `toolFilter`
 * through the start request (composition owns restriction), so the retry had
 * no remaining purpose. File deleted in place (rm blocked by session
 * permissions); the export rows were removed from `./index.ts`.
 * @module
 */
export {}
