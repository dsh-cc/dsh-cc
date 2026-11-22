#!/usr/bin/env node
/**
 * check-math-eval.mjs — structure check for the math-eval package
 * (docs/plans/2026-11-21-mathematical-research-harness.md §8.1, §8.4).
 *
 * Structure only, no models: validates the package skeleton is intact, that
 * fixtures/gold-set.json parses and matches the documented shape (splits
 * recorded, train/test problemIds present, one §8.1-shaped record per planned
 * slice), that fixture metadata is present, and that no redistribution-
 * forbidding license is recorded. Wired as the package's `check` script.
 *
 * Exit 0 with `check OK: …` on success; exit 1 listing every failure.
 * Pure node stdlib.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')

/** §8.1 slices the design commits to (ids used as keys in gold-set.json). */
const EXPECTED_SLICES = ['minif2f', 'proofnet', 'putnambench']

/** Redistribution-permitting licenses only; anything else fails CI (§8.1). */
const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'CC-BY-4.0', 'CC-BY-SA-4.0']

const PENDING = 'unverified-pending-ingestion'

const REQUIRED_SOURCE_FILES = [
  'src/types.ts',
  'src/manifest.ts',
  'src/ablation.ts',
  'src/scorer.ts',
  'src/runner.ts',
  'src/index.ts',
]

const REQUIRED_TEST_FILES = ['tests/manifest.spec.ts', 'tests/ablation.spec.ts', 'tests/scorer.spec.ts']

const FIXTURE_RECORD_FIELDS = ['source', 'license', 'licenseStatus', 'fetchedAt', 'sha256', 'problemIds']
const SPLIT_FIELDS = ['purpose', 'writeBlocked', 'problemIds']

const failures = []
const warnings = []

const fail = (message) => failures.push(message)
const warn = (message) => warnings.push(message)
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function readJson(path, label) {
  if (!existsSync(path)) {
    fail(`${label}: missing file ${path}`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${label}: does not parse as JSON (${error.message})`)
    return undefined
  }
}

function checkManifestFields(record, label) {
  for (const field of Object.keys(record)) {
    if (field === '$comment') continue
    if (!FIXTURE_RECORD_FIELDS.includes(field)) fail(`${label}: unknown field "${field}"`)
  }
  for (const field of FIXTURE_RECORD_FIELDS) {
    if (!(field in record)) fail(`${label}: missing field "${field}"`)
  }
  if (typeof record['source'] !== 'string' || record['source'].trim() === '') {
    fail(`${label}: source must be a non-empty string`)
  }
  if (!Array.isArray(record['problemIds'])) {
    fail(`${label}: problemIds must be an array`)
  }
}

function checkLicense(record, label) {
  const license = record['license']
  if (typeof license !== 'string') {
    fail(`${label}: license must be a string`)
    return
  }
  if (license === '') {
    if (record['licenseStatus'] === PENDING) {
      warn(`${label}: license not recorded yet (${PENDING}) — delivery-blocking before ingestion`)
    } else {
      fail(`${label}: empty license without licenseStatus="${PENDING}"`)
    }
    return
  }
  if (!ALLOWED_LICENSES.includes(license)) {
    fail(`${label}: license "${license}" is not on the redistribution-permitting allow-list`)
  }
}

// 1. Package skeleton.
const manifest = readJson(join(PKG, 'package.json'), 'package.json')
if (manifest !== undefined) {
  if (manifest.name !== '@dsh-cc/math-eval') fail(`package.json: unexpected name "${manifest.name}"`)
  if (manifest.private !== true) fail('package.json: must stay private')
  if (manifest.version !== '0.9.6-rc.3') fail(`package.json: unexpected version "${manifest.version}"`)
  if (manifest.scripts?.check !== 'node scripts/check-math-eval.mjs') {
    fail('package.json: "check" script must run node scripts/check-math-eval.mjs')
  }
}

const tsconfig = readJson(join(PKG, 'tsconfig.json'), 'tsconfig.json')
if (tsconfig !== undefined) {
  if (tsconfig.extends !== '../../../tsconfig.base.json') {
    fail('tsconfig.json: must extend ../../../tsconfig.base.json')
  }
  if (tsconfig.compilerOptions?.rootDir !== 'src') fail('tsconfig.json: rootDir must be "src"')
}

for (const file of REQUIRED_SOURCE_FILES) {
  if (!existsSync(join(PKG, file))) fail(`missing source file: ${file}`)
}
for (const file of REQUIRED_TEST_FILES) {
  if (!existsSync(join(PKG, file))) fail(`missing structure test: ${file}`)
}

// 2. Fixture metadata.
const fixturesReadme = join(PKG, 'fixtures', 'README.md')
if (!existsSync(fixturesReadme)) {
  fail('fixtures/README.md: missing (fixture metadata + license policy)')
} else {
  const readme = readFileSync(fixturesReadme, 'utf8')
  for (const needle of ['§8.1', 'license', 'sha256', 'gold-set.json']) {
    if (!readme.includes(needle)) fail(`fixtures/README.md: must document "${needle}"`)
  }
}

// 3. gold-set.json shape.
const goldSet = readJson(join(PKG, 'fixtures', 'gold-set.json'), 'fixtures/gold-set.json')
if (goldSet !== undefined) {
  if (typeof goldSet.$comment !== 'string' || goldSet.$comment.trim() === '') {
    fail('gold-set.json: needs a $comment explaining that fixture ingestion is a later wave')
  }
  if (!isPlainObject(goldSet.splits)) {
    fail('gold-set.json: splits must be an object with train and test')
  } else {
    for (const splitName of ['train', 'test']) {
      const split = goldSet.splits[splitName]
      if (!isPlainObject(split)) {
        fail(`gold-set.json: splits.${splitName} missing`)
        continue
      }
      for (const key of Object.keys(split)) {
        if (key === '$comment') continue
        if (!SPLIT_FIELDS.includes(key)) fail(`gold-set.json: splits.${splitName} unknown field "${key}"`)
      }
      for (const field of SPLIT_FIELDS) {
        if (!(field in split)) fail(`gold-set.json: splits.${splitName} missing "${field}"`)
      }
      if (typeof split.writeBlocked !== 'boolean') {
        fail(`gold-set.json: splits.${splitName}.writeBlocked must be a boolean`)
      }
      if (!Array.isArray(split.problemIds)) fail(`gold-set.json: splits.${splitName}.problemIds must be an array`)
    }
    if (goldSet.splits.test?.writeBlocked !== true) {
      fail('gold-set.json: splits.test must be writeBlocked (experience snapshot is train-only)')
    }
    if (goldSet.splits.train?.writeBlocked !== false) {
      fail('gold-set.json: splits.train must not be writeBlocked')
    }
  }

  if (!isPlainObject(goldSet.fixtures)) {
    fail('gold-set.json: fixtures must be an object keyed by slice id')
  } else {
    for (const slice of EXPECTED_SLICES) {
      const record = goldSet.fixtures[slice]
      const label = `gold-set.json: fixtures.${slice}`
      if (!isPlainObject(record)) {
        fail(`${label}: missing planned slice record`)
        continue
      }
      checkManifestFields(record, label)
      checkLicense(record, label)
    }
    for (const slice of Object.keys(goldSet.fixtures)) {
      if (!EXPECTED_SLICES.includes(slice)) fail(`gold-set.json: unexpected slice "${slice}"`)
    }
    // Placeholder honesty: this wave ships no benchmark content.
    const anyContent = Object.values(goldSet.fixtures).some(
      (record) => Array.isArray(record?.problemIds) && record.problemIds.length > 0,
    )
    if (anyContent && !goldSet.contentIngested) {
      fail('gold-set.json: problemIds are populated but contentIngested is not set')
    }
    if (!anyContent && goldSet.contentIngested) {
      fail('gold-set.json: contentIngested is set but every problemIds array is empty')
    }
  }
}

// 4. Report.
for (const message of warnings) console.warn(`  warn: ${message}`)
if (failures.length > 0) {
  for (const message of failures) console.error(`  fail: ${message}`)
  console.error(`check FAILED: ${failures.length} problem(s)`)
  process.exit(1)
}
const sliceCount = isPlainObject(goldSet?.fixtures) ? Object.keys(goldSet.fixtures).length : 0
console.log(`check OK: math-eval skeleton intact, gold-set.json parses (${sliceCount} slices, 2 splits)`)
