import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { listenPrivateControlServer } from "./private-control-server"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "lyra-control-"))
  directories.push(path)
  await chmod(path, 0o700)
  return path
}

describe("private control listener", () => {
  it("serves through an owned Unix socket without a TCP listener", async () => {
    const socketPath = join(await directory(), "control.sock")
    const server = createServer((_request, response) => response.end("private"))
    try {
      await listenPrivateControlServer(server, socketPath)
      expect((await lstat(socketPath)).mode & 0o777).toBe(0o660)
      const body = await new Promise<string>((resolve, reject) => {
        const call = request({ socketPath, path: "/" }, (response) => {
          response.setEncoding("utf8")
          let value = ""
          response.on("data", (chunk) => (value += chunk))
          response.on("end", () => resolve(value))
        })
        call.on("error", reject)
        call.end()
      })
      expect(body).toBe("private")
      expect(server.address()).toBe(socketPath)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it("rejects a writable shared directory and a symlinked directory", async () => {
    const path = await directory()
    await chmod(path, 0o770)
    await expect(
      listenPrivateControlServer(createServer(), join(path, "bad.sock"))
    ).rejects.toThrow("not protected")
    const alias = join(await directory(), "alias")
    await symlink(path, alias)
    await expect(
      listenPrivateControlServer(createServer(), join(alias, "bad.sock"))
    ).rejects.toThrow("not protected")
  })
  it("preserves an existing path instead of unlinking another controller's state", async () => {
    const path = join(await directory(), "existing.sock")
    await writeFile(path, "retained", { mode: 0o600 })
    await expect(listenPrivateControlServer(createServer(), path)).rejects.toThrow()
    expect((await lstat(path)).isFile()).toBe(true)
  })
})
