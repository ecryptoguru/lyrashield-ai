/**
 * WebMCP output and contract budget helpers.
 *
 * Chrome's recommended WebMCP content budgets are approximately:
 * - tool name: 500 characters
 * - tool description: 150 characters
 * - parameter description: 30 characters
 * - tool output: 1,500 characters
 *
 * These are enforced locally before registration and before returning a result
 * so the dashboard never advertises an unbounded tool surface to the agent.
 */

export const WEBMCP_BUDGETS = {
  toolName: 500,
  toolTitle: 150,
  toolDescription: 150,
  paramDescription: 30,
  output: 1_500,
} as const

const ELLIPSIS = "…"

function clampString(value: string, max: number): string {
  if (value.length <= max) return value
  const take = Math.max(0, max - ELLIPSIS.length)
  return `${value.slice(0, take)}${ELLIPSIS}`
}

function clampSerializedString(value: string, max: number): string {
  if (JSON.stringify(value).length <= max) return value

  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${value.slice(0, middle)}${ELLIPSIS}`
    if (JSON.stringify(candidate).length <= max) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low)}${ELLIPSIS}`
}

export function enforceToolName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new Error("WebMCP tool name must not be empty")
  }
  // Name is constrained by the protocol to a small ASCII set, but the budget
  // guard is the local hard ceiling.
  return clampString(trimmed, WEBMCP_BUDGETS.toolName)
}

export function enforceToolTitle(title: string): string {
  return clampString(title.trim(), WEBMCP_BUDGETS.toolTitle)
}

export function enforceToolDescription(description: string): string {
  const trimmed = description.trim()
  if (trimmed.length === 0) {
    throw new Error("WebMCP tool description must not be empty")
  }
  return clampString(trimmed, WEBMCP_BUDGETS.toolDescription)
}

export function enforceParamDescription(description?: string): string {
  if (!description) return ""
  return clampString(description.trim(), WEBMCP_BUDGETS.paramDescription)
}

export interface WebMcpJsonSchemaProperty {
  type: string
  description?: string
  enum?: unknown[]
  properties?: Record<string, WebMcpJsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
  items?: WebMcpJsonSchemaProperty
}

export interface WebMcpObjectSchema {
  type: "object"
  description?: string
  properties: Record<string, WebMcpJsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

export function buildObjectSchema(input: {
  description?: string
  properties: Record<string, WebMcpJsonSchemaProperty>
  required?: string[]
}): WebMcpObjectSchema {
  const boundedProperties: Record<string, WebMcpJsonSchemaProperty> = {}
  for (const [key, prop] of Object.entries(input.properties)) {
    boundedProperties[key] = enforceSchemaProperty(prop)
  }
  return {
    type: "object",
    description: input.description ? enforceToolDescription(input.description) : undefined,
    properties: boundedProperties,
    required: input.required ?? [],
    additionalProperties: false,
  }
}

function enforceSchemaProperty(prop: WebMcpJsonSchemaProperty): WebMcpJsonSchemaProperty {
  const bounded: WebMcpJsonSchemaProperty = { ...prop }

  if (prop.description) {
    bounded.description = enforceParamDescription(prop.description)
  }

  if (prop.properties) {
    bounded.properties = {}
    for (const [key, child] of Object.entries(prop.properties)) {
      bounded.properties[key] = enforceSchemaProperty(child)
    }
  }

  if (prop.items) {
    bounded.items = enforceSchemaProperty(prop.items)
  }

  return bounded
}

export interface WebMcpStructuredOutput<T = unknown> {
  ok: boolean
  output?: T
  error?: string
  cancelled?: boolean
  truncated?: boolean
}

/**
 * Bound an arbitrary value to the output character budget. Objects are
 * serialized to JSON; if the serialized form exceeds the budget they are
 * replaced with a short, agent-safe truncation marker so the response stays
 * valid JSON and never leaks unbounded agent-visible text.
 */
export function boundOutputValue<T>(
  value: T,
  maxChars: number = WEBMCP_BUDGETS.output
): T | { summary: string; truncated: true } {
  if (value === null || value === undefined) {
    return value as T
  }

  if (typeof value === "string") {
    return clampSerializedString(value, maxChars) as T
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value as T
  }

  const serialized = JSON.stringify(value)
  if (serialized.length <= maxChars) return value as T

  return {
    summary: clampString(`Output exceeded the ${maxChars}-character budget.`, maxChars - 20),
    truncated: true,
  }
}

export function wrapToolOutput<T>(
  value: T,
  maxChars: number = WEBMCP_BUDGETS.output
): WebMcpStructuredOutput<T> {
  const bounded = boundOutputValue(value, maxChars - 50)
  if (bounded && typeof bounded === "object" && "truncated" in bounded && bounded.truncated) {
    return { ok: true, output: bounded as T, truncated: true }
  }
  return { ok: true, output: bounded as T }
}

export function wrapToolError(
  error: Error | string,
  maxChars: number = WEBMCP_BUDGETS.output
): WebMcpStructuredOutput {
  const message = error instanceof Error ? error.message : String(error)
  const safe = clampString(message, Math.max(0, maxChars - 50))
  return { ok: false, error: safe }
}

export function wrapToolCancellation(maxChars = WEBMCP_BUDGETS.output): WebMcpStructuredOutput {
  const message = clampString("Tool execution was cancelled", maxChars)
  return { ok: false, cancelled: true, error: message }
}
