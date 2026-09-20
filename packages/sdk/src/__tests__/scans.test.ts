import { describe, it, expect, vi, beforeEach } from "vitest"
import { LyraShieldClient } from "../client"
import { createScan } from "../resources/scans"

function mockResponse(body: unknown, status = 201) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "Created",
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response
}

const SCAN_RESPONSE = {
  id: "scan-1",
  goal: "CHECK_PR",
  mode: "QUICK",
  status: "QUEUED",
  createdAt: "2026-09-19T00:00:00.000Z",
}

describe("createScan Review Changes inputs", () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let client: LyraShieldClient

  beforeEach(() => {
    mockFetch = vi.fn()
    client = new LyraShieldClient({
      apiKey: "test-key",
      apiUrl: "http://localhost:3000",
      workspaceId: "ws-1",
      fetchFn: mockFetch as unknown as typeof fetch,
    })
  })

  it("submits workflow and both comparison refs in the request body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ success: true, data: SCAN_RESPONSE }))

    await createScan(client, {
      targetId: "t-1",
      goal: "CHECK_PR",
      mode: "QUICK",
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
      headRef: "feature/42",
    })

    const init = mockFetch.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      workspaceId: "ws-1",
      targetId: "t-1",
      goal: "CHECK_PR",
      mode: "QUICK",
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
      headRef: "feature/42",
    })
  })

  it("keeps the idempotency key a header, never a body field", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ success: true, data: SCAN_RESPONSE }))

    await createScan(client, {
      targetId: "t-1",
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
      idempotencyKey: "idem-123",
    })

    const init = mockFetch.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers["Idempotency-Key"]).toBe("idem-123")
    const body = JSON.parse(init.body as string)
    expect(body).not.toHaveProperty("idempotencyKey")
    expect(body).not.toHaveProperty("headRef")
  })

  it("omits workflow fields for a plain snapshot scan", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ success: true, data: SCAN_RESPONSE }))

    await createScan(client, { targetId: "t-1", goal: "TEST_APP", mode: "SAFE" })

    const init = mockFetch.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body).not.toHaveProperty("workflow")
    expect(body).not.toHaveProperty("baseRef")
    expect(body).not.toHaveProperty("headRef")
  })
})
