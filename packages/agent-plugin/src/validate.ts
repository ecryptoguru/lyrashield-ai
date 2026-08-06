import Ajv from "ajv"
import { readFile } from "node:fs/promises"
import path from "node:path"

const ajv = new Ajv({ strict: false })

const pluginSchema = {
  type: "object",
  properties: {
    $schema: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    description: { type: "string" },
    author: {
      type: "object",
      properties: {
        name: { type: "string" },
        url: { type: "string" },
      },
    },
    homepage: { type: "string" },
    repository: { type: "string" },
    license: { type: "string" },
    keywords: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["name", "version"],
} as const

const mcpServerSchema = {
  type: "object",
  properties: {
    type: { enum: ["stdio", "streamable-http", "sse"] },
  },
  required: ["type"],
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        type: { const: "stdio" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["type", "command", "args"],
    },
    {
      additionalProperties: false,
      properties: {
        type: { const: "streamable-http" },
        url: { type: "string" },
      },
      required: ["type", "url"],
    },
    {
      additionalProperties: false,
      properties: {
        type: { const: "sse" },
        url: { type: "string" },
      },
      required: ["type", "url"],
    },
  ],
} as const

const mcpSchema = {
  type: "object",
  properties: {
    $schema: { type: "string" },
    mcpServers: {
      type: "object",
      additionalProperties: mcpServerSchema,
    },
  },
  required: ["mcpServers"],
} as const

const validatePluginJson = ajv.compile(pluginSchema)
const validateMcpJson = ajv.compile(mcpSchema)

export async function validatePlugin(
  pluginRoot: string
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []

  const pluginJsonPath = path.join(pluginRoot, "plugin.json")
  const mcpJsonPath = path.join(pluginRoot, "mcp.json")

  for (const [p, label] of [
    [pluginJsonPath, "plugin.json"],
    [mcpJsonPath, "mcp.json"],
  ] as const) {
    let parsed: unknown
    try {
      const raw = await readFile(p, "utf-8")
      parsed = JSON.parse(raw)
    } catch {
      errors.push(`Missing or unreadable: ${label}`)
      continue
    }

    const isPlugin = label === "plugin.json"
    const valid = isPlugin ? validatePluginJson(parsed) : validateMcpJson(parsed)

    if (!valid) {
      const validationErrors = isPlugin
        ? validatePluginJson.errors
        : validateMcpJson.errors
      for (const err of validationErrors ?? []) {
        const path = err.instancePath ? `${err.instancePath}: ` : ""
        errors.push(`${label}: ${path}${err.message ?? "validation error"}`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}
