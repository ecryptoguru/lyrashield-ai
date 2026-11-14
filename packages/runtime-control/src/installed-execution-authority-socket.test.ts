import { lstatSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthorityAction } from "./authority-fence"
import type { AuthoritySqlConnection } from "./postgres-mirror"

const fixture = vi.hoisted(() => ({ path: "" }))
vi.mock("node:fs", () => ({ lstatSync: vi.fn() }))
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>()
  return {
    ...actual,
    createConnection: (options: { path: string }) => {
      if (options.path !== "/opt/lyrashield-runtime/authority.sock")
        throw new Error("Unexpected authority socket")
      return actual.createConnection(fixture.path)
    },
  }
})
const { createInstalledExecutionAuthorityCapability } =
  await import("./installed-execution-authority")

const identity = {
  purpose: "production-installed",
  epochId: "epoch-test",
  epoch: 7,
  sourceRevision: "a".repeat(40),
  runtimePolicyDigest: "sha256:" + "b".repeat(64),
  authorityDigest: "sha256:" + "c".repeat(64),
  supervisorInstanceId: "supervisor-test",
}
const action: AuthorityAction = {
  phase: "EXECUTOR_START",
  operationId: "operation-test",
  attemptId: "attempt-test",
  scanId: "scan-test",
  workspaceId: "workspace-test",
  authorityEpochId: "epoch-test",
  authorityRevision: 1,
  authorityChecksum: "d".repeat(64),
  actionChecksum: "e".repeat(64),
  commandId: "command-test",
  executorKey: "sandbox",
}
function connection() {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('FROM "ScanAuthorityEpoch"')
      ? [{ id: identity.epochId, epoch: "7", held: true }]
      : [{ held: true }],
  }))
  return { query, release: vi.fn() } satisfies AuthoritySqlConnection
}
let server: Server
let directory: string
let replies: unknown[]
let requests: string[]
beforeAll(async () => {
  directory = await mkdtemp("/tmp/lyra-authority-")
  fixture.path = join(directory, "authority.sock")
  server = createServer((socket) => {
    socket.once("data", (input) => {
      requests.push(input.toString())
      socket.end(JSON.stringify(replies.shift() ?? identity) + "\n")
    })
  })
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
  const socket = {
    uid: 0,
    gid: 1002,
    mode: 0o140660,
    isSocket: () => true,
    isSymbolicLink: () => false,
  }
  const directory = { uid: 0, mode: 0o40755, isDirectory: () => true, isSymbolicLink: () => false }
  vi.mocked(lstatSync).mockImplementation(
    (path) =>
      (String(path).endsWith("authority.sock") ? socket : directory) as ReturnType<typeof lstatSync>
  )
  replies = []
  requests = []
})

describe("installed authority via protected host socket", () => {
  it("lets a non-root supervisor recheck a fenced epoch through the fixed observer", async () => {
    const client = connection()
    const observed = await createInstalledExecutionAuthorityCapability().verifyAction(
      client,
      action
    )
    expect(observed).toEqual(identity)
    expect(Object.isFrozen(observed)).toBe(true)
    expect(requests).toEqual(["execution-authority\n", "execution-authority\n"])
    expect(client.query.mock.calls[0]?.[0]).toContain("FOR SHARE")
  })

  it("rejects an untrusted socket before reading authority", async () => {
    const socket = {
      uid: 1001,
      gid: 1002,
      mode: 0o140660,
      isSocket: () => true,
      isSymbolicLink: () => false,
    }
    const directory = {
      uid: 0,
      mode: 0o40755,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }
    vi.mocked(lstatSync).mockImplementation(
      (path) =>
        (String(path).endsWith("authority.sock") ? socket : directory) as ReturnType<
          typeof lstatSync
        >
    )
    await expect(
      createInstalledExecutionAuthorityCapability().verifyAction(connection(), action)
    ).rejects.toThrow()
    expect(requests).toEqual([])
  })

  it("rejects an observer identity that changes while the gate is held", async () => {
    replies = [identity, { ...identity, authorityDigest: "sha256:" + "f".repeat(64) }]
    await expect(
      createInstalledExecutionAuthorityCapability().verifyAction(connection(), action)
    ).rejects.toThrow()
    expect(requests).toHaveLength(2)
  })
})
