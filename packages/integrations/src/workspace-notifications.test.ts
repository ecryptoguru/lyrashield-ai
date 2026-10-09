import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ readEncryptedArtifact: vi.fn() }))
vi.mock("@lyrashield/evidence-storage", () => mocks)

import {
  sendWorkspaceNotification,
  validateNotificationWebhookUrl,
} from "./workspace-notifications"

const slackUrl = "https://hooks.slack.com/services/T123/B456/secret-token"
const discordUrl = "https://discord.com/api/webhooks/123456789012345678/secret-token"
const payload = { type: "scan.failed", title: "Scan Failed", body: "An error occurred" }
const context = { workspaceId: "ws-1", configRef: "s3://bucket/evidence/ws-1/config" }

describe("workspace notification webhooks", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    mocks.readEncryptedArtifact.mockResolvedValue({
      content: Buffer.from(JSON.stringify({ webhookUrl: slackUrl })),
      checksum: "checksum",
      encryptionKeyRef: "key-ref",
      legacy: false,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each([
    ["slack", slackUrl, true],
    ["discord", discordUrl, true],
    ["slack", discordUrl, false],
    ["discord", slackUrl, false],
    ["slack", "http://hooks.slack.com/services/T/B/token", false],
    ["slack", "https://hooks.slack.com.evil.test/services/T/B/token", false],
    ["slack", "https://hooks.slack.com:443/services/T/B/token", false],
    ["slack", "https://user:pass@hooks.slack.com/services/T/B/token", false],
    ["slack", "https://hooks.slack.com/services/T/B/token?next=evil", false],
    ["slack", "https://hooks.slack.com/services/T/B/token#secret", false],
    ["slack", "https://hooks.slack.com/services/T/B/%2fprivate", false],
    ["slack", "https://hooks.slack.com/services/T/B/../token", false],
    ["slack", " https://hooks.slack.com/services/T/B/token", false],
    ["discord", "https://discord.com/api/webhooks/name/token", false],
    ["discord", "https://discord.com/api/webhooks/123/token/extra", false],
    ["discord", "https://discord.com/api/webhooks/123/token?wait=true", false],
  ] as const)("validates %s destination %s", (channel, url, valid) => {
    expect(validateNotificationWebhookUrl(channel, url)).toBe(valid)
  })

  it("decrypts only the expected workspace credential and disables redirects", async () => {
    await expect(sendWorkspaceNotification("slack", payload, context)).resolves.toBe(true)
    expect(mocks.readEncryptedArtifact).toHaveBeenCalledWith(context.configRef, "ws-1")
    expect(fetchMock).toHaveBeenCalledWith(
      slackUrl,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      })
    )
  })

  it("escapes Slack mention and link syntax and disables markdown and unfurls", async () => {
    await sendWorkspaceNotification(
      "slack",
      {
        ...payload,
        title: "<!channel>",
        body: "<https://evil.test|click> & <@U123>",
      },
      context
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.text).toContain("&lt;!channel&gt;")
    expect(body.text).toContain("&lt;https://evil.test|click&gt; &amp; &lt;@U123&gt;")
    expect(body).toMatchObject({ mrkdwn: false, unfurl_links: false, unfurl_media: false })
  })

  it("prevents Discord mentions and bounds content to provider limits", async () => {
    mocks.readEncryptedArtifact.mockResolvedValue({
      content: Buffer.from(JSON.stringify({ webhookUrl: discordUrl })),
    })
    await sendWorkspaceNotification(
      "discord",
      { ...payload, body: "@everyone ".repeat(500) },
      context
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(body.content.length).toBeLessThanOrEqual(2000)
  })

  it.each([
    "not-json",
    "null",
    "[]",
    JSON.stringify({ webhookUrl: slackUrl, extra: "secret" }),
    JSON.stringify({ webhookUrl: "https://127.0.0.1/internal" }),
  ])("rejects invalid encrypted payloads before any outbound request", async (content) => {
    mocks.readEncryptedArtifact.mockResolvedValue({ content: Buffer.from(content) })
    await expect(sendWorkspaceNotification("slack", payload, context)).rejects.toThrow("credential")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("redacts artifact failures that may include a credential reference", async () => {
    mocks.readEncryptedArtifact.mockRejectedValue(new Error(`Cannot read ${context.configRef}`))
    await expect(sendWorkspaceNotification("slack", payload, context)).rejects.toThrow("credential")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("bounds encrypted credential retrieval before attempting any provider send", async () => {
    vi.useFakeTimers()
    mocks.readEncryptedArtifact.mockImplementation(() => new Promise(() => {}))
    const result = sendWorkspaceNotification("slack", payload, context).then(
      () => "sent",
      (error: Error) => error.message
    )
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(result).resolves.toBe(
      "Workspace notification credential is unavailable or invalid"
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("redacts transport errors including webhook tokens", async () => {
    fetchMock.mockRejectedValue(new Error(`Fetch failed for ${slackUrl}`))
    await expect(sendWorkspaceNotification("slack", payload, context)).rejects.toThrow(
      /^Workspace notification delivery failed$/
    )
  })

  it("rejects provider failures without reading raw response bodies", async () => {
    const response = new Response("secret upstream details", { status: 429 })
    const read = vi.spyOn(response, "text")
    fetchMock.mockResolvedValue(response)
    await expect(sendWorkspaceNotification("slack", payload, context)).rejects.toThrow("HTTP 429")
    expect(read).not.toHaveBeenCalled()
  })

  it("cancels unused upstream response streams so connections can be released", async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 200 }))
    await sendWorkspaceNotification("slack", payload, context)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
