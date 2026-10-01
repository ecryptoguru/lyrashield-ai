import { access, readFile } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
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
  return isDeepStrictEqual(a, b)
}

type MultilineStringDelimiter = '"""' | "'''"

function scanTomlLine(line: string, multiline: MultilineStringDelimiter | undefined) {
  let index = 0
  while (index < line.length) {
    if (multiline) {
      if (multiline === '"""' && line[index] === "\\") {
        index += 2
      } else if (line.startsWith(multiline, index)) {
        multiline = undefined
        index += 3
      } else {
        index++
      }
      continue
    }

    const character = line[index]!
    if (character === "#") break
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      multiline = line.slice(index, index + 3) as MultilineStringDelimiter
      index += 3
      continue
    }
    if (character === '"' || character === "'") {
      const quote = character
      index++
      while (index < line.length) {
        if (quote === '"' && line[index] === "\\") {
          index += 2
        } else if (line[index] === quote) {
          index++
          break
        } else {
          index++
        }
      }
      continue
    }
    index++
  }
  return multiline
}

function findSectionRange(
  text: string,
  rootKey: string,
  serverName: string,
  fromOffset = 0
): { start: number; end: number } | undefined {
  const header = `[${rootKey}.${serverName}]`
  const lines = text.split("\n")
  const lineStarts: number[] = [0]
  for (let i = 1; i < lines.length; i++) {
    lineStarts.push(lineStarts[i - 1]! + lines[i - 1]!.length + 1)
  }

  let startLine = -1
  let multiline: MultilineStringDelimiter | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const leadingWhitespace = line.match(/^[\t ]*/)?.[0] ?? ""
    const candidate = line.slice(leadingWhitespace.length)
    if (!multiline && lineStarts[i]! >= fromOffset && candidate.startsWith(header)) {
      const suffix = candidate.slice(header.length).trimStart()
      if (suffix.length === 0 || suffix.startsWith("#")) {
        startLine = i
      }
    }

    if (startLine !== -1 && lineStarts[i]! >= fromOffset) break
    multiline = scanTomlLine(line, multiline)
  }
  if (startLine === -1) return undefined

  const subPrefix = `[${rootKey}.${serverName}.`
  let endLine = lines.length
  multiline = undefined

  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i]!
    const tableHeader = !multiline && /^\s*\[/.test(line)
    if (tableHeader) {
      if (!line.trim().startsWith(subPrefix)) {
        endLine = i
        break
      }
    }
    multiline = scanTomlLine(line, multiline)
  }

  // Keep comments and whitespace that lead into the next table (or trail the
  // file); TOML convention attaches those lines to the following content.
  let preservedBlockLine = endLine
  for (let i = endLine - 1; i > startLine; i--) {
    const line = lines[i]!.trim()
    if (line !== "" && !line.startsWith("#")) break
    preservedBlockLine = i
  }

  return { start: lineStarts[startLine]!, end: lineStarts[preservedBlockLine]! }
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
  mode?: number
}

export interface TomlMergeResult {
  changed: boolean
  backupPath?: string
}

export async function mergeToml(opts: TomlMergeOptions): Promise<TomlMergeResult> {
  const { filePath, rootKey, serverName, value, dryRun, mode } = opts
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

  const originalParsed = (exists ? TOML.parse(original) : {}) as Record<string, unknown>
  if (exists) {
    if (
      Object.prototype.hasOwnProperty.call(originalParsed, rootKey) &&
      !isJsonObject(originalParsed[rootKey])
    ) {
      throw new Error(`Cannot merge into the existing non-table value at ${rootKey}`)
    }
  }

  const newEntry = buildEntry(rootKey, serverName, value)
  const range = exists ? findSectionRange(original, rootKey, serverName) : undefined
  const originalRoot = isJsonObject(originalParsed[rootKey]) ? originalParsed[rootKey] : undefined
  if (originalRoot && Object.hasOwn(originalRoot, serverName) && !range) {
    throw new Error(`Cannot safely replace inline TOML entry at ${rootKey}.${serverName}`)
  }

  const expected = structuredClone(originalParsed)
  const expectedRoot: Record<string, unknown> = isJsonObject(expected[rootKey])
    ? expected[rootKey]
    : {}
  expected[rootKey] = expectedRoot
  expectedRoot[serverName] = value

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
  if (!equals(candidate, expected)) {
    throw new Error(`Cannot safely merge entry at ${rootKey}.${serverName} in this TOML file`)
  }

  if (dryRun) {
    return { changed: true }
  }

  const backupPath = await backupFile(filePath, { mode })
  // parent is the directory of the resolved installer target path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(path.dirname(filePath), { recursive: true })
  await atomicWrite(filePath, newContent, { expectedContent: exists ? original : null, mode })

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

    const candidateContent = original.slice(0, range.start) + original.slice(range.end)
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
