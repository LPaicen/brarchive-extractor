import { ToolError } from './errors.js'

const utf8 = new TextDecoder('utf-8', { fatal: true })

export class BinaryReader {
  readonly buffer: Buffer
  offset = 0

  constructor(buffer: Buffer) {
    this.buffer = buffer
  }

  get remaining(): number {
    return this.buffer.length - this.offset
  }

  ensure(size: number, label: string): void {
    if (!Number.isInteger(size) || size < 0 || this.offset + size > this.buffer.length) {
      throw new ToolError(
        'decode-error',
        `Reading ${label} requires ${size} bytes, but only ${this.remaining} bytes remain after offset 0x${this.offset.toString(16)}`,
        { offset: this.offset },
      )
    }
  }

  readBytes(size: number, label = 'bytes'): Buffer {
    this.ensure(size, label)
    const result = this.buffer.subarray(this.offset, this.offset + size)
    this.offset += size
    return result
  }

  readUint8(label = 'uint8'): number {
    this.ensure(1, label)
    return this.buffer[this.offset++]!
  }

  readInt8(label = 'int8'): number {
    this.ensure(1, label)
    const result = this.buffer.readInt8(this.offset)
    this.offset += 1
    return result
  }

  readUint16(label = 'uint16'): number {
    this.ensure(2, label)
    const result = this.buffer.readUInt16LE(this.offset)
    this.offset += 2
    return result
  }

  readInt16(label = 'int16'): number {
    this.ensure(2, label)
    const result = this.buffer.readInt16LE(this.offset)
    this.offset += 2
    return result
  }

  readUint32(label = 'uint32'): number {
    this.ensure(4, label)
    const result = this.buffer.readUInt32LE(this.offset)
    this.offset += 4
    return result
  }

  readInt32(label = 'int32'): number {
    this.ensure(4, label)
    const result = this.buffer.readInt32LE(this.offset)
    this.offset += 4
    return result
  }

  readUint64(label = 'uint64'): number | string {
    this.ensure(8, label)
    const result = this.buffer.readBigUInt64LE(this.offset)
    this.offset += 8
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result.toString()
  }

  readInt64(label = 'int64'): number | string {
    this.ensure(8, label)
    const result = this.buffer.readBigInt64LE(this.offset)
    this.offset += 8
    return result >= BigInt(Number.MIN_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(result)
      : result.toString()
  }

  readFloat32(label = 'float'): number {
    this.ensure(4, label)
    const result = this.buffer.readFloatLE(this.offset)
    this.offset += 4
    if (!Number.isFinite(result)) {
      throw new ToolError('decode-error', `${label} is not a finite float32 value`, { offset: this.offset - 4 })
    }
    return Number(result.toPrecision(7))
  }

  readFloat64(label = 'double'): number {
    this.ensure(8, label)
    const result = this.buffer.readDoubleLE(this.offset)
    this.offset += 8
    if (!Number.isFinite(result)) {
      throw new ToolError('decode-error', `${label} is not a finite float64 value`, { offset: this.offset - 8 })
    }
    return result
  }

  readBool(label = 'boolean'): boolean {
    const offset = this.offset
    const value = this.readUint8(label)
    if (value !== 0 && value !== 1) {
      throw new ToolError('decode-error', `${label} has value ${value} at offset 0x${offset.toString(16)}; expected 0 or 1`, {
        offset,
      })
    }
    return value === 1
  }

  readVarUint32(label = 'VarUInt32'): number {
    const start = this.offset
    let result = 0

    for (let index = 0; index < 5; index += 1) {
      const byte = this.readUint8(label)
      if (index === 4 && (byte & 0xf0) !== 0) {
        throw new ToolError('decode-error', `${label} overflows uint32 at offset 0x${start.toString(16)}`, { offset: start })
      }
      result += (byte & 0x7f) * 2 ** (index * 7)
      if ((byte & 0x80) === 0) {
        return result >>> 0
      }
    }

    throw new ToolError('decode-error', `${label} exceeds 5 bytes at offset 0x${start.toString(16)}`, { offset: start })
  }

  readString(label = 'string'): string {
    const length = this.readVarUint32(`${label} length`)
    const start = this.offset
    const bytes = this.readBytes(length, label)
    try {
      return utf8.decode(bytes)
    } catch (error) {
      throw new ToolError('decode-error', `${label} is not valid UTF-8 at offset 0x${start.toString(16)}`, {
        offset: start,
        cause: error,
      })
    }
  }
}
