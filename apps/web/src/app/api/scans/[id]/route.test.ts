import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  getScanWithEvents: vi.fn(),
  cancelScan: vi.fn(),
  removeScan: vi.fn(),
  claimOrGetAgentOperation: vi.fn(),
  completeAgentOperation: vi.fn(),
  failAgentOperation: vi.fn(),
  toJsonObject: (value: object) => JSON.parse(JSON.stringify(value)),
  prisma: { auditLog: { create: vi.fn() } },
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
  assertOAuthDelegatedScope: vi.fn(),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scan: { view: "scan:view", cancel: "scan:cancel", remove: "scan:remove" } },
}))

vi.mock("@lyrashield/integrations", () => ({ getScanQueuePosition: vi.fn() }))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
  logger: { error: vi.fn() },
}))

import { DELETE, GET, POST } from "./route"
import {
  cancelScan,
  claimOrGetAgentOperation,
  completeAgentOperation,
  getScanWithEvents,
  prisma,
  removeScan,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { getScanQueuePosition } from "@lyrashield/integrations"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

const routeParams = { params: Promise.resolve({ id: "scan-1" }) }

describe("/api/scans/[id] workspace boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("requires an explicit workspace before reading a scan", async () => {
    const response = await GET(new Request("http://localhost/api/scans/scan-1"), routeParams)

    expect(response.status).toBe(400)
    expect(getScanWithEvents).not.toHaveBeenCalled()
  })

  it("authorizes and queries inside the requested workspace", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({ id: "scan-1", workspaceId: "ws-1" } as never)

    const response = await GET(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1"),
      routeParams
    )

    expect(response.status).toBe(200)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:view")
    // No `eventsAfter` param = no cursor: the full event window is returned.
    expect(getScanWithEvents).toHaveBeenCalledWith("scan-1", "ws-1", { eventsAfter: undefined })
  })

  it("returns an updated queued position when the scan row and events are unchanged", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({
      id: "scan-1",
      workspaceId: "ws-1",
      status: "QUEUED",
      updatedAt: new Date("2026-09-28T00:00:00.000Z"),
      events: [],
    } as never)
    vi.mocked(getScanQueuePosition)
      .mockResolvedValueOnce({ position: 3, waiting: 3 })
      .mockResolvedValueOnce({ position: 2, waiting: 2 })
    const url = "http://localhost/api/scans/scan-1?workspaceId=ws-1"

    const first = await GET(new Request(url), routeParams)
    const second = await GET(
      new Request(url, { headers: { "If-None-Match": first.headers.get("ETag")! } }),
      routeParams
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers.get("ETag")).not.toBe(first.headers.get("ETag"))
    expect((await second.json()).data.queuePosition).toEqual({ position: 2, waiting: 2 })
    expect(getScanQueuePosition).toHaveBeenCalledTimes(2)
  })

  it("returns 304 for an unchanged completed scan", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({
      id: "scan-1",
      workspaceId: "ws-1",
      status: "COMPLETED",
      updatedAt: new Date("2026-09-28T00:00:00.000Z"),
      events: [],
    } as never)
    const url = "http://localhost/api/scans/scan-1?workspaceId=ws-1"
    const first = await GET(new Request(url), routeParams)
    const second = await GET(
      new Request(url, { headers: { "If-None-Match": first.headers.get("ETag")! } }),
      routeParams
    )

    expect(second.status).toBe(304)
    expect(getScanQueuePosition).not.toHaveBeenCalled()
  })

  it("denies reading a scan without scan:view", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const response = await GET(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1"),
      routeParams
    )

    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/scans/[id]",
      "GET"
    )
    expect(getScanWithEvents).not.toHaveBeenCalled()
  })

  it("passes a well-formed eventsAfter cursor through to the service", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({ id: "scan-1", workspaceId: "ws-1" } as never)

    const response = await GET(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1&eventsAfter=event-42"),
      routeParams
    )

    expect(response.status).toBe(200)
    expect(getScanWithEvents).toHaveBeenCalledWith("scan-1", "ws-1", { eventsAfter: "event-42" })
  })

  it("binds cancellation to the authorized workspace", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({
      id: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
    } as never)
    vi.mocked(cancelScan).mockResolvedValue({
      id: "scan-1",
      status: "CANCELLED",
      endedAt: new Date(),
    } as never)

    const response = await POST(
      new Request("http://localhost/api/scans/scan-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      routeParams
    )

    expect(response.status).toBe(200)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:cancel")
    expect(assertOAuthDelegatedScope).toHaveBeenCalledWith(expect.anything(), "target-1")
    expect(cancelScan).toHaveBeenCalledWith("scan-1", "ws-1")
  })

  it("denies cancellation without scan:cancel", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const response = await POST(
      new Request("http://localhost/api/scans/scan-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      routeParams
    )

    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/scans/[id]",
      "POST"
    )
    expect(getScanWithEvents).not.toHaveBeenCalled()
    expect(cancelScan).not.toHaveBeenCalled()
  })

  it("does not cancel when delegated target scope rejects the scan target", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({
      id: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-2",
    } as never)
    vi.mocked(assertOAuthDelegatedScope).mockImplementationOnce(() => {
      throw new Error("FORBIDDEN")
    })

    const response = await POST(
      new Request("http://localhost/api/scans/scan-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      routeParams
    )

    expect(response.status).toBe(403)
    expect(cancelScan).not.toHaveBeenCalled()
  })

  it("replays a keyed cancellation without submitting it twice", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({ id: "scan-1", workspaceId: "ws-1" } as never)
    vi.mocked(cancelScan).mockResolvedValue({
      id: "scan-1",
      status: "CANCELLED",
      endedAt: new Date("2026-09-26T00:00:00.000Z"),
    } as never)
    vi.mocked(claimOrGetAgentOperation)
      .mockResolvedValueOnce({ status: "NEW", operation: { id: "op-1" } } as never)
      .mockResolvedValueOnce({
        status: "REPLAY",
        operation: {
          id: "op-1",
          result: { id: "scan-1", status: "CANCELLED", endedAt: "2026-09-26T00:00:00.000Z" },
        },
      } as never)
    const request = () =>
      new Request("http://localhost/api/scans/scan-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "cancel-once" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      })

    const first = await POST(request(), routeParams)
    const replay = await POST(request(), routeParams)

    expect(first.status).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    expect(cancelScan).toHaveBeenCalledOnce()
    expect(completeAgentOperation).toHaveBeenCalledOnce()
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        operationName: "scan.cancel",
        input: { id: "scan-1" },
      })
    )
  })

  it("allows cancellation while a scan is verifying", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({
      id: "scan-1",
      workspaceId: "ws-1",
      status: "VERIFYING",
    } as never)
    vi.mocked(cancelScan).mockResolvedValue({
      id: "scan-1",
      status: "CANCELLED",
      endedAt: new Date(),
    } as never)

    const response = await POST(
      new Request("http://localhost/api/scans/scan-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      routeParams
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { id: "scan-1", status: "CANCELLED" },
    })
  })

  it("returns a conflict when finalization already won", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({ id: "scan-1", workspaceId: "ws-1" } as never)
    vi.mocked(cancelScan).mockRejectedValue(new Error("Scan finalization already started"))

    const response = await POST(
      new Request("http://localhost/api/scans/scan-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      routeParams
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCAN_FINALIZATION_STARTED" },
    })
  })

  it("removes a terminal scan from the authorized workspace", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({
      id: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
    } as never)
    vi.mocked(removeScan).mockResolvedValue({ id: "scan-1" } as never)

    const response = await DELETE(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1", { method: "DELETE" }),
      routeParams
    )

    expect(response.status).toBe(200)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:remove")
    expect(assertOAuthDelegatedScope).toHaveBeenCalledWith(expect.anything(), "target-1")
    expect(removeScan).toHaveBeenCalledWith("scan-1", "ws-1")
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          actorUserId: "user-1",
          action: "scan.removed",
          resourceType: "scan",
          resourceId: "scan-1",
        }),
      })
    )
  })

  it("denies removal without scan:remove", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const response = await DELETE(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1", { method: "DELETE" }),
      routeParams
    )

    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/scans/[id]",
      "DELETE"
    )
    expect(getScanWithEvents).not.toHaveBeenCalled()
    expect(removeScan).not.toHaveBeenCalled()
  })

  it("returns SCAN_NOT_FOUND when the scan is not in the authorized workspace", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue(null as never)

    const response = await DELETE(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1", { method: "DELETE" }),
      routeParams
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCAN_NOT_FOUND" },
    })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
    expect(removeScan).not.toHaveBeenCalled()
  })

  it("returns SCAN_ACTIVE without removing an active scan", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({
      id: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
    } as never)
    vi.mocked(removeScan).mockRejectedValue(new Error("Cannot remove an active scan"))

    const response = await DELETE(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1", { method: "DELETE" }),
      routeParams
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SCAN_ACTIVE" } })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("rejects a blank scan id before authorizing or querying the database", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/scans/%20%20%20?workspaceId=ws-1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "   " }) }
    )

    expect(response.status).toBe(400)
    expect(requirePermission).not.toHaveBeenCalled()
    expect(removeScan).not.toHaveBeenCalled()
  })
})
