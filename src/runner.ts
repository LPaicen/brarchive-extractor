import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isMcb, parseBrarchive, type Brarchive, type BrarchiveEntry } from './brarchive.js'
import { ToolError, toToolError, type FailureKind } from './errors.js'
import { McbDecoder } from './mcb-decoder.js'
import { SchemaRegistry } from './schema-registry.js'

export type JsonFormat = 'pretty' | 'compact'
export type IndentCharacter = 'space' | 'tab'
export type ConflictAction = 'overwrite' | 'keep' | 'coexist'

export interface ConflictDetails {
  destination: string
  existingSource: string
  incomingSource: string
  conflictIndex: number
  totalConflicts: number
}

export interface ConflictDecision {
  action: ConflictAction
  applyToAll?: boolean
}

export interface ConflictResolution extends ConflictDetails {
  action: ConflictAction
  outputDestination?: string
}

export interface RunOptions {
  inputPath: string
  directoryMode?: boolean
  recursive?: boolean
  outputPath?: string
  schemaPath?: string
  overwrite?: boolean
  force?: boolean
  report?: boolean
  jsonFormat?: JsonFormat
  formatAllJson?: boolean
  indentSize?: number
  indentCharacter?: IndentCharacter
  failFast?: boolean
  preserveFailed?: boolean
  mcbOnly?: boolean
  splitArchives?: boolean
  inPlace?: boolean
  resolveConflict?: (details: ConflictDetails) => Promise<ConflictDecision>
  onProgress?: (progress: ProgressInfo) => void
}

export interface ProgressInfo {
  phase: 'copy-start' | 'copy-file' | 'copy-complete' | 'archive-start' | 'entry' | 'archive-complete'
  archive: string
  archiveIndex: number
  archiveCount: number
  entry?: string
  entryIndex?: number
  entryCount?: number
  overallIndex?: number
  overallCount?: number
  failed?: boolean
  interrupted?: boolean
}

export interface RestoreFailure {
  archive: string
  entry: string
  kind: FailureKind
  reason: string
  offset?: number
  schemaPath?: string
}

export interface ArchiveReport {
  archive: string
  archiveVersion?: number
  output: string
  entries: number
  selectedEntries: number
  processedEntries: number
  mcbEntries: number
  restoredMcb: number
  failedMcb: number
  jsonEntries: number
  formattedJson: number
  failedJson: number
  copiedEntries: number
  skippedEntries: number
  conflictSkippedEntries: number
  failures: RestoreFailure[]
  reportPath?: string
  interrupted?: boolean
  archiveError?: string
}

export interface SourceFileReport {
  files: number
  selectedFiles: number
  processedFiles: number
  mcbFiles: number
  restoredMcb: number
  failedMcb: number
  jsonFiles: number
  formattedJson: number
  failedJson: number
  copiedFiles: number
  skippedFiles: number
  conflictSkippedFiles: number
  failures: RestoreFailure[]
  interrupted: boolean
}

export interface RunSummary {
  schemaRoot?: string
  schemaExportVersion?: string
  archives: ArchiveReport[]
  sourceFiles: SourceFileReport
  failures: RestoreFailure[]
  archiveErrors: number
  interrupted: boolean
  outputRoot: string
  totalArchives: number
  conflictsDetected: number
  conflictsResolved: ConflictResolution[]
}

interface JsonOutputSettings {
  format: JsonFormat
  formatAllJson: boolean
  indentation: string
}

interface PlannedArchive {
  archivePath: string
  outputPath: string
  reportDestination: string
  archive?: Brarchive
  error?: ToolError
  selectedEntries: BrarchiveEntry[]
}

interface PlannedSourceFile {
  sourcePath: string
  relativePath: string
  destination: string
  payload: Buffer
  mcb: boolean
}

interface PlannedWrite {
  destination: string
  source: string
  replacesExisting?: boolean
}

interface OutputClaim {
  destination: string
  source: string
}

function jsonOutputSettings(options: RunOptions): JsonOutputSettings {
  const format = options.jsonFormat ?? 'pretty'
  if (format !== 'pretty' && format !== 'compact') {
    throw new ToolError('invalid-option', `Unsupported JSON format: ${String(format)}`)
  }

  const indentSize = options.indentSize ?? 2
  if (!Number.isInteger(indentSize) || indentSize < 0 || indentSize > 10) {
    throw new ToolError('invalid-option', `JSON indent size must be an integer from 0 to 10: ${String(indentSize)}`)
  }

  const indentCharacter = options.indentCharacter ?? 'space'
  if (indentCharacter !== 'space' && indentCharacter !== 'tab') {
    throw new ToolError('invalid-option', `JSON indent character must be space or tab: ${String(indentCharacter)}`)
  }

  const unit = indentCharacter === 'tab' ? '\t' : ' '
  return {
    format,
    formatAllJson: options.formatAllJson ?? false,
    indentation: unit.repeat(indentSize),
  }
}

function serializeJson(value: unknown, settings: JsonOutputSettings): string {
  if (settings.format === 'compact') {
    return JSON.stringify(value)
  }
  return `${JSON.stringify(value, null, settings.indentation)}\n`
}

async function collectFiles(directory: string, recursive: boolean): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isFile()) {
      result.push(fullPath)
    } else if (recursive && entry.isDirectory()) {
      result.push(...(await collectFiles(fullPath, true)))
    }
  }
  return result.sort((left, right) => left.localeCompare(right, 'en-US'))
}

async function prepareOutputDirectory(outputPath: string, allowNonEmpty: boolean, clearOutput: boolean): Promise<void> {
  try {
    const info = await stat(outputPath)
    if (!info.isDirectory()) {
      throw new ToolError('io-error', `Output path already exists and is not a directory: ${outputPath}`)
    }
    if (clearOutput) {
      await rm(outputPath, { recursive: true, force: true })
      await mkdir(outputPath, { recursive: true })
      return
    }
    if (!allowNonEmpty && (await readdir(outputPath)).length > 0) {
      throw new ToolError(
        'io-error',
        `Output directory is not empty: ${outputPath}; use --overwrite to preserve it or --force to clear it`,
      )
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
    if (code !== 'ENOENT') {
      throw error
    }
    await mkdir(outputPath, { recursive: true })
  }
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateForceOutputRoot(inputPath: string, outputRoot: string): void {
  const resolvedOutput = path.resolve(outputRoot)
  if (resolvedOutput === path.parse(resolvedOutput).root) {
    throw new ToolError('invalid-option', `--force refuses to clear a filesystem root: ${resolvedOutput}`)
  }
  if (pathContains(resolvedOutput, inputPath)) {
    throw new ToolError('invalid-option', `--force output root must not contain the input path: ${resolvedOutput}`)
  }
  if (pathContains(resolvedOutput, process.cwd())) {
    throw new ToolError('invalid-option', `--force output root must not contain the current working directory: ${resolvedOutput}`)
  }
}

function destinationForEntry(outputPath: string, entry: BrarchiveEntry): string {
  const destination = path.resolve(outputPath, ...entry.name.split('/'))
  const relative = path.relative(outputPath, destination)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolError('invalid-archive', `Archive entry escapes the output directory: ${entry.name}`)
  }
  return destination
}

function outputRootPath(
  inputPath: string,
  directoryMode: boolean,
  explicitOutput: string | undefined,
  inPlace: boolean,
): string {
  if (explicitOutput !== undefined) {
    return path.resolve(explicitOutput)
  }
  if (inPlace) {
    if (directoryMode) {
      return inputPath
    }
    return path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)))
  }
  if (directoryMode) {
    return path.join(path.dirname(inputPath), `${path.basename(inputPath)}_unpacked`)
  }
  const baseName = `${path.basename(inputPath, path.extname(inputPath))}_unpacked`
  return path.join(path.dirname(inputPath), baseName)
}

function archiveOutputPath(
  archivePath: string,
  inputRoot: string | undefined,
  outputRoot: string,
  splitArchives: boolean,
): string {
  if (inputRoot === undefined) {
    return outputRoot
  }
  const relativeArchive = path.relative(inputRoot, archivePath)
  if (splitArchives) {
    return path.resolve(outputRoot, relativeArchive)
  }
  const extension = path.extname(relativeArchive)
  const relativeOutput = extension === '' ? relativeArchive : relativeArchive.slice(0, -extension.length)
  return path.resolve(outputRoot, relativeOutput)
}

function archiveEntrySource(archivePath: string, entry: BrarchiveEntry): string {
  return `${archivePath} :: ${entry.name}`
}

function sourceFileSource(sourcePath: string): string {
  return `Source file: ${sourcePath}`
}

function reportSource(archivePath: string): string {
  return `Report for ${archivePath}`
}

function destinationKey(destination: string): string {
  const resolved = path.resolve(destination)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

async function pathType(value: string): Promise<'file' | 'directory' | undefined> {
  try {
    const info = await stat(value)
    return info.isDirectory() ? 'directory' : 'file'
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

class ConflictManager {
  readonly totalConflicts: number
  readonly resolutions: ConflictResolution[] = []
  readonly #resolver: RunOptions['resolveConflict']
  readonly #claims = new Map<string, OutputClaim>()
  readonly #reserved = new Set<string>()
  #applyToAll?: ConflictAction
  #encountered = 0

  private constructor(totalConflicts: number, resolver: RunOptions['resolveConflict']) {
    this.totalConflicts = totalConflicts
    this.#resolver = resolver
  }

  static async create(
    writes: PlannedWrite[],
    resolver: RunOptions['resolveConflict'],
    overwriteExistingFiles: boolean,
  ): Promise<ConflictManager> {
    const grouped = new Map<string, PlannedWrite[]>()
    for (const write of writes) {
      const key = destinationKey(write.destination)
      const values = grouped.get(key) ?? []
      values.push(write)
      grouped.set(key, values)
    }

    const destinations = new Map<string, string>()
    for (const write of writes) {
      destinations.set(destinationKey(write.destination), path.resolve(write.destination))
    }
    const existingPathTypes = new Map<string, 'file' | 'directory' | undefined>()
    const existingPathType = async (value: string): Promise<'file' | 'directory' | undefined> => {
      const key = destinationKey(value)
      if (!existingPathTypes.has(key)) {
        existingPathTypes.set(key, await pathType(value))
      }
      return existingPathTypes.get(key)
    }
    for (const destination of destinations.values()) {
      let parent = path.dirname(destination)
      while (parent !== path.dirname(parent)) {
        if (destinations.has(destinationKey(parent))) {
          throw new ToolError('conflict', `Output path is both a file and a directory: ${parent}`)
        }
        if ((await existingPathType(parent)) === 'file') {
          throw new ToolError(
            'conflict',
            `Output directory path conflicts with an existing file: ${parent} (required by ${destination})`,
          )
        }
        parent = path.dirname(parent)
      }
    }

    let totalConflicts = 0
    const existingClaims: OutputClaim[] = []
    for (const values of grouped.values()) {
      const destination = values[0]!.destination
      const existingType = await existingPathType(destination)
      if (existingType === 'directory') {
        throw new ToolError('conflict', `Output file conflicts with an existing directory: ${destination}`)
      }
      const replacesExisting = values.some(value => value.replacesExisting === true)
      const existingCount = existingType === 'file' && !replacesExisting && !overwriteExistingFiles ? 1 : 0
      totalConflicts += Math.max(0, values.length + existingCount - 1)
      if (existingType === 'file' && !replacesExisting && !overwriteExistingFiles) {
        existingClaims.push({ destination, source: `Existing output file: ${destination}` })
      }
    }

    const manager = new ConflictManager(totalConflicts, resolver)
    for (const write of writes) {
      manager.#reserved.add(destinationKey(write.destination))
    }
    for (const claim of existingClaims) {
      manager.#claims.set(destinationKey(claim.destination), claim)
    }
    return manager
  }

  async resolve(destination: string, incomingSource: string): Promise<string | undefined> {
    const key = destinationKey(destination)
    const existing = this.#claims.get(key)
    if (existing === undefined) {
      this.#claims.set(key, { destination, source: incomingSource })
      return destination
    }

    this.#encountered += 1
    const details: ConflictDetails = {
      destination,
      existingSource: existing.source,
      incomingSource,
      conflictIndex: this.#encountered,
      totalConflicts: this.totalConflicts,
    }
    let decision: ConflictDecision
    if (this.#applyToAll !== undefined) {
      decision = { action: this.#applyToAll, applyToAll: true }
    } else {
      if (this.#resolver === undefined) {
        throw new ToolError(
          'conflict',
          `Output conflict requires an interactive decision: ${destination} (${this.totalConflicts} conflicts detected)`,
        )
      }
      decision = await this.#resolver(details)
      if (!['overwrite', 'keep', 'coexist'].includes(decision.action)) {
        throw new ToolError('conflict', `Conflict resolver returned an invalid action: ${String(decision.action)}`)
      }
      if (decision.applyToAll === true) {
        this.#applyToAll = decision.action
      }
    }

    let outputDestination: string | undefined
    if (decision.action === 'overwrite') {
      this.#claims.set(key, { destination, source: incomingSource })
      outputDestination = destination
    } else if (decision.action === 'coexist') {
      outputDestination = await this.#coexistDestination(destination)
      this.#claims.set(destinationKey(outputDestination), { destination: outputDestination, source: incomingSource })
    }

    this.resolutions.push({ ...details, action: decision.action, outputDestination })
    return outputDestination
  }

  async #coexistDestination(destination: string): Promise<string> {
    const extension = path.extname(destination)
    const base = extension === '' ? destination : destination.slice(0, -extension.length)
    for (let index = 1; ; index += 1) {
      const candidate = `${base} (${index})${extension}`
      const key = destinationKey(candidate)
      if (!this.#reserved.has(key) && (await pathType(candidate)) === undefined) {
        this.#reserved.add(key)
        return candidate
      }
    }
  }
}

function recordFailure(
  failures: RestoreFailure[],
  archive: string,
  entry: string,
  failure: ToolError,
): void {
  failures.push({
    archive,
    entry,
    kind: failure.kind,
    reason: failure.message,
    offset: failure.offset,
    schemaPath: failure.schemaPath,
  })
}

async function planArchives(
  archivePaths: string[],
  inputRoot: string | undefined,
  outputRoot: string,
  splitArchives: boolean,
  mcbOnly: boolean,
): Promise<PlannedArchive[]> {
  const result: PlannedArchive[] = []
  for (const archivePath of archivePaths) {
    const outputPath = archiveOutputPath(archivePath, inputRoot, outputRoot, splitArchives)
    try {
      const archive = parseBrarchive(await readFile(archivePath))
      result.push({
        archivePath,
        outputPath,
        reportDestination: path.join(outputPath, '.brarchive-report.json'),
        archive,
        selectedEntries: mcbOnly ? archive.entries.filter(entry => isMcb(entry.payload)) : archive.entries,
      })
    } catch (error) {
      result.push({
        archivePath,
        outputPath,
        reportDestination: path.join(outputPath, '.brarchive-report.json'),
        error: toToolError(error, 'invalid-archive'),
        selectedEntries: [],
      })
    }
  }
  return result
}

async function planSourceFiles(
  inputRoot: string,
  outputRoot: string,
  files: string[],
  mcbOnly: boolean,
): Promise<PlannedSourceFile[]> {
  const result: PlannedSourceFile[] = []
  for (const sourcePath of files) {
    const relativePath = path.relative(inputRoot, sourcePath)
    const payload = await readFile(sourcePath)
    const mcb = isMcb(payload)
    if (mcbOnly && !mcb) {
      continue
    }
    result.push({ sourcePath, relativePath, destination: path.resolve(outputRoot, relativePath), payload, mcb })
  }
  return result
}

function plannedWrites(
  sourceFiles: PlannedSourceFile[],
  archives: PlannedArchive[],
  writeReports: boolean,
): PlannedWrite[] {
  const result: PlannedWrite[] = sourceFiles.map(file => ({
    destination: file.destination,
    source: sourceFileSource(file.sourcePath),
    replacesExisting: destinationKey(file.destination) === destinationKey(file.sourcePath),
  }))
  for (const archive of archives) {
    for (const entry of archive.selectedEntries) {
      result.push({
        destination: destinationForEntry(archive.outputPath, entry),
        source: archiveEntrySource(archive.archivePath, entry),
      })
    }
    if (writeReports && archive.archive !== undefined) {
      result.push({ destination: archive.reportDestination, source: reportSource(archive.archivePath) })
    }
  }
  return result
}

async function processSourceFiles(
  plans: PlannedSourceFile[],
  totalInputFiles: number,
  inputRoot: string,
  decoder: McbDecoder | undefined,
  settings: JsonOutputSettings,
  failFast: boolean,
  preserveFailed: boolean,
  conflicts: ConflictManager,
  onProgress: RunOptions['onProgress'],
): Promise<SourceFileReport> {
  const report: SourceFileReport = {
    files: totalInputFiles,
    selectedFiles: plans.length,
    processedFiles: 0,
    mcbFiles: 0,
    restoredMcb: 0,
    failedMcb: 0,
    jsonFiles: 0,
    formattedJson: 0,
    failedJson: 0,
    copiedFiles: 0,
    skippedFiles: totalInputFiles - plans.length,
    conflictSkippedFiles: 0,
    failures: [],
    interrupted: false,
  }
  if (plans.length === 0) {
    return report
  }

  onProgress?.({
    phase: 'copy-start',
    archive: inputRoot,
    archiveIndex: 0,
    archiveCount: 0,
    entryIndex: 0,
    entryCount: plans.length,
  })
  for (const [index, plan] of plans.entries()) {
    report.processedFiles += 1
    onProgress?.({
      phase: 'copy-file',
      archive: inputRoot,
      archiveIndex: 0,
      archiveCount: 0,
      entry: plan.relativePath.replaceAll('\\', '/'),
      entryIndex: index + 1,
      entryCount: plans.length,
    })

    let output: Buffer | string | undefined
    let rawCopy = false
    let failed = false
    if (plan.mcb) {
      report.mcbFiles += 1
      if (decoder === undefined) {
        output = plan.payload
        rawCopy = true
      } else {
        try {
          output = serializeJson(decoder.decode(plan.payload).value, settings)
          report.restoredMcb += 1
        } catch (error) {
          const failure = toToolError(error)
          report.failedMcb += 1
          failed = true
          recordFailure(report.failures, inputRoot, plan.relativePath, failure)
          if (preserveFailed || failFast) {
            output = plan.payload
            rawCopy = true
          }
        }
      }
    } else if (settings.formatAllJson && plan.relativePath.toLocaleLowerCase('en-US').endsWith('.json')) {
      report.jsonFiles += 1
      try {
        output = serializeJson(JSON.parse(plan.payload.toString('utf8')) as unknown, settings)
        report.formattedJson += 1
      } catch (error) {
        const cause = toToolError(error)
        const failure = new ToolError('decode-error', `Unable to parse JSON file ${plan.relativePath}: ${cause.message}`, {
          cause,
        })
        report.failedJson += 1
        failed = true
        recordFailure(report.failures, inputRoot, plan.relativePath, failure)
        if (preserveFailed || failFast) {
          output = plan.payload
          rawCopy = true
        }
      }
    } else {
      output = plan.payload
      rawCopy = true
    }

    if (output !== undefined) {
      const destination = await conflicts.resolve(plan.destination, sourceFileSource(plan.sourcePath))
      if (destination === undefined) {
        report.conflictSkippedFiles += 1
      } else {
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, output)
        if (rawCopy) {
          report.copiedFiles += 1
        }
      }
    }

    if (failed && failFast) {
      report.interrupted = true
      break
    }
  }
  onProgress?.({
    phase: 'copy-complete',
    archive: inputRoot,
    archiveIndex: 0,
    archiveCount: 0,
    entryIndex: report.processedFiles,
    entryCount: plans.length,
    failed: report.failures.length > 0,
    interrupted: report.interrupted,
  })
  return report
}

async function unpackOne(
  plan: PlannedArchive,
  decoder: McbDecoder | undefined,
  writeReport: boolean,
  settings: JsonOutputSettings,
  failFast: boolean,
  preserveFailed: boolean,
  conflicts: ConflictManager,
  progress: Omit<ProgressInfo, 'phase' | 'entry' | 'entryIndex' | 'entryCount' | 'failed' | 'interrupted'>,
  onProgress: RunOptions['onProgress'],
): Promise<ArchiveReport> {
  const report: ArchiveReport = {
    archive: plan.archivePath,
    output: plan.outputPath,
    entries: plan.archive?.entries.length ?? 0,
    selectedEntries: plan.selectedEntries.length,
    processedEntries: 0,
    mcbEntries: 0,
    restoredMcb: 0,
    failedMcb: 0,
    jsonEntries: 0,
    formattedJson: 0,
    failedJson: 0,
    copiedEntries: 0,
    skippedEntries: (plan.archive?.entries.length ?? 0) - plan.selectedEntries.length,
    conflictSkippedEntries: 0,
    failures: [],
  }
  if (plan.error !== undefined) {
    report.archiveError = `[${plan.error.kind}] ${plan.error.message}`
    report.interrupted = failFast || undefined
    return report
  }

  report.archiveVersion = plan.archive!.version
  await mkdir(plan.outputPath, { recursive: true })
  for (const [entryOffset, entry] of plan.selectedEntries.entries()) {
    report.processedEntries += 1
    onProgress?.({
      ...progress,
      phase: 'entry',
      entry: entry.name,
      entryIndex: entryOffset + 1,
      entryCount: plan.selectedEntries.length,
    })

    let output: Buffer | string | undefined
    let rawCopy = false
    let failed = false
    if (!isMcb(entry.payload)) {
      if (settings.formatAllJson && entry.name.toLocaleLowerCase('en-US').endsWith('.json')) {
        report.jsonEntries += 1
        try {
          output = serializeJson(JSON.parse(entry.payload.toString('utf8')) as unknown, settings)
          report.formattedJson += 1
        } catch (error) {
          const cause = toToolError(error)
          const failure = new ToolError('decode-error', `Unable to parse JSON entry ${entry.name}: ${cause.message}`, {
            cause,
          })
          report.failedJson += 1
          failed = true
          recordFailure(report.failures, plan.archivePath, entry.name, failure)
          if (preserveFailed || failFast) {
            output = entry.payload
            rawCopy = true
          }
        }
      } else {
        output = entry.payload
        rawCopy = true
      }
    } else {
      report.mcbEntries += 1
      if (decoder === undefined) {
        output = entry.payload
        rawCopy = true
      } else {
        try {
          output = serializeJson(decoder.decode(entry.payload).value, settings)
          report.restoredMcb += 1
        } catch (error) {
          const failure = toToolError(error)
          report.failedMcb += 1
          failed = true
          recordFailure(report.failures, plan.archivePath, entry.name, failure)
          if (preserveFailed || failFast) {
            output = entry.payload
            rawCopy = true
          }
        }
      }
    }

    const originalDestination = destinationForEntry(plan.outputPath, entry)
    if (output !== undefined) {
      const destination = await conflicts.resolve(
        originalDestination,
        archiveEntrySource(plan.archivePath, entry),
      )
      if (destination === undefined) {
        report.conflictSkippedEntries += 1
      } else {
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, output)
        if (rawCopy) {
          report.copiedEntries += 1
        }
      }
    }

    if (failed && failFast) {
      report.interrupted = true
      break
    }
  }

  if (writeReport) {
    const reportDestination = await conflicts.resolve(plan.reportDestination, reportSource(plan.archivePath))
    if (reportDestination !== undefined) {
      report.reportPath = reportDestination
      await mkdir(path.dirname(reportDestination), { recursive: true })
      await writeFile(reportDestination, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
  }
  return report
}

function emptySourceFileReport(files: number, skippedFiles: number): SourceFileReport {
  return {
    files,
    selectedFiles: 0,
    processedFiles: 0,
    mcbFiles: 0,
    restoredMcb: 0,
    failedMcb: 0,
    jsonFiles: 0,
    formattedJson: 0,
    failedJson: 0,
    copiedFiles: 0,
    skippedFiles,
    conflictSkippedFiles: 0,
    failures: [],
    interrupted: false,
  }
}

function createOverallProgressEmitter(
  sourceFileCount: number,
  archives: PlannedArchive[],
  onProgress: RunOptions['onProgress'],
): RunOptions['onProgress'] {
  if (onProgress === undefined) {
    return undefined
  }

  const archiveStarts: number[] = []
  let overallCount = sourceFileCount
  for (const archive of archives) {
    archiveStarts.push(overallCount)
    overallCount += archive.selectedEntries.length + 1
  }

  return progress => {
    let overallIndex: number
    if (progress.phase.startsWith('copy-')) {
      overallIndex =
        progress.phase === 'copy-file'
          ? Math.max(0, (progress.entryIndex ?? 1) - 1)
          : progress.phase === 'copy-complete'
            ? Math.min(sourceFileCount, progress.entryIndex ?? 0)
            : 0
    } else {
      const archiveStart = archiveStarts[progress.archiveIndex - 1] ?? sourceFileCount
      overallIndex =
        progress.phase === 'entry'
          ? archiveStart + Math.max(0, (progress.entryIndex ?? 1) - 1)
          : progress.phase === 'archive-complete'
            ? archiveStart + (progress.entryIndex ?? 0) + 1
            : archiveStart
    }
    onProgress({
      ...progress,
      overallIndex: Math.min(overallCount, overallIndex),
      overallCount,
    })
  }
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const settings = jsonOutputSettings(options)
  const inputPath = path.resolve(options.inputPath)
  const inPlace = options.inPlace ?? false
  const overwrite = options.overwrite ?? false
  const force = options.force ?? false
  if (overwrite && force) {
    throw new ToolError('invalid-option', '--overwrite cannot be combined with --force')
  }
  if (inPlace && force) {
    throw new ToolError('invalid-option', '--in-place cannot be combined with --force')
  }
  if (inPlace && options.outputPath !== undefined) {
    throw new ToolError('invalid-option', '--in-place cannot be combined with --output')
  }
  if (inPlace && options.splitArchives === true) {
    throw new ToolError('invalid-option', '--in-place cannot be combined with --split-archives')
  }
  let inputInfo
  try {
    inputInfo = await stat(inputPath)
  } catch (error) {
    throw new ToolError('io-error', `Input path does not exist: ${inputPath}`, { cause: error })
  }

  const directoryMode = options.directoryMode === true || inputInfo.isDirectory()
  if (directoryMode && !inputInfo.isDirectory()) {
    throw new ToolError('io-error', `--directory requires a directory input path: ${inputPath}`)
  }
  if (!directoryMode && !inputInfo.isFile()) {
    throw new ToolError('io-error', `Input path is not a file: ${inputPath}`)
  }

  const outputRoot = outputRootPath(
    inputPath,
    directoryMode,
    options.outputPath === undefined ? undefined : path.resolve(options.outputPath),
    inPlace,
  )
  if (force) {
    validateForceOutputRoot(inputPath, outputRoot)
  }
  if (directoryMode && !inPlace) {
    const relativeOutput = path.relative(inputPath, outputRoot)
    if (relativeOutput === '' || (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput))) {
      throw new ToolError('invalid-option', `Output root must not be inside the input directory: ${outputRoot}`)
    }
  }

  const allInputFiles = directoryMode ? await collectFiles(inputPath, options.recursive ?? true) : [inputPath]
  const archivePaths = directoryMode
    ? allInputFiles.filter(file => file.toLocaleLowerCase('en-US').endsWith('.brarchive'))
    : [inputPath]
  if (archivePaths.length === 0) {
    throw new ToolError('io-error', `No .brarchive files were found in directory: ${inputPath}`)
  }
  const loosePaths = directoryMode
    ? allInputFiles.filter(file => !file.toLocaleLowerCase('en-US').endsWith('.brarchive'))
    : []

  const registry = options.schemaPath === undefined ? undefined : await SchemaRegistry.load(options.schemaPath)
  const decoder = registry === undefined ? undefined : new McbDecoder(registry)
  const archives = await planArchives(
    archivePaths,
    directoryMode ? inputPath : undefined,
    outputRoot,
    options.splitArchives ?? false,
    options.mcbOnly ?? false,
  )
  const sourceFiles = await planSourceFiles(
    inputPath,
    outputRoot,
    loosePaths,
    options.mcbOnly ?? false,
  )
  const onProgress = createOverallProgressEmitter(sourceFiles.length, archives, options.onProgress)

  await prepareOutputDirectory(outputRoot, inPlace || overwrite, force)
  const conflicts = await ConflictManager.create(
    plannedWrites(sourceFiles, archives, options.report ?? false),
    options.resolveConflict,
    overwrite || force,
  )

  let sourceFileReport = emptySourceFileReport(loosePaths.length, loosePaths.length)
  let interrupted = false
  if (sourceFiles.length > 0) {
    sourceFileReport = await processSourceFiles(
      sourceFiles,
      loosePaths.length,
      inputPath,
      decoder,
      settings,
      options.failFast ?? false,
      options.preserveFailed ?? true,
      conflicts,
      onProgress,
    )
    interrupted = sourceFileReport.interrupted
  }

  const reports: ArchiveReport[] = []
  if (!interrupted) {
    for (const [archiveOffset, archive] of archives.entries()) {
      const progress = {
        archive: archive.archivePath,
        archiveIndex: archiveOffset + 1,
        archiveCount: archives.length,
      }
      onProgress?.({ ...progress, phase: 'archive-start' })
      const report = await unpackOne(
        archive,
        decoder,
        options.report ?? false,
        settings,
        options.failFast ?? false,
        options.preserveFailed ?? true,
        conflicts,
        progress,
        onProgress,
      )
      reports.push(report)
      const failed = report.archiveError !== undefined || report.failures.length > 0
      onProgress?.({
        ...progress,
        phase: 'archive-complete',
        entryIndex: report.processedEntries,
        entryCount: report.selectedEntries,
        failed,
        interrupted: report.interrupted,
      })
      if ((options.failFast ?? false) && failed) {
        interrupted = true
        break
      }
    }
  }

  const failures = [...sourceFileReport.failures, ...reports.flatMap(report => report.failures)]
  return {
    schemaRoot: registry?.rootPath,
    schemaExportVersion: registry?.exportVersion,
    archives: reports,
    sourceFiles: sourceFileReport,
    failures,
    archiveErrors: reports.filter(report => report.archiveError !== undefined).length,
    interrupted,
    outputRoot,
    totalArchives: archives.length,
    conflictsDetected: conflicts.totalConflicts,
    conflictsResolved: conflicts.resolutions,
  }
}
