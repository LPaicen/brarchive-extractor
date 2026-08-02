import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { isMcb, parseBrarchive } from '../src/brarchive.js'
import { ToolError } from '../src/errors.js'
import { McbDecoder } from '../src/mcb-decoder.js'
import { SchemaRegistry } from '../src/schema-registry.js'

const fixtureInput = path.resolve(process.cwd(), 'test', 'input')
const fixtureSchemas = path.resolve(process.cwd(), 'test', 'bds-schema')
const hasLocalFixtures =
  existsSync(fixtureInput) &&
  existsSync(path.join(fixtureSchemas, 'exist.json')) &&
  existsSync(path.join(fixtureSchemas, 'contents.json'))

async function collectArchives(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await collectArchives(fullPath)))
    } else if (entry.isFile() && entry.name.toLocaleLowerCase('en-US').endsWith('.brarchive')) {
      result.push(fullPath)
    }
  }
  return result.sort((left, right) => left.localeCompare(right, 'en-US'))
}

test('local fixtures parse every archive and process every MCB entry', { skip: !hasLocalFixtures }, async () => {
  const archivePaths = await collectArchives(fixtureInput)
  const decoder = new McbDecoder(await SchemaRegistry.load(fixtureSchemas))
  let mcbEntryCount = 0
  let decodedEntryCount = 0
  let restorationFailureCount = 0
  const restorationFailures: string[] = []

  assert.ok(archivePaths.length > 0, `No .brarchive fixtures found under ${fixtureInput}`)
  for (const archivePath of archivePaths) {
    const archive = parseBrarchive(await readFile(archivePath))
    for (const entry of archive.entries.filter(candidate => isMcb(candidate.payload))) {
      mcbEntryCount += 1
      try {
        const result = decoder.decode(entry.payload)
        assert.doesNotThrow(() => JSON.stringify(result.value), `${archivePath} :: ${entry.name}`)
        decodedEntryCount += 1
      } catch (error) {
        assert.ok(error instanceof ToolError, `${archivePath} :: ${entry.name} threw an unexpected error: ${String(error)}`)
        restorationFailureCount += 1
        restorationFailures.push(`${error.kind}: ${error.message}`)
      }
    }
  }
  assert.ok(mcbEntryCount > 0, `No MCB entries found under ${fixtureInput}`)
  assert.equal(decodedEntryCount + restorationFailureCount, mcbEntryCount)
  assert.equal(mcbEntryCount, 464)
  assert.equal(decodedEntryCount, 463)
  assert.equal(restorationFailureCount, 1)
  assert.deepEqual(restorationFailures, [
    'missing-schema: No root schema found for document type "minecraft:camera_entity"',
  ])
})
