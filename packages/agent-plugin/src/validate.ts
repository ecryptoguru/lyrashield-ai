/* eslint-disable security/detect-non-literal-fs-filename */
import Ajv2020 from "ajv/dist/2020.js"
import { lstat, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { parse as parseYaml } from "yaml"

import pluginSchema from "../schemas/plugin.schema.json" with { type: "json" }
import mcpSchema from "../schemas/mcp.schema.json" with { type: "json" }

const ajv = new Ajv2020({ strict: false })
const validatePluginJson = ajv.compile(pluginSchema)
const validateMcpJson = ajv.compile(mcpSchema)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isValidSkillName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  return name.split("-").every(
    (part) =>
      part.length > 0 &&
      part.split("").every((character) => {
        const lowerAlpha = character >= "a" && character <= "z"
        const digit = character >= "0" && character <= "9"
        return lowerAlpha || digit
      })
  )
}

async function validateSkills(pluginRoot: string, errors: string[]): Promise<void> {
  const skillsRoot = path.join(pluginRoot, "skills")
  let skillsStat
  try {
    skillsStat = await lstat(skillsRoot)
  } catch {
    errors.push("Missing required component directory: skills/")
    return
  }
  if (skillsStat.isSymbolicLink() || !skillsStat.isDirectory()) {
    errors.push("skills/ must be a real directory within the plugin root")
    return
  }

  const skillEntries = await readdir(skillsRoot, { withFileTypes: true })
  const directories = skillEntries.filter((entry) => entry.isDirectory())
  if (directories.length === 0) errors.push("skills/ must contain at least one skill directory")

  for (const entry of skillEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      errors.push(`Unsupported entry in skills/: ${entry.name}`)
      continue
    }
    if (!isValidSkillName(entry.name)) {
      errors.push(`Invalid skill directory name: ${entry.name}`)
      continue
    }

    const skillRoot = path.resolve(skillsRoot, entry.name)
    const relativeSkillPath = path.relative(path.resolve(skillsRoot), skillRoot)
    if (relativeSkillPath.startsWith("..") || path.isAbsolute(relativeSkillPath)) {
      errors.push(`Skill path escapes skills/: ${entry.name}`)
      continue
    }

    const skillFile = path.join(skillRoot, "SKILL.md")
    let skillStat
    try {
      skillStat = await lstat(skillFile)
    } catch {
      errors.push(`${entry.name}/SKILL.md is required`)
      continue
    }
    if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
      errors.push(`${entry.name}/SKILL.md must be a regular file`)
      continue
    }

    const content = await readFile(skillFile, "utf-8")
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (!frontmatter?.[1]) {
      errors.push(`${entry.name}/SKILL.md must start with YAML frontmatter`)
      continue
    }

    let metadata: unknown
    try {
      metadata = parseYaml(frontmatter[1], { uniqueKeys: true })
    } catch {
      errors.push(`${entry.name}/SKILL.md has invalid YAML frontmatter`)
      continue
    }
    if (!isRecord(metadata)) {
      errors.push(`${entry.name}/SKILL.md frontmatter must be a mapping`)
      continue
    }
    if (metadata.name !== entry.name) {
      errors.push(`${entry.name}/SKILL.md frontmatter name must match its directory`)
    }
    if (
      typeof metadata.description !== "string" ||
      metadata.description.trim().length === 0 ||
      metadata.description.length > 1024
    ) {
      errors.push(`${entry.name}/SKILL.md needs a description between 1 and 1024 characters`)
    }
    if (/\blsk_[A-Za-z0-9]{24,}\b/.test(content)) {
      errors.push(`Credential-like LyraShield key detected in skills/${entry.name}/SKILL.md`)
    }
  }
}

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

  await validateSkills(pluginRoot, errors)

  return { ok: errors.length === 0, errors }
}
