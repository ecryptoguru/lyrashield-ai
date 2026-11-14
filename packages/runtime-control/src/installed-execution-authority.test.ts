import { execFileSync } from "node:child_process"
import { lstatSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createInstalledExecutionAuthorityCapability } from "./installed-execution-authority"
import type { AuthorityAction } from "./authority-fence"
import type { AuthoritySqlConnection } from "./postgres-mirror"
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }))
vi.mock("node:fs", () => ({ lstatSync: vi.fn() }))
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
function connection(held = true) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('FROM "ScanAuthorityEpoch"')
      ? [{ id: identity.epochId, epoch: "7", held }]
      : [{ held }],
  }))
  return { query, release: vi.fn() } satisfies AuthoritySqlConnection
}
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(process, "getuid").mockReturnValue(0)
  vi.mocked(lstatSync).mockReturnValue({
    uid: 0,
    mode: 0o100644,
    isSymbolicLink: () => false,
  } as ReturnType<typeof lstatSync>)
  vi.mocked(execFileSync)
    .mockReset()
    .mockReturnValue(Buffer.from(JSON.stringify(identity)))
})
describe("fixed installed execution authority capability (root observation fixture)", () => {
  it("uses fixed public pin and helper, requires actual fenced OPEN epoch, and returns immutable identity", async () => {
    const client = connection()
    const capability = createInstalledExecutionAuthorityCapability()
    expect(await capability.verifyAction(client, action)).toEqual(identity)
    expect(Object.isFrozen(await capability.verifyAction(client, action))).toBe(true)
    const [file, args] = vi.mocked(execFileSync).mock.calls[0]!
    expect(file).toBe("/usr/bin/python3")
    expect(args).toEqual([
      "/opt/lyrashield/runtime-control/paired-runtime-host-observation.py",
      "execution-authority",
      "/opt/lyrashield/runtime-control/runtime-qualification-key.json",
    ])
    expect(client.query.mock.calls[0]?.[0]).toContain("FOR SHARE")
  })
  it("rejects caller selected authority, root helper mutation and unqualified staging purpose", async () => {
    expect(() =>
      Reflect.apply(createInstalledExecutionAuthorityCapability, null, [identity])
    ).toThrow()
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from(JSON.stringify({ ...identity, purpose: "disposable-staging" }))
    )
    await expect(
      createInstalledExecutionAuthorityCapability().verifyAction(connection(), action)
    ).rejects.toThrow()
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(JSON.stringify(identity)))
    vi.mocked(lstatSync).mockReturnValue({
      uid: 0,
      mode: 0o100666,
      isSymbolicLink: () => false,
    } as ReturnType<typeof lstatSync>)
    await expect(
      createInstalledExecutionAuthorityCapability().verifyAction(connection(), action)
    ).rejects.toThrow()
  })
  it("rejects missing native gate, changed epoch and changed protected policy during verification", async () => {
    await expect(
      createInstalledExecutionAuthorityCapability().verifyAction(connection(false), action)
    ).rejects.toThrow()
    await expect(
      createInstalledExecutionAuthorityCapability().verifyAction(connection(), {
        ...action,
        authorityEpochId: "epoch-stale",
      })
    ).rejects.toThrow()
    vi.mocked(execFileSync)
      .mockReset()
      .mockReturnValueOnce(Buffer.from(JSON.stringify(identity)))
      .mockReturnValueOnce(
        Buffer.from(
          JSON.stringify({ ...identity, runtimePolicyDigest: "sha256:" + "f".repeat(64) })
        )
      )
    await expect(
      createInstalledExecutionAuthorityCapability().verifyAction(connection(), action)
    ).rejects.toThrow()
  })
  it("a lost or failed fenced query cannot return a positive capability", async () => {
    const client = connection()
    client.query.mockRejectedValueOnce(new Error("response lost"))
    await expect(
      createInstalledExecutionAuthorityCapability().verifyAction(client, action)
    ).rejects.toThrow()
  })
})
