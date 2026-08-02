import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { BRARCHIVE_MAGIC, parseBrarchive } from '../src/brarchive.js'
import { run, type ProgressInfo } from '../src/runner.js'

function makeArchive(entries: Array<{ name: string; payload: Buffer }>): Buffer {
  const tableSize = entries.length * 256
  const dataSize = entries.reduce((sum, entry) => sum + entry.payload.length, 0)
  const result = Buffer.alloc(16 + tableSize + dataSize)
  BRARCHIVE_MAGIC.copy(result)
  result.writeUInt32LE(entries.length, 8)
  result.writeUInt32LE(1, 12)

  let dataOffset = 0
  for (const [index, entry] of entries.entries()) {
    const recordOffset = 16 + index * 256
    const name = Buffer.from(entry.name, 'utf8')
    result[recordOffset] = name.length
    name.copy(result, recordOffset + 1)
    result.writeUInt32LE(dataOffset, recordOffset + 248)
    result.writeUInt32LE(entry.payload.length, recordOffset + 252)
    entry.payload.copy(result, 16 + tableSize + dataOffset)
    dataOffset += entry.payload.length
  }
  return result
}

test('parseBrarchive extracts indexed payloads', () => {
  const archive = parseBrarchive(
    makeArchive([
      { name: 'one.json', payload: Buffer.from('one') },
      { name: 'nested/two.bin', payload: Buffer.from([1, 2, 3]) },
    ]),
  )
  assert.equal(archive.version, 1)
  assert.deepEqual(
    archive.entries.map(entry => [entry.name, [...entry.payload]]),
    [
      ['one.json', [111, 110, 101]],
      ['nested/two.bin', [1, 2, 3]],
    ],
  )
})

test('parseBrarchive rejects path traversal', () => {
  assert.throws(() => parseBrarchive(makeArchive([{ name: '../escape', payload: Buffer.alloc(0) }])), /path traversal/)
})

test('run controls overwrite, force clearing, reports, and progress events', async () => {
  const temporaryRoot = await mkdtemp(path.join(process.cwd(), '.test-runner-'))
  try {
    const archivePath = path.join(temporaryRoot, 'sample.brarchive')
    const outputPath = path.join(temporaryRoot, 'output')
    const reportPath = path.join(outputPath, '.brarchive-report.json')
    await writeFile(archivePath, makeArchive([{ name: 'nested/value.txt', payload: Buffer.from('payload') }]))

    const firstRun = await run({ inputPath: archivePath, outputPath })
    assert.equal(firstRun.archiveErrors, 0)
    assert.equal(await readFile(path.join(outputPath, 'nested', 'value.txt'), 'utf8'), 'payload')
    await assert.rejects(access(reportPath))

    await assert.rejects(run({ inputPath: archivePath, outputPath }), /--overwrite.*--force/)

    const progress: ProgressInfo[] = []
    let overwritePrompts = 0
    const overwriteRun = await run({
      inputPath: archivePath,
      outputPath,
      overwrite: true,
      report: true,
      resolveConflict: async () => {
        overwritePrompts += 1
        return { action: 'overwrite', applyToAll: true }
      },
      onProgress: event => progress.push(event),
    })
    assert.equal(overwriteRun.archiveErrors, 0)
    assert.equal(overwriteRun.conflictsDetected, 0)
    assert.equal(overwritePrompts, 0)
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { entries: number; failures: unknown[] }
    assert.equal(report.entries, 1)
    assert.deepEqual(report.failures, [])
    assert.deepEqual(
      progress.map(event => event.phase),
      ['archive-start', 'entry', 'archive-complete'],
    )
    assert.equal(progress[1]!.entry, 'nested/value.txt')
    assert.equal(progress[1]!.entryIndex, 1)
    assert.equal(progress[1]!.entryCount, 1)
    assert.deepEqual(
      progress.map(event => [event.overallIndex, event.overallCount]),
      [
        [0, 2],
        [0, 2],
        [2, 2],
      ],
    )

    const stalePath = path.join(outputPath, 'stale.txt')
    await writeFile(stalePath, 'remove me')
    const forcedRun = await run({ inputPath: archivePath, outputPath, force: true })
    assert.equal(forcedRun.conflictsDetected, 0)
    assert.equal(await readFile(path.join(outputPath, 'nested', 'value.txt'), 'utf8'), 'payload')
    await assert.rejects(access(stalePath))
    await assert.rejects(access(reportPath))

    await assert.rejects(
      run({ inputPath: archivePath, outputPath, overwrite: true, force: true }),
      /--overwrite cannot be combined with --force/,
    )
    await assert.rejects(
      run({ inputPath: archivePath, outputPath: temporaryRoot, force: true }),
      /--force output root must not contain the input path/,
    )

    const cliPath = path.join(process.cwd(), 'dist', 'src', 'cli.js')
    const cliOutputPath = path.join(temporaryRoot, 'cli-output')
    const cliRun = spawnSync(
      process.execPath,
      [cliPath, archivePath, '--output', cliOutputPath, '-p', '--list'],
      { encoding: 'utf8' },
    )
    assert.equal(cliRun.status, 0, cliRun.stderr)
    assert.match(cliRun.stdout, /Report:/)
    assert.equal(cliRun.stderr, '')

    const overwrittenCliRun = spawnSync(
      process.execPath,
      [cliPath, archivePath, '--output', cliOutputPath, '-w', '--no-verbose'],
      { encoding: 'utf8' },
    )
    assert.equal(overwrittenCliRun.status, 0, overwrittenCliRun.stderr)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('run formats non-MCB JSON only when requested', async () => {
  const temporaryRoot = await mkdtemp(path.join(process.cwd(), '.test-json-format-'))
  try {
    const archivePath = path.join(temporaryRoot, 'json.brarchive')
    const originalJson = '{\n    "name": "sample",\n    "values": [1, 2]\n}\n'
    const commentedJson =
      '{\n    // line comment\n    "name": /* block comment */ "sample",\n    "values": [1, 2]\n}\n'
    await writeFile(
      archivePath,
      makeArchive([
        { name: 'data.json', payload: Buffer.from(originalJson) },
        { name: 'commented.json', payload: Buffer.from(commentedJson) },
        { name: 'data.txt', payload: Buffer.from(originalJson) },
      ]),
    )

    const untouchedOutput = path.join(temporaryRoot, 'untouched')
    await run({ inputPath: archivePath, outputPath: untouchedOutput, jsonFormat: 'compact' })
    assert.equal(await readFile(path.join(untouchedOutput, 'data.json'), 'utf8'), originalJson)
    assert.equal(await readFile(path.join(untouchedOutput, 'commented.json'), 'utf8'), commentedJson)
    assert.equal(await readFile(path.join(untouchedOutput, 'data.txt'), 'utf8'), originalJson)

    const compactOutput = path.join(temporaryRoot, 'compact')
    const compactRun = await run({
      inputPath: archivePath,
      outputPath: compactOutput,
      jsonFormat: 'compact',
      formatAllJson: true,
    })
    assert.equal(await readFile(path.join(compactOutput, 'data.json'), 'utf8'), '{"name":"sample","values":[1,2]}')
    assert.equal(
      await readFile(path.join(compactOutput, 'commented.json'), 'utf8'),
      '{// line comment\n"name":/* block comment */"sample","values":[1,2]}',
    )
    assert.equal(await readFile(path.join(compactOutput, 'data.txt'), 'utf8'), originalJson)
    assert.equal(compactRun.archives[0]!.formattedJson, 2)

    const tabOutput = path.join(temporaryRoot, 'tabs')
    await run({
      inputPath: archivePath,
      outputPath: tabOutput,
      formatAllJson: true,
      indentSize: 1,
      indentCharacter: 'tab',
    })
    assert.equal(
      await readFile(path.join(tabOutput, 'data.json'), 'utf8'),
      '{\n\t"name": "sample",\n\t"values": [\n\t\t1,\n\t\t2\n\t]\n}\n',
    )
    assert.equal(
      await readFile(path.join(tabOutput, 'commented.json'), 'utf8'),
      '{\n\t// line comment\n\t"name": /* block comment */ "sample",\n\t"values": [\n\t\t1,\n\t\t2\n\t]\n}\n',
    )

    const cliPath = path.join(process.cwd(), 'dist', 'src', 'cli.js')
    const cliOutput = path.join(temporaryRoot, 'cli-compact')
    const cliRun = spawnSync(process.execPath, [cliPath, archivePath, '-o', cliOutput, '-j', 'compact', '-a'], {
      encoding: 'utf8',
    })
    assert.equal(cliRun.status, 0, cliRun.stderr)
    assert.equal(await readFile(path.join(cliOutput, 'data.json'), 'utf8'), '{"name":"sample","values":[1,2]}')
    assert.equal(
      await readFile(path.join(cliOutput, 'commented.json'), 'utf8'),
      '{// line comment\n"name":/* block comment */"sample","values":[1,2]}',
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('run continues by default and supports fail-fast processing', async () => {
  const temporaryRoot = await mkdtemp(path.join(process.cwd(), '.test-fail-fast-'))
  try {
    const archivePath = path.join(temporaryRoot, 'failure.brarchive')
    await writeFile(
      archivePath,
      makeArchive([
        { name: 'invalid.json', payload: Buffer.from('{ invalid') },
        { name: 'after.txt', payload: Buffer.from('processed') },
      ]),
    )

    const continuedOutput = path.join(temporaryRoot, 'continued')
    const continued = await run({ inputPath: archivePath, outputPath: continuedOutput, formatAllJson: true })
    assert.equal(continued.interrupted, false)
    assert.equal(continued.failures.length, 1)
    assert.equal(await readFile(path.join(continuedOutput, 'invalid.json'), 'utf8'), '{ invalid')
    assert.equal(await readFile(path.join(continuedOutput, 'after.txt'), 'utf8'), 'processed')

    const discardedOutput = path.join(temporaryRoot, 'discarded')
    const discarded = await run({
      inputPath: archivePath,
      outputPath: discardedOutput,
      formatAllJson: true,
      preserveFailed: false,
    })
    assert.equal(discarded.failures.length, 1)
    await assert.rejects(access(path.join(discardedOutput, 'invalid.json')))
    assert.equal(await readFile(path.join(discardedOutput, 'after.txt'), 'utf8'), 'processed')

    const stoppedOutput = path.join(temporaryRoot, 'stopped')
    const stopped = await run({
      inputPath: archivePath,
      outputPath: stoppedOutput,
      formatAllJson: true,
      failFast: true,
      preserveFailed: false,
      report: true,
    })
    assert.equal(stopped.interrupted, true)
    assert.equal(stopped.archives[0]!.processedEntries, 1)
    assert.equal(stopped.archives[0]!.interrupted, true)
    assert.equal(await readFile(path.join(stoppedOutput, 'invalid.json'), 'utf8'), '{ invalid')
    await assert.rejects(access(path.join(stoppedOutput, 'after.txt')))
    const stoppedReport = JSON.parse(await readFile(path.join(stoppedOutput, '.brarchive-report.json'), 'utf8')) as {
      interrupted: boolean
      failedJson: number
    }
    assert.equal(stoppedReport.interrupted, true)
    assert.equal(stoppedReport.failedJson, 1)

    const cliPath = path.join(process.cwd(), 'dist', 'src', 'cli.js')
    const summaryOutput = path.join(temporaryRoot, 'summary')
    const concise = spawnSync(
      process.execPath,
      [cliPath, archivePath, '--output', summaryOutput, '--format-all-json'],
      { encoding: 'utf8' },
    )
    assert.equal(concise.status, 2)
    assert.match(concise.stdout, /Extraction completed/)
    assert.match(concise.stdout, /Failures: 1; use --list for details/)
    assert.doesNotMatch(concise.stdout, /Archive results:/)
    assert.equal(concise.stderr, '')

    const listedOutput = path.join(temporaryRoot, 'listed')
    const listed = spawnSync(
      process.execPath,
      [cliPath, archivePath, '--output', listedOutput, '--format-all-json', '--list'],
      { encoding: 'utf8' },
    )
    assert.equal(listed.status, 2)
    assert.match(listed.stdout, /Archive results:/)
    assert.match(listed.stdout, /Entry failures:/)

    const shortFailureOutput = path.join(temporaryRoot, 'short-failure-options')
    const shortFailureRun = spawnSync(
      process.execPath,
      [cliPath, archivePath, '-o', shortFailureOutput, '-a', '-F', '-D'],
      { encoding: 'utf8' },
    )
    assert.equal(shortFailureRun.status, 2, shortFailureRun.stderr)
    assert.match(shortFailureRun.stdout, /Extraction stopped/)

    const removedResultsOption = spawnSync(process.execPath, [cliPath, archivePath, '--show-all-results'], {
      encoding: 'utf8',
    })
    assert.equal(removedResultsOption.status, 1)
    assert.match(removedResultsOption.stderr, /Unknown option: --show-all-results/)

    const colorEnvironment: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '1' }
    delete colorEnvironment.NO_COLOR
    const coloredHelp = spawnSync(process.execPath, [cliPath, '--help'], {
      encoding: 'utf8',
      env: colorEnvironment,
    })
    assert.equal(coloredHelp.status, 0)
    assert.match(coloredHelp.stdout, /\u001b\[/)
    assert.match(coloredHelp.stdout, /brax/)
    assert.match(coloredHelp.stdout, /--in-place/)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('directory mode writes a mirrored tree under one sibling output root', async () => {
  const temporaryRoot = await mkdtemp(path.join(process.cwd(), '.test-output-tree-'))
  try {
    const inputRoot = path.join(temporaryRoot, 'input')
    const archiveDirectory = path.join(inputRoot, 'pack', '__brarchive')
    await mkdir(archiveDirectory, { recursive: true })
    await writeFile(path.join(inputRoot, 'pack', 'binary.dat'), Buffer.from([0, 1, 2, 255]))
    await writeFile(
      path.join(archiveDirectory, 'entities.brarchive'),
      makeArchive([{ name: 'nested/agent.json', payload: Buffer.from('{"name":"agent"}') }]),
    )
    await writeFile(
      path.join(archiveDirectory, 'recipes.brarchive'),
      makeArchive([{ name: 'boat.json', payload: Buffer.from('{"recipe":true}') }]),
    )

    const overallProgress: ProgressInfo[] = []
    const summary = await run({ inputPath: inputRoot, onProgress: event => overallProgress.push(event) })
    const expectedRoot = path.join(temporaryRoot, 'input_unpacked')
    assert.equal(summary.outputRoot, expectedRoot)
    assert.equal(summary.totalArchives, 2)
    assert.deepEqual(await readFile(path.join(expectedRoot, 'pack', 'binary.dat')), Buffer.from([0, 1, 2, 255]))
    assert.equal(summary.sourceFiles.copiedFiles, 1)
    assert.ok(overallProgress.every(event => event.overallCount === 5))
    assert.equal(overallProgress.at(-1)?.overallIndex, 5)
    assert.equal(
      await readFile(path.join(expectedRoot, 'pack', '__brarchive', 'entities', 'nested', 'agent.json'), 'utf8'),
      '{"name":"agent"}',
    )
    assert.equal(
      await readFile(path.join(expectedRoot, 'pack', '__brarchive', 'recipes', 'boat.json'), 'utf8'),
      '{"recipe":true}',
    )
    await assert.rejects(access(path.join(archiveDirectory, 'entities_unpacked')))
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('run supports in-place directory and single-archive extraction', async () => {
  const temporaryRoot = await mkdtemp(path.join(process.cwd(), '.test-in-place-'))
  try {
    const inputRoot = path.join(temporaryRoot, 'input')
    await mkdir(inputRoot, { recursive: true })
    await writeFile(path.join(inputRoot, 'source.json'), '{\n  // source comment\n  "value": /* block */ true\n}\n')
    await writeFile(path.join(inputRoot, 'binary.dat'), Buffer.from([0, 1, 2, 255]))
    await writeFile(
      path.join(inputRoot, 'pack.brarchive'),
      makeArchive([{ name: 'nested/value.txt', payload: Buffer.from('archive value') }]),
    )

    const directoryRun = await run({
      inputPath: inputRoot,
      inPlace: true,
      formatAllJson: true,
      jsonFormat: 'compact',
    })
    assert.equal(directoryRun.outputRoot, inputRoot)
    assert.equal(directoryRun.conflictsDetected, 0)
    assert.equal(
      await readFile(path.join(inputRoot, 'source.json'), 'utf8'),
      '{// source comment\n"value":/* block */true}',
    )
    assert.deepEqual(await readFile(path.join(inputRoot, 'binary.dat')), Buffer.from([0, 1, 2, 255]))
    assert.equal(await readFile(path.join(inputRoot, 'pack', 'nested', 'value.txt'), 'utf8'), 'archive value')
    await access(path.join(inputRoot, 'pack.brarchive'))

    const singleArchive = path.join(temporaryRoot, 'single.brarchive')
    await writeFile(singleArchive, makeArchive([{ name: 'value.txt', payload: Buffer.from('single value') }]))
    const singleRun = await run({ inputPath: singleArchive, inPlace: true })
    assert.equal(singleRun.outputRoot, path.join(temporaryRoot, 'single'))
    assert.equal(await readFile(path.join(temporaryRoot, 'single', 'value.txt'), 'utf8'), 'single value')
    await access(singleArchive)

    const cliArchive = path.join(temporaryRoot, 'cli-in-place.brarchive')
    await writeFile(cliArchive, makeArchive([{ name: 'cli.txt', payload: Buffer.from('cli value') }]))
    const cliPath = path.join(process.cwd(), 'dist', 'src', 'cli.js')
    const cliRun = spawnSync(process.execPath, [cliPath, cliArchive, '-i', '--no-verbose'], {
      encoding: 'utf8',
    })
    assert.equal(cliRun.status, 0, cliRun.stderr)
    assert.equal(await readFile(path.join(temporaryRoot, 'cli-in-place', 'cli.txt'), 'utf8'), 'cli value')

    const conflictRoot = path.join(temporaryRoot, 'conflict-input')
    await mkdir(path.join(conflictRoot, 'foo'), { recursive: true })
    await writeFile(path.join(conflictRoot, 'foo', 'same.txt'), 'source value')
    await writeFile(
      path.join(conflictRoot, 'foo.brarchive'),
      makeArchive([{ name: 'same.txt', payload: Buffer.from('archive replacement') }]),
    )
    const conflictRun = await run({
      inputPath: conflictRoot,
      inPlace: true,
      resolveConflict: async () => ({ action: 'overwrite' }),
    })
    assert.equal(conflictRun.conflictsDetected, 1)
    assert.equal(await readFile(path.join(conflictRoot, 'foo', 'same.txt'), 'utf8'), 'archive replacement')

    await assert.rejects(
      run({ inputPath: inputRoot, inPlace: true, outputPath: path.join(temporaryRoot, 'output') }),
      /--in-place cannot be combined with --output/,
    )
    await assert.rejects(
      run({ inputPath: inputRoot, inPlace: true, splitArchives: true }),
      /--in-place cannot be combined with --split-archives/,
    )
    await assert.rejects(
      run({ inputPath: inputRoot, inPlace: true, force: true }),
      /--in-place cannot be combined with --force/,
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('run detects merged conflicts, applies decisions, and supports split archives', async () => {
  const temporaryRoot = await mkdtemp(path.join(process.cwd(), '.test-conflicts-'))
  try {
    const inputRoot = path.join(temporaryRoot, 'input')
    const nestedDirectory = path.join(inputRoot, 'foo')
    await mkdir(nestedDirectory, { recursive: true })
    await writeFile(
      path.join(inputRoot, 'foo.brarchive'),
      makeArchive([
        { name: 'nested/same.txt', payload: Buffer.from('parent-one') },
        { name: 'nested/second.txt', payload: Buffer.from('parent-two') },
      ]),
    )
    await writeFile(
      path.join(nestedDirectory, 'nested.brarchive'),
      makeArchive([
        { name: 'same.txt', payload: Buffer.from('child-one') },
        { name: 'second.txt', payload: Buffer.from('child-two') },
      ]),
    )

    let coexistPrompts = 0
    const coexistOutput = path.join(temporaryRoot, 'coexist')
    const coexist = await run({
      inputPath: inputRoot,
      outputPath: coexistOutput,
      resolveConflict: async () => {
        coexistPrompts += 1
        return { action: 'coexist', applyToAll: true }
      },
    })
    assert.equal(coexist.conflictsDetected, 2)
    assert.equal(coexist.conflictsResolved.length, 2)
    assert.equal(coexistPrompts, 1)
    assert.ok(coexist.conflictsResolved.every(conflict => conflict.action === 'coexist'))
    const sameContents = [
      await readFile(path.join(coexistOutput, 'foo', 'nested', 'same.txt'), 'utf8'),
      await readFile(path.join(coexistOutput, 'foo', 'nested', 'same (1).txt'), 'utf8'),
    ].sort()
    assert.deepEqual(sameContents, ['child-one', 'parent-one'])

    const forcedOutput = path.join(temporaryRoot, 'forced-existing')
    await mkdir(path.join(forcedOutput, 'foo', 'nested'), { recursive: true })
    await writeFile(path.join(forcedOutput, 'foo', 'nested', 'same.txt'), 'old output one')
    await writeFile(path.join(forcedOutput, 'foo', 'nested', 'second.txt'), 'old output two')
    let forcedConflictPrompts = 0
    const forced = await run({
      inputPath: inputRoot,
      outputPath: forcedOutput,
      force: true,
      resolveConflict: async () => {
        forcedConflictPrompts += 1
        return { action: 'keep', applyToAll: true }
      },
    })
    assert.equal(forced.conflictsDetected, 2)
    assert.equal(forced.conflictsResolved.length, 2)
    assert.equal(forcedConflictPrompts, 1)
    assert.ok(forced.conflictsResolved.every(conflict => !conflict.existingSource.startsWith('Existing output file:')))
    assert.notEqual(await readFile(path.join(forcedOutput, 'foo', 'nested', 'same.txt'), 'utf8'), 'old output one')
    assert.notEqual(await readFile(path.join(forcedOutput, 'foo', 'nested', 'second.txt'), 'utf8'), 'old output two')

    const keepOutput = path.join(temporaryRoot, 'keep')
    await run({
      inputPath: inputRoot,
      outputPath: keepOutput,
      resolveConflict: async () => ({ action: 'keep', applyToAll: true }),
    })
    const kept = await readFile(path.join(keepOutput, 'foo', 'nested', 'same.txt'), 'utf8')
    await assert.rejects(access(path.join(keepOutput, 'foo', 'nested', 'same (1).txt')))

    const overwriteOutput = path.join(temporaryRoot, 'overwrite')
    await run({
      inputPath: inputRoot,
      outputPath: overwriteOutput,
      resolveConflict: async () => ({ action: 'overwrite', applyToAll: true }),
    })
    const overwritten = await readFile(path.join(overwriteOutput, 'foo', 'nested', 'same.txt'), 'utf8')
    assert.notEqual(overwritten, kept)

    const splitOutput = path.join(temporaryRoot, 'split')
    const split = await run({ inputPath: inputRoot, outputPath: splitOutput, splitArchives: true })
    assert.equal(split.conflictsDetected, 0)
    assert.equal(
      await readFile(path.join(splitOutput, 'foo.brarchive', 'nested', 'same.txt'), 'utf8'),
      'parent-one',
    )
    assert.equal(
      await readFile(path.join(splitOutput, 'foo', 'nested.brarchive', 'same.txt'), 'utf8'),
      'child-one',
    )

    await assert.rejects(
      run({ inputPath: inputRoot, outputPath: path.join(temporaryRoot, 'no-decision') }),
      /2 conflicts detected/,
    )
    const cliPath = path.join(process.cwd(), 'dist', 'src', 'cli.js')
    const nonInteractive = spawnSync(
      process.execPath,
      [cliPath, inputRoot, '--output', path.join(temporaryRoot, 'non-interactive'), '--no-verbose'],
      { encoding: 'utf8' },
    )
    assert.equal(nonInteractive.status, 1)
    assert.match(nonInteractive.stderr, /interactive terminal/)
    assert.match(nonInteractive.stderr, /2 conflicts detected/)

    const blockedOutput = path.join(temporaryRoot, 'blocked-parent')
    await mkdir(blockedOutput, { recursive: true })
    await writeFile(path.join(blockedOutput, 'foo'), 'existing file')
    await assert.rejects(
      run({ inputPath: inputRoot, outputPath: blockedOutput, splitArchives: true, overwrite: true }),
      /Output directory path conflicts with an existing file/,
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
