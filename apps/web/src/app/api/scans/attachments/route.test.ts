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
  prisma: { auditLog: { create: vi.fn() } },
  createScanAttachmentRecord: vi.fn(),
  listScanAttachments: vi.fn(),
  claimOrGetAgentOperation: vi.fn(),
  completeAgentOperation: vi.fn(),
  failAgentOperation: vi.fn(),
  ScanAttachmentError: class ScanAttachmentError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

vi.mock("@lyrashield/evidence-storage", () => ({
  uploadEncryptedArtifact: vi.fn(),
  deleteEncryptedArtifact: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { id: "ws-1" },
  }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: {
    scanAttachment: { read: "scan_attachment:read", upload: "scan_attachment:upload" },
  },
}))

vi.mock("@lyrashield/logger", async () =>
  (await import("../../../../__tests__/mocks")).loggerModule()
)

import { POST, GET } from "./route"
import {
  createScanAttachmentRecord,
  listScanAttachments,
  prisma,
  claimOrGetAgentOperation,
  completeAgentOperation,
} from "@lyrashield/db"
import { deleteEncryptedArtifact, uploadEncryptedArtifact } from "@lyrashield/evidence-storage"
import { requirePermission } from "@lyrashield/auth/server"

const SHA = "a".repeat(64)

function uploadRequest(body: string, filename = "notes.txt", type = "text/plain"): Request {
  return new Request("http://localhost:3000/api/scans/attachments?workspaceId=ws-1", {
    method: "POST",
    headers: {
      "content-type": type,
      "x-lyrashield-attachment-filename": encodeURIComponent(filename),
    },
    body,
  })
}

describe("POST /api/scans/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { id: "ws-1" },
    } as never)
    vi.mocked(uploadEncryptedArtifact).mockResolvedValue({
      storageUri: `file:///tmp/evidence/ws-1/att-${SHA}`,
      checksum: SHA,
      encryptionKeyRef: "local",
      byteLength: 5,
    } as never)
    vi.mocked(createScanAttachmentRecord).mockResolvedValue({
      id: "att-1",
      filename: "notes.txt",
      mediaType: "text/plain",
      byteLength: 5,
      checksum: SHA,
      createdAt: new Date(),
    } as never)
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never)
  })

  it("uploads a text attachment and records it workspace-scoped", async () => {
    const res = await POST(uploadRequest("hello"))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.data.id).toBe("att-1")
    expect(uploadEncryptedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", type: "scan-attachment" })
    )
    expect(createScanAttachmentRecord).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", checksum: SHA, createdById: "user-1" })
    )
  })

  it("replays the same authorized upload without storing a second encrypted object", async () => {
    const first = { id: "op-1" }
    vi.mocked(claimOrGetAgentOperation)
      .mockResolvedValueOnce({ status: "NEW", operation: first } as never)
      .mockResolvedValueOnce({
        status: "REPLAY",
        operation: {
          ...first,
          result: {
            id: "att-1",
            filename: "notes.txt",
            mediaType: "text/plain",
            byteLength: 5,
            checksum: SHA,
            createdAt: "2026-09-26T00:00:00.000Z",
          },
        },
      } as never)
    const request = () =>
      new Request("http://localhost:3000/api/scans/attachments?workspaceId=ws-1", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "x-lyrashield-attachment-filename": "notes.txt",
          "Idempotency-Key": "retry-1",
        },
        body: "hello",
      })
    const firstResponse = await POST(request())
    const replay = await POST(request())
    expect(firstResponse.status).toBe(201)
    expect(replay.status).toBe(200)
    expect((await replay.json()).data.id).toBe("att-1")
    expect(uploadEncryptedArtifact).toHaveBeenCalledTimes(1)
    expect(completeAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ resultReference: "att-1" })
    )
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        operationName: "scan.attachment.upload",
        input: {
          filename: "notes.txt",
          mediaType: "text/plain",
          checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      })
    )
  })

  it("rejects changed bytes with the same operation key before storing", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "CONFLICT",
      message: "different input",
    } as never)
    const request = uploadRequest("hello")
    request.headers.set("Idempotency-Key", "retry-1")
    const res = await POST(request)
    expect(res.status).toBe(409)
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("rejects an executable upload", async () => {
    const res = await POST(uploadRequest("MZ", "run.exe", "application/x-msdownload"))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("SCAN_ATTACHMENT_TYPE_NOT_ALLOWED")
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("rejects a path-traversal filename", async () => {
    const res = await POST(uploadRequest("x", "../escape.txt"))
    expect(res.status).toBe(400)
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("rejects an archive upload", async () => {
    const res = await POST(uploadRequest("PK\x03\x04", "bundle.zip", "application/zip"))
    expect(res.status).toBe(400)
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("rejects content over the per-file byte limit", async () => {
    const req = new Request("http://localhost:3000/api/scans/attachments?workspaceId=ws-1", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-lyrashield-attachment-filename": "big.txt",
        "content-length": String(2 * 1024 * 1024),
      },
      body: "x",
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("SCAN_ATTACHMENT_SIZE_EXCEEDED")
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("rejects binary bytes even under a text media type", async () => {
    const res = await POST(uploadRequest("a\x00b", "notes.txt"))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("SCAN_ATTACHMENT_TYPE_NOT_ALLOWED")
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("compensates the stored object when the record write fails", async () => {
    vi.mocked(createScanAttachmentRecord).mockRejectedValue(new Error("db down") as never)
    const res = await POST(uploadRequest("hello"))
    expect(res.status).toBe(500)
    expect(deleteEncryptedArtifact).toHaveBeenCalledWith(
      `file:///tmp/evidence/ws-1/att-${SHA}`,
      "ws-1"
    )
  })

  it("requires workspaceId", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/scans/attachments", {
        method: "POST",
        headers: { "content-type": "text/plain", "x-lyrashield-attachment-filename": "a.txt" },
        body: "x",
      })
    )
    expect(res.status).toBe(400)
  })

  it("denies upload without explicit attachment permission", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN") as never)
    const res = await POST(uploadRequest("x"))
    expect(res.status).not.toBe(201)
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })
})

describe("GET /api/scans/attachments", () => {
  it("lists active attachments without storage internals", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { id: "ws-1" },
    } as never)
    vi.mocked(listScanAttachments).mockResolvedValue([
      {
        id: "att-1",
        filename: "notes.txt",
        mediaType: "text/plain",
        byteLength: 5,
        checksum: SHA,
        createdAt: new Date("2026-09-20T00:00:00Z"),
      },
    ] as never)
    const res = await GET(
      new Request("http://localhost:3000/api/scans/attachments?workspaceId=ws-1")
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.items[0].id).toBe("att-1")
    expect(json.data.items[0]).not.toHaveProperty("storageUri")
    expect(json.data.items[0]).not.toHaveProperty("encryptionKeyRef")
  })
})
