import { describe, expect, it, vi } from "vitest"
import { LyraShieldClient } from "../client"
import {
  uploadScanAttachment,
  listScanAttachments,
  deleteScanAttachment,
} from "../resources/scan-attachments"
import { requestFixPr } from "../resources/fix-proposals"

const summary = {
  id: "att-1",
  filename: "my notes.md",
  mediaType: "text/markdown",
  byteLength: 5,
  checksum: "a".repeat(64),
  createdAt: "2026-09-26T00:00:00.000Z",
}

function makeClient(data: unknown) {
  const fetchFn = vi.fn(
    async () =>
      new Response(JSON.stringify({ success: true, data }), {
        headers: { "Content-Type": "application/json" },
      })
  )
  return {
    client: new LyraShieldClient({
      apiKey: "synthetic",
      workspaceId: "ws-1",
      apiUrl: "http://localhost",
      fetchFn,
    }),
    fetchFn,
  }
}

describe("scan attachment SDK", () => {
  it("rejects mixing JSON and raw bytes before sending a request", async () => {
    const { client, fetchFn } = makeClient(summary)
    await expect(
      client.request("POST", "/scans/attachments", {
        body: { x: 1 },
        rawBody: new Uint8Array([65]),
      })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("sends authenticated raw bytes with encoded filename and no JSON quoting", async () => {
    const { client, fetchFn } = makeClient(summary)
    const content = new TextEncoder().encode("hello")
    await expect(
      uploadScanAttachment(client, {
        filename: "my notes.md",
        mediaType: "text/markdown",
        content,
        idempotencyKey: "request-1",
      })
    ).resolves.toEqual(summary)
    const [url, request] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://localhost/api/v1/scans/attachments?workspaceId=ws-1")
    expect(request.body).toEqual(content)
    expect(request.body).not.toBe(JSON.stringify(Array.from(content)))
    expect(request.headers).toMatchObject({
      Authorization: "Bearer synthetic",
      "Content-Type": "text/markdown",
      "x-lyrashield-attachment-filename": "my%20notes.md",
      "Idempotency-Key": "request-1",
    })
  })

  it("rejects oversized uploads before fetch and forwards cancellation", async () => {
    const { client, fetchFn } = makeClient(summary)
    expect(() =>
      uploadScanAttachment(client, {
        filename: "a.txt",
        mediaType: "text/plain",
        content: new Uint8Array(1024 * 1024 + 1),
      })
    ).toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadScanAttachment(client, {
        filename: "a.txt",
        mediaType: "text/plain",
        content: new Uint8Array([65]),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "REQUEST_ABORTED" })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("times out a stalled raw upload without retrying the mutation", async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            ;(init.signal as AbortSignal).addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            )
          })
      ) as unknown as typeof fetch
      const client = new LyraShieldClient({ apiKey: "synthetic", workspaceId: "ws-1", fetchFn })
      const pending = uploadScanAttachment(client, {
        filename: "a.txt",
        mediaType: "text/plain",
        content: new Uint8Array([65]),
      }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT" })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("lists and deletes only in the selected workspace", async () => {
    const listed = makeClient({ items: [summary] })
    await expect(listScanAttachments(listed.client)).resolves.toEqual([summary])
    expect(listed.fetchFn.mock.calls[0]?.[0]).toContain("workspaceId=ws-1")
    const deleted = makeClient({ id: "att-1", deleted: true })
    await expect(
      deleteScanAttachment(deleted.client, "att-1", { idempotencyKey: "request-2" })
    ).resolves.toEqual({ id: "att-1", deleted: true })
    expect(deleted.fetchFn.mock.calls[0]?.[0]).toContain("workspaceId=ws-1")
  })

  it("requests a server-owned fix PR with proposal and workspace only", async () => {
    const { client, fetchFn } = makeClient({
      status: "pending_approval",
      approvalId: "approval-1",
      approvalUrl: "https://app.example/approval",
    })
    await expect(
      requestFixPr(client, "proposal-1", { idempotencyKey: "request-3" })
    ).resolves.toMatchObject({ status: "pending_approval" })
    const request = fetchFn.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(request.body as string)).toEqual({ workspaceId: "ws-1" })
    expect(request.headers).toMatchObject({ "Idempotency-Key": "request-3" })
  })
})
