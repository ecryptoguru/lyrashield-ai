import { describe, expect, it, vi } from "vitest"
import { requestNativeExecutor } from "./native-executor-client"
import { createSandboxToolRunner } from "./sandbox-tool-runner"

vi.mock("./native-executor-client", () => ({ requestNativeExecutor: vi.fn() }))
const ownership = {
  kind: "container",
  executorKey: "sandbox",
  ownershipId: "own_" + "a".repeat(40),
  containerId: "b".repeat(64),
}
const scope = {
  authorityEpochId: "epoch-1",
  operationId: "operation-1",
  attemptId: "attempt-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  authorityRevision: 1,
  authorityChecksum: "c".repeat(64),
  prepareCommandId: "prepare-1",
  prepareCommandInputChecksum: "d".repeat(64),
  ownershipReceiptId: "receipt-1",
  ownership,
  sandboxHandle: ownership.ownershipId,
}
const credential = {
  token: "signed-scoped-token",
  attemptId: scope.attemptId,
  sandboxHandle: scope.sandboxHandle,
}
function fixture() {
  const authorizeRead = vi.fn(async () => undefined),
    publish = vi.fn(),
    run = vi.fn(),
    complete = vi.fn()
  const options = {
    verifyCapability: vi.fn(() => scope),
    intents: { authorizeRead, publish },
    fence: { run },
    context: {},
    journal: {},
    recordNativeStart: vi.fn(),
    supervisorInstanceId: "supervisor-1",
    acknowledgements: { complete },
    consumeReceipts: vi.fn(),
  }
  const result = createSandboxToolRunner(
    options as unknown as Parameters<typeof createSandboxToolRunner>[0]
  )
  return { ...result, authorizeRead, publish, run, complete, options }
}
describe("actual stopped sandbox state", () => {
  it.each([{ state: "PRESENT", ownership, running: false }, { state: "ABSENT" }])(
    "returns stopped state after positive current source and exact native inspection",
    async (inspection) => {
      vi.mocked(requestNativeExecutor).mockResolvedValue(inspection)
      const f = fixture()
      expect(await f.runner.state(credential)).toEqual({
        binding: {
          attemptId: scope.attemptId,
          operationId: scope.operationId,
          authorityEpochId: scope.authorityEpochId,
          sandboxHandle: scope.sandboxHandle,
        },
        running: false,
      })
      expect(f.authorizeRead).toHaveBeenCalledOnce()
      expect(f.publish).not.toHaveBeenCalled()
      expect(f.run).not.toHaveBeenCalled()
      expect(f.complete).not.toHaveBeenCalled()
      expect(f.options.verifyCapability).toHaveBeenCalledWith(
        credential.token,
        credential,
        "invoke"
      )
    }
  )
  it("rejects revoked current authority or a foreign native ownership instead of issuing state or a renewal", async () => {
    const f = fixture()
    f.authorizeRead.mockRejectedValueOnce(new Error("current grant revoked"))
    await expect(f.runner.state(credential)).rejects.toThrow("revoked")
    vi.mocked(requestNativeExecutor).mockResolvedValue({
      state: "PRESENT",
      ownership: { ...ownership, containerId: "e".repeat(64) },
      running: false,
    })
    await expect(f.runner.state(credential)).rejects.toThrow("unavailable")
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()
  })
})
