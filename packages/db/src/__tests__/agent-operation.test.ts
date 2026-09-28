import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  claimOrGetAgentOperation,
  getOperationStatus,
  hashOperationInput,
} from "../agent-operation-service"
import { prisma } from "../client"

vi.mock("../client", () => ({
  prisma: {
    agentOperation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}))
vi.mock("../rls", () => ({
  withWorkspaceRLS: (_workspaceId: string, callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
}))

describe("WP-03 Agent Operation Durable Execution and Idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("produces deterministic canonical input hashes regardless of key order", () => {
    const hash1 = hashOperationInput("lyrashield_scan_target", {
      targetId: "t-1",
      profile: "STANDARD",
      metadata: { a: 1, b: 2 },
    })

    const hash2 = hashOperationInput("lyrashield_scan_target", {
      profile: "STANDARD",
      metadata: { b: 2, a: 1 },
      targetId: "t-1",
    })

    expect(hash1).toBe(hash2)
  })

  it("creates a NEW operation when key has never been seen", async () => {
    const mockFindUnique = vi.mocked(prisma.agentOperation.findUnique)
    const mockCreate = vi.mocked(prisma.agentOperation.create)

    mockFindUnique.mockResolvedValueOnce(null)
    const mockCreated = {
      id: "op-1",
      workspaceId: "ws-1",
      connectionId: "conn-1",
      operationName: "lyrashield_create_report",
      idempotencyKey: "key-123",
      inputHash: "some-hash",
      authorizationVersion: 1,
      status: "PENDING" as const,
      resultReference: null,
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockCreate.mockResolvedValueOnce(mockCreated)

    const result = await claimOrGetAgentOperation({
      workspaceId: "ws-1",
      connectionId: "conn-1",
      operationName: "lyrashield_create_report",
      idempotencyKey: "key-123",
      input: { title: "Security Assessment" },
    })

    expect(result.status).toBe("NEW")
    if (result.status === "NEW") {
      expect(result.operation.id).toBe("op-1")
    }
  })

  it("returns REPLAY when key is repeated with matching input", async () => {
    const mockFindUnique = vi.mocked(prisma.agentOperation.findUnique)

    const input = { targetId: "t-1", profile: "SAFE" }
    const inputHash = hashOperationInput("lyrashield_scan_target", input)

    const existingOp = {
      id: "op-existing",
      workspaceId: "ws-1",
      connectionId: "conn-1",
      operationName: "lyrashield_scan_target",
      idempotencyKey: "key-replay",
      inputHash,
      authorizationVersion: 1,
      status: "COMPLETED" as const,
      resultReference: "scan-id-99",
      result: { scanId: "scan-id-99", status: "QUEUED" },
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockFindUnique.mockResolvedValueOnce(existingOp)

    const result = await claimOrGetAgentOperation({
      workspaceId: "ws-1",
      connectionId: "conn-1",
      operationName: "lyrashield_scan_target",
      idempotencyKey: "key-replay",
      input,
    })

    expect(result.status).toBe("REPLAY")
    if (result.status === "REPLAY") {
      expect(result.operation.id).toBe("op-existing")
      expect(result.operation.resultReference).toBe("scan-id-99")
    }
  })

  it("returns IN_PROGRESS instead of replay permission for an unfinished operation", async () => {
    const input = { targetId: "t-1", mode: "SAFE" }
    vi.mocked(prisma.agentOperation.findUnique).mockResolvedValueOnce({
      id: "op-running",
      workspaceId: "ws-1",
      connectionId: "conn-1",
      operationName: "scan.create",
      idempotencyKey: "key-running",
      inputHash: hashOperationInput("scan.create", input),
      authorizationVersion: 1,
      status: "EXECUTING",
      resultReference: null,
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await claimOrGetAgentOperation({
      workspaceId: "ws-1",
      connectionId: "conn-1",
      operationName: "scan.create",
      idempotencyKey: "key-running",
      input,
    })

    expect(result.status).toBe("IN_PROGRESS")
  })

  it("returns CONFLICT when same key is used with conflicting input", async () => {
    const mockFindUnique = vi.mocked(prisma.agentOperation.findUnique)

    const originalInput = { targetId: "target-A" }
    const originalHash = hashOperationInput("lyrashield_scan_target", originalInput)

    const existingOp = {
      id: "op-original",
      workspaceId: "ws-1",
      connectionId: "conn-1",
      operationName: "lyrashield_scan_target",
      idempotencyKey: "key-shared",
      inputHash: originalHash,
      authorizationVersion: 1,
      status: "COMPLETED" as const,
      resultReference: "scan-1",
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockFindUnique.mockResolvedValueOnce(existingOp)

    const result = await claimOrGetAgentOperation({
      workspaceId: "ws-1",
      connectionId: "conn-1",
      operationName: "lyrashield_scan_target",
      idempotencyKey: "key-shared",
      input: { targetId: "target-DIFFERENT-B" },
    })

    expect(result.status).toBe("CONFLICT")
  })

  it("reopens a failed scan cancellation with an atomic status check", async () => {
    const service = (await import("../agent-operation-service")) as unknown as {
      retryScanCancellation?: (
        operationId: string,
        workspaceId: string,
        staleBefore: Date
      ) => Promise<{ status: string; operation?: { id: string } } | null>
    }
    expect(service.retryScanCancellation).toBeTypeOf("function")
    if (!service.retryScanCancellation) return

    vi.mocked(prisma.agentOperation.updateMany).mockResolvedValueOnce({ count: 1 } as never)
    vi.mocked(prisma.agentOperation.findFirst).mockResolvedValueOnce({
      id: "cancel-op-1",
      workspaceId: "ws-1",
      operationName: "scan.cancel",
      status: "EXECUTING",
    } as never)

    const staleBefore = new Date("2026-09-28T00:00:00Z")
    const result = await service.retryScanCancellation("cancel-op-1", "ws-1", staleBefore)

    expect(prisma.agentOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cancel-op-1",
        workspaceId: "ws-1",
        operationName: "scan.cancel",
        OR: [
          {
            status: "FAILED",
            error: {
              in: [
                "TASK_CANCELLATION_FAILED",
                "TASK_CANCELLATION_NOT_CONFIRMED",
                "TASK_CANCELLATION_STATUS_UNAVAILABLE",
              ],
            },
          },
          {
            status: { in: ["PENDING", "EXECUTING"] },
            error: null,
            updatedAt: { lt: staleBefore },
          },
        ],
      },
      data: { status: "EXECUTING", error: null },
    })
    expect(result).toMatchObject({ status: "NEW", operation: { id: "cancel-op-1" } })
  })

  it("returns in-progress when another cancellation retry already claimed the row", async () => {
    const service = (await import("../agent-operation-service")) as unknown as {
      retryScanCancellation?: (
        operationId: string,
        workspaceId: string,
        staleBefore: Date
      ) => Promise<{ status: string; operation?: { id: string } } | null>
    }
    expect(service.retryScanCancellation).toBeTypeOf("function")
    if (!service.retryScanCancellation) return

    vi.mocked(prisma.agentOperation.updateMany).mockResolvedValueOnce({ count: 0 } as never)
    vi.mocked(prisma.agentOperation.findFirst).mockResolvedValueOnce({
      id: "cancel-op-1",
      workspaceId: "ws-1",
      operationName: "scan.cancel",
      status: "EXECUTING",
    } as never)

    const result = await service.retryScanCancellation(
      "cancel-op-1",
      "ws-1",
      new Date("2026-09-28T00:00:00Z")
    )

    expect(result).toMatchObject({ status: "IN_PROGRESS", operation: { id: "cancel-op-1" } })
  })

  it("reclaims only scan cancellations older than the supplied cutoff", async () => {
    const service = (await import("../agent-operation-service")) as unknown as {
      retryScanCancellation?: (
        operationId: string,
        workspaceId: string,
        staleBefore: Date
      ) => Promise<{ status: string; operation?: { id: string } } | null>
    }
    expect(service.retryScanCancellation).toBeTypeOf("function")
    if (!service.retryScanCancellation) return

    const staleBefore = new Date("2026-09-28T00:00:00Z")
    vi.mocked(prisma.agentOperation.updateMany).mockResolvedValueOnce({ count: 1 } as never)
    vi.mocked(prisma.agentOperation.findFirst).mockResolvedValueOnce({
      id: "cancel-op-1",
      workspaceId: "ws-1",
      operationName: "scan.cancel",
      status: "EXECUTING",
    } as never)

    const result = await service.retryScanCancellation("cancel-op-1", "ws-1", staleBefore)

    expect(prisma.agentOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationName: "scan.cancel",
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: { in: ["PENDING", "EXECUTING"] },
              error: null,
              updatedAt: { lt: staleBefore },
            }),
          ]),
        }),
      })
    )
    expect(result).toMatchObject({ status: "NEW", operation: { id: "cancel-op-1" } })
  })

  it("does not fail a cancellation after another attempt has taken over", async () => {
    const service = (await import("../agent-operation-service")) as unknown as {
      failAgentOperation: (
        operationId: string,
        workspaceId: string,
        params: { error: string; expectedUpdatedAt: Date }
      ) => Promise<{ id: string; status: string; error: string | null }>
    }
    const oldAttempt = new Date("2026-09-28T00:00:00Z")
    const currentAttempt = new Date("2026-09-28T00:03:00Z")
    vi.mocked(prisma.agentOperation.updateMany).mockResolvedValueOnce({ count: 0 } as never)
    vi.mocked(prisma.agentOperation.findFirst).mockResolvedValueOnce({
      id: "cancel-op-1",
      workspaceId: "ws-1",
      status: "EXECUTING",
      error: null,
      updatedAt: currentAttempt,
    } as never)

    const result = await service.failAgentOperation("cancel-op-1", "ws-1", {
      error: "TASK_CANCELLATION_FAILED",
      expectedUpdatedAt: oldAttempt,
    })

    expect(prisma.agentOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cancel-op-1",
        workspaceId: "ws-1",
        status: "EXECUTING",
        updatedAt: oldAttempt,
      },
      data: {
        status: "FAILED",
        error: "TASK_CANCELLATION_FAILED",
        resultReference: undefined,
      },
    })
    expect(result).toMatchObject({ status: "EXECUTING", error: null, updatedAt: currentAttempt })
  })
})

it("restricts operation status to its principal and current authorization version", async () => {
  vi.mocked(prisma.agentOperation.findFirst).mockResolvedValue({
    id: "op",
    principalType: "OAUTH_CONNECTION",
    principalId: "conn-a",
    authorizationVersion: 2,
    status: "COMPLETED",
    resultReference: "report",
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never)
  expect(
    await getOperationStatus("op", "ws", {
      principalType: "OAUTH_CONNECTION",
      principalId: "conn-b",
    })
  ).toBeNull()
  expect(
    await getOperationStatus("op", "ws", {
      principalType: "OAUTH_CONNECTION",
      principalId: "conn-a",
      authorizationVersion: 3,
    })
  ).toBeNull()
  expect(
    await getOperationStatus("op", "ws", {
      principalType: "OAUTH_CONNECTION",
      principalId: "conn-a",
      authorizationVersion: 2,
    })
  ).toMatchObject({ operationId: "op", resultLocation: "report" })
})
