import { createServer } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { safeFetch } from "./safe-fetch"

describe("safeFetch", () => {
  const servers: ReturnType<typeof createServer>[] = []

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            )
        )
    )
  })

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

  it("pins the connection to the validated address and blocks DNS rebinding", async () => {
    let reachedLoopback = false
    const server = createServer((_request, response) => {
      reachedLoopback = true
      response.end("internal-only")
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("fixture did not bind")

    const result = await safeFetch(`http://rebind.test:${address.port}/admin`, {
      resolver: async () => ["93.184.216.34"],
      timeoutMs: 250,
    })

    expect(result).toBeNull()
    expect(reachedLoopback).toBe(false)
  })
})
