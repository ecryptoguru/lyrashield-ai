import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { canonicalJson } from "@lyrashield/runtime-control"
import { createHash } from "node:crypto"
import {
  sandboxFileCommand,
  SANDBOX_FILE_PROGRAM,
  SANDBOX_FILE_INPUT_BYTES,
} from "./sandbox-file-command"

const execute = promisify(execFile)
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const base = {
  binding: {
    attemptId: "attempt-1",
    operationId: "operation-1",
    authorityEpochId: "epoch-1",
    sandboxHandle: `own_${"a".repeat(40)}`,
  },
  requestId: "1d5b3040-b775-43a0-a7fb-ac5965fb91fa",
  commandId: "1d5b3040-b775-43a0-a7fb-ac5965fb91fa",
}
function write(data: Buffer, path = "/workspace/src/test.txt") {
  return { ...base, path, dataBase64: data.toString("base64"), sha256: sha256Hex(data) }
}
describe("bounded sandbox file command", () => {
  it("fits the immutable native descriptor and per-argument bounds at the exact input cap", () => {
    const command = sandboxFileCommand("files/write", write(Buffer.alloc(SANDBOX_FILE_INPUT_BYTES)))
    expect(command.argv.every((arg) => Buffer.byteLength(arg) <= 8192)).toBe(true)
    expect(
      Buffer.byteLength(
        canonicalJson({
          ...base,
          argv: command.argv,
          cwd: "/workspace",
          user: "pentester",
          timeoutSeconds: 10,
          maxOutputBytes: 1024 * 1024,
        })
      )
    ).toBeLessThan(128 * 1024 - 1024)
    expect(Buffer.byteLength(SANDBOX_FILE_PROGRAM)).toBeLessThan(8192)
  })
  it("rejects outside paths, traversal, corrupt checksums and oversized content before native execution", () => {
    for (const path of [
      "/etc/passwd",
      "/workspace/../secret",
      "/workspace//file",
      "/workspace/./file",
    ]) {
      expect(() => sandboxFileCommand("files/write", write(Buffer.from("x"), path))).toThrow()
    }
    expect(() =>
      sandboxFileCommand("files/write", { ...write(Buffer.from("x")), sha256: "f".repeat(64) })
    ).toThrow()
    expect(() =>
      sandboxFileCommand("files/write", write(Buffer.alloc(SANDBOX_FILE_INPUT_BYTES + 1)))
    ).toThrow()
  })
})

describe.skipIf(process.env.LYRA_NATIVE_TOOL_DOCKER_TEST !== "1")(
  "actual disposable sandbox files",
  () => {
    let container = ""
    beforeAll(async () => {
      const image = process.env.LYRA_NATIVE_TOOL_TEST_IMAGE ?? "python:3.12-slim"
      container = (
        await execute("docker", [
          "run",
          "--detach",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "64",
          "--user",
          "1000:1000",
          "--tmpfs",
          "/workspace:rw,nosuid,nodev,uid=1000,gid=1000,mode=0750",
          "--entrypoint",
          "python3",
          image,
          "-c",
          "import time;time.sleep(60)",
        ])
      ).stdout.trim()
    })
    afterAll(async () => {
      if (container) await execute("docker", ["rm", "--force", container])
    })
    async function call(kind: Parameters<typeof sandboxFileCommand>[0], input: unknown) {
      const { argv } = sandboxFileCommand(kind, input)
      const result = await execute("docker", ["exec", "--user", "1000:1000", container, ...argv], {
        maxBuffer: 1024 * 1024,
      })
      return JSON.parse(result.stdout) as Record<string, string>
    }
    it("writes and reads exact content/checksum and persists a safe workspace archive", async () => {
      const data = Buffer.from("scan fixture\n")
      expect(await call("files/write", write(data))).toEqual({ sha256: sha256Hex(data) })
      expect(
        await call("files/read", {
          ...base,
          path: "/workspace/src/test.txt",
          maxBytes: 16 * 1024 * 1024,
        })
      ).toEqual({ dataBase64: data.toString("base64"), sha256: sha256Hex(data) })
      const archive = await call("workspace/persist", { ...base, maxBytes: 16 * 1024 * 1024 })
      expect(sha256Hex(Buffer.from(archive.archiveBase64!, "base64"))).toBe(archive.sha256)
      await call("files/write", write(Buffer.from("changed")))
      expect(
        await call("workspace/hydrate", {
          ...base,
          archiveBase64: archive.archiveBase64,
          sha256: archive.sha256,
        })
      ).toEqual({ sha256: archive.sha256 })
      expect(
        (await call("files/read", { ...base, path: "/workspace/src/test.txt", maxBytes: 1024 }))
          .dataBase64
      ).toBe(data.toString("base64"))
    })
    it("rejects symlink traversal and unsafe tar members without writing outside the approved directory", async () => {
      await execute("docker", [
        "exec",
        "--user",
        "1000:1000",
        container,
        "python3",
        "-c",
        "import os;os.symlink('/tmp','/workspace/link')",
      ])
      await expect(
        call("files/write", write(Buffer.from("x"), "/workspace/link/foreign"))
      ).rejects.toThrow()
      const archive = (
        await execute("docker", [
          "exec",
          container,
          "python3",
          "-c",
          "import tarfile,io,base64;b=io.BytesIO();t=tarfile.open(fileobj=b,mode='w');e=tarfile.TarInfo('../foreign');e.size=1;t.addfile(e,io.BytesIO(b'x'));t.close();print(base64.b64encode(b.getvalue()).decode())",
        ])
      ).stdout.trim()
      await expect(
        call("workspace/hydrate", {
          ...base,
          archiveBase64: archive,
          sha256: sha256Hex(Buffer.from(archive, "base64")),
        })
      ).rejects.toThrow()
    })
    it("keeps capped and unreadable files incomplete without emitting partial content", async () => {
      await execute("docker", [
        "exec",
        "--user",
        "1000:1000",
        container,
        "python3",
        "-c",
        "open('/workspace/large','wb').write(b'x'*524289)",
      ])
      await expect(
        call("files/read", { ...base, path: "/workspace/large", maxBytes: 16 * 1024 * 1024 })
      ).rejects.toThrow()
      await expect(
        call("files/read", { ...base, path: "/workspace/link/foreign", maxBytes: 1024 })
      ).rejects.toThrow()
      await expect(
        call("workspace/persist", { ...base, maxBytes: 16 * 1024 * 1024 })
      ).rejects.toThrow()
    })
  }
)
