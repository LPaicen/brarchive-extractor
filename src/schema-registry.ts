import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ToolError } from './errors.js'
import { minecraftDocumentType, schemaTitleCandidates } from './minecraft-documents.js'
import type { JsonSchema, ResolvedSchema, SchemaDocument } from './schema-types.js'

export type { JsonSchema, ResolvedSchema, SchemaDocument } from './schema-types.js'

function normalizeId(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    decoded = value
  }
  const slashes = decoded.replaceAll('\\', '/')
  return path.posix.normalize(slashes.startsWith('/') ? slashes : `/${slashes}`).toLocaleLowerCase('en-US')
}

function normalizeTitle(value: string): string {
  return value.trim().replaceAll('%20', ' ').toLocaleLowerCase('en-US')
}

function parseNumericVersion(value: string | undefined): number[] | undefined {
  if (value === undefined || !/^\d+(?:\.\d+)*$/.test(value)) {
    return undefined
  }
  return value.split('.').map(part => Number(part))
}

function uniqueDocuments(documents: SchemaDocument[]): SchemaDocument[] {
  const byId = new Map<string, SchemaDocument>()
  for (const document of documents) {
    if (!byId.has(document.id)) {
      byId.set(document.id, document)
    }
  }
  return [...byId.values()]
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await collectJsonFiles(fullPath)))
    } else if (entry.isFile() && entry.name.toLocaleLowerCase('en-US').endsWith('.json')) {
      result.push(fullPath)
    }
  }
  return result
}

function resolvePointer(root: JsonSchema, fragment: string, ref: string): JsonSchema {
  if (fragment === '' || fragment === '#') {
    return root
  }
  if (!fragment.startsWith('#/')) {
    throw new ToolError('unsupported-schema', `Unsupported schema fragment: ${ref}`)
  }

  let current: unknown = root
  for (const encodedPart of fragment.slice(2).split('/')) {
    const part = decodeURIComponent(encodedPart).replaceAll('~1', '/').replaceAll('~0', '~')
    if (typeof current !== 'object' || current === null || !(part in current)) {
      throw new ToolError('missing-schema', `Schema fragment does not exist: ${ref}`)
    }
    current = (current as Record<string, unknown>)[part]
  }

  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new ToolError('unsupported-schema', `Schema fragment does not resolve to an object: ${ref}`)
  }
  return current as JsonSchema
}

export class SchemaRegistry {
  readonly rootPath: string
  readonly exportVersion?: string
  readonly documents: SchemaDocument[]
  readonly #byId: Map<string, SchemaDocument>
  readonly #byTitle: Map<string, SchemaDocument[]>
  readonly #byPayloadKey: Map<string, SchemaDocument[]>

  private constructor(rootPath: string, exportVersion: string | undefined, documents: SchemaDocument[]) {
    this.rootPath = rootPath
    this.exportVersion = exportVersion
    this.documents = documents
    this.#byId = new Map()
    this.#byTitle = new Map()
    this.#byPayloadKey = new Map()

    for (const document of documents) {
      if (this.#byId.has(document.id)) {
        throw new ToolError('unsupported-schema', `Duplicate schema $id: ${document.id}`)
      }
      this.#byId.set(document.id, document)

      if (document.title !== undefined) {
        const key = normalizeTitle(document.title)
        const values = this.#byTitle.get(key) ?? []
        values.push(document)
        this.#byTitle.set(key, values)
      }
    }

    this.#indexEnvelopePayloadSchemas()
  }

  #addPayloadSchema(payloadKey: string, document: SchemaDocument): void {
    const key = normalizeTitle(payloadKey)
    const values = this.#byPayloadKey.get(key) ?? []
    values.push(document)
    this.#byPayloadKey.set(key, values)
  }

  #indexEnvelopePayloadSchemas(): void {
    for (const document of this.documents) {
      const properties = document.schema.properties
      if (properties === undefined || properties.format_version === undefined) {
        continue
      }

      for (const [payloadKey, payloadSchema] of Object.entries(properties)) {
        const isKnownPayload = minecraftDocumentType(payloadKey) !== undefined
        const isRequired = document.schema.required?.includes(payloadKey) ?? false
        if (payloadKey === 'format_version' || (!payloadKey.includes(':') && !isKnownPayload) || !isRequired) {
          continue
        }

        if (typeof payloadSchema.$ref === 'string') {
          const resolved = this.resolve(payloadSchema.$ref, document)
          this.#addPayloadSchema(payloadKey, {
            ...resolved.document,
            version: document.version ?? resolved.document.version,
            schema: resolved.schema,
          })
        } else {
          this.#addPayloadSchema(payloadKey, {
            ...document,
            title: payloadSchema.title ?? document.title,
            schema: payloadSchema,
          })
        }
      }
    }
  }

  static async load(schemaRoot: string): Promise<SchemaRegistry> {
    const rootPath = path.resolve(schemaRoot)
    for (const marker of ['exist.json', 'contents.json']) {
      const markerPath = path.join(rootPath, marker)
      try {
        if (!(await stat(markerPath)).isFile()) {
          throw new Error('not a file')
        }
      } catch (error) {
        throw new ToolError('missing-schema', `Schema root is missing ${marker}: ${rootPath}`, { cause: error })
      }
    }

    let exportVersion: string | undefined
    try {
      const exists = JSON.parse(await readFile(path.join(rootPath, 'exist.json'), 'utf8')) as Record<string, unknown>
      if (typeof exists.version === 'string') {
        exportVersion = exists.version
      }
    } catch (error) {
      throw new ToolError('missing-schema', `Unable to parse exist.json in schema root: ${rootPath}`, { cause: error })
    }

    const schemaDirectory = path.join(rootPath, 'metadata', 'json_schemas')
    try {
      if (!(await stat(schemaDirectory)).isDirectory()) {
        throw new Error('not a directory')
      }
    } catch (error) {
      throw new ToolError('missing-schema', `Schema root does not contain metadata/json_schemas: ${rootPath}`, {
        cause: error,
      })
    }

    const files = await collectJsonFiles(schemaDirectory)
    const documents: SchemaDocument[] = []
    for (const filePath of files) {
      let schema: JsonSchema
      try {
        schema = JSON.parse(await readFile(filePath, 'utf8')) as JsonSchema
      } catch (error) {
        throw new ToolError('missing-schema', `Unable to parse schema file: ${filePath}`, { cause: error })
      }
      if (typeof schema.$id !== 'string') {
        continue
      }
      documents.push({
        filePath,
        id: normalizeId(schema.$id),
        title: typeof schema.title === 'string' ? schema.title : undefined,
        version: typeof schema['x-format-version'] === 'string' ? schema['x-format-version'] : undefined,
        schema,
      })
    }

    if (documents.length === 0) {
      throw new ToolError('missing-schema', `No schemas with $id were found under metadata/json_schemas: ${rootPath}`)
    }
    return new SchemaRegistry(rootPath, exportVersion, documents)
  }

  selectRoot(payloadKey: string, mcbFormatVersion: string): SchemaDocument {
    const normalizedPayloadKey = normalizeTitle(payloadKey)
    const envelopeCandidates = this.#byPayloadKey.get(normalizedPayloadKey) ?? []
    const titles = schemaTitleCandidates(payloadKey)
    const titleCandidates = titles.flatMap(title => this.#byTitle.get(normalizeTitle(title)) ?? [])
    const configuredTitles = minecraftDocumentType(payloadKey)?.schemaTitles ?? []
    const configuredCandidates = configuredTitles.flatMap(
      title => this.#byTitle.get(normalizeTitle(title)) ?? [],
    )
    const candidates = uniqueDocuments(
      envelopeCandidates.length > 0
        ? [...envelopeCandidates, ...configuredCandidates]
        : configuredTitles.length > 0
          ? configuredCandidates
          : titleCandidates,
    )
    if (candidates.length === 0) {
      throw new ToolError('missing-schema', `No root schema found for payload key ${JSON.stringify(payloadKey)}`)
    }

    const target = parseNumericVersion(mcbFormatVersion)
    if (target === undefined) {
      const normalizedVersion = mcbFormatVersion.trim().toLocaleLowerCase('en-US')
      const exactCandidate = candidates.find(
        document => document.version?.trim().toLocaleLowerCase('en-US') === normalizedVersion,
      )
      if (exactCandidate !== undefined) {
        return exactCandidate
      }
      throw new ToolError(
        'missing-schema',
        `No root schema found for payload key ${JSON.stringify(payloadKey)} and format version ${JSON.stringify(mcbFormatVersion)}`,
      )
    }

    const numericCandidates = candidates
      .map(document => ({ document, version: parseNumericVersion(document.version) }))
      .filter((item): item is { document: SchemaDocument; version: number[] } => item.version !== undefined)

    if (numericCandidates.length > 0) {
      const compatible = numericCandidates.filter(item => compareVersions(item.version, target) <= 0)
      const pool = compatible.length > 0 ? compatible : numericCandidates
      pool.sort((left, right) => compareVersions(right.version, left.version))
      return pool[0]!.document
    }

    return candidates[0]!
  }

  resolve(ref: string, currentDocument: SchemaDocument): ResolvedSchema {
    const hashIndex = ref.indexOf('#')
    const referencePart = hashIndex >= 0 ? ref.slice(0, hashIndex) : ref
    const fragment = hashIndex >= 0 ? ref.slice(hashIndex) : ''
    let document = currentDocument

    if (referencePart !== '') {
      const base = path.posix.dirname(currentDocument.id)
      const id = normalizeId(referencePart.startsWith('/') ? referencePart : path.posix.join(base, referencePart))
      const found = this.#byId.get(id)
      if (found === undefined) {
        throw new ToolError('missing-schema', `Referenced schema does not exist: ${ref} (from ${currentDocument.id})`)
      }
      document = found
    }

    return { document, schema: resolvePointer(document.schema, fragment, ref) }
  }
}
