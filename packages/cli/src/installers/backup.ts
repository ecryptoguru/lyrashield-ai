import { copyFile, access } from "node:fs/promises"

export async function backupFile(filePath: string): Promise<string | undefined> {
  try {
    await access(filePath)
  } catch {
    return undefined
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = `${filePath}.lyrashield-backup-${stamp}`
  await copyFile(filePath, backupPath)
  return backupPath
}
