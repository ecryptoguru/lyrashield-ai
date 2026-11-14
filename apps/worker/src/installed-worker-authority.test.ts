import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const io = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  read: vi.fn(),
  connect: vi.fn(),
  provenance: vi.fn(),
  broker: vi.fn(),
  publication: vi.fn(),
}))
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  openSync: io.open,
  closeSync: io.close,
  fstatSync: io.stat,
  lstatSync: io.lstat,
  readFileSync: io.read,
}))
vi.mock("node:net", () => ({ createConnection: io.connect }))
vi.mock("@lyrashield/config", () => ({ resolveWorkerExecutionProvenance: io.provenance }))
vi.mock("./jobs/run-scan/broker-client", () => ({ createWorkerBrokerClient: io.broker }))
vi.mock("./jobs/run-scan/worker-publication-client", () => ({
  createWorkerBrokerPublicationVerifier: io.publication,
}))
import { loadProtectedWorkerBrokerInstallation } from "./installed-worker-authority"

const tuple = {
  productRevision: "a".repeat(40),
  workerImageDigest: `sha256:${"b".repeat(64)}`,
  engineRevision: "c".repeat(40),
}
const authority = {
  ...tuple,
  authorityEpochId: "epoch-one",
  epoch: 3,
  workerInstanceId: "worker-one",
  workerGrantId: "grant-one",
  expiresAt: "2099-01-01T00:00:00.000Z",
}
const credential = "fixture-worker-credential-with-no-production-authority"
const configuration = {
  schema: "lyrashield-worker-broker-installation/1",
  authority,
  workerCredential: credential,
}
const observed = {
  ...authority,
  purpose: "production-worker-installed",
  qualificationDigest: "d".repeat(64),
  authorityDigest: `sha256:${"e".repeat(64)}`,
  runtimePolicyDigest: `sha256:${"f".repeat(64)}`,
}
let body: Buffer, descriptor: unknown
const metadata = () => ({
  isFile: () => true,
  uid: 0,
  gid: 10004,
  nlink: 1,
  mode: 0o440,
  size: body.length,
  dev: 1,
  ino: 2,
  mtimeMs: 3,
  ctimeMs: 4,
})

// These are filesystem/IPC rejection tests; the descriptor fixture is not a
// qualified host receipt or evidence of production activation.
describe("fixed protected worker installation", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(process, "getuid").mockReturnValue(10004)
    vi.spyOn(process, "getgid").mockReturnValue(10004)
    body = Buffer.from(JSON.stringify(configuration))
    descriptor = observed
    io.open.mockReturnValue(7)
    io.read.mockImplementation(() => body)
    io.stat.mockImplementation(metadata)
    io.lstat.mockImplementation((path: string) =>
      path.endsWith(".sock")
        ? { isSocket: () => true, isSymbolicLink: () => false, uid: 0, gid: 10004, mode: 0o660 }
        : { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o755 }
    )
    io.provenance.mockReturnValue(tuple)
    io.broker.mockReturnValue({})
    io.publication.mockReturnValue({})
    io.connect.mockImplementation(() => {
      const client = new EventEmitter() as EventEmitter & {
        end: ReturnType<typeof vi.fn>
        destroy: ReturnType<typeof vi.fn>
      }
      client.destroy = vi.fn()
      client.end = vi.fn(() =>
        queueMicrotask(() => {
          client.emit("data", Buffer.from(`${JSON.stringify(descriptor)}\n`))
          client.emit("end")
        })
      )
      queueMicrotask(() => client.emit("connect"))
      return client
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it("retains only cleanup transport after expiry and independently authenticates its inventory", async () => {
    descriptor = {
      ...observed,
      purpose: "production-worker-installed-cleanup",
      expiresAt: "2020-01-01T00:00:00.000Z",
    }
    const installed = await loadProtectedWorkerBrokerInstallation()
    expect(installed).toBeDefined()
    expect(await installed!.verifyAuthority(installed!.authority)).toBe(false)
    const row = {
      operationId: "operation-one",
      workspaceId: "workspace-one",
      scanId: "scan-one",
      attemptId: "attempt-one",
      state: "ACTIVE",
    }
    descriptor = {
      schema: "lyrashield-root-worker-operation-inventory/1",
      authority: descriptor,
      operations: [row],
    }
    expect(await installed!.cleanup!.inventory()).toEqual([row])
    descriptor = {
      schema: "lyrashield-root-worker-operation-inventory/1",
      authority: {
        ...observed,
        purpose: "production-worker-installed-cleanup",
        workerGrantId: "foreign-grant",
      },
      operations: [row],
    }
    await expect(installed!.cleanup!.inventory()).rejects.toThrow()
    expect(await installed!.verifyAuthority(installed!.authority)).toBe(false)
  })

  it("uses only the fixed root config and bounded distinct observer request", async () => {
    const installed = await loadProtectedWorkerBrokerInstallation()
    expect(installed).toBeDefined()
    expect(io.open).toHaveBeenCalledWith(
      "/opt/lyrashield-runtime/worker-authority.json",
      expect.any(Number)
    )
    expect(io.connect).toHaveBeenCalledWith({
      path: "/opt/lyrashield-runtime/worker-authority.sock",
    })
    expect(io.broker).toHaveBeenCalledExactlyOnceWith(credential)
    expect(io.publication).toHaveBeenCalledExactlyOnceWith(credential)
    expect(await installed!.verifyAuthority(installed!.authority)).toBe(true)
    expect(io.close).toHaveBeenCalledWith(7)
  })
  it("defaults closed when the protected config is absent", async () => {
    io.open.mockImplementation(() => {
      throw new Error("ENOENT")
    })
    expect(await loadProtectedWorkerBrokerInstallation()).toBeUndefined()
    expect(io.connect).not.toHaveBeenCalled()
    expect(io.broker).not.toHaveBeenCalled()
  })
  it.each([{ uid: 10004 }, { gid: 99 }, { nlink: 2 }, { mode: 0o644 }, { size: 20000 }])(
    "rejects unsafe file metadata %j",
    async (changed) => {
      io.stat.mockImplementation(() => ({ ...metadata(), ...changed }))
      expect(await loadProtectedWorkerBrokerInstallation()).toBeUndefined()
      expect(io.broker).not.toHaveBeenCalled()
    }
  )
  it("rejects worker-controlled ancestry and root worker execution", async () => {
    io.lstat.mockReturnValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 10004,
      mode: 0o755,
    })
    expect(await loadProtectedWorkerBrokerInstallation()).toBeUndefined()
    vi.mocked(process.getuid).mockReturnValue(0)
    expect(await loadProtectedWorkerBrokerInstallation()).toBeUndefined()
  })
  it("rejects tuple substitution and unavailable root observations", async () => {
    descriptor = { ...observed, workerGrantId: "other-grant" }
    expect(await loadProtectedWorkerBrokerInstallation()).toBeUndefined()
    descriptor = { purpose: "unavailable" }
    expect(await loadProtectedWorkerBrokerInstallation()).toBeUndefined()
  })
  it("does not accept policy or envelope hashes embedded in stable configuration", async () => {
    body = Buffer.from(
      JSON.stringify({
        ...configuration,
        authority: { ...authority, runtimePolicyDigest: observed.runtimePolicyDigest },
      })
    )
    expect(await loadProtectedWorkerBrokerInstallation()).toBeUndefined()
  })
  it("withdraws authority after config mutation, expiry, revocation or changed qualified record", async () => {
    const installed = (await loadProtectedWorkerBrokerInstallation())!
    body = Buffer.from(
      JSON.stringify({
        ...configuration,
        workerCredential: "other-fixture-credential-with-no-production-authority",
      })
    )
    expect(await installed.verifyAuthority(installed.authority)).toBe(false)
    body = Buffer.from(JSON.stringify(configuration))
    for (const changed of [
      { expiresAt: "2000-01-01T00:00:00.000Z" },
      { authorityDigest: `sha256:${"0".repeat(64)}` },
      { workerGrantId: "revoked-grant" },
      { purpose: "unavailable" },
    ]) {
      descriptor = { ...observed, ...changed }
      expect(await installed.verifyAuthority(installed.authority)).toBe(false)
    }
  })
  it("reads only root-verified assigned operation inventory and rejects changed qualified authority", async () => {
    const installed = (await loadProtectedWorkerBrokerInstallation())!
    const row = {
      operationId: "operation-one",
      workspaceId: "workspace-one",
      scanId: "scan-one",
      attemptId: "attempt-one",
      state: "ACTIVE",
    }
    descriptor = {
      schema: "lyrashield-root-worker-operation-inventory/1",
      authority: observed,
      operations: [row],
    }
    expect(await installed.results!.inventory()).toEqual([row])
    descriptor = {
      schema: "lyrashield-root-worker-operation-inventory/1",
      authority: { ...observed, runtimePolicyDigest: `sha256:${"0".repeat(64)}` },
      operations: [row],
    }
    await expect(installed.results!.inventory()).rejects.toThrow()
    descriptor = {
      schema: "lyrashield-root-worker-operation-inventory/1",
      authority: observed,
      operations: Array.from({ length: 33 }, () => row),
    }
    await expect(installed.results!.inventory()).rejects.toThrow()
  })
  it("requires independent result-proof exact operation and current installed descriptor", async () => {
    const installed = (await loadProtectedWorkerBrokerInstallation())!
    const action = {
      phase: "EXECUTOR_CREATE",
      operationId: "operation-one",
      attemptId: "attempt-one",
      workspaceId: "workspace-one",
      scanId: "scan-one",
      authorityEpochId: authority.authorityEpochId,
      authorityRevision: 1,
      authorityChecksum: "d".repeat(64),
      actionChecksum: "e".repeat(64),
      commandId: "command-one",
      executorKey: "engine",
    }
    descriptor = {
      schema: "lyrashield-root-worker-result-proof/1",
      authority: observed,
      action,
      guardId: "guard-one",
      ownership: {
        kind: "container",
        executorKey: "engine",
        ownershipId: "ownership-one",
        containerId: "f".repeat(64),
      },
      sha256: `sha256:${"1".repeat(64)}`,
      totalBytes: 100,
    }
    expect(await installed.results!.proof("operation-one")).toMatchObject({ action })
    await expect(installed.results!.proof("other-operation")).rejects.toThrow()
    descriptor = {
      ...(descriptor as object),
      authority: { ...observed, expiresAt: "2020-01-01T00:00:00.000Z" },
    }
    await expect(installed.results!.proof("operation-one")).rejects.toThrow()
  })
})
