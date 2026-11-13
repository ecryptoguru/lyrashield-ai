import { describe, expect, it } from "vitest"
import { canonicalJson } from "@lyrashield/runtime-control"
import { sha256Hex } from "./scan-supervisor-receipt-verifier"
import {
  verifyPrepareInvocationCompleted,
  verifyNativeInvocationAck,
} from "./scan-supervisor-native-invocation-resolution"

const checksum = "a".repeat(64)
const guard = {
  id: "guard-test",
  operationId: "operation-test",
  attemptId: "attempt-test",
  authorityEpochId: "epoch-test",
  phase: "EXECUTOR_START",
  commandId: "command-test",
  executorKey: "engine",
  actionChecksum: checksum,
  bindingInputJson: '{"phase":"EXECUTOR_START"}',
}
const ownership = {
  kind: "container",
  ownershipId: `own_${sha256Hex(`${guard.attemptId}\0${guard.commandId}\0engine`).slice(0, 40)}`,
  executorKey: "engine",
  containerId: "c".repeat(64),
}
const ack = {
  type: "native_invocation_ack",
  supervisorInstanceId: "supervisor-test",
  observedAt: "2026-11-13T00:00:00.000Z",
  commandId: guard.commandId,
  attemptId: guard.attemptId,
  operationId: guard.operationId,
  authorityEpochId: guard.authorityEpochId,
  executorKey: "engine",
  guardId: guard.id,
  nativeRequestId: guard.id,
  nativeOperation: "CONTAINER_START_ACK",
  bindingInputChecksum: sha256Hex(guard.bindingInputJson),
  actionChecksum: checksum,
  commandInputChecksum: checksum,
  ownership,
  inspection: { state: "PRESENT", running: true, ownership },
}

describe("original native invocation acknowledgement", () => {
  it("accepts exact acknowledged start and current inspection without settling paid uncertainty", () => {
    expect(canonicalJson(verifyNativeInvocationAck(ack, guard, checksum))).toBe(canonicalJson(ack))
  })
  it.each([
    ["foreign guard", { ...ack, guardId: "foreign" }],
    ["different original request", { ...ack, nativeRequestId: "foreign" }],
    ["changed exact command", { ...ack, commandInputChecksum: "b".repeat(64) }],
    ["wrong phase", { ...ack, nativeOperation: "CONTAINER_CREATE_ACK" }],
    ["lost inspection", { ...ack, inspection: { state: "UNKNOWN" } }],
    ["container absence", { ...ack, inspection: { state: "ABSENT" } }],
    ["start not running", { ...ack, inspection: { state: "PRESENT", running: false, ownership } }],
    [
      "different owned container",
      {
        ...ack,
        inspection: {
          state: "PRESENT",
          running: true,
          ownership: { ...ownership, containerId: "d".repeat(64) },
        },
      },
    ],
  ])("holds %s", (_name, changed) => {
    expect(() => verifyNativeInvocationAck(changed, guard, checksum)).toThrow()
  })
})

describe("original metadata preparation completion", () => {
  const preparedGuard = {
    ...guard,
    phase: "PREPARE",
    executorKey: null,
    bindingInputJson: '{"phase":"PREPARE"}',
  }
  const common = {
    supervisorInstanceId: ack.supervisorInstanceId,
    observedAt: ack.observedAt,
    commandId: ack.commandId,
    attemptId: ack.attemptId,
    operationId: ack.operationId,
    authorityEpochId: ack.authorityEpochId,
    guardId: ack.guardId,
    nativeRequestId: ack.nativeRequestId,
    actionChecksum: ack.actionChecksum,
    commandInputChecksum: ack.commandInputChecksum,
  }
  const proof = {
    ...common,
    type: "prepare_invocation_completed",
    bindingInputChecksum: sha256Hex(preparedGuard.bindingInputJson),
  }
  it("accepts exact original metadata invocation and never invents a Docker acknowledgement", () => {
    expect(verifyPrepareInvocationCompleted(proof, preparedGuard, checksum).type).toBe(
      "prepare_invocation_completed"
    )
  })
  it.each([
    ["native phase", guard],
    ["different original command", { ...preparedGuard, commandId: "other-command" }],
    ["changed binding", { ...preparedGuard, bindingInputJson: '{"phase":"STOP"}' }],
  ])("rejects %s", (_label, changed) => {
    expect(() => verifyPrepareInvocationCompleted(proof, changed, checksum)).toThrow()
  })
})
