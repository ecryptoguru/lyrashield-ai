import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {},
}))

// withWorkspaceRLS passes a tx client; tests supply a mocked tx.
vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(
    async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)
  ),
}))

const mockTx = {
  scanAttachment: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
}

import {
  createScanAttachmentRecord,
  listScanAttachments,
  resolveScanAttachments,
  softDeleteScanAttachment,
  ScanAttachmentError,
} from "./scan-attachment-service"

const SHA = "a".repeat(64)

function attachmentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "att-1",
    workspaceId: "ws-1",
    filename: "notes.txt",
    mediaType: "text/plain",
    byteLength: 512,
    checksum: SHA,
    storageUri: `file:///tmp/evidence/ws-1/att-1-${SHA}`,
    encryptionKeyRef: "local",
    status: "ACTIVE",
    createdById: "user-1",
    createdAt: new Date("2026-09-20T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  }
}

describe("resolveScanAttachments — admission matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns no rows for an empty list", async () => {
    expect(await resolveScanAttachments("ws-1", [])).toEqual([])
    expect(mockTx.scanAttachment.findMany).not.toHaveBeenCalled()
  })

  it("returns verified rows for owned active attachments", async () => {
    mockTx.scanAttachment.findMany.mockResolvedValue([attachmentRow()])
    const rows = await resolveScanAttachments("ws-1", ["att-1"])
    expect(rows).toHaveLength(1)
    // The query is workspace-scoped — a caller can never reach another
    // workspace's attachment by id.
    expect(mockTx.scanAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws-1" }),
      })
    )
  })

  it("rejects an unknown or cross-workspace id with NOT_FOUND", async () => {
    mockTx.scanAttachment.findMany.mockResolvedValue([])
    await expect(resolveScanAttachments("ws-1", ["att-other"])).rejects.toMatchObject({
      code: "SCAN_ATTACHMENT_NOT_FOUND",
    })
  })

  it("rejects a soft-deleted attachment", async () => {
    mockTx.scanAttachment.findMany.mockResolvedValue([
      attachmentRow({ status: "DELETED", deletedAt: new Date() }),
    ])
    await expect(resolveScanAttachments("ws-1", ["att-1"])).rejects.toMatchObject({
      code: "SCAN_ATTACHMENT_UNAVAILABLE",
    })
  })

  it("rejects a malformed stored checksum", async () => {
    mockTx.scanAttachment.findMany.mockResolvedValue([attachmentRow({ checksum: "not-a-sha" })])
    await expect(resolveScanAttachments("ws-1", ["att-1"])).rejects.toMatchObject({
      code: "SCAN_ATTACHMENT_CHECKSUM_INVALID",
    })
  })

  it("rejects a stored row whose type is not allowed", async () => {
    mockTx.scanAttachment.findMany.mockResolvedValue([
      attachmentRow({ filename: "run.exe", mediaType: "application/x-msdownload" }),
    ])
    await expect(resolveScanAttachments("ws-1", ["att-1"])).rejects.toMatchObject({
      code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED",
    })
  })

  it("rejects more than the per-scan attachment cap", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `att-${i}`)
    await expect(resolveScanAttachments("ws-1", ids)).rejects.toMatchObject({
      code: "SCAN_ATTACHMENT_LIMIT_EXCEEDED",
    })
    expect(mockTx.scanAttachment.findMany).not.toHaveBeenCalled()
  })

  it("rejects an aggregate over the per-scan byte cap", async () => {
    // Five ~900 KiB files pass the per-file bound but exceed the 4 MiB
    // per-scan aggregate.
    const rows = Array.from({ length: 5 }, (_, i) =>
      attachmentRow({
        id: `att-${i}`,
        byteLength: 900 * 1024,
        checksum: String(i).padStart(2, "0") + "b".repeat(62),
      })
    )
    mockTx.scanAttachment.findMany.mockResolvedValue(rows)
    await expect(
      resolveScanAttachments("ws-1", rows.map((r) => r.id as string))
    ).rejects.toMatchObject({
      code: "SCAN_ATTACHMENT_LIMIT_EXCEEDED",
    })
  })
})

describe("createScanAttachmentRecord", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTx.scanAttachment.count.mockResolvedValue(0)
    mockTx.scanAttachment.create.mockImplementation(async ({ data }: never) => ({
      ...attachmentRow(),
      ...data,
    }))
  })

  it("persists a validated record", async () => {
    const row = await createScanAttachmentRecord({
      workspaceId: "ws-1",
      filename: "notes.md",
      mediaType: "text/markdown",
      byteLength: 128,
      checksum: SHA,
      storageUri: `file:///tmp/evidence/ws-1/att-${SHA}`,
      encryptionKeyRef: "local",
      createdById: "user-1",
    })
    expect(row.filename).toBe("notes.md")
    expect(row).not.toHaveProperty("storageUri")
    expect(row).not.toHaveProperty("encryptionKeyRef")
  })

  it("rejects a disallowed type at the service boundary", async () => {
    await expect(
      createScanAttachmentRecord({
        workspaceId: "ws-1",
        filename: "run.exe",
        mediaType: "application/x-msdownload",
        byteLength: 128,
        checksum: SHA,
        storageUri: `file:///tmp/evidence/ws-1/att-${SHA}`,
        encryptionKeyRef: "local",
        createdById: "user-1",
      })
    ).rejects.toBeInstanceOf(ScanAttachmentError)
    expect(mockTx.scanAttachment.create).not.toHaveBeenCalled()
  })

  it("rejects an invalid checksum format", async () => {
    await expect(
      createScanAttachmentRecord({
        workspaceId: "ws-1",
        filename: "notes.txt",
        mediaType: "text/plain",
        byteLength: 128,
        checksum: "zz",
        storageUri: `file:///tmp/evidence/ws-1/att-x`,
        encryptionKeyRef: "local",
        createdById: "user-1",
      })
    ).rejects.toMatchObject({ code: "SCAN_ATTACHMENT_CHECKSUM_INVALID" })
  })
})

describe("softDeleteScanAttachment", () => {
  beforeEach(() => vi.clearAllMocks())

  it("marks the row deleted and returns its storage URI", async () => {
    mockTx.scanAttachment.updateMany.mockResolvedValue({ count: 1 })
    mockTx.scanAttachment.findUnique.mockResolvedValue({ storageUri: "file:///tmp/a" })
    const result = await softDeleteScanAttachment("ws-1", "att-1")
    expect(result).toEqual({ storageUri: "file:///tmp/a" })
    expect(mockTx.scanAttachment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "att-1", workspaceId: "ws-1" }),
      })
    )
  })

  it("returns null when nothing was deleted", async () => {
    mockTx.scanAttachment.updateMany.mockResolvedValue({ count: 0 })
    expect(await softDeleteScanAttachment("ws-1", "att-1")).toBeNull()
  })
})

describe("listScanAttachments", () => {
  it("queries only active, non-deleted rows for the workspace", async () => {
    mockTx.scanAttachment.findMany.mockResolvedValue([attachmentRow()])
    const rows = await listScanAttachments("ws-1")
    expect(rows[0]).not.toHaveProperty("storageUri")
    expect(mockTx.scanAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1", status: "ACTIVE", deletedAt: null },
      })
    )
  })
})
