import { BinaryReader } from './binary-reader.js'
import { ToolError } from './errors.js'
import { type JsonSchema, type SchemaDocument, SchemaRegistry } from './schema-registry.js'

const MCB_MAGIC = 0x42434d7f
const MAX_CONTAINER_ITEMS = 1_000_000

// Some exported oneOf schemas describe JSON spellings while the binary stores one normalized representation.
const IMPLICIT_BINARY_VARIANTS = new Set(['particle_appearance_tinting color_data', 'particle_curve'])
const ARRAY_REPRESENTATION_UNIONS = new Set([
  'vectorevents',
  'color_expr',
  'particle_motion_collision_event_vector',
  'vec3',
])
const OBJECT_REPRESENTATION_UNIONS = new Set(['item descriptor', 'minecraft:icon v1.21.80', 'trade quantity'])
const BOOLEAN_REPRESENTATION_UNIONS = new Set(['minecraft:hand_equipped'])
const INTEGER_REPRESENTATION_UNIONS = new Set(['minecraft:max_stack_size'])
const FORMAT_VERSIONLESS_DOCUMENTS = new Set(['tiers'])

export interface McbHeader {
  major: number
  minor: number
  patch: number
  version: string
  documentType: string
}

export interface McbDecodeResult {
  header: McbHeader
  schemaId: string
  schemaVersion?: string
  value: Record<string, unknown>
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function schemaType(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') : schema.type
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function formatHash(value: number): string {
  return `0x${value.toString(16).padStart(8, '0').toUpperCase()}`
}

function mergeReference(target: JsonSchema, source: JsonSchema): JsonSchema {
  const { $ref: _sourceReference, ...sourceMetadata } = source
  return { ...target, ...sourceMetadata }
}

export class McbDecoder {
  readonly registry: SchemaRegistry
  #reader!: BinaryReader

  constructor(registry: SchemaRegistry) {
    this.registry = registry
  }

  decode(buffer: Buffer): McbDecodeResult {
    this.#reader = new BinaryReader(buffer)
    const magicOffset = this.#reader.offset
    const magic = this.#reader.readUint32('MCB magic')
    if (magic !== MCB_MAGIC) {
      throw new ToolError('invalid-mcb', `Invalid MCB magic: ${formatHash(magic)}`, { offset: magicOffset })
    }

    const major = this.#reader.readUint16('MCB major version')
    const minor = this.#reader.readUint16('MCB minor version')
    const patch = this.#reader.readUint32('MCB patch version')
    const version = `${major}.${minor}.${patch}`
    const documentType = this.#reader.readString('MCB document type')
    const root = this.registry.selectRoot(documentType, version)

    const decoded = this.#decodeNode(root.schema, root, `$.${documentType}`)
    if (this.#reader.remaining !== 0) {
      throw new ToolError(
        'trailing-data',
        `Root object left ${this.#reader.remaining} trailing bytes (read 0x${this.#reader.offset.toString(16)} / 0x${buffer.length.toString(16)})`,
        { offset: this.#reader.offset, schemaPath: `$.${documentType}` },
      )
    }

    const formatVersion = root.version ?? version
    const value: Record<string, unknown> = FORMAT_VERSIONLESS_DOCUMENTS.has(documentType.toLocaleLowerCase('en-US'))
      ? { [documentType]: decoded }
      : { format_version: formatVersion, [documentType]: decoded }
    return {
      header: { major, minor, patch, version, documentType },
      schemaId: root.id,
      schemaVersion: root.version,
      value,
    }
  }

  #withContext<T>(schemaPath: string, action: () => T): T {
    const start = this.#reader.offset
    try {
      return action()
    } catch (error) {
      if (error instanceof ToolError && error.schemaPath === undefined) {
        throw new ToolError(error.kind, error.message, {
          offset: error.offset ?? start,
          schemaPath,
          cause: error,
        })
      }
      throw error
    }
  }

  #decodeNode(schema: JsonSchema, document: SchemaDocument, schemaPath: string): unknown {
    return this.#withContext(schemaPath, () => {
      if (typeof schema.$ref === 'string') {
        const resolved = this.registry.resolve(schema.$ref, document)
        return this.#decodeNode(mergeReference(resolved.schema, schema), resolved.document, schemaPath)
      }

      if (Array.isArray(schema.oneOf)) {
        return this.#decodeOneOf(schema, document, schemaPath)
      }

      const type = schemaType(schema)
      switch (type) {
        case 'object':
          return this.#decodeObject(schema, document, schemaPath)
        case 'array':
          return this.#decodeArray(schema, document, schemaPath)
        case 'string':
          return this.#decodeString(schema, schemaPath)
        case 'boolean':
          return this.#reader.readBool(schemaPath)
        case 'number':
        case 'integer':
          return this.#decodeNumber(schema, schemaPath)
        case undefined:
          if (schema.properties !== undefined || schema.additionalProperties !== undefined) {
            return this.#decodeObject(schema, document, schemaPath)
          }
          throw new ToolError('unsupported-schema', `Schema does not have a decodable type: ${document.id}`, {
            offset: this.#reader.offset,
            schemaPath,
          })
        default:
          throw new ToolError('unsupported-schema', `Unsupported schema type ${JSON.stringify(type)}`, {
            offset: this.#reader.offset,
            schemaPath,
          })
      }
    })
  }

  #decodeOneOf(schema: JsonSchema, document: SchemaDocument, schemaPath: string): unknown {
    const variants = schema.oneOf!
    const title = schema.title?.toLocaleLowerCase('en-US') ?? ''

    if (title === 'tradeitemlist') {
      const itemSchema = variants[0]
      if (itemSchema === undefined) {
        throw new ToolError('unsupported-schema', 'TradeItemList schema has no direct item branch', {
          offset: this.#reader.offset,
          schemaPath,
        })
      }
      const count = this.#readContainerCount(schemaPath)
      const items: unknown[] = []
      for (let index = 0; index < count; index += 1) {
        items.push(this.#decodeNode(itemSchema, document, `${schemaPath}.choice[${index}]`))
      }
      return count === 1 ? items[0] : { choice: items }
    }

    const usesBinaryOrdinal =
      variants.some(variant => typeof variant['x-ordinal-index'] === 'number') ||
      IMPLICIT_BINARY_VARIANTS.has(title)

    if (usesBinaryOrdinal) {
      const tagOffset = this.#reader.offset
      const tag = this.#reader.readUint8(`${schemaPath} oneOf tag`)
      const variant = variants.find((candidate, index) => (candidate['x-ordinal-index'] ?? index) === tag)
      if (variant === undefined) {
        throw new ToolError('decode-error', `${schemaPath} has no branch for oneOf tag ${tag}`, {
          offset: tagOffset,
          schemaPath,
        })
      }
      return this.#decodeNode(variant, document, `${schemaPath}<${tag}>`)
    }

    if (title === 'molang string') {
      const stringVariant = variants.find(variant => schemaType(variant) === 'string')
      if (stringVariant !== undefined) {
        return this.#decodeNode(stringVariant, document, schemaPath)
      }
    }

    if (ARRAY_REPRESENTATION_UNIONS.has(title)) {
      const arrayVariant = variants.find(variant => schemaType(variant) === 'array')
      if (arrayVariant !== undefined) {
        return this.#decodeNode(arrayVariant, document, schemaPath)
      }
    }

    if (OBJECT_REPRESENTATION_UNIONS.has(title)) {
      const objectVariant = variants.find(variant => schemaType(variant) === 'object')
      if (objectVariant !== undefined) {
        return this.#decodeNode(objectVariant, document, schemaPath)
      }
    }

    if (BOOLEAN_REPRESENTATION_UNIONS.has(title)) {
      const booleanVariant = variants.find(variant => schemaType(variant) === 'boolean')
      if (booleanVariant !== undefined) {
        return this.#decodeNode(booleanVariant, document, schemaPath)
      }
    }

    if (INTEGER_REPRESENTATION_UNIONS.has(title)) {
      const integerVariant = variants.find(variant => schemaType(variant) === 'integer')
      if (integerVariant !== undefined) {
        return this.#decodeNode(integerVariant, document, schemaPath)
      }
    }

    if (variants.length === 1) {
      return this.#decodeNode(variants[0]!, document, schemaPath)
    }

    throw new ToolError(
      'unsupported-schema',
      `Cannot determine the binary branch of oneOf ${JSON.stringify(schema.title ?? document.id)} without x-ordinal-index`,
      { offset: this.#reader.offset, schemaPath },
    )
  }

  #decodeString(schema: JsonSchema, schemaPath: string): string {
    const value = this.#reader.readString(schemaPath)
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new ToolError('decode-error', `Enum value ${JSON.stringify(value)} at ${schemaPath} is not in the schema`, {
        offset: this.#reader.offset,
        schemaPath,
      })
    }
    return value
  }

  #decodeNumber(schema: JsonSchema, schemaPath: string): number | string {
    const underlying = schema['x-underlying-type']
    switch (underlying) {
      case 'uint8':
        return this.#reader.readUint8(schemaPath)
      case 'int8':
        return this.#reader.readInt8(schemaPath)
      case 'uint16':
        return this.#reader.readUint16(schemaPath)
      case 'int16':
        return this.#reader.readInt16(schemaPath)
      case 'uint32':
        return this.#reader.readUint32(schemaPath)
      case 'int32':
        return this.#reader.readInt32(schemaPath)
      case 'uint64':
        return this.#reader.readUint64(schemaPath)
      case 'int64':
        return this.#reader.readInt64(schemaPath)
      case 'float':
        return this.#reader.readFloat32(schemaPath)
      case 'double':
        return this.#reader.readFloat64(schemaPath)
      default:
        throw new ToolError(
          'unsupported-schema',
          `${schemaPath} is numeric, but its schema has no supported x-underlying-type (received ${JSON.stringify(underlying)})`,
          { offset: this.#reader.offset, schemaPath },
        )
    }
  }

  #readContainerCount(schemaPath: string): number {
    const offset = this.#reader.offset
    const count = this.#reader.readVarUint32(`${schemaPath} count`)
    if (count > MAX_CONTAINER_ITEMS) {
      throw new ToolError('decode-error', `${schemaPath} item count ${count} exceeds the limit ${MAX_CONTAINER_ITEMS}`, {
        offset,
        schemaPath,
      })
    }
    return count
  }

  #decodeArray(schema: JsonSchema, document: SchemaDocument, schemaPath: string): unknown[] {
    if (schema.items === undefined) {
      throw new ToolError('unsupported-schema', `Array schema at ${schemaPath} is missing items`, {
        offset: this.#reader.offset,
        schemaPath,
      })
    }

    if (Array.isArray(schema.items)) {
      return schema.items.map((item, index) => this.#decodeNode(item, document, `${schemaPath}[${index}]`))
    }

    const fixedLength =
      typeof schema.minItems === 'number' && schema.minItems === schema.maxItems ? schema.minItems : undefined
    const count = fixedLength ?? this.#readContainerCount(schemaPath)
    if (count > MAX_CONTAINER_ITEMS) {
      throw new ToolError('decode-error', `Array length ${count} at ${schemaPath} exceeds the limit`, {
        offset: this.#reader.offset,
        schemaPath,
      })
    }

    const result: unknown[] = []
    for (let index = 0; index < count; index += 1) {
      result.push(this.#decodeNode(schema.items, document, `${schemaPath}[${index}]`))
    }
    return result
  }

  #isComponentStorage(schema: JsonSchema): boolean {
    const properties = Object.keys(schema.properties ?? {})
    return (
      properties.length > 0 &&
      properties.every(name => name.includes(':')) &&
      properties.every(name => schema.properties?.[name]?.['x-ordinal-index'] === undefined)
    )
  }

  #decodeComponentStorage(schema: JsonSchema, document: SchemaDocument, schemaPath: string): Record<string, unknown> {
    const properties = schema.properties ?? {}
    const byHash = new Map<number, { name: string; schema: JsonSchema }>()
    for (const [name, componentSchema] of Object.entries(properties)) {
      const hash = fnv1a(name)
      if (byHash.has(hash)) {
        throw new ToolError('unsupported-schema', `Component name FNV-1a collision: ${name} / ${byHash.get(hash)!.name}`, {
          offset: this.#reader.offset,
          schemaPath,
        })
      }
      byHash.set(hash, { name, schema: componentSchema })
    }

    const countOffset = this.#reader.offset
    const count = this.#reader.readUint32(`${schemaPath} component count`)
    if (count > MAX_CONTAINER_ITEMS) {
      throw new ToolError('decode-error', `${schemaPath} component count ${count} exceeds the limit ${MAX_CONTAINER_ITEMS}`, {
        offset: countOffset,
        schemaPath,
      })
    }
    const result: Record<string, unknown> = {}
    for (let index = 0; index < count; index += 1) {
      const hashOffset = this.#reader.offset
      const hash = this.#reader.readUint32(`${schemaPath} component hash`)
      const component = byHash.get(hash)
      if (component === undefined) {
        throw new ToolError(
          'missing-schema',
          `Component ${formatHash(hash)} at ${schemaPath} has no matching schema (${byHash.size} component names loaded)`,
          { offset: hashOffset, schemaPath },
        )
      }
      if (hasOwn(result, component.name)) {
        throw new ToolError('decode-error', `${schemaPath} contains duplicate component ${component.name}`, {
          offset: hashOffset,
          schemaPath,
        })
      }
      result[component.name] = this.#decodeNode(component.schema, document, `${schemaPath}.${component.name}`)
    }
    return result
  }

  #decodeMap(schema: JsonSchema, document: SchemaDocument, schemaPath: string): Record<string, unknown> {
    if (typeof schema.additionalProperties !== 'object' || schema.additionalProperties === null) {
      throw new ToolError('unsupported-schema', `additionalProperties at ${schemaPath} is not a decodable schema`, {
        offset: this.#reader.offset,
        schemaPath,
      })
    }

    const count = this.#readContainerCount(schemaPath)
    const result: Record<string, unknown> = {}
    const keyType = schema['x-key-underlying-type'] ?? 'string'
    for (let index = 0; index < count; index += 1) {
      let key: string
      if (keyType === 'string') {
        key = this.#reader.readString(`${schemaPath} key`)
      } else if (keyType === 'float') {
        key = String(this.#reader.readFloat32(`${schemaPath} key`))
      } else if (keyType === 'int32') {
        key = String(this.#reader.readInt32(`${schemaPath} key`))
      } else {
        throw new ToolError('unsupported-schema', `${schemaPath} does not support map key type ${keyType}`, {
          offset: this.#reader.offset,
          schemaPath,
        })
      }

      if (hasOwn(result, key)) {
        throw new ToolError('decode-error', `${schemaPath} contains duplicate map key ${JSON.stringify(key)}`, {
          offset: this.#reader.offset,
          schemaPath,
        })
      }
      result[key] = this.#decodeNode(schema.additionalProperties, document, `${schemaPath}.${key}`)
    }
    return result
  }

  #decodeObject(schema: JsonSchema, document: SchemaDocument, schemaPath: string): Record<string, unknown> {
    if (this.#isComponentStorage(schema)) {
      return this.#decodeComponentStorage(schema, document, schemaPath)
    }

    const properties = Object.entries(schema.properties ?? {})
    if (properties.length === 0 && schema.additionalProperties !== undefined) {
      return this.#decodeMap(schema, document, schemaPath)
    }
    if (properties.length === 0) {
      return {}
    }

    const missingOrdinals = properties.filter(([, property]) => typeof property['x-ordinal-index'] !== 'number')
    if (missingOrdinals.length > 0) {
      throw new ToolError(
        'unsupported-schema',
        `Fields at ${schemaPath} are missing x-ordinal-index: ${missingOrdinals.map(([name]) => name).join(', ')}`,
        { offset: this.#reader.offset, schemaPath },
      )
    }

    properties.sort((left, right) => left[1]['x-ordinal-index']! - right[1]['x-ordinal-index']!)
    const ordinals = new Set<number>()
    for (const [name, property] of properties) {
      const ordinal = property['x-ordinal-index']!
      if (ordinals.has(ordinal)) {
        throw new ToolError('unsupported-schema', `${schemaPath} has duplicate x-ordinal-index ${ordinal} (field ${name})`, {
          offset: this.#reader.offset,
          schemaPath,
        })
      }
      ordinals.add(ordinal)
    }

    const required = new Set(schema.required ?? [])
    const result: Record<string, unknown> = {}
    for (const [name, property] of properties) {
      const propertyPath = `${schemaPath}.${name}`
      const isUnconditional = required.has(name) || hasOwn(property, 'default')
      if (!isUnconditional && !this.#reader.readBool(`${propertyPath} presence`)) {
        continue
      }
      result[name] = this.#decodeNode(property, document, propertyPath)
    }
    return result
  }
}
