import { lstat, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

/**
 * Atomically write a file with a temp-and-rename pattern. The temp file is
 * created with O_EXCL so a pre-existing file or symlink cannot be hijacked, and
 * the final path is re-validated with lstat after the rename to ensure it is a
 * regular file and not a dangling or followed symlink.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const absolutePath = resolve(filePath)
  const tmp = `${absolutePath}.${randomUUID()}.lyrashield-tmp`

  // O_EXCL: fail if the temp path already exists (including as a symlink).
  // This prevents a symlink attack where an attacker points the temp path at
  // another file and we overwrite the target.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(tmp, content, { encoding: "utf-8", flag: "wx" })

  // filePath is the resolved installer target path selected for this workspace.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await rename(tmp, absolutePath)

  // Re-validate the final path is a regular file and that the rename landed in
  // the expected place, not through a later-created symlink.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const stat = await lstat(absolutePath)
  if (!stat.isFile()) {
    throw new Error(`Atomic write did not produce a regular file: ${absolutePath}`)
  }
}
