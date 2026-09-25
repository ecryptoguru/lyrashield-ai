import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  softDeleteScanAttachment: vi.fn(),
  claimOrGetAgentOperation: vi.fn(),
  completeAgentOperation: vi.fn(),
  failAgentOperation: vi.fn(),
}))

vi.mock("@lyrashield/evidence-storage", () => ({
  deleteEncryptedArtifact: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { id: "ws-1" },
  }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { attachment: { delete: "attachment:delete" } },
}))

vi.mock("@lyrashield/logger", async () =>
  (await import("../../../../../__tests__/mocks")).loggerModule()
)

import { DELETE } from "./route"
import {
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
  softDeleteScanAttachment,
} from "@lyrashield/db"
import { deleteEncryptedArtifact } from "@lyrashield/evidence-storage"
import { requirePermission } from "@lyrashield/auth/server"

function deleteRequest(key?: string): Request {
  const headers: Record<string, string> = {}
  if (key) headers["Idempotency-Key"] = key
  return new Request("http://localhost:3000/api/scans/attachments/att-1?workspaceId=ws-1", {
    method: "DELETE",
    headers,
  })
}

const routeParams = { params: Promise.resolve({ id: "att-1" }) }

describe("DELETE /api/scans/attachments/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { id: "ws-1" },
    } as never)
    vi.mocked(softDeleteScanAttachment).mockResolvedValue({
      storageUri: "file:///tmp/evidence/ws-1/att-1",
    } as never)
    vi.mocked(deleteEncryptedArtifact).mockResolvedValue(undefined as never)
    vi.mocked(completeAgentOperation).mockResolvedValue({} as never)
    vi.mocked(failAgentOperation).mockResolvedValue({} as never)
  })

  it("deletes the attachment and removes the stored object", async () => {
    const res = await DELETE(deleteRequest(), routeParams)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toMatchObject({ id: "att-1", deleted: true })
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "attachment:delete")
    expect(softDeleteScanAttachment).toHaveBeenCalledWith("ws-1", "att-1")
    expect(deleteEncryptedArtifact).toHaveBeenCalledWith("file:///tmp/evidence/ws-1/att-1", "ws-1")
    expect(claimOrGetAgentOperation).not.toHaveBeenCalled()
  })

  it("returns 404 for a missing or cross-workspace attachment", async () => {
    vi.mocked(softDeleteScanAttachment).mockResolvedValue(null as never)
    const res = await DELETE(deleteRequest(), routeParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe("SCAN_ATTACHMENT_NOT_FOUND")
    expect(deleteEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("still succeeds when storage removal fails — the outbox retries", async () => {
    vi.mocked(deleteEncryptedArtifact).mockRejectedValue(new Error("storage down") as never)
    const res = await DELETE(deleteRequest(), routeParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data.deleted).toBe(true)
  })

  it("denies delete without attachment:delete permission", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN") as never)
    const res = await DELETE(deleteRequest(), routeParams)
    expect(res.status).not.toBe(200)
    expect(softDeleteScanAttachment).not.toHaveBeenCalled()
  })

  it("claims a scan_attachment.delete operation keyed to the attachment id", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op-del" },
    } as never)
    const res = await DELETE(deleteRequest("del-key"), routeParams)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.operationId).toBe("op-del")
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        operationName: "scan_attachment.delete",
        idempotencyKey: "del-key",
        input: { attachmentId: "att-1" },
      })
    )
    expect(completeAgentOperation).toHaveBeenCalledWith(
      "op-del",
      "ws-1",
      expect.objectContaining({ result: expect.objectContaining({ deleted: true }) })
    )
  })

  it("replays the recorded deletion on a same-key retry", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "REPLAY",
      operation: { id: "op-del", result: { id: "att-1", deleted: true } },
    } as never)
    const res = await DELETE(deleteRequest("del-key"), routeParams)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toMatchObject({ id: "att-1", deleted: true, operationId: "op-del" })
    expect(softDeleteScanAttachment).not.toHaveBeenCalled()
    expect(deleteEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("conflicts when the key was bound to a different attachment", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "CONFLICT",
      message: "Idempotency key was already used with different input",
    } as never)
    const res = await DELETE(deleteRequest("del-key"), routeParams)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_CONFLICT")
    expect(softDeleteScanAttachment).not.toHaveBeenCalled()
  })

  it("marks the operation not-submitted when the attachment is already gone", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op-del" },
    } as never)
    vi.mocked(softDeleteScanAttachment).mockResolvedValue(null as never)
    const res = await DELETE(deleteRequest("del-key"), routeParams)
    expect(res.status).toBe(404)
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-del",
      "ws-1",
      expect.objectContaining({ error: "OPERATION_NOT_SUBMITTED" })
    )
  })

  it("requires workspaceId", async () => {
    const res = await DELETE(
      new Request("http://localhost:3000/api/scans/attachments/att-1", { method: "DELETE" }),
      routeParams
    )
    expect(res.status).toBe(400)
    expect(softDeleteScanAttachment).not.toHaveBeenCalled()
  })
})
