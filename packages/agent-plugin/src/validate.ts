/* eslint-disable security/detect-non-literal-fs-filename */
import Ajv2020 from "ajv/dist/2020.js"
import { readFile } from "node:fs/promises"
import path from "node:path"

import pluginSchema from "../schemas/plugin.schema.json" with { type: "json" }
import mcpSchema from "../schemas/mcp.schema.json" with { type: "json" }

const ajv = new Ajv2020({ strict: false })
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
      const validationErrors = isPlugin ? validatePluginJson.errors : validateMcpJson.errors
      for (const err of validationErrors ?? []) {
        const path = err.instancePath ? `${err.instancePath}: ` : ""
        errors.push(`${label}: ${path}${err.message ?? "validation error"}`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}
