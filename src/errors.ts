export type FailureKind =
  | 'invalid-option'
  | 'conflict'
  | 'missing-schema'
  | 'unsupported-schema'
  | 'invalid-mcb'
  | 'decode-error'
  | 'trailing-data'
  | 'invalid-archive'
  | 'io-error'

export class ToolError extends Error {
  readonly kind: FailureKind
  readonly offset?: number
  readonly schemaPath?: string

  constructor(
    kind: FailureKind,
    message: string,
    options: { offset?: number; schemaPath?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ToolError'
    this.kind = kind
    this.offset = options.offset
    this.schemaPath = options.schemaPath
  }
}

export function toToolError(error: unknown, fallbackKind: FailureKind = 'decode-error'): ToolError {
  if (error instanceof ToolError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  return new ToolError(fallbackKind, message, { cause: error })
}
