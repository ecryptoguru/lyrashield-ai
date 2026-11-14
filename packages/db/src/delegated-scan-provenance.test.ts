import { describe, expect, it, vi } from "vitest"
import {
  bindDelegatedScanProvenance,
  DelegatedScanAdmissionError,
} from "./delegated-scan-provenance"
import { hashDelegatedAdmissionProof } from "./agent-operation-hash"

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op-1",
    workspaceId: "ws-1",
    connectionId: "conn-1",
    principalType: "OAUTH_CONNECTION",
    principalId: "conn-1",
    operationName: "scan.create",
    authorizationVersion: 3,
    inputHash: "input-hash",
    status: "EXECUTING",
    resultReference: null,
    admissionProofHash: hashDelegatedAdmissionProof("server-proof"),
    ...overrides,
  }
}

function transaction(op = operation()) {
  return {
    agentOperation: {
      findFirst: vi.fn().mockResolvedValue(op),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    delegatedScanProvenance: {
      create: vi.fn().mockResolvedValue({ operationId: op.id }),
    },
  }
}

const admission = {
  operationId: "op-1",
  admissionProof: "server-proof",
  connectionId: "conn-1",
  authorizationVersion: 3,
}

describe("delegated scan provenance", () => {
  it("atomically reserves the operation result and writes exact immutable provenance", async () => {
    const tx = transaction()

    await bindDelegatedScanProvenance(tx as never, {
      workspaceId: "ws-1",
      scanId: "scan-1",
      targetId: "target-1",
      executionPlanHash: "plan-hash",
      admission,
    })

    expect(tx.agentOperation.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "op-1",
        workspaceId: "ws-1",
        connectionId: "conn-1",
        principalType: "OAUTH_CONNECTION",
        principalId: "conn-1",
        operationName: "scan.create",
        authorizationVersion: 3,
        status: "EXECUTING",
        resultReference: null,
      }),
      select: { id: true, inputHash: true, admissionProofHash: true },
    })
    expect(tx.agentOperation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "op-1",
        workspaceId: "ws-1",
        connectionId: "conn-1",
        authorizationVersion: 3,
        status: "EXECUTING",
        resultReference: null,
      }),
      data: { resultReference: "scan-1" },
    })
    expect(tx.delegatedScanProvenance.create).toHaveBeenCalledWith({
      data: {
        operationId: "op-1",
        workspaceId: "ws-1",
        scanId: "scan-1",
        targetId: "target-1",
        connectionId: "conn-1",
        authorizationVersion: 3,
        operationInputHash: "input-hash",
        scanExecutionPlanHash: "plan-hash",
      },
    })
  })

  it("binds a retest-created scan without relabelling its outer operation", async () => {
    const tx = transaction(operation({ operationName: "retest.create" }))

    await bindDelegatedScanProvenance(tx as never, {
      workspaceId: "ws-1",
      scanId: "scan-retest",
      targetId: "target-1",
      executionPlanHash: "plan-hash",
      admission: { ...admission, operationName: "retest.create" },
    })

    expect(tx.agentOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ operationName: "retest.create" }),
      })
    )
    expect(tx.delegatedScanProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ operationId: "op-1", scanId: "scan-retest" }),
    })
  })

  it("rejects a forged proof before reserving the result or writing provenance", async () => {
    const tx = transaction()

    await expect(
      bindDelegatedScanProvenance(tx as never, {
        workspaceId: "ws-1",
        scanId: "scan-1",
        targetId: "target-1",
        executionPlanHash: "plan-hash",
        admission: { ...admission, admissionProof: "forged-proof" },
      })
    ).rejects.toBeInstanceOf(DelegatedScanAdmissionError)

    expect(tx.agentOperation.updateMany).not.toHaveBeenCalled()
    expect(tx.delegatedScanProvenance.create).not.toHaveBeenCalled()
  })

  it("fails closed when another writer already claimed the operation result", async () => {
    const tx = transaction()
    tx.agentOperation.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      bindDelegatedScanProvenance(tx as never, {
        workspaceId: "ws-1",
        scanId: "scan-1",
        targetId: "target-1",
        executionPlanHash: "plan-hash",
        admission,
      })
    ).rejects.toBeInstanceOf(DelegatedScanAdmissionError)

    expect(tx.delegatedScanProvenance.create).not.toHaveBeenCalled()
  })
})
