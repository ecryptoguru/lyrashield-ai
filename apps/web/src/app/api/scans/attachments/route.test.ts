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
    scan: { view: "scan:view", create: "scan:create" },
    attachment: { upload: "attachment:upload", delete: "attachment:delete" },
  },
}))

vi.mock("@lyrashield/logger", async () =>
  (await import("../../../../__tests__/mocks")).loggerModule()
)

import { POST, GET } from "./route"
import {
  claimOrGetAgentOperation,
  completeAgentOperation,
  createScanAttachmentRecord,
  failAgentOperation,
  listScanAttachments,
  prisma,
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
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "attachment:upload")
    expect(uploadEncryptedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", type: "scan-attachment" })
    )
    expect(createScanAttachmentRecord).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", checksum: SHA, createdById: "user-1" })
    )
    // No Idempotency-Key → no operation ledger involvement at all.
    expect(claimOrGetAgentOperation).not.toHaveBeenCalled()
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

  it("denies upload without attachment:upload permission", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN") as never)
    const res = await POST(uploadRequest("x"))
    expect(res.status).not.toBe(201)
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })
})

describe("POST /api/scans/attachments idempotency", () => {
  function keyedUploadRequest(key: string | null, body = "hello", filename = "notes.txt") {
    const headers: Record<string, string> = {
      "content-type": "text/plain",
      "x-lyrashield-attachment-filename": encodeURIComponent(filename),
    }
    if (key !== null) headers["Idempotency-Key"] = key
    return new Request("http://localhost:3000/api/scans/attachments?workspaceId=ws-1", {
      method: "POST",
      headers,
      body,
    })
  }

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
    vi.mocked(completeAgentOperation).mockResolvedValue({} as never)
    vi.mocked(failAgentOperation).mockResolvedValue({} as never)
  })

  it("claims a scan_attachment.upload operation with canonical input, never the bytes", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op-1" },
    } as never)
    const res = await POST(keyedUploadRequest("key-1"))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.data.id).toBe("att-1")
    expect(json.data.operationId).toBe("op-1")
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        operationName: "scan_attachment.upload",
        idempotencyKey: "key-1",
        input: {
          filename: "notes.txt",
          mediaType: "text/plain",
          contentChecksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        userId: "user-1",
      })
    )
    expect(completeAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ result: expect.objectContaining({ id: "att-1" }) })
    )
  })

  it("replays the stored result for a same-key same-input retry without re-uploading", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "REPLAY",
      operation: { id: "op-1", result: { id: "att-1", filename: "notes.txt" } },
    } as never)
    const res = await POST(keyedUploadRequest("key-1"))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.id).toBe("att-1")
    expect(json.data.operationId).toBe("op-1")
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
    expect(createScanAttachmentRecord).not.toHaveBeenCalled()
  })

  it("two same-key uploads create exactly one record", async () => {
    vi.mocked(claimOrGetAgentOperation)
      .mockResolvedValueOnce({ status: "NEW", operation: { id: "op-1" } } as never)
      .mockResolvedValueOnce({
        status: "REPLAY",
        operation: { id: "op-1", result: { id: "att-1" } },
      } as never)
    await POST(keyedUploadRequest("key-1"))
    const replay = await POST(keyedUploadRequest("key-1"))
    expect(replay.status).toBe(200)
    expect(createScanAttachmentRecord).toHaveBeenCalledTimes(1)
    expect(uploadEncryptedArtifact).toHaveBeenCalledTimes(1)
  })

  it("conflicts on same-key different input before any storage write", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "CONFLICT",
      message: "Idempotency key was already used with different input",
    } as never)
    const res = await POST(keyedUploadRequest("key-1", "different bytes"))
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_CONFLICT")
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("marks the operation not-submitted when the record write fails", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op-1" },
    } as never)
    vi.mocked(createScanAttachmentRecord).mockRejectedValue(new Error("db down") as never)
    const res = await POST(keyedUploadRequest("key-1"))
    expect(res.status).toBe(500)
    expect(failAgentOperation).toHaveBeenCalledWith(
      "op-1",
      "ws-1",
      expect.objectContaining({ error: "OPERATION_NOT_SUBMITTED" })
    )
    // Storage compensation still runs for the orphaned object.
    expect(deleteEncryptedArtifact).toHaveBeenCalledWith(
      `file:///tmp/evidence/ws-1/att-${SHA}`,
      "ws-1"
    )
  })

  it("rejects an over-long idempotency key", async () => {
    const res = await POST(keyedUploadRequest("k".repeat(129)))
    expect(res.status).toBe(400)
    expect(claimOrGetAgentOperation).not.toHaveBeenCalled()
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
