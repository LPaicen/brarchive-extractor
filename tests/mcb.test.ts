import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BRARCHIVE_MAGIC } from '../src/brarchive.js'
import { MINECRAFT_DOCUMENT_TYPES } from '../src/minecraft-documents.js'
import { McbDecoder } from '../src/mcb-decoder.js'
import { run } from '../src/runner.js'
import { SchemaRegistry } from '../src/schema-registry.js'

function mcbString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  assert.ok(bytes.length < 128)
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

function makeMcb(
  payloadKey: string,
  payload: Buffer,
  formatVersion: readonly [number, number, number] | 'beta' = [1, 26, 30],
): Buffer {
  const header = Buffer.alloc(10)
  const components = formatVersion === 'beta' ? ([9999, 9999, 9999] as const) : formatVersion
  header.writeUInt32LE(0x42434d7f, 0)
  header.writeUInt16LE(components[0], 4)
  header.writeUInt16LE(components[1], 6)
  header.writeUInt16LE(components[2], 8)
  return Buffer.concat([
    header,
    mcbString(formatVersion === 'beta' ? 'beta' : ''),
    mcbString(''),
    mcbString(payloadKey),
    payload,
  ])
}

function makeArchive(entries: Array<{ name: string; payload: Buffer }>): Buffer {
  const tableSize = entries.length * 256
  const result = Buffer.alloc(16 + tableSize + entries.reduce((total, entry) => total + entry.payload.length, 0))
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

test('Minecraft document catalog covers the symbolized MinecraftDocumentInput payload keys', () => {
  const payloadKeys = MINECRAFT_DOCUMENT_TYPES.map(document => document.payloadKey)
  assert.equal(new Set(payloadKeys).size, payloadKeys.length)
  for (const expected of [
    'minecraft:block_culling_rules',
    'minecraft:camera_custom_splines',
    'minecraft:crafting_items_catalog',
    'minecraft:processor_list',
    'minecraft:template_pool',
    'minecraft:structure_set',
  ]) {
    assert.ok(payloadKeys.includes(expected), `Missing document payload key ${expected}`)
  }
})

test('SchemaRegistry accepts a recursive schema root without bds-docs metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brarchive-extractor-standalone-schema-'))
  try {
    const schemaDirectory = path.join(root, 'schemas', 'nested')
    await mkdir(schemaDirectory, { recursive: true })
    await writeFile(path.join(root, 'exist.json'), '{invalid optional metadata')
    await writeFile(path.join(root, 'export-report.json'), '{invalid optional metadata')
    await writeFile(
      path.join(schemaDirectory, 'root.json'),
      JSON.stringify({
        title: 'standalone_document',
        $id: '/standalone/1.0.0/root.json',
        'x-format-version': '1.0.0',
        type: 'object',
        properties: { name: { type: 'string', 'x-ordinal-index': 0 } },
        required: ['name'],
      }),
    )

    const registry = await SchemaRegistry.load(root)
    assert.equal(registry.exportVersion, undefined)
    assert.equal(registry.selectRoot('standalone_document', '1.0.0').title, 'standalone_document')

    await writeFile(path.join(root, 'exist.json'), '{"version":"fallback-version"}')
    await writeFile(
      path.join(root, 'export-report.json'),
      JSON.stringify({
        tool: 'LLClientSchemaExporter',
        target_minecraft_version: '1.26.30.1',
        exported_count: 1,
      }),
    )
    const clientRegistry = await SchemaRegistry.load(root)
    assert.equal(clientRegistry.exportVersion, '1.26.30.1')

    const archivePath = path.join(root, 'sample.brarchive')
    await writeFile(
      archivePath,
      makeArchive([
        {
          name: 'restored.json',
          payload: makeMcb('standalone_document', mcbString('value'), [1, 0, 0]),
        },
      ]),
    )
    const cliPath = path.join(process.cwd(), 'dist', 'src', 'cli.js')
    const cliRun = spawnSync(
      process.execPath,
      [cliPath, archivePath, '--schema', root, '--output', path.join(root, 'output'), '--no-verbose'],
      { encoding: 'utf8' },
    )
    assert.equal(cliRun.status, 0, cliRun.stderr)
    assert.match(cliRun.stdout, /Schema: .* \(1\.26\.30\.1\)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SchemaRegistry resolves LL client exporter refs by physical filename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brarchive-extractor-ll-schema-'))
  try {
    const schemaDirectory = path.join(root, 'client', 'biome', '1.21.100')
    await mkdir(schemaDirectory, { recursive: true })
    const documentPath = path.join(schemaDirectory, 'Client_Biome_Document.json')
    const objectPath = path.join(schemaDirectory, 'Client_Biome_Object.json')
    await writeFile(
      documentPath,
      JSON.stringify({
        title: 'Client Biome JSON File',
        $id: '/client/biome/1.21.100/Client%20Biome%20Document.json',
        'x-format-version': '1.21.100',
        type: 'object',
        required: ['format_version', 'minecraft:client_biome'],
        properties: {
          format_version: { type: 'string' },
          'minecraft:client_biome': { $ref: './Client_Biome_Object.json' },
        },
      }),
    )
    await writeFile(
      objectPath,
      JSON.stringify({
        title: 'Client Biome Definition',
        $id: '/client/biome/1.21.100/Client%20Biome%20Object.json',
        'x-format-version': '1.21.100',
        type: 'object',
        properties: {},
      }),
    )

    const registry = await SchemaRegistry.load(root)
    const document = registry.documents.find(candidate => candidate.filePath === documentPath)
    assert.ok(document)
    const resolved = registry.resolve('./Client_Biome_Object.json', document)
    assert.equal(resolved.document.filePath, objectPath)

    assert.throws(
      () => registry.resolve('./Missing_Object.json', document),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Referenced schema does not exist: \.\/Missing_Object\.json/)
        assert.ok(error.message.includes(documentPath), error.message)
        assert.doesNotMatch(error.message, /from \/client\/biome\/1\.21\.100\/client biome document\.json/)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('McbDecoder uses ordinal order, defaults and optional presence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brarchive-extractor-schema-'))
  try {
    await mkdir(path.join(root, 'metadata', 'json_schemas', 'test', '1.0.0'), { recursive: true })
    await writeFile(path.join(root, 'exist.json'), '{"version":"test"}')
    await writeFile(path.join(root, 'contents.json'), '[]')
    await writeFile(
      path.join(root, 'metadata', 'json_schemas', 'test', '1.0.0', 'root.json'),
      JSON.stringify({
        title: 'test_document',
        $id: '/test/1.0.0/root.json',
        'x-format-version': '1.0.0',
        type: 'object',
        properties: {
          optional_count: { type: 'integer', 'x-underlying-type': 'uint32', 'x-ordinal-index': 2 },
          enabled: { type: 'boolean', default: false, 'x-ordinal-index': 1 },
          name: { type: 'string', 'x-ordinal-index': 0 },
        },
        required: ['name'],
      }),
    )

    const payload = makeMcb('test_document', Buffer.concat([mcbString('hello'), Buffer.from([1, 0])]), [1, 0, 0])
    const registry = await SchemaRegistry.load(root)
    assert.equal(registry.exportVersion, 'test')
    const decoder = new McbDecoder(registry)
    const decoded = decoder.decode(payload)
    assert.deepEqual(decoded.header, {
      major: 1,
      minor: 0,
      patch: 0,
      preRelease: '',
      buildMeta: '',
      formatVersion: '1.0.0',
      payloadKey: 'test_document',
    })
    assert.deepEqual(decoded.value, {
      format_version: '1.0.0',
      test_document: { name: 'hello', enabled: true },
    })

    const archivePath = path.join(root, 'format.brarchive')
    const regularJson = '{\n    "unchanged": true\n}\n'
    await writeFile(
      archivePath,
      makeArchive([
        { name: 'restored.json', payload },
        { name: 'regular.json', payload: Buffer.from(regularJson) },
        { name: 'notes.txt', payload: Buffer.from('not JSON') },
      ]),
    )
    const compactOutput = path.join(root, 'compact')
    await run({
      inputPath: archivePath,
      outputPath: compactOutput,
      schemaPath: root,
      jsonFormat: 'compact',
    })
    assert.equal(
      await readFile(path.join(compactOutput, 'restored.json'), 'utf8'),
      '{"format_version":"1.0.0","test_document":{"name":"hello","enabled":true}}',
    )
    assert.equal(await readFile(path.join(compactOutput, 'regular.json'), 'utf8'), regularJson)

    const tabOutput = path.join(root, 'tab-indented')
    await run({
      inputPath: archivePath,
      outputPath: tabOutput,
      schemaPath: root,
      indentSize: 1,
      indentCharacter: 'tab',
    })
    assert.match(await readFile(path.join(tabOutput, 'restored.json'), 'utf8'), /\n\t"format_version"/)

    const mcbOnlyOutput = path.join(root, 'mcb-only')
    const mcbOnly = await run({
      inputPath: archivePath,
      outputPath: mcbOnlyOutput,
      schemaPath: root,
      mcbOnly: true,
    })
    assert.match(await readFile(path.join(mcbOnlyOutput, 'restored.json'), 'utf8'), /"test_document"/)
    await assert.rejects(access(path.join(mcbOnlyOutput, 'regular.json')))
    assert.equal(mcbOnly.archives[0]!.selectedEntries, 1)
    assert.equal(mcbOnly.archives[0]!.processedEntries, 1)
    assert.equal(mcbOnly.archives[0]!.skippedEntries, 2)

    const jsonOnlyOutput = path.join(root, 'json-only')
    const jsonOnly = await run({
      inputPath: archivePath,
      outputPath: jsonOnlyOutput,
      schemaPath: root,
      jsonOnly: true,
    })
    assert.match(await readFile(path.join(jsonOnlyOutput, 'restored.json'), 'utf8'), /"test_document"/)
    assert.equal(await readFile(path.join(jsonOnlyOutput, 'regular.json'), 'utf8'), regularJson)
    await assert.rejects(access(path.join(jsonOnlyOutput, 'notes.txt')))
    assert.equal(jsonOnly.archives[0]!.selectedEntries, 2)
    assert.equal(jsonOnly.archives[0]!.processedEntries, 2)
    assert.equal(jsonOnly.archives[0]!.skippedEntries, 1)

    await assert.rejects(
      run({
        inputPath: archivePath,
        outputPath: path.join(root, 'invalid-filter'),
        mcbOnly: true,
        jsonOnly: true,
      }),
      /--mcb-only cannot be combined with --json-only/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('McbDecoder restores beta versions with the matching beta schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brarchive-extractor-beta-schema-'))
  try {
    const schemaRoot = path.join(root, 'metadata', 'json_schemas', 'test')
    await mkdir(path.join(schemaRoot, '1.0.0'), { recursive: true })
    await mkdir(path.join(schemaRoot, 'beta'), { recursive: true })
    await writeFile(path.join(root, 'exist.json'), '{"version":"test"}')
    await writeFile(path.join(root, 'contents.json'), '[]')
    await writeFile(
      path.join(schemaRoot, '1.0.0', 'root.json'),
      JSON.stringify({
        title: 'beta_document',
        $id: '/test/1.0.0/root.json',
        'x-format-version': '1.0.0',
        type: 'object',
        properties: {
          numericValue: { type: 'integer', 'x-underlying-type': 'uint32', 'x-ordinal-index': 0 },
        },
        required: ['numericValue'],
      }),
    )
    await writeFile(
      path.join(schemaRoot, 'beta', 'root.json'),
      JSON.stringify({
        title: 'beta_document',
        $id: '/test/beta/root.json',
        'x-format-version': 'beta',
        type: 'object',
        properties: {
          name: { type: 'string', 'x-ordinal-index': 0 },
        },
        required: ['name'],
      }),
    )

    const decoded = new McbDecoder(await SchemaRegistry.load(root)).decode(
      makeMcb('beta_document', mcbString('preview'), 'beta'),
    )
    assert.deepEqual(decoded.header, {
      major: 9999,
      minor: 9999,
      patch: 9999,
      preRelease: 'beta',
      buildMeta: '',
      formatVersion: 'beta',
      payloadKey: 'beta_document',
    })
    assert.equal(decoded.schemaId, '/test/beta/root.json')
    assert.equal(decoded.schemaVersion, 'beta')
    assert.deepEqual(decoded.value, {
      format_version: 'beta',
      beta_document: { name: 'preview' },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('McbDecoder resolves root aliases and supports versionless array roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brarchive-extractor-alias-schema-'))
  try {
    const schemaDirectory = path.join(root, 'metadata', 'json_schemas', 'test', '1.26.30')
    await mkdir(schemaDirectory, { recursive: true })
    await writeFile(path.join(root, 'exist.json'), '{"version":"test"}')
    await writeFile(path.join(root, 'contents.json'), '[]')
    const schemas = [
      {
        file: 'trade.json',
        title: 'Trade Table',
        id: '/test/1.26.30/trade.json',
        type: 'array',
        items: { type: 'integer', 'x-underlying-type': 'uint8' },
      },
      {
        file: 'item.json',
        title: 'Item Document',
        id: '/test/1.26.30/item.json',
        type: 'object',
      },
      {
        file: 'voxel.json',
        title: 'VoxelShapeFile',
        id: '/test/1.26.30/voxel.json',
        type: 'object',
      },
    ]
    for (const schema of schemas) {
      await writeFile(
        path.join(schemaDirectory, schema.file),
        JSON.stringify({
          title: schema.title,
          $id: schema.id,
          'x-format-version': '1.26.30',
          type: schema.type,
          items: schema.items,
        }),
      )
    }

    const registry = await SchemaRegistry.load(root)
    assert.equal(registry.selectRoot('minecraft:item', '1.26.30').title, 'Item Document')
    assert.equal(registry.selectRoot('minecraft:voxel_shape', '1.26.30').title, 'VoxelShapeFile')
    assert.deepEqual(new McbDecoder(registry).decode(makeMcb('tiers', Buffer.from([2, 7, 8]))).value, {
      tiers: [7, 8],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SchemaRegistry discovers envelope payload schemas and the crafting catalog title', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brarchive-extractor-document-schema-'))
  try {
    const schemaDirectory = path.join(root, 'metadata', 'json_schemas', 'test', '1.26.50')
    await mkdir(schemaDirectory, { recursive: true })
    await writeFile(path.join(root, 'exist.json'), '{"version":"test"}')
    await writeFile(path.join(root, 'contents.json'), '[]')
    await writeFile(
      path.join(schemaDirectory, 'future-value.json'),
      JSON.stringify({
        title: 'Future Value',
        $id: '/test/1.26.50/future-value.json',
        'x-format-version': '1.26.50',
        type: 'object',
        properties: { name: { type: 'string', 'x-ordinal-index': 0 } },
        required: ['name'],
      }),
    )
    await writeFile(
      path.join(schemaDirectory, 'future-document.json'),
      JSON.stringify({
        title: 'Future Document',
        $id: '/test/1.26.50/future-document.json',
        'x-format-version': '1.26.50',
        type: 'object',
        properties: {
          format_version: { type: 'string', 'x-ordinal-index': 0 },
          'minecraft:future_payload': { $ref: './future-value.json', 'x-ordinal-index': 1 },
        },
        required: ['format_version', 'minecraft:future_payload'],
      }),
    )
    await writeFile(
      path.join(schemaDirectory, 'string.json'),
      JSON.stringify({
        title: 'Catalog Item Name',
        $id: '/test/1.26.50/string.json',
        'x-format-version': '1.26.50',
        type: 'string',
      }),
    )
    await writeFile(
      path.join(schemaDirectory, 'catalog-item.json'),
      JSON.stringify({
        title: 'Crafting Catalog Item',
        $id: '/test/1.26.50/catalog-item.json',
        'x-format-version': '1.26.50',
        oneOf: [
          { $ref: './string.json' },
          {
            type: 'object',
            properties: { name: { type: 'string', 'x-ordinal-index': 0 } },
            required: ['name'],
          },
        ],
      }),
    )
    await writeFile(
      path.join(schemaDirectory, 'catalog-document.json'),
      JSON.stringify({
        title: 'Crafting Catalog Document',
        $id: '/test/1.26.50/catalog-document.json',
        'x-format-version': '1.26.50',
        type: 'object',
        properties: { icon: { $ref: './catalog-item.json', 'x-ordinal-index': 0 } },
        required: ['icon'],
      }),
    )

    const registry = await SchemaRegistry.load(root)
    assert.equal(registry.selectRoot('minecraft:future_payload', '1.26.50').title, 'Future Value')
    assert.deepEqual(
      new McbDecoder(registry).decode(makeMcb('minecraft:future_payload', mcbString('future'), [1, 26, 50])).value,
      {
        format_version: '1.26.50',
        'minecraft:future_payload': { name: 'future' },
      },
    )
    assert.deepEqual(
      new McbDecoder(registry).decode(
        makeMcb('minecraft:crafting_items_catalog', mcbString('minecraft:stone'), [1, 26, 50]),
      ).value,
      {
        format_version: '1.26.50',
        'minecraft:crafting_items_catalog': { icon: 'minecraft:stone' },
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('McbDecoder handles confirmed normalized oneOf encodings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brarchive-extractor-union-schema-'))
  try {
    const schemaDirectory = path.join(root, 'metadata', 'json_schemas', 'test', '1.26.30')
    await mkdir(schemaDirectory, { recursive: true })
    await writeFile(path.join(root, 'exist.json'), '{"version":"test"}')
    await writeFile(path.join(root, 'contents.json'), '[]')
    await writeFile(
      path.join(schemaDirectory, 'root.json'),
      JSON.stringify({
        title: 'union_document',
        $id: '/test/1.26.30/root.json',
        'x-format-version': '1.26.30',
        type: 'object',
        properties: {
          curve: {
            title: 'particle_curve',
            oneOf: [
              { type: 'integer', 'x-underlying-type': 'uint8' },
              { type: 'string' },
            ],
            'x-ordinal-index': 0,
          },
          vector: {
            title: 'vec3',
            oneOf: [
              {
                type: 'array',
                items: { type: 'integer', 'x-underlying-type': 'uint8' },
                minItems: 3,
                maxItems: 3,
              },
              { type: 'object' },
            ],
            'x-ordinal-index': 1,
          },
          icon: {
            title: 'minecraft:icon v1.21.80',
            oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: { type: 'string' } }],
            'x-ordinal-index': 2,
          },
          handEquipped: {
            title: 'minecraft:hand_equipped',
            oneOf: [{ type: 'boolean' }, { type: 'object' }],
            'x-ordinal-index': 3,
          },
          maxStackSize: {
            title: 'minecraft:max_stack_size',
            oneOf: [
              { type: 'integer', 'x-underlying-type': 'int16' },
              { type: 'object' },
            ],
            'x-ordinal-index': 4,
          },
          quantity: {
            title: 'Trade Quantity',
            oneOf: [
              { type: 'integer', 'x-underlying-type': 'uint32' },
              {
                type: 'object',
                properties: {
                  min: { type: 'integer', 'x-underlying-type': 'uint32', 'x-ordinal-index': 0 },
                  max: { type: 'integer', 'x-underlying-type': 'uint32', 'x-ordinal-index': 1 },
                },
                required: ['min', 'max'],
              },
            ],
            'x-ordinal-index': 5,
          },
          descriptor: {
            title: 'Item Descriptor',
            oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: { type: 'string' } }],
            'x-ordinal-index': 6,
          },
          tradeItems: {
            title: 'TradeItemList',
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { choice: { type: 'array', items: { type: 'string' } } },
                required: ['choice'],
              },
            ],
            'x-ordinal-index': 7,
          },
        },
        required: ['curve', 'vector', 'icon', 'handEquipped', 'maxStackSize', 'quantity', 'descriptor', 'tradeItems'],
      }),
    )

    const uint32 = Buffer.alloc(8)
    uint32.writeUInt32LE(2, 0)
    uint32.writeUInt32LE(5, 4)
    const payload = makeMcb(
      'union_document',
      Buffer.concat([
        Buffer.from([0, 9]),
        Buffer.from([1, 2, 3]),
        Buffer.from([1]),
        mcbString('default'),
        mcbString('icon'),
        Buffer.from([1]),
        Buffer.from([64, 0]),
        uint32,
        Buffer.from([1]),
        mcbString('name'),
        mcbString('minecraft:stone'),
        Buffer.from([2]),
        mcbString('first'),
        mcbString('second'),
      ]),
    )
    assert.deepEqual(new McbDecoder(await SchemaRegistry.load(root)).decode(payload).value, {
      format_version: '1.26.30',
      union_document: {
        curve: 9,
        vector: [1, 2, 3],
        icon: { default: 'icon' },
        handEquipped: true,
        maxStackSize: 64,
        quantity: { min: 2, max: 5 },
        descriptor: { name: 'minecraft:stone' },
        tradeItems: { choice: ['first', 'second'] },
      },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
