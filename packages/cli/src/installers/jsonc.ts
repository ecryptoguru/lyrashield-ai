import { access, readFile, writeFile, rename } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { modify, applyEdits, parse as parseJsonc } from "jsonc-parser"
import { backupFile } from "./backup.js"

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.lyrashield-tmp`
  // tmp is a sibling file generated from the same resolved target path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(tmp, content, "utf-8")
  // filePath is the resolved installer target path selected for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await rename(tmp, filePath)
}

function equals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface JsoncMergeOptions {
  filePath: string
  rootKey: string
  serverName: string
  value: unknown
  dryRun?: boolean
}

export interface JsoncMergeResult {
  changed: boolean
  backupPath?: string
}

export async function mergeJsonc(opts: JsoncMergeOptions): Promise<JsoncMergeResult> {
  const { filePath, rootKey, serverName, value, dryRun } = opts
  let original = "{}"
  try {
    await access(filePath)
    // filePath is the resolved installer target path for this workspace.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    original = await readFile(filePath, "utf-8")
  } catch {
    // new file
  }

  const before = parseJsonc(original) ?? {}
  const edits = modify(original, [rootKey, serverName], value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: "\n",
    },
  })

  if (!edits.length) {
    return { changed: false }
  }

  const newContent = applyEdits(original, edits)
  const after = parseJsonc(newContent) ?? {}

  if (
    before &&
    after &&
    equals(
      (before as Record<string, unknown>)[rootKey],
      (after as Record<string, unknown>)[rootKey]
    )
  ) {
    // No meaningful change at this root key.
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

  // filePath is the resolved installer target path for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const reread = (parseJsonc(await readFile(filePath, "utf-8")) ?? {}) as Record<string, unknown>
  const root = reread[rootKey] as Record<string, unknown> | undefined
  if (!equals(root?.[serverName], value)) {
    throw new Error(
      `Verification failed: entry not found at ${rootKey}.${serverName} after JSONC write`
    )
  }

  return { changed: true, backupPath }
}

export interface JsoncRemoveOptions {
  filePath: string
  rootKey: string
  serverName: string
}

export async function removeJsonc(opts: JsoncRemoveOptions): Promise<boolean> {
  const { filePath, rootKey, serverName } = opts
  try {
    await access(filePath)
  } catch {
    return false
  }
  // filePath is the resolved installer target path for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const original = await readFile(filePath, "utf-8")
  const before = (parseJsonc(original) ?? {}) as Record<string, unknown>
  const root = before[rootKey] as Record<string, unknown> | undefined
  if (!root || !(serverName in root)) return false

  const edits = modify(original, [rootKey, serverName], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  })
  if (!edits.length) return false

  const newContent = applyEdits(original, edits)
  await backupFile(filePath)
  await atomicWrite(filePath, newContent)
  return true
}
