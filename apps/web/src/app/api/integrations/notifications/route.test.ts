import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  getSession: vi.fn(),
  requirePermission: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  disable: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  audit: vi.fn(),
  validate: vi.fn(),
  send: vi.fn(),
  channels: vi.fn(),
  activeDestination: vi.fn(),
}))
vi.mock("../../../../lib/rate-limit", () => ({ checkNotificationTestRateLimit: mocks.rateLimit }))
vi.mock("@lyrashield/auth/server", () => ({
  getSession: mocks.getSession,
  requirePermission: mocks.requirePermission,
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: {
    integration: { manage: "integration:manage" },
    notification: { view: "notification:view" },
  },
}))
vi.mock("@lyrashield/db", () => ({
  listNotificationIntegrations: mocks.list,
  saveNotificationIntegration: mocks.save,
  disableNotificationIntegration: mocks.disable,
  getWorkspaceNotificationChannels: mocks.channels,
  withActiveWorkspaceNotificationDestination: mocks.activeDestination,
  prisma: { auditLog: { create: mocks.audit } },
}))
vi.mock("@lyrashield/evidence-storage", () => ({
  uploadEncryptedArtifact: mocks.upload,
  deleteEncryptedArtifact: mocks.remove,
}))
vi.mock("@lyrashield/integrations", () => ({
  validateNotificationWebhookUrl: mocks.validate,
  sendWorkspaceNotification: mocks.send,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock("../../../../lib/api-auth", () => ({
  withCookieMutation: (fn: unknown) => fn,
  authErrorResponse: (error: Error) =>
    ["FORBIDDEN", "UNAUTHORIZED"].includes(error.message)
      ? Response.json({ success: false }, { status: error.message === "FORBIDDEN" ? 403 : 401 })
      : null,
}))

import { GET, POST, DELETE } from "./route"
import { POST as TEST } from "./test/route"
const webhookUrl = "https://hooks.slack.com/services/T000/B000/secret"
const summary = {
  id: "int-1",
  channel: "slack",
  name: "Slack notifications",
  status: "active",
  updatedAt: "2026-10-10",
}
function request(
  method: string,
  body: object = { workspaceId: "ws-1", channel: "slack", webhookUrl }
) {
  return new Request("https://app.lyrashieldai.com/api/integrations/notifications", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("workspace notification settings API", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.rateLimit.mockResolvedValue({
      limited: false,
      remaining: 2,
      retryAfter: 0,
      unavailable: false,
    })
    mocks.getSession.mockResolvedValue({ userId: "user-1" })
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.validate.mockReturnValue(true)
    mocks.list.mockResolvedValue([summary])
    mocks.upload.mockResolvedValue({ storageUri: "s3://private/new" })
    mocks.save.mockResolvedValue({ integration: summary, previousConfigRef: null })
    mocks.disable.mockResolvedValue({
      integration: { ...summary, status: "disabled" },
      previousConfigRef: "s3://private/retired",
    })
    mocks.channels.mockResolvedValue([{ channel: "slack", configRef: "s3://private/current" }])
    mocks.activeDestination.mockImplementation(async (_workspaceId, _channel, send) =>
      send("s3://private/current")
    )
    mocks.send.mockResolvedValue(true)
    mocks.remove.mockResolvedValue(undefined)
    mocks.audit.mockResolvedValue({})
  })

  it("lists safe summaries with notification view permission", async () => {
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/integrations/notifications?workspaceId=ws-1")
    )
    expect(await response.json()).toEqual({ success: true, data: [summary] })
    expect(mocks.requirePermission).toHaveBeenCalledWith("ws-1", "notification:view")
  })

  it("saves only a sealed webhook reference, audits, and never sends a message", async () => {
    const response = await POST(request("POST"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, data: summary })
    expect(mocks.requirePermission).toHaveBeenCalledWith("ws-1", "integration:manage")
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", content: JSON.stringify({ webhookUrl }) })
    )
    expect(mocks.save).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      channel: "slack",
      configRef: "s3://private/new",
    })
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret")
    expect(mocks.audit).toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each([{ apiKey: true }, { oauth: true }])(
    "rejects credential mutations without a browser session: %j",
    async (credentials) => {
      mocks.getSession.mockResolvedValue({ userId: "user-1", ...credentials })
      expect((await POST(request("POST"))).status).toBe(403)
      expect(mocks.upload).not.toHaveBeenCalled()
      expect(mocks.save).not.toHaveBeenCalled()
    }
  )

  it("rejects unauthenticated mutations", async () => {
    mocks.getSession.mockResolvedValue(null)
    expect((await POST(request("POST"))).status).toBe(401)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it.each([DELETE, TEST])(
    "rejects non-browser credentials for disable and explicit test",
    async (handler) => {
      mocks.getSession.mockResolvedValue({ userId: "user-1", apiKey: true })
      expect(
        (await handler(request("POST", { workspaceId: "ws-1", channel: "slack" }))).status
      ).toBe(403)
      expect(mocks.disable).not.toHaveBeenCalled()
      expect(mocks.channels).not.toHaveBeenCalled()
      expect(mocks.send).not.toHaveBeenCalled()
    }
  )

  it("checks manage permission before resolving or sending a test notification", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))
    expect((await TEST(request("POST", { workspaceId: "ws-1", channel: "slack" }))).status).toBe(
      403
    )
    expect(mocks.channels).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it("rejects custom test content", async () => {
    expect(
      (
        await TEST(
          request("POST", { workspaceId: "ws-1", channel: "slack", body: "untrusted message" })
        )
      ).status
    ).toBe(400)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("does not list another workspace when access is denied", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))
    expect(
      (
        await GET(
          new Request(
            "https://app.lyrashieldai.com/api/integrations/notifications?workspaceId=ws-2"
          )
        )
      ).status
    ).toBe(403)
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it("denies members lacking integration manage before sealing secrets", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))
    expect((await POST(request("POST"))).status).toBe(403)
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it("rejects untrusted webhook hosts before storage", async () => {
    mocks.validate.mockReturnValue(false)
    expect((await POST(request("POST"))).status).toBe(400)
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it("rejects unknown fields and unsupported channels", async () => {
    expect(
      (
        await POST(
          request("POST", { workspaceId: "ws-1", channel: "slack", webhookUrl, token: "hidden" })
        )
      ).status
    ).toBe(400)
    expect(
      (await POST(request("POST", { workspaceId: "ws-1", channel: "email", webhookUrl }))).status
    ).toBe(400)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it("cleans up a newly sealed orphan when persistence fails without reflecting secrets", async () => {
    mocks.save.mockRejectedValue(new Error(webhookUrl))
    const response = await POST(request("POST"))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain(webhookUrl)
    expect(mocks.remove).toHaveBeenCalledWith("s3://private/new", "ws-1")
  })

  it("does not delete the persisted credential if audit persistence fails", async () => {
    mocks.audit.mockRejectedValue(new Error("audit down"))
    expect((await POST(request("POST"))).status).toBe(500)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it("removes the rotated prior credential only after successful replacement", async () => {
    mocks.save.mockResolvedValue({ integration: summary, previousConfigRef: "s3://private/old" })
    expect((await POST(request("POST"))).status).toBe(200)
    expect(mocks.remove).toHaveBeenCalledWith("s3://private/old", "ws-1")
  })

  it("disconnects then retires its workspace-bound sealed credential without exposing its reference", async () => {
    const response = await DELETE(request("DELETE", { workspaceId: "ws-1", channel: "slack" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      data: { ...summary, status: "disabled" },
    })
    expect(mocks.disable).toHaveBeenCalledWith("ws-1", "slack")
    expect(mocks.remove).toHaveBeenCalledWith("s3://private/retired", "ws-1")
    expect(mocks.disable.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0]
    )
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("s3:")
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("waits for disconnect commit before artifact cleanup or its separate audit", async () => {
    let commit!: () => void
    let reachedDisable!: () => void
    const reached = new Promise<void>((resolve) => {
      reachedDisable = resolve
    })
    mocks.disable.mockImplementation(async () => {
      reachedDisable()
      await new Promise<void>((resolve) => {
        commit = resolve
      })
      return {
        integration: { ...summary, status: "disabled" },
        previousConfigRef: "s3://private/retired",
      }
    })
    const pending = DELETE(request("DELETE", { workspaceId: "ws-1", channel: "slack" }))
    await reached
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
    commit()
    expect((await pending).status).toBe(200)
    expect(mocks.remove).toHaveBeenCalledWith("s3://private/retired", "ws-1")
    expect(mocks.audit).toHaveBeenCalled()
  })

  it("does not retire an artifact if disconnect persistence fails", async () => {
    mocks.disable.mockRejectedValue(new Error("transaction failed"))
    expect(
      (await DELETE(request("DELETE", { workspaceId: "ws-1", channel: "slack" }))).status
    ).toBe(500)
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it("does not attempt artifact deletion for an already retired credential", async () => {
    mocks.disable.mockResolvedValue({
      integration: { ...summary, status: "disabled" },
      previousConfigRef: null,
    })
    expect(
      (await DELETE(request("DELETE", { workspaceId: "ws-1", channel: "slack" }))).status
    ).toBe(200)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it("denies rate-limited tests before resolving credentials, audit, or send", async () => {
    mocks.rateLimit.mockResolvedValue({
      limited: true,
      remaining: 0,
      retryAfter: 30,
      unavailable: false,
    })
    const response = await TEST(request("POST", { workspaceId: "ws-1", channel: "slack" }))
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("30")
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "user-1",
      channel: "slack",
    })
    expect(mocks.channels).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("fails closed when shared test rate limiting is unavailable", async () => {
    mocks.rateLimit.mockResolvedValue({
      limited: true,
      remaining: 0,
      retryAfter: 60,
      unavailable: true,
    })
    const response = await TEST(request("POST", { workspaceId: "ws-1", channel: "slack" }))
    expect(response.status).toBe(503)
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("tests only a configured active channel with a canned payload", async () => {
    expect((await TEST(request("POST", { workspaceId: "ws-1", channel: "slack" }))).status).toBe(
      200
    )
    expect(mocks.send).toHaveBeenCalledWith(
      "slack",
      {
        type: "integration.test",
        title: "LyraShield AI test notification",
        body: "Your notification integration is connected.",
      },
      { workspaceId: "ws-1", configRef: "s3://private/current" }
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "integration.notification.test_requested" }),
      })
    )
  })

  it("resolves a rotated reference inside the delivery lock instead of using the stale selection", async () => {
    mocks.activeDestination.mockImplementation(async (_workspaceId, _channel, send) =>
      send("s3://private/rotated")
    )
    expect((await TEST(request("POST", { workspaceId: "ws-1", channel: "slack" }))).status).toBe(
      200
    )
    expect(mocks.send).toHaveBeenCalledWith("slack", expect.any(Object), {
      workspaceId: "ws-1",
      configRef: "s3://private/rotated",
    })
  })

  it("does not send when integration was disabled after the initial configured check", async () => {
    mocks.activeDestination.mockResolvedValue(null)
    expect((await TEST(request("POST", { workspaceId: "ws-1", channel: "slack" }))).status).toBe(
      409
    )
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("does not test an absent or disabled integration", async () => {
    mocks.channels.mockResolvedValue([])
    expect((await TEST(request("POST", { workspaceId: "ws-1", channel: "slack" }))).status).toBe(
      404
    )
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("returns a sanitized provider failure for a failed explicit test", async () => {
    mocks.send.mockRejectedValue(new Error(webhookUrl))
    const response = await TEST(request("POST", { workspaceId: "ws-1", channel: "slack" }))
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain(webhookUrl)
  })
})
