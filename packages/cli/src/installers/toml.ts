import { access, readFile } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import * as TOML from "@iarna/toml"
import { isJsonObject } from "@lyrashield/types"
import { backupFile } from "./backup.js"
import { atomicWrite } from "./atomic-write.js"

function toTomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v)
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) return `[${v.map(toTomlValue).join(", ")}]`
  return "{}"
}

function renderSectionHeader(prefix: string): string {
  return `[${prefix}]`
}

function renderTable(prefix: string, value: Record<string, unknown>): string[] {
  const lines = [renderSectionHeader(prefix), ""]
  for (const [k, v] of Object.entries(value)) {
    if (isJsonObject(v)) {
      continue
    }
    lines.push(`${k} = ${toTomlValue(v)}`)
  }
  for (const [k, v] of Object.entries(value)) {
    if (isJsonObject(v)) {
      lines.push(...renderTable(`${prefix}.${k}`, v))
    }
  }
  return lines
}

function equals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function findSectionRange(
  text: string,
  rootKey: string,
  serverName: string,
  fromOffset = 0
): { start: number; end: number } | undefined {
  const header = `[${rootKey}.${serverName}]`
  let start = -1
  let lineOffset = 0
  for (const line of text.split("\n")) {
    const leadingWhitespace = line.match(/^[\t ]*/)?.[0] ?? ""
    const candidate = line.slice(leadingWhitespace.length)
    if (lineOffset >= fromOffset && candidate.startsWith(header)) {
      const suffix = candidate.slice(header.length).trimStart()
      if (suffix.length === 0 || suffix.startsWith("#")) {
        start = lineOffset
        break
      }
    }
    lineOffset += line.length + 1
  }
  if (start === -1) return undefined

  const lines = text.slice(start).split("\n")
  let endOffset = lines[0]!.length
  const subPrefix = `[${rootKey}.${serverName}.`

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    const tableHeader = /^\s*\[/.test(line)
    if (tableHeader) {
      if (line.trim().startsWith(subPrefix)) {
        endOffset += 1 + line.length
        continue
      }
      break
    }
    endOffset += 1 + line.length
  }

  return { start, end: start + endOffset }
}

function buildEntry(rootKey: string, serverName: string, value: unknown): string {
  if (!isJsonObject(value)) {
    return renderTable(`${rootKey}.${serverName}`, { value }).join("\n") + "\n"
  }
  return renderTable(`${rootKey}.${serverName}`, value).join("\n") + "\n"
}

export interface TomlMergeOptions {
  filePath: string
  rootKey: string
  serverName: string
  value: unknown
  dryRun?: boolean
}

export interface TomlMergeResult {
  changed: boolean
  backupPath?: string
}

export async function mergeToml(opts: TomlMergeOptions): Promise<TomlMergeResult> {
  const { filePath, rootKey, serverName, value, dryRun } = opts
  let original = ""
  let exists = false
  try {
    await access(filePath)
    // filePath is the resolved installer target path for this workspace.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    original = await readFile(filePath, "utf-8")
    exists = true
  } catch {
    original = ""
  }

  if (exists) {
    const parsed = TOML.parse(original) as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(parsed, rootKey) && !isJsonObject(parsed[rootKey])) {
      throw new Error(`Cannot merge into the existing non-table value at ${rootKey}`)
    }
  }

  const newEntry = buildEntry(rootKey, serverName, value)
  const range = exists ? findSectionRange(original, rootKey, serverName) : undefined

  let newContent: string
  if (!exists) {
    newContent = newEntry
  } else if (!range) {
    const sep = original.endsWith("\n") ? "" : "\n"
    newContent = original + sep + newEntry
  } else {
    newContent = original.slice(0, range.start) + newEntry + original.slice(range.end)
  }

  if (exists && original === newContent) {
    return { changed: false }
  }

  const candidate = TOML.parse(newContent) as Record<string, unknown>
  const candidateRoot = candidate[rootKey]
  const insertedCandidate = isJsonObject(candidateRoot) ? candidateRoot[serverName] : undefined
  if (!equals(insertedCandidate, value)) {
    throw new Error(`Cannot safely merge entry at ${rootKey}.${serverName} in this TOML file`)
  }

  if (dryRun) {
    return { changed: true }
  }

  const backupPath = await backupFile(filePath)
  // parent is the directory of the resolved installer target path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(path.dirname(filePath), { recursive: true })
  await atomicWrite(filePath, newContent, { expectedContent: exists ? original : null })

  // filePath is the resolved installer target path for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const reread = TOML.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>
  const inserted = (reread[rootKey] as Record<string, unknown> | undefined)?.[serverName]
  if (!equals(inserted, value)) {
    throw new Error(
      `Verification failed: entry not found at ${rootKey}.${serverName} after TOML write`
    )
  }

  return { changed: true, backupPath }
}

export interface TomlRemoveOptions {
  filePath: string
  rootKey: string
  serverName: string
}

export async function removeToml(opts: TomlRemoveOptions): Promise<boolean> {
  const { filePath, rootKey, serverName } = opts
  try {
    await access(filePath)
  } catch {
    return false
  }
  // filePath is the resolved installer target path for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const original = await readFile(filePath, "utf-8")
  const parsed = TOML.parse(original) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(parsed, rootKey) && !isJsonObject(parsed[rootKey])) {
    throw new Error(`Cannot remove from the existing non-table value at ${rootKey}`)
  }
  const root = isJsonObject(parsed[rootKey]) ? parsed[rootKey] : undefined
  if (!root || !Object.prototype.hasOwnProperty.call(root, serverName)) return false
  const expected = structuredClone(parsed)
  const expectedRoot = expected[rootKey] as Record<string, unknown>
  delete expectedRoot[serverName]
  if (Object.keys(expectedRoot).length === 0) delete expected[rootKey]

  let newContent: string | undefined
  let searchFrom = 0
  for (;;) {
    const range = findSectionRange(original, rootKey, serverName, searchFrom)
    if (!range) break
    searchFrom = range.start + 1

    let candidateContent = original.slice(0, range.start) + original.slice(range.end)
    // remove trailing blank lines
    candidateContent = candidateContent.replace(/\n\n\n+/g, "\n\n")
    try {
      const candidate = TOML.parse(candidateContent) as Record<string, unknown>
      if (equals(candidate, expected)) {
        newContent = candidateContent
        break
      }
    } catch {
      // A table-looking line inside a multiline string is not a removable table.
    }
  }
  if (newContent === undefined) {
    throw new Error(`Cannot safely remove ${rootKey}.${serverName} from this TOML file`)
  }
  await backupFile(filePath)
  await atomicWrite(filePath, newContent, { expectedContent: original })
  return true
}
