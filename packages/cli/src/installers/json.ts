import { readFile, writeFile, rename, access } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { backupFile } from "./backup.js"

function detectIndent(text: string): string {
  const m = text.match(/^(\s+)\S/m)
  if (m && m[1]) return m[1].startsWith("\t") ? "\t" : m[1]
  return "  "
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.lyrashield-tmp`
  // tmp is a sibling file generated from the same resolved target path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(tmp, content, "utf-8")
  // filePath is the resolved installer target path selected for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await rename(tmp, filePath)
}

function setIn(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown
): Record<string, unknown> {
  let current: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    let next = current[key] as Record<string, unknown> | undefined
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      next = {}
      current[key] = next
    }
    current = next
  }
  const last = path[path.length - 1]!
  current[last] = value
  return obj
}

function equals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface JsonMergeOptions {
  filePath: string
  rootKey: string
  serverName: string
  value: unknown
  dryRun?: boolean
}

export interface JsonMergeResult {
  changed: boolean
  backupPath?: string
}

export async function mergeJson(opts: JsonMergeOptions): Promise<JsonMergeResult> {
  const { filePath, rootKey, serverName, value, dryRun } = opts
  let original = "{}"
  let exists = false
  try {
    await access(filePath)
    // filePath is the resolved installer target path for this workspace.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    original = await readFile(filePath, "utf-8")
    exists = true
  } catch {
    // file does not exist
  }

  let parsed: Record<string, unknown>
  if (exists) {
    parsed = JSON.parse(original) as Record<string, unknown>
  } else {
    parsed = {}
  }

  const before = JSON.stringify(parsed)
  setIn(parsed, [rootKey, serverName], value)

  const indent = exists ? detectIndent(original) : "  "
  const trailing = original.match(/\n\s*$/) ? "\n" : ""
  const newContent = JSON.stringify(parsed, null, indent) + (exists ? trailing : "\n")

  if (before === JSON.stringify(parsed)) {
    return { changed: false }
  }

  if (dryRun) {
    return { changed: true }
  }

  const backupPath = await backupFile(filePath)
  // parent is the directory of the resolved installer target path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(path.dirname(filePath), { recursive: true })
  await atomicWrite(filePath, newContent)

  // re-read and verify
  // filePath is the resolved installer target path for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const reread = JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>
  const inserted = (reread[rootKey] as Record<string, unknown> | undefined)?.[serverName]
  if (!equals(inserted, value)) {
    throw new Error(`Verification failed: entry not found at ${rootKey}.${serverName} after write`)
  }

  return { changed: true, backupPath }
}

export interface JsonRemoveOptions {
  filePath: string
  rootKey: string
  serverName: string
}

export async function removeJson(opts: JsonRemoveOptions): Promise<boolean> {
  const { filePath, rootKey, serverName } = opts
  try {
    await access(filePath)
  } catch {
    return false
  }
  // filePath is the resolved installer target path for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const original = await readFile(filePath, "utf-8")
  const parsed = JSON.parse(original) as Record<string, unknown>
  const root = parsed[rootKey] as Record<string, unknown> | undefined
  if (!root || !(serverName in root)) return false
  delete root[serverName]
  if (Object.keys(root).length === 0) delete parsed[rootKey]
  const indent = detectIndent(original)
  const trailing = original.match(/\n\s*$/) ? "\n" : ""
  await backupFile(filePath)
  await atomicWrite(filePath, JSON.stringify(parsed, null, indent) + trailing)
  return true
}
