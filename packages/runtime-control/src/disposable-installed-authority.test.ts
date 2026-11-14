import { lstatSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthorityAction } from "./authority-fence"
import type { AuthoritySqlConnection } from "./postgres-mirror"

const fixture = vi.hoisted(() => {
  const context: Record<string, unknown> = {}
  return {
    path: "",
    absent: false,
    mode: 0o440,
    uid: 0,
    gid: 1002,
    links: 1,
    context,
  }
})
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>()
  return {
    ...actual,
    lstatSync: vi.fn((path) => {
      if (String(path).endsWith("disposable-native-context.json")) {
        if (fixture.absent) throw Object.assign(new Error("missing"), { code: "ENOENT" })
        return { isFile: () => true }
      }
      if (String(path).endsWith("authority.sock"))
        return {
          uid: 0,
          gid: 1002,
          mode: 0o140660,
          isSocket: () => true,
          isSymbolicLink: () => false,
        }
      return { uid: 0, mode: 0o40755, isDirectory: () => true, isSymbolicLink: () => false }
    }),
    openSync: vi.fn(() => 42),
    closeSync: vi.fn(),
    fstatSync: vi.fn(() => ({
      uid: fixture.uid,
      gid: fixture.gid,
      mode: fixture.mode,
      nlink: fixture.links,
      size: Buffer.byteLength(JSON.stringify(fixture.context)),
      ino: 42,
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => true,
    })),
    readSync: vi.fn((_fd, bytes: Buffer) => bytes.write(JSON.stringify(fixture.context))),
  }
})
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>()
  return {
    ...actual,
    createConnection: (options: { path: string }) => {
      if (options.path !== "/opt/lyrashield-runtime/authority.sock")
        throw new Error("Unexpected socket")
      return actual.createConnection(fixture.path)
    },
  }
})
const { createSupervisorExecutionAuthorityCapability } =
  await import("./disposable-installed-authority")
const context = {
  schema: "lyrashield-disposable-native-context/1",
  owner: "123:1",
  bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  nonce: "b".repeat(64),
  sourceRevision: "c".repeat(40),
  sourceTree: "d".repeat(40),
}
const installed = {
  purpose: "disposable-installed",
  epochId: "disposable-" + "a".repeat(32),
  epoch: 7,
  sourceRevision: context.sourceRevision,
  runtimePolicyDigest: "sha256:" + "e".repeat(64),
  authorityDigest: "sha256:" + "f".repeat(64),
  supervisorInstanceId: "supervisor-fixture",
  owner: context.owner,
  bootId: context.bootId,
  nonce: context.nonce,
  sourceTree: context.sourceTree,
  issuedAt: Math.floor(Date.now() / 1000) - 1,
  expiresAt: Math.floor(Date.now() / 1000) + 120,
}
const action: AuthorityAction = {
  phase: "PREPARE",
  operationId: "operation-fixture",
  attemptId: "attempt-fixture",
  commandId: "command-fixture",
  scanId: "scan-fixture",
  workspaceId: "workspace-fixture",
  authorityEpochId: installed.epochId,
  authorityRevision: 1,
  authorityChecksum: "1".repeat(64),
  actionChecksum: "2".repeat(64),
}
function connection(held = true) {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('FROM "ScanAuthorityEpoch"')
        ? [{ id: installed.epochId, epoch: "7", held }]
        : [{ held }],
    })),
    release: vi.fn(),
  } satisfies AuthoritySqlConnection
}
let directory: string, server: Server
let replies: unknown[], requests: string[]
beforeAll(async () => {
  directory = await mkdtemp("/tmp/lyra-disposable-authority-")
  fixture.path = join(directory, "authority.sock")
  server = createServer((socket) =>
    socket.once("data", (bytes) => {
      requests.push(bytes.toString())
      socket.end(JSON.stringify(replies.shift() ?? installed) + "\n")
    })
  )
  await new Promise<void>((resolve) => server.listen(fixture.path, resolve))
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  await rm(directory, { recursive: true, force: true })
})
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(process, "getuid").mockReturnValue(1001)
  vi.spyOn(process, "getgid").mockReturnValue(1002)
  fixture.absent = false
  fixture.mode = 0o440
  fixture.uid = 0
  fixture.gid = 1002
  fixture.links = 1
  fixture.context = { ...context }
  replies = []
  requests = []
})
describe("separate protected disposable installed authority", () => {
  it("rechecks the real socket and current session gate without producing a production purpose", async () => {
    const observed = await createSupervisorExecutionAuthorityCapability().verifyAction(
      connection(),
      action
    )
    expect(observed).toEqual(installed)
    expect(requests).toEqual([
      "disposable-execution-authority\n",
      "disposable-execution-authority\n",
    ])
    expect(Object.isFrozen(observed)).toBe(true)
  })
  it.each(["owner", "bootId", "nonce", "sourceRevision", "sourceTree"])(
    "rejects a different %s before native action",
    async (field) => {
      replies = [
        {
          ...installed,
          [field]:
            field === "owner"
              ? "456:1"
              : field === "bootId"
                ? "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
                : "e".repeat(field === "nonce" ? 64 : 40),
        },
      ]
      await expect(
        createSupervisorExecutionAuthorityCapability().verifyAction(connection(), action)
      ).rejects.toThrow()
    }
  )
  it.each([
    { purpose: "production-installed" },
    { expiresAt: 1 },
    { expiresAt: installed.issuedAt + 3601 },
    { issuedAt: installed.expiresAt + 1 },
    { epochId: "production-epoch" },
  ])("rejects an invalid purpose, lifetime or epoch", async (change) => {
    replies = [{ ...installed, ...change }]
    await expect(
      createSupervisorExecutionAuthorityCapability().verifyAction(connection(), action)
    ).rejects.toThrow()
  })
  it("rejects a lost gate or changed observer identity", async () => {
    await expect(
      createSupervisorExecutionAuthorityCapability().verifyAction(connection(false), action)
    ).rejects.toThrow()
    replies = [installed, { ...installed, authorityDigest: "sha256:" + "1".repeat(64) }]
    await expect(
      createSupervisorExecutionAuthorityCapability().verifyAction(connection(), action)
    ).rejects.toThrow()
  })
  it.each(["mode", "uid", "gid", "links"])("rejects unprotected context %s", (field) => {
    Object.assign(fixture, { [field]: field === "mode" ? 0o640 : field === "links" ? 2 : 9000 })
    expect(() => createSupervisorExecutionAuthorityCapability()).toThrow()
    expect(requests).toEqual([])
  })
  it("does not accept caller-selected authority or a changed protected context", async () => {
    expect(() =>
      Reflect.apply(createSupervisorExecutionAuthorityCapability, null, [installed])
    ).toThrow()
    const authority = createSupervisorExecutionAuthorityCapability()
    fixture.context.nonce = "e".repeat(64)
    await expect(authority.verifyAction(connection(), action)).rejects.toThrow()
    expect(requests).toEqual([])
  })
  it("keeps the production observer selected when no fixture context is installed", async () => {
    fixture.absent = true
    const production = {
      purpose: "production-installed",
      epochId: installed.epochId,
      epoch: installed.epoch,
      sourceRevision: installed.sourceRevision,
      runtimePolicyDigest: installed.runtimePolicyDigest,
      authorityDigest: installed.authorityDigest,
      supervisorInstanceId: installed.supervisorInstanceId,
    }
    replies = [production, production]
    await expect(
      createSupervisorExecutionAuthorityCapability().verifyAction(connection(), action)
    ).resolves.toEqual(production)
    expect(requests).toEqual(["execution-authority\n", "execution-authority\n"])
    expect(lstatSync).toHaveBeenCalledWith("/opt/lyrashield-runtime/disposable-native-context.json")
  })
})
