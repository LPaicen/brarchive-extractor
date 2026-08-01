import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BRARCHIVE_MAGIC } from '../src/brarchive.js'
import { McbDecoder } from '../src/mcb-decoder.js'
import { run } from '../src/runner.js'
import { SchemaRegistry } from '../src/schema-registry.js'

function mcbString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  assert.ok(bytes.length < 128)
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
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

    const header = Buffer.alloc(12)
    header.writeUInt32LE(0x42434d7f, 0)
    header.writeUInt16LE(1, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt32LE(0, 8)
    const payload = Buffer.concat([header, mcbString('test_document'), mcbString('hello'), Buffer.from([1, 0])])
    const decoder = new McbDecoder(await SchemaRegistry.load(root))
    assert.deepEqual(decoder.decode(payload).value, {
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
    assert.equal(mcbOnly.archives[0]!.skippedEntries, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
