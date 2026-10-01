import { lstat, open } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { assertSafeDestination, atomicWrite } from "./atomic-write.js"

export async function backupFile(filePath: string): Promise<string | undefined> {
  await assertSafeDestination(filePath)

  let sourceStat: Stats
  try {
    // filePath is the resolved installer destination selected by the caller.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    sourceStat = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  }
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to back up a symlinked destination file: ${filePath}`)
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Refusing to back up a non-file destination: ${filePath}`)
  }

  // filePath is the resolved installer destination selected by the caller.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = await open(filePath, "r")
  try {
    const openedStat = await source.stat()
    if (openedStat.dev !== sourceStat.dev || openedStat.ino !== sourceStat.ino) {
      throw new Error(`The file changed while creating its backup: ${filePath}`)
    }
    const content = await source.readFile("utf-8")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupPath = `${filePath}.lyrashield-backup-${stamp}-${randomUUID()}`
    await atomicWrite(backupPath, content, { mode: sourceStat.mode & 0o777 })
    return backupPath
  } finally {
    await source.close()
  }
}
