import { lstat, open, realpath, rename } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"

/**
 * Reject a destination whose directory chain passes through a symlink ANYWHERE,
 * not just at the immediate parent.
 *
 * An `lstat(dir).isSymbolicLink()` check only catches the last component, so
 * `~/.cursor/rules/file.mdc` sails through when `.cursor` itself is the attacker's
 * symlink — and nested paths like that are exactly what every installer writes.
 * `realpath()` resolves the whole chain, so comparing it against the lexical path
 * catches a redirect at any depth.
 *
 * The directory frequently does not exist yet (callers `mkdir -p` afterwards), so
 * walk up to the nearest ancestor that does exist and validate that. A symlink
 * cannot hide under a path component that is absent.
 */
async function assertNoSymlinkedAncestor(dir: string): Promise<void> {
  let probe = dir
  for (;;) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await lstat(probe)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = dirname(probe)
      // Reached the filesystem root without finding anything that exists.
      if (parent === probe) return
      probe = parent
    }
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const real = await realpath(probe)
  if (real !== probe) {
    throw new Error(
      `Refusing to write through a symlinked directory: ${probe} resolves to ${real}`
    )
  }
}

/**
 * Atomically write a file with a temp-and-rename pattern. The temp file is
 * created with O_EXCL so a pre-existing file or symlink cannot be hijacked,
 * fsynced before the rename for durability, and the final path is re-validated
 * with lstat after the rename to ensure it is a regular file and not a dangling
 * or followed symlink. The destination directory chain is fully resolved and
 * checked so a symlink at ANY depth cannot redirect the write outside the
 * intended location.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const absolutePath = resolve(filePath)

  await assertNoSymlinkedAncestor(dirname(absolutePath))

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
