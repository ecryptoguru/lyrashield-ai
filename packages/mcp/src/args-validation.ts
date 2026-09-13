/**
 * Minimal JSON-schema validator for the inputSchema subset LyraShield tools
 * declare: type, properties, required, items, enum, minLength/maxLength,
 * minimum/maximum, minItems/maxItems, additionalProperties. Returns a list of
 * field-level errors; empty means the args are valid for the tool.
 */
type Schema = {
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  enum?: unknown[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  additionalProperties?: boolean
}

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value // object | string | number | boolean | undefined
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  return typeOf(value) === type
}

function validate(value: unknown, schema: Schema, path: string, errors: string[]): void {
  if (schema.enum && !schema.enum.some((v) => v === value)) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
    return
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    errors.push(`${path} must be ${types.join(" or ")}, got ${typeOf(value)}`)
    return
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path} is shorter than ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path} exceeds ${schema.maxLength} characters`)
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} is below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path} exceeds ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path} has fewer than ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path} has more than ${schema.maxItems} items`)
    if (schema.items)
      value.forEach((item, i) => validate(item, schema.items!, `${path}[${i}]`, errors))
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const req of schema.required ?? []) {
      if (!(req in obj) || obj[req] === undefined) errors.push(`missing required argument "${req}"`)
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined)
        validate(obj[key], propSchema, path ? `${path}.${key}` : key, errors)
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) errors.push(`unexpected argument "${key}"`)
      }
    }
  }
}

export function validateToolArgs(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>
): string[] {
  const errors: string[] = []
  validate(args, inputSchema as Schema, "", errors)
  return errors
}
