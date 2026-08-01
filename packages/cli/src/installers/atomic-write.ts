import { lstat, open, rename, realpath } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"

/**
 * Atomically write a file with a temp-and-rename pattern. The temp file is
 * created with O_EXCL so a pre-existing file or symlink cannot be hijacked,
 * fsynced before the rename for durability, and the final path is re-validated
 * with lstat after the rename to ensure it is a regular file and not a dangling
 * or followed symlink. The destination directory is resolved and checked so a
 * parent-path symlink cannot redirect the write outside the intended location.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const absolutePath = resolve(filePath)

  // Validate the parent directory chain: if any parent is a symlink, the write
  // could land outside the intended target (e.g. /tmp/link -> /etc). Resolve the
  // directory and confirm the real path matches the requested directory.
  const dir = dirname(absolutePath)
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const realDir = await realpath(dir)
    if (realDir !== dir) {
      throw new Error(`Refusing to write through a symlinked directory: ${dir}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // Parent does not exist yet (callers mkdir recursively); nothing to validate.
  }

  const tmp = `${absolutePath}.${randomUUID()}.lyrashield-tmp`

  // O_EXCL: fail if the temp path already exists (including as a symlink).
  // This prevents a symlink attack where an attacker points the temp path at
  // another file and we overwrite the target. fsync before rename so the data is
  // durable on disk before it becomes visible at the final path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const handle = await open(tmp, "wx")
  try {
    await handle.writeFile(content, "utf-8")
    await handle.sync()
  } finally {
    await handle.close()
  }

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
