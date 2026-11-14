import { describe, it, expect } from "vitest"
import {
  canonicalJson,
  sha256Hex,
  parseSandboxToolRetirementProof,
} from "@lyrashield/runtime-control"
import { verifySandboxToolRetirement } from "./scan-sandbox-tool-retirement"
function fixture() {
  const ownership = {
    kind: "container",
    executorKey: "sandbox",
    ownershipId: "own_" + "a".repeat(40),
    containerId: "b".repeat(64),
  }
  const requestId = "cb732253-dc0a-4555-9996-340db3bb7f82"
  const descriptor = {
    schema: "lyrashield-sandbox-tool-exec/1",
    workspaceRoot: "/workspace",
    ownership,
    request: {
      binding: {
        operationId: "operation-1",
        attemptId: "attempt-1",
        authorityEpochId: "epoch-1",
        sandboxHandle: ownership.ownershipId,
      },
      requestId,
      commandId: requestId,
      argv: ["true"],
      cwd: "/workspace",
      user: "pentester",
      timeoutSeconds: 1,
      maxOutputBytes: 1024,
    },
  }
  const action = {
    phase: "SANDBOX_TOOL",
    executorKey: "sandbox",
    operationId: "operation-1",
    attemptId: "attempt-1",
    authorityEpochId: "epoch-1",
    workspaceId: "workspace-1",
    scanId: "scan-1",
    authorityRevision: 1,
    authorityChecksum: "c".repeat(64),
    actionChecksum: sha256Hex(canonicalJson(descriptor)),
    commandId: "prepare-1",
    requestId,
  }
  const guard = { ...action, id: "guard-1", bindingInputJson: canonicalJson(action) }
  const intent = {
    actionInputJson: canonicalJson(descriptor),
    actionChecksum: action.actionChecksum,
    authorityChecksum: action.authorityChecksum,
    requestId,
    prepareCommandId: action.commandId,
  }
  const prepareChecksum = "d".repeat(64)
  const body = {
    schema: "lyrashield-native-tool-retirement/1",
    phase: "SANDBOX_TOOL",
    guardId: guard.id,
    nativeRequestId: guard.id,
    commandId: action.commandId,
    stopCommandId: "stop-1",
    operationId: action.operationId,
    attemptId: action.attemptId,
    authorityEpochId: action.authorityEpochId,
    requestId,
    actionChecksum: action.actionChecksum,
    commandInputChecksum: prepareChecksum,
    bindingInputJson: guard.bindingInputJson,
    ownership,
    inspection: { state: "ABSENT" },
  }
  const proof = { ...body, receiptSha256: sha256Hex(canonicalJson(body)) }
  const event = {
    type: "native_invocation_retired",
    phase: "SANDBOX_TOOL",
    supervisorInstanceId: "supervisor-1",
    observedAt: "2026-11-14T00:00:00.000Z",
    commandId: action.commandId,
    stopCommandId: "stop-1",
    attemptId: action.attemptId,
    operationId: action.operationId,
    authorityEpochId: action.authorityEpochId,
    executorKey: "sandbox",
    guardId: guard.id,
    nativeRequestId: guard.id,
    bindingInputChecksum: sha256Hex(guard.bindingInputJson),
    actionChecksum: action.actionChecksum,
    commandInputChecksum: prepareChecksum,
    nativeOperation: "CONTAINER_REMOVED",
    ownership,
    inspection: { state: "ABSENT" },
    nativeToolRetirementProof: proof,
  }
  return { guard, intent, event, proof, prepareChecksum }
}
describe("uncertain native tool retirement", () => {
  it("retires the immutable original guard only with exact owned removal bound to stored STOP", () => {
    const f = fixture()
    expect(verifySandboxToolRetirement(f.event, f.guard, f.prepareChecksum, f.intent)).toEqual(
      f.event
    )
    expect(f.event).not.toHaveProperty("execId")
    expect(f.event).not.toHaveProperty("nativeMutationId")
  })
  it.each(["guardId", "commandId", "stopCommandId", "actionChecksum", "commandInputChecksum"])(
    "rejects changed original %s without manufacturing a start ACK",
    (field) => {
      const f = fixture()
      expect(() =>
        verifySandboxToolRetirement(
          { ...f.event, [field]: "e".repeat(64) },
          f.guard,
          f.prepareChecksum,
          f.intent
        )
      ).toThrow()
    }
  )
  it("rejects live/stopped-but-present inspection and another sandbox", () => {
    const f = fixture()
    expect(() =>
      verifySandboxToolRetirement(
        {
          ...f.event,
          inspection: { state: "PRESENT", running: false, ownership: f.event.ownership },
        },
        f.guard,
        f.prepareChecksum,
        f.intent
      )
    ).toThrow()
    expect(() =>
      verifySandboxToolRetirement(
        { ...f.event, ownership: { ...f.event.ownership, containerId: "e".repeat(64) } },
        f.guard,
        f.prepareChecksum,
        f.intent
      )
    ).toThrow()
  })
  it("rejects root proof checksum tampering or a noncanonical original action", () => {
    const f = fixture()
    expect(() =>
      parseSandboxToolRetirementProof({ ...f.proof, receiptSha256: "e".repeat(64) })
    ).toThrow()
    const { receiptSha256: _sha, ...body } = f.proof
    void _sha
    const changed = { ...body, bindingInputJson: body.bindingInputJson + " " }
    expect(() =>
      parseSandboxToolRetirementProof({
        ...changed,
        receiptSha256: sha256Hex(canonicalJson(changed)),
      })
    ).toThrow()
  })
})
