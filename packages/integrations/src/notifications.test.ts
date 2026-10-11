import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({
  env: {
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test/secret",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789012345678/secret",
  },
}))
vi.mock("@lyrashield/config", () => config)

import { sendNotification } from "./notifications"

describe("legacy global webhook senders", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(["slack", "discord"] as const)(
    "blocks redirects and releases %s responses",
    async (channel) => {
      const cancel = vi.fn()
      const response = new Response(new ReadableStream({ cancel }), { status: 429 })
      const read = vi.spyOn(response, "text")
      fetchMock.mockResolvedValue(response)

      await expect(
        sendNotification(channel, { type: "scan.failed", title: "Failed", body: "Details" })
      ).resolves.toBe(false)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "POST", redirect: "error" })
      )
      expect(read).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledOnce()
    }
  )

  it.each(["slack", "discord"] as const)(
    "does not follow a rejected %s redirect",
    async (channel) => {
      fetchMock.mockRejectedValue(new TypeError("redirect rejected"))
      await expect(
        sendNotification(channel, { type: "scan.failed", title: "Failed", body: "Details" })
      ).resolves.toBe(false)
      expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "error" }))
    }
  )
})
