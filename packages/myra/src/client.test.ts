import { describe, expect, it, vi } from "vitest"
import { createMyraClient, MyraClientError } from "./client"

describe("createMyraClient clearMemory", () => {
  it("clears dashboard memory with an authenticated DELETE request and returns parsed JSON", async () => {
    const payload = { data: { cleared: true } }
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as typeof fetch
    const client = createMyraClient({ apiBase: "", surface: "DASHBOARD", fetchImpl })

    await expect(client.clearMemory()).resolves.toEqual(payload)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith("/api/myra/memory", {
      method: "DELETE",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
    })
  })

  it("throws the structured server error for a non-OK response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "MEMORY_CLEAR_DENIED", message: "Saved preferences cannot be cleared." },
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          }
        )
    ) as typeof fetch
    const client = createMyraClient({ apiBase: "", surface: "DASHBOARD", fetchImpl })

    const error = await client.clearMemory().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MyraClientError)
    expect(error).toMatchObject({
      code: "MEMORY_CLEAR_DENIED",
      message: "Saved preferences cannot be cleared.",
    })
  })
})
