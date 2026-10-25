#!/usr/bin/env node
/**
 * Single CLI entry point (plan §6):
 *   node writing.mjs <command> --workspace <root> --input <json-file>
 *
 * Prints one JSON object on stdout. Diagnostics go to stderr without source
 * text. Exit codes: 0 success, 2 invalid input/path, 3 stale input or lock,
 * 4 unmet prerequisite/review/budget, 5 filesystem failure.
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dispatch, COMMANDS } from './commands.lib.mjs'
import { CliError, decodeUtf8, fail, resolveInputFile, workspaceRoot } from './files.lib.mjs'

const EXIT_CODES = {
  INVALID_INPUT: 2,
  PATH_OUTSIDE_WORKSPACE: 2,
  STALE_BODY: 3,
  STALE_PLAN: 3,
  STALE_BRIEF: 3,
  LOCKED: 3,
  PERMISSION_REQUIRED: 4,
  PREREQUISITE_MISSING: 4,
  REVIEW_INCOMPLETE: 4,
  BUDGET_EXHAUSTED: 4,
  IO_ERROR: 5,
}

export function exitCodeFor(code) {
  return EXIT_CODES[code] ?? 5
}

/**
 * Execute one command against a workspace input object. Never throws: callers
 * get the same envelope the CLI prints.
 */
export function runCommand(command, workspace, input) {
  try {
    const root = workspaceRoot(workspace)
    const result = dispatch(command, root, input)
    return { ok: true, result }
  } catch (error) {
    if (error instanceof CliError) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details ?? {},
        exitCode: exitCodeFor(error.code),
      }
    }
    return {
      ok: false,
      code: 'IO_ERROR',
      message: 'unexpected failure',
      details: {},
      exitCode: 5,
    }
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  if (command === undefined) fail('INVALID_INPUT', 'usage: writing.mjs <command> --workspace <root> --input <json-file>')
  if (!COMMANDS.includes(command)) fail('INVALID_INPUT', `unknown command "${command}"`)
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (flag !== '--workspace' && flag !== '--input') fail('INVALID_INPUT', `unknown option "${String(flag)}"`)
    if (value === undefined) fail('INVALID_INPUT', `${flag}: missing value`)
    if (Object.hasOwn(options, flag)) fail('INVALID_INPUT', `duplicate option "${flag}"`)
    options[flag] = value
  }
  if (options['--workspace'] === undefined) fail('INVALID_INPUT', 'missing required option --workspace')
  if (options['--input'] === undefined) fail('INVALID_INPUT', 'missing required option --input')
  return { command, workspace: options['--workspace'], inputFile: options['--input'] }
}

export function main(argv) {
  let parsed
  try {
    parsed = parseArguments(argv)
    const root = workspaceRoot(parsed.workspace)
    const inputAbs = resolveInputFile(root, parsed.inputFile)
    let input
    try {
      input = JSON.parse(decodeUtf8(readFileSync(inputAbs), 'input'))
    } catch (error) {
      if (error instanceof CliError) throw error
      fail('INVALID_INPUT', 'input: not valid JSON')
    }
    const envelope = runCommand(parsed.command, root, input)
    process.stdout.write(`${JSON.stringify(envelope)}\n`)
    if (!envelope.ok) process.stderr.write(`${envelope.code}: ${envelope.message}\n`)
    process.exitCode = envelope.ok ? 0 : envelope.exitCode
    return envelope
  } catch (error) {
    const envelope =
      error instanceof CliError
        ? { ok: false, code: error.code, message: error.message, details: error.details ?? {}, exitCode: exitCodeFor(error.code) }
        : { ok: false, code: 'IO_ERROR', message: 'unexpected failure', details: {}, exitCode: 5 }
    process.stdout.write(`${JSON.stringify(envelope)}\n`)
    process.stderr.write(`${envelope.code}: ${envelope.message}\n`)
    process.exitCode = envelope.exitCode
    return envelope
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) main(process.argv.slice(2))
