import { describe, expect, it } from "vitest"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { verifyNativeRetirement } from "./scan-native-retirement"

function fixture(phase: "EXECUTOR_CREATE" | "EXECUTOR_START" = "EXECUTOR_CREATE") {
  const binding = {
    phase,
    operationId: "operation-1",
    attemptId: "attempt-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    authorityEpochId: "epoch-1",
    authorityRevision: 1,
    commandId: "start-1",
    executorKey: "engine",
    authorityChecksum: "a".repeat(64),
    actionChecksum: "b".repeat(64),
  }
  const guard = { ...binding, id: "guard-1", bindingInputJson: canonicalJson(binding) }
  const ownership = {
    executorKey: "engine" as const,
    kind: "container" as const,
    ownershipId: "own_" + sha256Hex("attempt-1\0start-1\0engine").slice(0, 40),
    containerId: "c".repeat(64),
  }
  const shared = {
    supervisorInstanceId: "supervisor-1",
    observedAt: "2026-11-14T00:00:00.000Z",
    commandId: guard.commandId,
    attemptId: guard.attemptId,
    operationId: guard.operationId,
    authorityEpochId: guard.authorityEpochId,
    executorKey: ownership.executorKey,
    guardId: guard.id,
    nativeRequestId: guard.id,
    bindingInputChecksum: sha256Hex(guard.bindingInputJson),
    actionChecksum: guard.actionChecksum,
    commandInputChecksum: guard.actionChecksum,
  }
  const planned = {
    type: "native_invocation_planned",
    ...shared,
    ...(phase === "EXECUTOR_CREATE"
      ? { phase, ownership: { ...ownership, containerId: undefined } }
      : { ownership }),
  }
  const proofBody = {
    schema: "lyrashield-native-removal/1",
    phase: "EXECUTOR_CREATE",
    guardId: guard.id,
    nativeRequestId: guard.id,
    commandId: guard.commandId,
    stopCommandId: "stop-1",
    operationId: guard.operationId,
    attemptId: guard.attemptId,
    authorityEpochId: guard.authorityEpochId,
    bindingInputChecksum: shared.bindingInputChecksum,
    actionChecksum: guard.actionChecksum,
    ownership,
    inspection: { state: "ABSENT" },
  }
  const retired = {
    type: "native_invocation_retired",
    ...shared,
    stopCommandId: "stop-1",
    nativeOperation: "CONTAINER_REMOVED",
    ownership,
    inspection: { state: "ABSENT" },
    ...(phase === "EXECUTOR_CREATE"
      ? {
          phase,
          nativeRemovalProof: { ...proofBody, receiptSha256: sha256Hex(canonicalJson(proofBody)) },
        }
      : {}),
  }
  return { guard, planned, retired }
}

describe("original native retirement proof", () => {
  it.each(["EXECUTOR_CREATE", "EXECUTOR_START"] as const)(
    "accepts exact %s removal without inventing an invocation ACK",
    (phase) => {
      const f = fixture(phase)
      expect(verifyNativeRetirement(f.retired, f.guard, f.guard.actionChecksum, f.planned)).toEqual(
        f.retired
      )
    }
  )
  it("rejects altered original guard, phase, ownership, command and root receipt", () => {
    const f = fixture()
    for (const patch of [
      { guardId: "foreign-guard" },
      { phase: "EXECUTOR_START" },
      { stopCommandId: "foreign-stop" },
      { ownership: { ...f.retired.ownership, containerId: "d".repeat(64) } },
      { inspection: { state: "PRESENT" } },
      { nativeRemovalProof: { ...f.retired.nativeRemovalProof, receiptSha256: "f".repeat(64) } },
      { nativeRemovalProof: undefined },
    ])
      expect(() =>
        verifyNativeRetirement(
          { ...f.retired, ...patch },
          f.guard,
          f.guard.actionChecksum,
          f.planned
        )
      ).toThrow()
    expect(() => verifyNativeRetirement(f.retired, f.guard, "f".repeat(64), f.planned)).toThrow()
    expect(() =>
      verifyNativeRetirement(f.retired, f.guard, f.guard.actionChecksum, {
        ...f.planned,
        guardId: "foreign-guard",
      })
    ).toThrow()
  })
})
