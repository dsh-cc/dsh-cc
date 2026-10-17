#!/usr/bin/env node
/** Read-only prerequisite check. Runtime tools remain responsible for data integrity and grading. */
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const requiredTools = [
  'evidence.register',
  'evidence.search_log',
  'argument.update',
  'argument.review',
  'argument.report',
]
const projectPattern = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const blockers = []
function block(code, message, extra = {}) {
  blockers.push({ code, message, ...extra })
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function options(args) {
  const result = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--workspace', '--dsh-home', '--tools'].includes(key)) throw new Error(`Unknown option: ${key}`)
    if (result[key] !== undefined || args[i + 1] === undefined || args[i + 1].startsWith('--'))
      throw new Error(`Missing or duplicate option: ${key}`)
    result[key] = args[++i]
  }
  return result
}

try {
  if (process.argv.slice(2).includes('--help')) {
    console.log(
      'Usage: node preflight.mjs --workspace <path> [--dsh-home <path>] --tools <comma-separated live tool names>',
    )
  } else {
    const opts = options(process.argv.slice(2))
    const workspace = realpathSync(resolve(opts['--workspace'] ?? process.cwd()))
    const dshHome = resolve(opts['--dsh-home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    const tools = new Set((opts['--tools'] ?? '').split(',').filter(Boolean))
    const missingTools = requiredTools.filter((name) => !tools.has(name))
    if (missingTools.length)
      block(
        opts['--tools'] === undefined ? 'TOOLS_UNCHECKED' : 'TOOLS_MISSING',
        'Discover the VWA tools. Use /preset vwa in dsh-cc. Start a new session if the preset is locked.',
        { missingTools },
      )
    let settings = {}
    try {
      settings = readJson(join(dshHome, 'settings.json'))
      if (!object(settings)) throw new Error('shape')
      for (const key of ['vwa-argument', 'vwa-evidence'])
        if (settings[key] !== undefined && !object(settings[key])) throw new Error('shape')
    } catch (error) {
      if (error.code !== 'ENOENT') block('SETTINGS_INVALID', 'Repair the user settings file before VWA review.')
      settings = {}
    }
    const argument = settings['vwa-argument'] ?? {}
    if (argument['semantic-enabled'] !== true)
      block('SEMANTIC_DISABLED', 'Set vwa-argument.semantic-enabled to true in user settings. Restart dsh.')
    if (settings['vwa-evidence']?.enabled === false)
      block('EVIDENCE_DISABLED', 'Set vwa-evidence.enabled to true for automatic delivery checks.')
    let projectId, revision
    const dir = join(workspace, '.dsh', 'vwa')
    let pointer
    try {
      pointer = readJson(join(dir, 'current-project.json'))
    } catch (error) {
      block(
        error.code === 'ENOENT' ? 'NO_PROJECT' : 'PROJECT_INVALID',
        'Run /vwa init as the user, or inspect /vwa status.',
      )
    }
    if (pointer !== undefined) {
      try {
        if (!object(pointer) || pointer.schemaVersion !== 1 || !projectPattern.test(pointer.projectId ?? ''))
          throw new Error('pointer')
        const path = realpathSync(join(dir, pointer.projectId, 'HEAD.json'))
        if (!path.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)) throw new Error('outside workspace')
        const head = readJson(path)
        if (!object(head) || !Number.isSafeInteger(head.revision) || head.revision < 1) throw new Error('head')
        projectId = pointer.projectId
        revision = head.revision
      } catch {
        block('PROJECT_INVALID', 'Inspect /vwa status. Use the VWA recovery commands for invalid project data.')
      }
    }
    console.log(
      JSON.stringify({
        status: blockers.length ? 'blocked' : 'ready-for-tools',
        workspace,
        ...(projectId ? { projectId, revision } : {}),
        reviewerAlias: typeof argument['review-alias'] === 'string' ? argument['review-alias'] : 'sonnet',
        blockers,
      }),
    )
  }
} catch (error) {
  console.error(
    error.message.startsWith('Unknown option:') || error.message.startsWith('Missing or duplicate option:')
      ? error.message
      : 'Cannot check prerequisites. Check the workspace path and command options.',
  )
  process.exitCode = 2
}
