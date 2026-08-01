import path from 'node:path'
import { ToolError } from './errors.js'

export const BRARCHIVE_MAGIC = Buffer.from([0x7d, 0x27, 0x25, 0xb1, 0xa0, 0x52, 0x70, 0x26])
const ENTRY_SIZE = 256
const ENTRY_NAME_CAPACITY = 247
const utf8 = new TextDecoder('utf-8', { fatal: true })

export interface BrarchiveEntry {
  index: number
  name: string
  recordOffset: number
  relativeOffset: number
  absoluteOffset: number
  length: number
  payload: Buffer
}

export interface Brarchive {
  version: number
  entries: BrarchiveEntry[]
}

function fail(message: string): never {
  throw new ToolError('invalid-archive', message)
}

export function isMcb(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x7f && buffer[1] === 0x4d && buffer[2] === 0x43 && buffer[3] === 0x42
}

export function validateEntryPath(name: string): string {
  if (name.length === 0 || name.includes('\0') || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
    fail(`Archive entry has an unsafe path: ${JSON.stringify(name)}`)
  }

  const normalized = path.posix.normalize(name.replaceAll('\\', '/'))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`Archive entry contains path traversal: ${JSON.stringify(name)}`)
  }
  return normalized
}

export function parseBrarchive(buffer: Buffer): Brarchive {
  if (buffer.length < 16) {
    fail('File is shorter than the 16-byte brarchive header')
  }
  if (!buffer.subarray(0, BRARCHIVE_MAGIC.length).equals(BRARCHIVE_MAGIC)) {
    fail(`Invalid brarchive magic: ${buffer.subarray(0, 8).toString('hex')}`)
  }

  const entryCount = buffer.readUInt32LE(8)
  const version = buffer.readUInt32LE(12)
  const dataBase = 16 + entryCount * ENTRY_SIZE
  if (!Number.isSafeInteger(dataBase) || dataBase > buffer.length) {
    fail(`Entry table extends beyond the file: entry count ${entryCount}`)
  }

  const entries: BrarchiveEntry[] = []
  const seen = new Set<string>()

  for (let index = 0; index < entryCount; index += 1) {
    const recordOffset = 16 + index * ENTRY_SIZE
    const nameLength = buffer[recordOffset]!
    if (nameLength > ENTRY_NAME_CAPACITY) {
      fail(`Entry ${index} name length ${nameLength} exceeds ${ENTRY_NAME_CAPACITY}`)
    }

    let decodedName: string
    try {
      decodedName = utf8.decode(buffer.subarray(recordOffset + 1, recordOffset + 1 + nameLength))
    } catch (error) {
      throw new ToolError('invalid-archive', `Entry ${index} name is not valid UTF-8`, { cause: error })
    }
    const name = validateEntryPath(decodedName)
    const key = name.toLocaleLowerCase('en-US')
    if (seen.has(key)) {
      fail(`Archive contains a duplicate entry: ${name}`)
    }
    seen.add(key)

    const relativeOffset = buffer.readUInt32LE(recordOffset + 248)
    const length = buffer.readUInt32LE(recordOffset + 252)
    const absoluteOffset = dataBase + relativeOffset
    const end = absoluteOffset + length
    if (!Number.isSafeInteger(end) || absoluteOffset < dataBase || end > buffer.length) {
      fail(`Entry ${name} points outside the archive data area (offset=${relativeOffset}, length=${length})`)
    }

    entries.push({
      index,
      name,
      recordOffset,
      relativeOffset,
      absoluteOffset,
      length,
      payload: buffer.subarray(absoluteOffset, end),
    })
  }

  return { version, entries }
}
