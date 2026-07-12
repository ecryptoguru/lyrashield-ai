import { describe, expect, it, vi } from "vitest"
import { safeFetch } from "./safe-fetch"

describe("safeFetch", () => {
  it("uses the LyraShield scanner user agent by default", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))

    await safeFetch("https://example.com", {
      fetchFn,
      resolver: async () => ["93.184.216.34"],
    })

    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ headers: { "User-Agent": "LyraShield-Scanner/1.0" } })
    )
  })
})
