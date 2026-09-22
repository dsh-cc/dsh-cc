#!/usr/bin/env node
/**
 * SessionEnd hook (detached on session dispose): garbage-collect this
 * session's serena hook state (`<project>/.serena/hook_data/<session-id>`)
 * so the per-session dirs do not accumulate. Gated — see ./serena-gate.mjs.
 */
import { runGatedSerenaHook } from './serena-gate.mjs'

runGatedSerenaHook('cleanup')
