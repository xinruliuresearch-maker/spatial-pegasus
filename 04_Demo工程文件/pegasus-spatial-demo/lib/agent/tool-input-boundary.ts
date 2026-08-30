/**
 * Runtime boundary for model-produced tool inputs.
 *
 * TypeScript's ToolUseBlock type is not a trust boundary: provider gateways,
 * partial-stream parsers, tests, and legacy persisted messages can all supply
 * values that are not JSON objects at runtime.  Tool inputs cross several
 * durability boundaries before execution (hashing, checkpoints, Mongo and API
 * logging), so validate them before any of those operations.
 */

import type { ToolSchema } from '../types'

export type ToolInputRejectionCode =
  | 'not_object'
  | 'array_root'
  | 'non_plain_object'
  | 'unsupported_value'
  | 'non_finite_number'
  | 'symbol_key'
  | 'accessor_property'
  | 'non_enumerable_property'
  | 'sparse_array'
  | 'circular_reference'
  | 'serialization_failed'
  | 'unstable_serialization'
  | 'too_deep'
  | 'rejected_marker'
  | 'unknown_tool'
  | 'schema_required'
  | 'schema_type'
  | 'schema_enum'
  | 'schema_constraint'
  | 'schema_one_of'
  | 'invalid_schema'

export interface ToolInputRejection {
  code: ToolInputRejectionCode
  path: string
  message: string
}

export type ToolInputBoundaryResult =
  | {
      ok: true
      /** The exact original object. Legal inputs are never reordered or cloned. */
      input: Record<string, unknown>
      serialized: string
    }
  | {
      ok: false
      rejection: ToolInputRejection
      /** A JSON-safe audit placeholder used in the persisted assistant block. */
      persistedInput: Record<string, unknown>
    }

const MAX_TOOL_INPUT_DEPTH = 256
const INVALID_INPUT_MARKER = '_sci_pegasus_rejected_tool_input'

class ToolInputBoundaryError extends Error {
  constructor(
    readonly code: ToolInputRejectionCode,
    readonly path: string,
    message: string,
  ) {
    super(message)
  }
}

function displayPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parent}.${key}`
  const rendered = JSON.stringify(key)
  return `${parent}[${rendered.length <= 96 ? rendered : `${rendered.slice(0, 92)}...\"`}]`
}

function reject(
  code: ToolInputRejectionCode,
  path: string,
  message: string,
): never {
  throw new ToolInputBoundaryError(code, path, message)
}

function ownDataDescriptor(
  owner: object,
  key: string,
  path: string,
): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  if (!descriptor) {
    return reject('serialization_failed', path, 'property descriptor disappeared during validation')
  }
  if (!('value' in descriptor)) {
    return reject('accessor_property', path, 'accessor properties are not valid JSON tool input')
  }
  if (!descriptor.enumerable) {
    return reject('non_enumerable_property', path, 'non-enumerable properties would be silently omitted by JSON')
  }
  return descriptor
}

function inspectJsonValue(
  value: unknown,
  path: string,
  activeAncestors: Set<object>,
  depth: number,
): void {
  if (depth > MAX_TOOL_INPUT_DEPTH) {
    reject('too_deep', path, `tool input exceeds the ${MAX_TOOL_INPUT_DEPTH}-level safety limit`)
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      reject('non_finite_number', path, 'JSON numbers must be finite')
    }
    return
  }
  if (typeof value !== 'object') {
    reject('unsupported_value', path, `${typeof value} is not a JSON value`)
  }

  const objectValue = value as object
  if (activeAncestors.has(objectValue)) {
    reject('circular_reference', path, 'circular references are not valid JSON')
  }

  const isArray = Array.isArray(objectValue)
  const prototype = Object.getPrototypeOf(objectValue)
  if (prototype !== (isArray ? Array.prototype : Object.prototype) && prototype !== null) {
    reject('non_plain_object', path, 'tool input may contain only plain objects and arrays')
  }
  // JSON.stringify invokes an inherited toJSON hook too. Normally neither
  // Object.prototype nor Array.prototype defines one, but reject a polluted or
  // polyfilled hook rather than executing application-global code here.
  if (prototype) {
    const inheritedToJson = Object.getOwnPropertyDescriptor(prototype, 'toJSON')
    if (inheritedToJson && (
      !('value' in inheritedToJson)
      || typeof inheritedToJson.value === 'function'
    )) {
      reject('unsupported_value', path, 'inherited toJSON hooks are not allowed in tool input')
    }
  }

  activeAncestors.add(objectValue)
  try {
    const keys = Reflect.ownKeys(objectValue)
    const symbolKey = keys.find((key): key is symbol => typeof key === 'symbol')
    if (symbolKey) {
      reject('symbol_key', path, 'symbol-keyed properties are not valid JSON')
    }

    if (isArray) {
      const arrayValue = objectValue as unknown[]
      const elementKeys = (keys as string[]).filter(key => key !== 'length')
      if (elementKeys.length !== arrayValue.length) {
        reject('sparse_array', path, 'sparse arrays or extra array properties are not valid JSON tool input')
      }
      for (let index = 0; index < arrayValue.length; index += 1) {
        const key = String(index)
        if (elementKeys[index] !== key) {
          reject('sparse_array', path, 'sparse arrays or extra array properties are not valid JSON tool input')
        }
        const childPath = displayPath(path, index)
        const descriptor = ownDataDescriptor(objectValue, key, childPath)
        inspectJsonValue(descriptor.value, childPath, activeAncestors, depth + 1)
      }
      return
    }

    for (const key of keys as string[]) {
      const childPath = displayPath(path, key)
      const descriptor = ownDataDescriptor(objectValue, key, childPath)
      inspectJsonValue(descriptor.value, childPath, activeAncestors, depth + 1)
    }
  } finally {
    activeAncestors.delete(objectValue)
  }
}

function rejectionFrom(error: unknown): ToolInputRejection {
  if (error instanceof ToolInputBoundaryError) {
    return {
      code: error.code,
      path: error.path,
      message: error.message,
    }
  }
  return {
    code: 'serialization_failed',
    path: '$',
    message: 'tool input could not be inspected or serialized safely',
  }
}

function persistedRejection(rejection: ToolInputRejection): Record<string, unknown> {
  return {
    [INVALID_INPUT_MARKER]: {
      code: rejection.code,
      path: rejection.path,
      message: rejection.message,
    },
  }
}

function safeRejectionResult(
  rejection: ToolInputRejection,
  persistedInput?: Record<string, unknown>,
): Extract<ToolInputBoundaryResult, { ok: false }> {
  return {
    ok: false,
    rejection,
    persistedInput: persistedInput ?? persistedRejection(rejection),
  }
}

function persistedMarkerRejection(input: Record<string, unknown>): ToolInputRejection | null {
  const descriptor = Object.getOwnPropertyDescriptor(input, INVALID_INPUT_MARKER)
  if (!descriptor || !('value' in descriptor)) return null
  const marker = descriptor.value
  if (marker && typeof marker === 'object' && !Array.isArray(marker)) {
    const code = Object.getOwnPropertyDescriptor(marker, 'code')?.value
    const path = Object.getOwnPropertyDescriptor(marker, 'path')?.value
    return {
      code: 'rejected_marker',
      path: typeof path === 'string' ? path : '$',
      message: `tool input contains the reserved ${INVALID_INPUT_MARKER} marker${typeof code === 'string' ? ` (${code})` : ''}`,
    }
  }
  return {
    code: 'rejected_marker',
    path: '$',
    message: `tool input contains the reserved ${INVALID_INPUT_MARKER} marker`,
  }
}

/**
 * Accept only a plain JSON object and prove that its JSON representation is
 * stable.  The original object is returned on success so valid persisted
 * history retains its byte/key-order semantics.
 */
export function enforceToolInputBoundary(input: unknown): ToolInputBoundaryResult {
  try {
    if (input === null || typeof input !== 'object') {
      reject('not_object', '$', 'tool input must be one JSON object')
    }
    if (Array.isArray(input)) {
      reject('array_root', '$', 'tool input must be an object, not an array')
    }

    inspectJsonValue(input, '$', new Set<object>(), 0)

    const markerRejection = persistedMarkerRejection(input as Record<string, unknown>)
    if (markerRejection) {
      // A rejection placeholder is an audit record, never executable input.
      // Preserve its exact bytes instead of nesting another placeholder around it.
      return safeRejectionResult(markerRejection, input as Record<string, unknown>)
    }

    let serialized: string | undefined
    let secondPass: string | undefined
    try {
      serialized = JSON.stringify(input)
      secondPass = JSON.stringify(input)
    } catch {
      reject('serialization_failed', '$', 'tool input threw while being serialized')
    }
    if (typeof serialized !== 'string' || typeof secondPass !== 'string') {
      reject('serialization_failed', '$', 'tool input did not produce a JSON document')
    }
    if (serialized !== secondPass) {
      reject('unstable_serialization', '$', 'tool input serialization changed between identical passes')
    }

    let roundTrip: string
    try {
      roundTrip = JSON.stringify(JSON.parse(serialized))
    } catch {
      reject('serialization_failed', '$', 'tool input did not survive a JSON round trip')
    }
    if (roundTrip !== serialized) {
      reject('unstable_serialization', '$', 'tool input does not have a stable JSON round trip')
    }

    return {
      ok: true,
      input: input as Record<string, unknown>,
      serialized,
    }
  } catch (error) {
    const rejection = rejectionFrom(error)
    return safeRejectionResult(rejection)
  }
}

type JsonSchema = Record<string, unknown>

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'enum',
  'oneOf',
  'anyOf',
  'items',
  'additionalProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  // Annotation-only keywords used by the current catalogue.
  'description',
  'default',
])

function schemaRejection(
  code: ToolInputRejectionCode,
  path: string,
  message: string,
): ToolInputRejection {
  return { code, path, message }
}

function schemaTypeMatches(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'null': return value === null
    default: return false
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Validate the JSON-Schema subset used by the model-visible tool catalogue.
 * This is intentionally non-coercing: validation observes the original value
 * and never inserts defaults, removes keys, clones, or reorders input.
 */
function validateSchemaValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
): ToolInputRejection | null {
  const unsupportedKeyword = Object.keys(schema).find(key => !SUPPORTED_SCHEMA_KEYWORDS.has(key))
  if (unsupportedKeyword) {
    return schemaRejection('invalid_schema', path, `unsupported tool-schema keyword ${unsupportedKeyword}`)
  }
  if (schema.oneOf !== undefined && !Array.isArray(schema.oneOf)) {
    return schemaRejection('invalid_schema', path, 'tool schema has an invalid oneOf declaration')
  }
  if (schema.anyOf !== undefined && !Array.isArray(schema.anyOf)) {
    return schemaRejection('invalid_schema', path, 'tool schema has an invalid anyOf declaration')
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    return schemaRejection('invalid_schema', path, 'tool schema has an invalid enum declaration')
  }
  if (
    schema.additionalProperties !== undefined
    && typeof schema.additionalProperties !== 'boolean'
    && (!schema.additionalProperties || typeof schema.additionalProperties !== 'object' || Array.isArray(schema.additionalProperties))
  ) {
    return schemaRejection('invalid_schema', path, 'tool schema has an invalid additionalProperties declaration')
  }

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.filter((branch): branch is JsonSchema => (
      branch !== null && typeof branch === 'object' && !Array.isArray(branch)
    ))
    if (branches.length !== schema.oneOf.length) {
      return schemaRejection('invalid_schema', path, 'tool schema contains an invalid oneOf branch')
    }
    const matches = branches.filter(branch => validateSchemaValue(value, branch, path) === null)
    if (matches.length !== 1) {
      return schemaRejection('schema_one_of', path, `value must match exactly one schema branch (matched ${matches.length})`)
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter((branch): branch is JsonSchema => (
      branch !== null && typeof branch === 'object' && !Array.isArray(branch)
    ))
    if (branches.length !== schema.anyOf.length || branches.length === 0) {
      return schemaRejection('invalid_schema', path, 'tool schema contains an invalid anyOf branch')
    }
    if (!branches.some(branch => validateSchemaValue(value, branch, path) === null)) {
      return schemaRejection('schema_constraint', path, 'value must match at least one schema branch')
    }
  }

  const expectedTypes = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type) && schema.type.every(item => typeof item === 'string')
      ? schema.type as string[]
      : []
  if (schema.type !== undefined && expectedTypes.length === 0) {
    return schemaRejection('invalid_schema', path, 'tool schema has an invalid type declaration')
  }
  if (expectedTypes.length > 0 && !expectedTypes.some(expected => schemaTypeMatches(value, expected))) {
    return schemaRejection('schema_type', path, `expected ${expectedTypes.join(' or ')}`)
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => jsonEqual(candidate, value))) {
    return schemaRejection('schema_enum', path, 'value is not one of the allowed enum values')
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return schemaRejection('schema_constraint', path, `string is shorter than minLength ${schema.minLength}`)
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return schemaRejection('schema_constraint', path, `string is longer than maxLength ${schema.maxLength}`)
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          return schemaRejection('schema_constraint', path, 'string does not match the required pattern')
        }
      } catch {
        return schemaRejection('invalid_schema', path, 'tool schema contains an invalid pattern')
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return schemaRejection('schema_constraint', path, `number is below minimum ${schema.minimum}`)
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return schemaRejection(
        'schema_constraint',
        path,
        `number is not above exclusive minimum ${schema.exclusiveMinimum}`,
      )
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return schemaRejection('schema_constraint', path, `number is above maximum ${schema.maximum}`)
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return schemaRejection('schema_constraint', path, `array has fewer than minItems ${schema.minItems}`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return schemaRejection('schema_constraint', path, `array has more than maxItems ${schema.maxItems}`)
    }
    if (schema.uniqueItems === true) {
      for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          if (jsonEqual(value[left], value[right])) {
            return schemaRejection('schema_constraint', displayPath(path, right), 'array items must be unique')
          }
        }
      }
    }
    if (schema.items !== undefined) {
      if (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)) {
        return schemaRejection('invalid_schema', path, 'tool schema contains invalid array items')
      }
      for (let index = 0; index < value.length; index += 1) {
        const rejection = validateSchemaValue(
          value[index],
          schema.items as JsonSchema,
          displayPath(path, index),
        )
        if (rejection) return rejection
      }
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const properties = schema.properties === undefined
      ? {}
      : schema.properties
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      return schemaRejection('invalid_schema', path, 'tool schema contains invalid object properties')
    }
    const propertySchemas = properties as Record<string, unknown>
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || !schema.required.every(item => typeof item === 'string')) {
        return schemaRejection('invalid_schema', path, 'tool schema contains an invalid required list')
      }
      for (const required of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(record, required)) {
          return schemaRejection('schema_required', displayPath(path, required), `required property ${required} is missing`)
        }
      }
    }
    for (const key of Object.keys(record)) {
      const propertySchema = propertySchemas[key]
      if (propertySchema !== undefined) {
        if (!propertySchema || typeof propertySchema !== 'object' || Array.isArray(propertySchema)) {
          return schemaRejection('invalid_schema', displayPath(path, key), 'tool schema contains an invalid property schema')
        }
        const rejection = validateSchemaValue(
          record[key],
          propertySchema as JsonSchema,
          displayPath(path, key),
        )
        if (rejection) return rejection
        continue
      }
      if (schema.additionalProperties === false) {
        return schemaRejection('schema_constraint', displayPath(path, key), 'additional property is not allowed')
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !Array.isArray(schema.additionalProperties)) {
        const rejection = validateSchemaValue(
          record[key],
          schema.additionalProperties as JsonSchema,
          displayPath(path, key),
        )
        if (rejection) return rejection
      }
    }
  }

  return null
}

/**
 * Complete execution boundary for a model-produced tool call. The input must
 * be JSON-safe and match one of the exact schemas exposed to this provider.
 */
export function enforceVisibleToolInputBoundary(
  toolName: unknown,
  input: unknown,
  visibleSchemas: readonly ToolSchema[],
): ToolInputBoundaryResult {
  const jsonBoundary = enforceToolInputBoundary(input)
  if (!jsonBoundary.ok) return jsonBoundary

  const schema = typeof toolName === 'string'
    ? visibleSchemas.find(candidate => candidate.name === toolName)
    : undefined
  if (!schema) {
    return safeRejectionResult({
      code: 'unknown_tool',
      path: '$',
      message: 'tool is not present in the schemas visible to this Agent',
    })
  }

  const rejection = validateSchemaValue(jsonBoundary.input, schema.input_schema, '$')
  return rejection
    ? safeRejectionResult(rejection)
    : jsonBoundary
}

export function isRejectedToolInput(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  return Object.prototype.hasOwnProperty.call(input, INVALID_INPUT_MARKER)
}

export function rejectedToolInputResultMessage(rejection: ToolInputRejection): string {
  return [
    `Tool input rejected before execution (${rejection.code} at ${rejection.path}): ${rejection.message}.`,
    'The tool was not run. Re-issue the tool call with one plain JSON object matching its input schema.',
  ].join(' ')
}
