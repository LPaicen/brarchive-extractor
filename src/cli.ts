#!/usr/bin/env node
import { MultiBar, Presets, type SingleBar } from 'cli-progress'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { ToolError, toToolError } from './errors.js'
import {
  run,
  type ArchiveReport,
  type ConflictDecision,
  type ConflictDetails,
  type IndentCharacter,
  type JsonFormat,
  type ProgressInfo,
  type RunOptions,
  type RunSummary,
} from './runner.js'

const VERSION = '0.1.0'
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
} as const

interface CliOptions extends RunOptions {
  verbose: boolean
  listResults?: boolean
  listAllResults?: boolean
}

type CompletionStatus = 'ok' | 'incomplete' | 'failed'

interface ProgressReporter {
  update(progress: ProgressInfo): void
  stop(): void
}

interface ResultTotals {
  processedEntries: number
  entries: number
  selectedEntries: number
  mcbEntries: number
  restoredMcb: number
  failedMcb: number
  jsonEntries: number
  formattedJson: number
  failedJson: number
  copiedEntries: number
  skippedEntries: number
  conflictSkippedEntries: number
}

function supportsColor(stream: NodeJS.WriteStream): boolean {
  if ('NO_COLOR' in process.env) {
    return false
  }
  const forced = process.env.FORCE_COLOR
  if (forced !== undefined) {
    return forced !== '0' && forced.toLocaleLowerCase('en-US') !== 'false'
  }
  return stream.isTTY === true
}

const stdoutColor = supportsColor(process.stdout)
const stderrColor = supportsColor(process.stderr)

function paint(value: string, color: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${value}${ANSI.reset}` : value
}

function printHelp(): void {
  const option = (flags: string, description: string): string =>
    `  ${paint(flags.padEnd(31), 'cyan', stdoutColor)}${description}`

  console.log(`${paint(`brax ${VERSION}`, 'bold', stdoutColor)}

${paint('Usage:', 'bold', stdoutColor)}
  brax <file-or-directory> [options]

${paint('Options:', 'bold', stdoutColor)}
${option('-d, --directory', 'Directory mode; process all .brarchive files')}
${option('-r, --recursive', 'Scan directories recursively (default)')}
${option('    --no-recursive', 'Scan only the specified directory')}
${option('-s, --schema <path>', 'BDS docs export root containing exist.json and contents.json')}
${option('-o, --output <path>', 'Output root; defaults to <input>_unpacked beside the input')}
${option('-w, --overwrite', 'Overwrite existing output files; incompatible with --force')}
${option('-f, --force', 'Clear output first; incompatible with --overwrite and --in-place')}
${option('-p, --report', 'Write .brarchive-report.json for each archive')}
${option('    --verbose', 'Show status and progress (default)')}
${option('    --no-verbose', 'Disable status and progress')}
${option('-l, --list', 'List failure details only')}
${option('-L, --list-all', 'List all archive, failure, and conflict details')}
${option('-j, --json-format <mode>', 'pretty or compact restored MCB JSON (default: pretty)')}
${option('-J, --format-all-json', 'Format non-MCB .json entries and preserve comments')}
${option('    --indent-size <0-10>', 'Indentation width for pretty JSON (default: 2)')}
${option('    --indent-char <value>', 'Indent with space or tab (default: space)')}
${option('-F, --fail-fast', 'Stop processing after the first entry or archive failure')}
${option('-D, --discard-failed', 'Do not keep failed entries; ignored with --fail-fast')}
${option('    --mcb-only', 'Extract and restore MCB entries only')}
${option('    --no-empty-dirs', 'Do not create directories without extracted files')}
${option('    --split-archives', 'Keep foo.brarchive and foo directory outputs separate')}
${option('-i, --in-place', 'Write into the source tree; incompatible with --output, --split-archives, and --force')}
${option('-h, --help', 'Show help')}
${option('-v, --version', 'Show version')}

${paint('Exit codes:', 'bold', stdoutColor)}
  ${paint('0', 'green', stdoutColor)}  All archives unpacked without entry-level issues
  ${paint('1', 'red', stdoutColor)}  Fatal error, or every archive failed to unpack
  ${paint('2', 'yellow', stdoutColor)}  Processing was incomplete, but not every archive failed to unpack

Colors are enabled for terminals and disabled for redirected output. NO_COLOR disables colors; FORCE_COLOR enables them.`)
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function parseJsonFormat(value: string): JsonFormat {
  if (value === 'pretty' || value === 'compact') {
    return value
  }
  throw new Error(`--json-format must be pretty or compact: ${value}`)
}

function parseIndentSize(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--indent-size must be an integer from 0 to 10: ${value}`)
  }
  const parsed = Number(value)
  if (parsed > 10) {
    throw new Error(`--indent-size must be an integer from 0 to 10: ${value}`)
  }
  return parsed
}

function parseIndentCharacter(value: string): IndentCharacter {
  if (value === 'space' || value === 'tab') {
    return value
  }
  throw new Error(`--indent-char must be space or tab: ${value}`)
}

function parseArguments(args: string[]): CliOptions | undefined {
  let inputPath: string | undefined
  const options: CliOptions = { inputPath: '', recursive: true, verbose: true }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    switch (argument) {
      case '-h':
      case '--help':
        printHelp()
        return undefined
      case '-v':
      case '--version':
        console.log(VERSION)
        return undefined
      case '-d':
      case '--directory':
        options.directoryMode = true
        break
      case '-r':
      case '--recursive':
        options.recursive = true
        break
      case '--no-recursive':
        options.recursive = false
        break
      case '-f':
      case '--force':
        options.force = true
        break
      case '-w':
      case '--overwrite':
        options.overwrite = true
        break
      case '-p':
      case '--report':
        options.report = true
        break
      case '--verbose':
        options.verbose = true
        break
      case '--no-verbose':
        options.verbose = false
        break
      case '-l':
      case '--list':
        options.listResults = true
        break
      case '-L':
      case '--list-all':
        options.listAllResults = true
        break
      case '-J':
      case '--format-all-json':
        options.formatAllJson = true
        break
      case '-F':
      case '--fail-fast':
        options.failFast = true
        break
      case '-D':
      case '--discard-failed':
        options.preserveFailed = false
        break
      case '--mcb-only':
        options.mcbOnly = true
        break
      case '--no-empty-dirs':
        options.omitEmptyDirectories = true
        break
      case '--split-archives':
        options.splitArchives = true
        break
      case '-i':
      case '--in-place':
        options.inPlace = true
        break
      case '-j':
      case '--json-format':
        options.jsonFormat = parseJsonFormat(requireValue(args, index, argument))
        index += 1
        break
      case '--indent-size':
        options.indentSize = parseIndentSize(requireValue(args, index, argument))
        index += 1
        break
      case '--indent-char':
        options.indentCharacter = parseIndentCharacter(requireValue(args, index, argument))
        index += 1
        break
      case '-s':
      case '--schema':
        options.schemaPath = requireValue(args, index, argument)
        index += 1
        break
      case '-o':
      case '--output':
        options.outputPath = requireValue(args, index, argument)
        index += 1
        break
      default:
        if (argument.startsWith('-')) {
          throw new Error(`Unknown option: ${argument}`)
        }
        if (inputPath !== undefined) {
          throw new Error(`Only one input path may be specified; extra argument: ${argument}`)
        }
        inputPath = argument
    }
  }

  if (inputPath === undefined) {
    throw new Error('Missing brarchive file or directory path; use --help for usage information')
  }
  options.inputPath = inputPath
  return options
}

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value
  }
  return maximumLength <= 3 ? value.slice(0, maximumLength) : `${value.slice(0, maximumLength - 3)}...`
}

function createProgressReporter(): ProgressReporter | undefined {
  if (!process.stderr.isTTY) {
    return undefined
  }

  const columns = process.stderr.columns || 80
  const barsize = Math.max(10, Math.min(40, columns - 24))
  const multibar = new MultiBar(
    {
      stream: process.stderr,
      clearOnComplete: true,
      hideCursor: true,
      linewrap: true,
      fps: 10,
      forceRedraw: true,
      noTTYOutput: false,
    },
    Presets.shades_classic,
  )
  const statusBar: SingleBar = multibar.create(
    1,
    0,
    { status: 'Starting', file: '-' },
    {
      format: `${paint('Status:', 'cyan', stderrColor)} {status} | ${paint('File:', 'cyan', stderrColor)} {file}`,
    },
  )
  const progressBar: SingleBar = multibar.create(1, 0, undefined, {
    format: `${paint('Current:', 'cyan', stderrColor)} [{bar}] {percentage}% | {value}/{total}`,
    barsize,
    barCompleteChar: '#',
    barIncompleteChar: '-',
  })
  const totalProgressBar: SingleBar = multibar.create(1, 0, undefined, {
    format: `${paint('Total:', 'cyan', stderrColor)}   [{bar}] {percentage}% | {value}/{total}`,
    barsize,
    barCompleteChar: '#',
    barIncompleteChar: '-',
  })

  return {
    update(progress): void {
      const copyingSource = progress.phase.startsWith('copy-')
      const stageStatus = copyingSource
        ? 'Copying source files'
        : `Archive ${progress.archiveIndex}/${progress.archiveCount}`
      const file = copyingSource
        ? (progress.entry ?? path.basename(progress.archive))
        : progress.entry === undefined
          ? path.basename(progress.archive)
          : `${path.basename(progress.archive)} :: ${progress.entry}`
      const maximumFileLength = Math.max(10, columns - stageStatus.length - 20)
      let status = stageStatus
      if (progress.phase === 'archive-complete' || progress.phase === 'copy-complete') {
        status = progress.interrupted === true ? 'Stopped' : progress.failed === true ? 'Completed with issues' : 'Complete'
      }
      statusBar.update(0, { status, file: truncate(file, maximumFileLength) })

      const total = Math.max(1, progress.entryCount ?? 1)
      const value =
        progress.phase === 'entry' || progress.phase === 'copy-file'
          ? Math.max(0, (progress.entryIndex ?? 1) - 1)
          : progress.entryCount === 0 && progress.failed !== true
            ? total
            : Math.min(total, progress.entryIndex ?? 0)
      progressBar.setTotal(total)
      progressBar.update(value)

      const overallTotal = Math.max(1, progress.overallCount ?? 1)
      const overallValue = Math.min(overallTotal, Math.max(0, progress.overallIndex ?? 0))
      totalProgressBar.setTotal(overallTotal)
      totalProgressBar.update(overallValue)
    },
    stop(): void {
      multibar.stop()
    },
  }
}

function resultTotals(reports: ArchiveReport[]): ResultTotals {
  return reports.reduce<ResultTotals>(
    (totals, report) => ({
      processedEntries: totals.processedEntries + report.processedEntries,
      entries: totals.entries + report.entries,
      selectedEntries: totals.selectedEntries + report.selectedEntries,
      mcbEntries: totals.mcbEntries + report.mcbEntries,
      restoredMcb: totals.restoredMcb + report.restoredMcb,
      failedMcb: totals.failedMcb + report.failedMcb,
      jsonEntries: totals.jsonEntries + report.jsonEntries,
      formattedJson: totals.formattedJson + report.formattedJson,
      failedJson: totals.failedJson + report.failedJson,
      copiedEntries: totals.copiedEntries + report.copiedEntries,
      skippedEntries: totals.skippedEntries + report.skippedEntries,
      conflictSkippedEntries: totals.conflictSkippedEntries + report.conflictSkippedEntries,
    }),
    {
      processedEntries: 0,
      entries: 0,
      selectedEntries: 0,
      mcbEntries: 0,
      restoredMcb: 0,
      failedMcb: 0,
      jsonEntries: 0,
      formattedJson: 0,
      failedJson: 0,
      copiedEntries: 0,
      skippedEntries: 0,
      conflictSkippedEntries: 0,
    },
  )
}

function archiveCompletionStatus(report: ArchiveReport): CompletionStatus {
  if (report.archiveError !== undefined) {
    return 'failed'
  }
  if (report.interrupted === true || report.failures.length > 0) {
    return 'incomplete'
  }
  return 'ok'
}

function summaryCompletionStatus(summary: RunSummary): CompletionStatus {
  const everyArchiveFailed =
    summary.totalArchives > 0 &&
    summary.archives.length === summary.totalArchives &&
    summary.archiveErrors === summary.totalArchives
  if (everyArchiveFailed) {
    return 'failed'
  }
  if (summary.interrupted || summary.archiveErrors > 0 || summary.failures.length > 0) {
    return 'incomplete'
  }
  return 'ok'
}

function printSummary(summary: RunSummary): void {
  const totals = resultTotals(summary.archives)
  totals.processedEntries += summary.sourceFiles.processedFiles
  totals.entries += summary.sourceFiles.files
  totals.selectedEntries += summary.sourceFiles.selectedFiles
  totals.mcbEntries += summary.sourceFiles.mcbFiles
  totals.restoredMcb += summary.sourceFiles.restoredMcb
  totals.failedMcb += summary.sourceFiles.failedMcb
  totals.jsonEntries += summary.sourceFiles.jsonFiles
  totals.formattedJson += summary.sourceFiles.formattedJson
  totals.failedJson += summary.sourceFiles.failedJson
  totals.copiedEntries += summary.sourceFiles.copiedFiles
  totals.skippedEntries += summary.sourceFiles.skippedFiles
  totals.conflictSkippedEntries += summary.sourceFiles.conflictSkippedFiles
  const keptConflicts = summary.conflictsResolved.filter(conflict => conflict.action === 'keep').length
  const writtenConflicts = summary.conflictsResolved.length - keptConflicts
  const completionStatus = summaryCompletionStatus(summary)
  const hasIssues = summary.archiveErrors > 0 || summary.failures.length > 0
  const entrySummary =
    totals.skippedEntries === 0
      ? `${totals.processedEntries}/${totals.selectedEntries}`
      : `${totals.processedEntries}/${totals.selectedEntries} selected (${totals.entries} total)`
  const status =
    completionStatus === 'failed'
      ? paint('[FAILED]', 'red', stdoutColor)
      : completionStatus === 'incomplete'
        ? paint('[INCOMPLETE]', 'yellow', stdoutColor)
        : paint('[OK]', 'green', stdoutColor)
  console.log(`${status} Extraction ${summary.interrupted ? 'stopped' : 'completed'}.
  ${paint('Output:', 'cyan', stdoutColor)} ${summary.outputRoot}
  Archives: ${summary.archives.length}/${summary.totalArchives}, entries: ${entrySummary}
  MCB: ${totals.mcbEntries}, restored: ${paint(String(totals.restoredMcb), 'green', stdoutColor)}, failed: ${paint(String(totals.failedMcb), totals.failedMcb === 0 ? 'green' : 'red', stdoutColor)}
  JSON formatted: ${totals.formattedJson}, failed: ${paint(String(totals.failedJson), totals.failedJson === 0 ? 'green' : 'red', stdoutColor)}, copied: ${totals.copiedEntries}, skipped: ${totals.skippedEntries}
  Conflicts: ${summary.conflictsDetected}, kept existing: ${keptConflicts}, coexist/overwrite: ${writtenConflicts}`)

  if (summary.schemaRoot === undefined) {
    console.log(`  ${paint('Schema:', 'cyan', stdoutColor)} not specified`)
  } else {
    const version = summary.schemaExportVersion === undefined ? '' : ` (${summary.schemaExportVersion})`
    console.log(`  ${paint('Schema:', 'cyan', stdoutColor)} ${paint(`${summary.schemaRoot}${version}`, 'dim', stdoutColor)}`)
  }
  if (hasIssues) {
    console.log(`  ${paint('Issues:', 'yellow', stdoutColor)} ${summary.failures.length + summary.archiveErrors}; use --list for details`)
  }
}

function printArchiveResult(report: ArchiveReport): void {
  const completionStatus = archiveCompletionStatus(report)
  const status =
    completionStatus === 'failed'
      ? paint('[FAILED]', 'red', stdoutColor)
      : completionStatus === 'incomplete'
        ? paint('[INCOMPLETE]', 'yellow', stdoutColor)
        : paint('[OK]', 'green', stdoutColor)
  console.log(
    `\n${status} ${report.archive}\n  ${paint('Output:', 'cyan', stdoutColor)} ${report.output}\n  Entries: ${report.processedEntries}/${report.selectedEntries} selected (${report.entries} total), MCB: ${report.mcbEntries}, restored: ${report.restoredMcb}, failed: ${report.failedMcb}\n  JSON formatted: ${report.formattedJson}, failed: ${report.failedJson}, copied: ${report.copiedEntries}, skipped: ${report.skippedEntries}, conflict-kept: ${report.conflictSkippedEntries}`,
  )
  if (report.reportPath !== undefined) {
    console.log(`  ${paint('Report:', 'cyan', stdoutColor)} ${report.reportPath}`)
  }
  if (report.archiveError !== undefined) {
    console.log(`  ${paint(report.archiveError, 'red', stdoutColor)}`)
  }
}

function printArchiveFailures(summary: RunSummary): void {
  const failedArchives = summary.archives.filter(report => report.archiveError !== undefined)
  if (failedArchives.length === 0) {
    return
  }
  console.log(`\n${paint('Archive failures:', 'red', stdoutColor)}`)
  for (const report of failedArchives) {
    console.log(`  ${paint('[FAILED]', 'red', stdoutColor)} ${report.archive}\n    ${paint(report.archiveError!, 'yellow', stdoutColor)}`)
  }
}

function printEntryFailures(summary: RunSummary): void {
  if (summary.failures.length === 0) {
    return
  }
  console.log(`\n${paint('Entry failures:', 'red', stdoutColor)}`)
  for (const failure of summary.failures) {
    const offset = failure.offset === undefined ? '' : `, offset 0x${failure.offset.toString(16)}`
    const schemaPath = failure.schemaPath === undefined ? '' : `, schema ${failure.schemaPath}`
    console.log(
      `  ${paint(`[${failure.kind}]`, 'red', stdoutColor)} ${failure.archive} :: ${failure.entry}${offset}${schemaPath}\n    ${paint(failure.reason, 'yellow', stdoutColor)}`,
    )
  }
}

function printFailureList(summary: RunSummary): void {
  printArchiveFailures(summary)
  printEntryFailures(summary)
}

function printFullResultList(summary: RunSummary): void {
  if (summary.sourceFiles.files > 0) {
    console.log(`\n${paint('Source files:', 'bold', stdoutColor)}
  Processed: ${summary.sourceFiles.processedFiles}/${summary.sourceFiles.selectedFiles} selected (${summary.sourceFiles.files} total)
  MCB: ${summary.sourceFiles.mcbFiles}, restored: ${summary.sourceFiles.restoredMcb}, failed: ${summary.sourceFiles.failedMcb}
  JSON formatted: ${summary.sourceFiles.formattedJson}, failed: ${summary.sourceFiles.failedJson}, copied: ${summary.sourceFiles.copiedFiles}, skipped: ${summary.sourceFiles.skippedFiles}, conflict-kept: ${summary.sourceFiles.conflictSkippedFiles}`)
  }
  console.log(`\n${paint('Archive results:', 'bold', stdoutColor)}`)
  for (const report of summary.archives) {
    printArchiveResult(report)
  }
  printEntryFailures(summary)

  if (summary.conflictsResolved.length > 0) {
    console.log(`\n${paint('Conflict decisions:', 'yellow', stdoutColor)}`)
    for (const conflict of summary.conflictsResolved) {
      const output = conflict.outputDestination === undefined ? '' : ` -> ${conflict.outputDestination}`
      console.log(
        `  [${conflict.conflictIndex}/${conflict.totalConflicts}] ${conflict.action}: ${conflict.destination}${output}\n    Existing: ${conflict.existingSource}\n    Incoming: ${conflict.incomingSource}`,
      )
    }
  }
}

async function promptForConflict(details: ConflictDetails): Promise<ConflictDecision> {
  if (process.stdin.isTTY !== true) {
    throw new ToolError(
      'conflict',
      `Output conflict requires an interactive terminal: ${details.destination} (${details.totalConflicts} conflicts detected)`,
    )
  }

  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    console.error(`\n${paint(`Output conflict ${details.conflictIndex}/${details.totalConflicts} (${details.totalConflicts} conflicts total)`, 'yellow', stderrColor)}
  ${paint('Destination:', 'cyan', stderrColor)} ${details.destination}
  ${paint('Existing:', 'cyan', stderrColor)} ${details.existingSource}
  ${paint('Incoming:', 'cyan', stderrColor)} ${details.incomingSource}

  o  overwrite       O  overwrite all remaining
  k  keep existing   K  keep all remaining
  c  coexist         C  coexist for all remaining`)

    for (;;) {
      const answer = (await terminal.question('Choose [o/k/c/O/K/C] and press Enter: ')).trim()
      const normalized = answer.toLocaleLowerCase('en-US')
      const action = normalized === 'o' ? 'overwrite' : normalized === 'k' ? 'keep' : normalized === 'c' ? 'coexist' : undefined
      if (action !== undefined && answer.length === 1) {
        return { action, applyToAll: answer === answer.toLocaleUpperCase('en-US') }
      }
      console.error(paint('Invalid choice. Enter one letter: o, k, c, O, K, or C.', 'red', stderrColor))
    }
  } finally {
    terminal.close()
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  if (options === undefined) {
    return
  }

  const { verbose, listResults, listAllResults, ...runOptions } = options
  let progress = verbose ? createProgressReporter() : undefined
  let lastProgress: ProgressInfo | undefined
  runOptions.onProgress = event => {
    lastProgress = event
    progress?.update(event)
  }
  runOptions.resolveConflict = async details => {
    progress?.stop()
    progress = undefined
    const decision = await promptForConflict(details)
    progress = verbose ? createProgressReporter() : undefined
    if (lastProgress !== undefined) {
      progress?.update(lastProgress)
    }
    return decision
  }

  let summary: RunSummary
  try {
    summary = await run(runOptions)
  } finally {
    progress?.stop()
  }

  printSummary(summary)
  if (listAllResults === true) {
    printFullResultList(summary)
  } else if (listResults === true) {
    printFailureList(summary)
  }

  const completionStatus = summaryCompletionStatus(summary)
  if (completionStatus === 'failed') {
    process.exitCode = 1
  } else if (completionStatus === 'incomplete') {
    process.exitCode = 2
  }
}

main().catch(error => {
  const failure = toToolError(error, 'invalid-option')
  console.error(`${paint(`[${failure.kind}]`, 'red', stderrColor)} ${failure.message}`)
  process.exitCode = 1
})
