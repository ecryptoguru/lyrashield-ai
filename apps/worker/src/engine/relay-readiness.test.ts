import { describe, expect, it, vi } from "vitest"
import { isTargetRelayReady } from "./relay-readiness"

const configured = {
  LYRASHIELD_TARGET_RELAY_URL: "https://relay.example.test",
  LYRASHIELD_RELAY_SIGNING_SECRET: "test-secret-never-sent",
  LYRASHIELD_EGRESS_PROXY_SECRET: "test-admin-never-sent",
}

describe("target relay readiness", () => {
  it("does not probe incomplete optional configuration", async () => {
    const probe = vi.fn()
    expect(await isTargetRelayReady({}, probe)).toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })

  it("accepts only an affirmative bounded capability probe without transmitting credentials", async () => {
    const probe = vi.fn().mockResolvedValue(Response.json({ relay: true }))
    expect(await isTargetRelayReady(configured, probe)).toBe(true)
    const [url, options] = probe.mock.calls[0]
    expect(url).toBe("https://relay.example.test/health/relay")
    expect(options).toMatchObject({ redirect: "error" })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(probe.mock.calls)).not.toContain(
      configured.LYRASHIELD_RELAY_SIGNING_SECRET
    )
    expect(JSON.stringify(probe.mock.calls)).not.toContain(
      configured.LYRASHIELD_EGRESS_PROXY_SECRET
    )
  })

  it.each([
    Response.json({ relay: false }, { status: 503 }),
    Response.json({ relay: false }),
    Response.json({ status: "ready" }),
    new Response("invalid-json"),
  ])("rejects unavailable or unrecognized capability evidence", async (response) => {
    expect(await isTargetRelayReady(configured, vi.fn().mockResolvedValue(response))).toBe(false)
  })

  it("treats timeout or network failure as unavailable", async () => {
    expect(
      await isTargetRelayReady(configured, vi.fn().mockRejectedValue(new Error("timeout")))
    ).toBe(false)
  })
})
