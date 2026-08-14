import {
  applyEdits,
  createScanner,
  format as formatJsonc,
  parseTree as parseJsoncTree,
  printParseErrorCode,
  SyntaxKind,
  type ParseError,
} from 'jsonc-parser'
import { ToolError } from './errors.js'
import type { JsonFormat, RunOptions } from './runner-types.js'

export interface JsonOutputSettings {
  format: JsonFormat
  formatAllJson: boolean
  indentation: string
}

export function jsonOutputSettings(options: RunOptions): JsonOutputSettings {
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

export function serializeJson(value: unknown, settings: JsonOutputSettings): string {
  if (settings.format === 'compact') {
    return JSON.stringify(value)
  }
  return `${JSON.stringify(value, null, settings.indentation)}\n`
}

function validateJsonWithComments(text: string): void {
  const errors: ParseError[] = []
  parseJsoncTree(text, errors, { allowTrailingComma: false, disallowComments: false })
  if (errors.length === 0) {
    return
  }

  const first = errors[0]!
  throw new SyntaxError(`${printParseErrorCode(first.error)} at offset ${first.offset}`)
}

function compactJsonWithComments(text: string): string {
  const scanner = createScanner(text, false)
  const tokens: Array<{ kind: SyntaxKind; text: string }> = []
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    if (kind === SyntaxKind.Trivia || kind === SyntaxKind.LineBreakTrivia) {
      continue
    }
    const offset = scanner.getTokenOffset()
    tokens.push({ kind, text: text.slice(offset, offset + scanner.getTokenLength()) })
  }

  let result = ''
  for (const [index, token] of tokens.entries()) {
    result += token.text
    if (token.kind === SyntaxKind.LineCommentTrivia && index + 1 < tokens.length) {
      result += '\n'
    }
  }
  return result
}

export function formatJsonWithComments(text: string, settings: JsonOutputSettings): string {
  validateJsonWithComments(text)
  const normalizedText = text.replace(/\r\n?/g, '\n')
  if (settings.format === 'compact') {
    return compactJsonWithComments(normalizedText)
  }
  if (settings.indentation.length === 0) {
    return `${compactJsonWithComments(normalizedText)}\n`
  }

  const insertSpaces = settings.indentation[0] === ' '
  let formatted = applyEdits(
    normalizedText,
    formatJsonc(normalizedText, undefined, {
      eol: '\n',
      insertFinalNewline: true,
      insertSpaces,
      tabSize: insertSpaces ? settings.indentation.length : 1,
    }),
  )
  if (!insertSpaces && settings.indentation.length > 1) {
    formatted = formatted.replace(/^\t+/gm, indentation => indentation.repeat(settings.indentation.length))
  }
  return formatted.endsWith('\n') ? formatted : `${formatted}\n`
}
