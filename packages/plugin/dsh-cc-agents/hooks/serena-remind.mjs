#!/usr/bin/env node
/**
 * PreToolUse (`read|grep|mcp__serena__*`) hook: nudge the model toward
 * serena's symbolic tools after a burst of raw reads/greps. Gated — see
 * ./serena-gate.mjs; without a serena project this is a silent no-op.
 */
import { runGatedSerenaHook } from './serena-gate.mjs'

runGatedSerenaHook('remind')
