import type { FailureKind } from './errors.js'

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
  omitEmptyDirectories?: boolean
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
