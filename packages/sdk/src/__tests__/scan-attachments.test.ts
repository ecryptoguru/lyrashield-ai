import { describe, it, expect, vi, beforeEach } from "vitest"
import { LyraShieldClient } from "../client"
import { LyraShieldError } from "../errors"
import {
  defaultScanAttachmentMediaType,
  deleteScanAttachment,
  listScanAttachments,
  requestFixPr,
  SCAN_ATTACHMENT_MAX_BYTES,
  uploadScanAttachment,
} from "../resources/scan-attachments"

const SUMMARY = {
  id: "att-1",
  filename: "notes.txt",
  mediaType: "text/plain",
  byteLength: 5,
  checksum: "a".repeat(64),
  createdAt: "2026-09-25T00:00:00.000Z",
}

function makeFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch
}

function mockResponse({
  ok = true,
  status = 200,
  statusText = "OK",
  headers = new Headers(),
  body,
}: {
  ok?: boolean
  status?: number
  statusText?: string
  headers?: Headers
  body?: unknown
}) {
  return {
    ok,
    status,
    statusText,
    headers,
    json: async () => body,
  }
}

let mockFetch: ReturnType<typeof vi.fn>
let client: LyraShieldClient

beforeEach(() => {
  mockFetch = vi.fn()
  client = new LyraShieldClient({
    apiKey: "test-key",
    apiUrl: "http://localhost:3000",
    workspaceId: "ws-1",
    fetchFn: makeFetch(mockFetch),
  })
})

describe("listScanAttachments", () => {
  it("GETs the workspace attachment list and parses safe fields only", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        body: {
          success: true,
          data: {
            items: [
              {
                ...SUMMARY,
                // Storage internals must never reach SDK callers even if the
                // API ever returns them.
                storageUri: "s3://bucket/secret",
                encryptionKeyRef: "kek-1",
              },
            ],
          },
        },
      })
    )
    const res = await listScanAttachments(client)
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/v1/scans/attachments?workspaceId=ws-1",
      expect.objectContaining({ method: "GET" })
    )
    expect(res.items[0]!.id).toBe("att-1")
    expect(res.items[0]).not.toHaveProperty("storageUri")
    expect(res.items[0]).not.toHaveProperty("encryptionKeyRef")
  })

  it("honors an explicit workspaceId over the client default", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ body: { success: true, data: { items: [] } } }))
    await listScanAttachments(client, "ws-other")
    expect(mockFetch.mock.calls[0]![0]).toContain("workspaceId=ws-other")
  })
})

describe("uploadScanAttachment", () => {
  it("POSTs raw bytes with filename/media-type/idempotency headers", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ status: 201, body: { success: true, data: SUMMARY } })
    )
    const res = await uploadScanAttachment(client, {
      filename: "notes.txt",
      content: "hello",
      mediaType: "text/plain",
      idempotencyKey: "up-1",
    })
    expect(res.id).toBe("att-1")
    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe("http://localhost:3000/api/v1/scans/attachments?workspaceId=ws-1")
    const headers = init.headers as Record<string, string>
    expect(headers["content-type"]).toBe("text/plain")
    expect(headers["x-lyrashield-attachment-filename"]).toBe("notes.txt")
    expect(headers["Idempotency-Key"]).toBe("up-1")
    expect(init.body).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe("hello")
  })

  it("encodes filenames for the header", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ status: 201, body: { success: true, data: SUMMARY } })
    )
    await uploadScanAttachment(client, {
      filename: "my notes.md",
      content: "x",
      mediaType: "text/markdown",
    })
    const headers = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers["x-lyrashield-attachment-filename"]).toBe(encodeURIComponent("my notes.md"))
  })

  it("rejects a traversal filename before any fetch", async () => {
    await expect(
      uploadScanAttachment(client, {
        filename: "../escape.txt",
        content: "x",
        mediaType: "text/plain",
      })
    ).rejects.toMatchObject({ code: "SCAN_ATTACHMENT_NAME_INVALID" })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects a forbidden extension before any fetch", async () => {
    await expect(
      uploadScanAttachment(client, {
        filename: "run.exe",
        content: "MZ",
        mediaType: "application/octet-stream",
      })
    ).rejects.toMatchObject({ code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED" })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects a disallowed media type for the extension before any fetch", async () => {
    await expect(
      uploadScanAttachment(client, {
        filename: "spec.yaml",
        content: "a: 1",
        mediaType: "application/json",
      })
    ).rejects.toMatchObject({ code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED" })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects an empty body before any fetch", async () => {
    await expect(
      uploadScanAttachment(client, { filename: "a.txt", content: "", mediaType: "text/plain" })
    ).rejects.toMatchObject({ code: "SCAN_ATTACHMENT_EMPTY" })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects over-limit bytes before any fetch", async () => {
    const big = new Uint8Array(SCAN_ATTACHMENT_MAX_BYTES + 1)
    await expect(
      uploadScanAttachment(client, { filename: "a.txt", content: big, mediaType: "text/plain" })
    ).rejects.toMatchObject({ code: "SCAN_ATTACHMENT_SIZE_EXCEEDED" })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects NUL bytes before any fetch", async () => {
    await expect(
      uploadScanAttachment(client, {
        filename: "a.txt",
        content: new Uint8Array([0x61, 0x00, 0x62]),
        mediaType: "text/plain",
      })
    ).rejects.toMatchObject({ code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED" })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe("defaultScanAttachmentMediaType", () => {
  it("maps extensions to their canonical media type", () => {
    expect(defaultScanAttachmentMediaType("a.txt")).toBe("text/plain")
    expect(defaultScanAttachmentMediaType("README.MD")).toBe("text/markdown")
    expect(defaultScanAttachmentMediaType("spec.yaml")).toBe("application/yaml")
    expect(defaultScanAttachmentMediaType("doc.json")).toBe("application/json")
    expect(defaultScanAttachmentMediaType("run.exe")).toBeUndefined()
  })
})

describe("deleteScanAttachment", () => {
  it("DELETEs the attachment route with the idempotency key", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ body: { success: true, data: { id: "att-1", deleted: true } } })
    )
    const res = await deleteScanAttachment(client, "att-1", { idempotencyKey: "del-1" })
    expect(res.deleted).toBe(true)
    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe("http://localhost:3000/api/v1/scans/attachments/att-1?workspaceId=ws-1")
    expect(init.method).toBe("DELETE")
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("del-1")
  })
})

describe("requestFixPr", () => {
  it("POSTs {workspaceId} and parses a pending_approval outcome", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        body: {
          success: true,
          data: {
            status: "pending_approval",
            approvalId: "ap-1",
            approvalUrl: "https://app.lyrashieldai.com/dashboard/approvals?approval=ap-1",
          },
        },
      })
    )
    const res = await requestFixPr(client, "prop-1", { idempotencyKey: "fix-1" })
    expect(res.status).toBe("pending_approval")
    expect(res.approvalUrl).toContain("approval=ap-1")
    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe("http://localhost:3000/api/v1/fix-proposals/prop-1/create-pr")
    expect(JSON.parse(String(init.body))).toEqual({ workspaceId: "ws-1" })
  })

  it("parses an opened outcome with PR coordinates", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        body: {
          success: true,
          data: { status: "opened", prNumber: 42, prUrl: "https://github.com/o/r/pull/42" },
        },
      })
    )
    const res = await requestFixPr(client, "prop-1")
    expect(res.status).toBe("opened")
    expect(res.prNumber).toBe(42)
  })

  it("surfaces a rejected patch as a 422 PATCH_REJECTED error, never a success", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        body: {
          success: false,
          error: { code: "PATCH_REJECTED", message: "Patch failed validation" },
        },
      })
    )
    const err = await requestFixPr(client, "prop-1").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LyraShieldError)
    expect((err as LyraShieldError).code).toBe("PATCH_REJECTED")
    expect((err as LyraShieldError).status).toBe(422)
  })
})
