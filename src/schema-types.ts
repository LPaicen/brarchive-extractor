export interface JsonSchema {
  [key: string]: unknown
  $id?: string
  $ref?: string
  title?: string
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: JsonSchema | boolean
  items?: JsonSchema | JsonSchema[]
  oneOf?: JsonSchema[]
  enum?: unknown[]
  default?: unknown
  minItems?: number
  maxItems?: number
  'x-format-version'?: string
  'x-ordinal-index'?: number
  'x-underlying-type'?: string
  'x-key-underlying-type'?: string
}

export interface SchemaDocument {
  filePath: string
  id: string
  title?: string
  version?: string
  schema: JsonSchema
}

export interface ResolvedSchema {
  document: SchemaDocument
  schema: JsonSchema
}
