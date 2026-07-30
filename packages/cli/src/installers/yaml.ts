import { access, readFile, writeFile, rename } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { backupFile } from "./backup.js"

function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.lyrashield-tmp`
  return writeFile(tmp, content, "utf-8").then(() => rename(tmp, filePath))
}

function equals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface YamlMergeOptions {
  filePath: string
  rootKey: string
  serverName: string
  value: unknown
  dryRun?: boolean
}

export interface YamlMergeResult {
  changed: boolean
  backupPath?: string
}

export async function mergeYaml(opts: YamlMergeOptions): Promise<YamlMergeResult> {
  const { filePath, rootKey, serverName, value, dryRun } = opts
  let content = ""
  let exists = false
  try {
    await access(filePath)
    content = await readFile(filePath, "utf-8")
    exists = true
  } catch {
    content = ""
  }

  const doc = content ? YAML.parseDocument(content) : new YAML.Document({})
  if (!doc.contents || doc.contents instanceof YAML.Scalar) {
    doc.contents = doc.createNode({})
  }
  const rootMap = doc.get(rootKey) as YAML.YAMLMap | undefined
  if (!rootMap) {
    doc.set(rootKey, doc.createNode({}))
  }
  const map = doc.get(rootKey) as YAML.YAMLMap
  const before = equals(map.toJSON()?.[serverName], value)
  map.set(serverName, doc.createNode(value))

  const newContent = doc.toString()
  if (exists && before) {
    return { changed: false }
  }

  if (dryRun) {
    return { changed: true }
  }

  const backupPath = await backupFile(filePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await atomicWrite(filePath, newContent)

  const reread = YAML.parseDocument(await readFile(filePath, "utf-8"))
  const rereadRoot = reread.get(rootKey) as YAML.YAMLMap | undefined
  if (!equals(rereadRoot?.toJSON()?.[serverName], value)) {
    throw new Error(
      `Verification failed: entry not found at ${rootKey}.${serverName} after YAML write`
    )
  }

  return { changed: true, backupPath }
}

export interface YamlRemoveOptions {
  filePath: string
  rootKey: string
  serverName: string
}

export async function removeYaml(opts: YamlRemoveOptions): Promise<boolean> {
  const { filePath, rootKey, serverName } = opts
  try {
    await access(filePath)
  } catch {
    return false
  }
  const content = await readFile(filePath, "utf-8")
  const doc = YAML.parseDocument(content)
  const root = doc.get(rootKey) as YAML.YAMLMap | undefined
  if (!root || !root.has(serverName)) return false
  root.delete(serverName)
  if (root.items.length === 0) doc.delete(rootKey)
  await backupFile(filePath)
  await atomicWrite(filePath, doc.toString())
  return true
}
