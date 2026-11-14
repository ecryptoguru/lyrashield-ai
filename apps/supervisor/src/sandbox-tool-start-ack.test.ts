import { describe, expect, it, vi } from "vitest"
import {
  canonicalJson,
  sha256Hex,
  type AuthorityAction,
  type JournalPort,
  type ResourceInspection,
} from "@lyrashield/runtime-control"
import { createSandboxToolStartAcknowledger } from "./sandbox-tool-start-ack"
import type { SupervisorJournalEvent } from "./journal-events"

function fixture() {
  const ownership = {
    kind: "container" as const,
    executorKey: "sandbox" as const,
    ownershipId: `own_${"a".repeat(40)}`,
    containerId: "b".repeat(64),
  }
  const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
  const descriptor = {
    schema: "lyrashield-sandbox-tool-exec/1" as const,
    workspaceRoot: "/workspace",
    ownership,
    request: {
      binding: {
        attemptId: "attempt-1",
        operationId: "operation-1",
        authorityEpochId: "epoch-1",
        sandboxHandle: ownership.ownershipId,
      },
      requestId,
      commandId: requestId,
      argv: ["true"],
      cwd: "/workspace",
      user: "pentester" as const,
      timeoutSeconds: 1,
      maxOutputBytes: 1024,
    },
  }
  const action: AuthorityAction = {
    phase: "SANDBOX_TOOL",
    operationId: "operation-1",
    attemptId: "attempt-1",
    authorityEpochId: "epoch-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    authorityRevision: 1,
    authorityChecksum: "c".repeat(64),
    actionChecksum: sha256Hex(canonicalJson(descriptor)),
    commandId: "prepare-1",
    requestId,
    executorKey: "sandbox",
  }
  const append = vi.fn(async () => undefined)
  const inspect = vi.fn(async (): Promise<ResourceInspection> => ({
    state: "PRESENT",
    running: true,
    ownership,
  }))
  const assertActive = vi.fn()
  const acknowledge = createSandboxToolStartAcknowledger({
    journal: { append } as unknown as JournalPort<SupervisorJournalEvent>,
    supervisorInstanceId: "supervisor-1",
    prepareCommandInputChecksum: "d".repeat(64),
    inspect,
    assertActive,
  })
  return {
    ownership,
    descriptor,
    action,
    append,
    inspect,
    assertActive,
    acknowledge,
    input: { action, descriptor, guardId: "guard-1", execId: "e".repeat(64) },
  }
}
describe("sandbox native start ACK producer", () => {
  it("records exact native start scope, guard, exec identity and immutable PREPARE checksum", async () => {
    const f = fixture()
    await f.acknowledge(f.input)
    expect(f.append).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeOperation: "SANDBOX_TOOL_START_ACK",
        guardId: "guard-1",
        nativeRequestId: "guard-1",
        execId: "e".repeat(64),
        requestId: f.descriptor.request.requestId,
        actionChecksum: f.action.actionChecksum,
        commandInputChecksum: "d".repeat(64),
        bindingInputChecksum: sha256Hex(canonicalJson(f.action)),
        ownership: f.ownership,
      })
    )
  })
  it("fails before signing for foreign scope, stopped ownership or expired original gate", async () => {
    const f = fixture()
    await expect(
      f.acknowledge({ ...f.input, action: { ...f.action, operationId: "foreign-1" } })
    ).rejects.toThrow()
    expect(f.inspect).not.toHaveBeenCalled()
    f.inspect.mockResolvedValue({ state: "PRESENT", ownership: f.ownership, running: false })
    await expect(f.acknowledge(f.input)).rejects.toThrow()
    f.assertActive.mockImplementation(() => {
      throw new Error("expired")
    })
    await expect(f.acknowledge(f.input)).rejects.toThrow("expired")
    expect(f.append).not.toHaveBeenCalled()
  })
  it("retains mirror failure without issuing a usable acknowledgement", async () => {
    const f = fixture()
    f.append.mockRejectedValue(new Error("mirror unavailable"))
    await expect(f.acknowledge(f.input)).rejects.toThrow("mirror unavailable")
    expect(f.append).toHaveBeenCalledTimes(1)
  })
})
