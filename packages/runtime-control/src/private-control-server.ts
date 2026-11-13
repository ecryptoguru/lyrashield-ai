import type { Server } from "node:http"
import { chmod, lstat } from "node:fs/promises"
import { dirname, isAbsolute, normalize } from "node:path"

export async function listenPrivateControlServer(
  server: Server,
  socketPath: string
): Promise<void> {
  const uid = process.getuid?.()
  if (
    uid === undefined ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath) > 100
  )
    throw new Error("Private control socket path is invalid")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- normalized installation path, directory ownership checked below
  const parent = await lstat(dirname(socketPath))
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== uid ||
    (parent.mode & 0o027) !== 0
  )
    throw new Error("Private control socket directory is not protected")
  // Existing paths are never unlinked: they may belong to an active controller.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same socket created inside the verified owned directory
    const socket = await lstat(socketPath)
    if (!socket.isSocket() || socket.uid !== uid)
      throw new Error("Private control socket ownership is invalid")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- exact newly created owned socket
    await chmod(socketPath, 0o660)
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }
}
