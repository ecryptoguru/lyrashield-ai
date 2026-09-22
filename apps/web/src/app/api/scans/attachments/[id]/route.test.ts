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
  PERMISSIONS: { scan: { view: "scan:view", create: "scan:create" } },
}))

vi.mock("@lyrashield/logger", async () =>
  (await import("../../../../../__tests__/mocks")).loggerModule()
)

import { DELETE } from "./route"
import { softDeleteScanAttachment } from "@lyrashield/db"
import { deleteEncryptedArtifact } from "@lyrashield/evidence-storage"
import { requirePermission } from "@lyrashield/auth/server"

function deleteRequest(id = "att-1", workspaceId = "ws-1"): Request {
  return new Request(
    `http://localhost:3000/api/scans/attachments/${id}?workspaceId=${workspaceId}`,
    {
      method: "DELETE",
    }
  )
}

function params(id = "att-1") {
  return { params: Promise.resolve({ id }) }
}

describe("DELETE /api/scans/attachments/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { id: "ws-1" },
    } as never)
    vi.mocked(softDeleteScanAttachment).mockResolvedValue({
      storageUri: "s3://bucket/evidence/ws-1/scan-attachments/user-1/att-1",
    } as never)
  })

  it("soft-deletes the row and removes the stored object", async () => {
    vi.mocked(deleteEncryptedArtifact).mockResolvedValue(undefined as never)
    const res = await DELETE(deleteRequest(), params())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ id: "att-1", deleted: true })
    expect(softDeleteScanAttachment).toHaveBeenCalledWith("ws-1", "att-1")
    expect(deleteEncryptedArtifact).toHaveBeenCalledWith(
      "s3://bucket/evidence/ws-1/scan-attachments/user-1/att-1",
      "ws-1"
    )
  })

  it("still succeeds when storage removal fails — the outbox task committed with the soft delete retries", async () => {
    vi.mocked(deleteEncryptedArtifact).mockRejectedValue(new Error("object store unavailable"))
    const res = await DELETE(deleteRequest(), params())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ id: "att-1", deleted: true })
  })

  it("returns 404 when the attachment is absent or already deleted", async () => {
    vi.mocked(softDeleteScanAttachment).mockResolvedValue(null)
    const res = await DELETE(deleteRequest(), params())
    expect(res.status).toBe(404)
    expect(deleteEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("requires workspaceId", async () => {
    const res = await DELETE(
      new Request("http://localhost:3000/api/scans/attachments/att-1", { method: "DELETE" }),
      params()
    )
    expect(res.status).toBe(400)
    expect(softDeleteScanAttachment).not.toHaveBeenCalled()
  })
})
