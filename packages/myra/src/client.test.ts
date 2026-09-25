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

describe("marketing public-token requests", () => {
  it("omits browser cookies from every shared client operation", async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith("/message")) {
        return new Response(
          'data: {"type":"error","error":{"code":"INTERNAL_ERROR","message":"Failed"}}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          }
        )
      }
      return Response.json({ suggestions: [], data: {} })
    }) as typeof fetch
    const client = createMyraClient({
      apiBase: "https://app.example.com",
      surface: "MARKETING",
      getPublicToken: () => "public-token",
      fetchImpl,
    })

    for await (const event of client.sendMessage({ text: "Hi" })) {
      expect(event).toBeDefined()
    }
    await client.suggest("plan")
    await client.confirmProposal("proposal")
    await client.cancelProposal("proposal")
    await client.clearMemory()
    await client.listCases()
    await client.getCase("case")
    await client.replyToCase("case", "Reply")

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/myra/message",
      "/api/myra/suggest",
      "/api/myra/proposals/confirm",
      "/api/myra/proposals/cancel",
      "/api/myra/memory",
      "/api/myra/cases",
      "/api/myra/cases/case",
      "/api/myra/cases/case/replies",
    ])
    for (const { init } of requests) {
      expect(init?.credentials).toBe("omit")
      expect(new Headers(init?.headers).get("x-myra-session")).toBe("public-token")
    }
  })
})

describe("Myra stream completion", () => {
  function clientFor(chunks: string[]) {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return createMyraClient({
      apiBase: "",
      surface: "DASHBOARD",
      fetchImpl: vi.fn(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } })
      ) as typeof fetch,
    })
  }

  it("accepts a terminal frame split across chunks", async () => {
    const client = clientFor([
      'data: {"type":"do',
      'ne","messageId":"m","taskRecord":{"intent":"help","toolsUsed":[],"outcome":"answered","unresolved":false}}\n\n',
    ])
    const events = []
    for await (const event of client.sendMessage({ text: "hello" })) events.push(event)
    expect(events.map((event) => event.type)).toEqual(["done"])
  })

  it.each([
    ["empty", []],
    ["token-only", ['data: {"type":"token","text":"partial"}\n\n']],
    ["malformed", ["data: {bad}\n\n"]],
  ])("rejects %s EOF as interrupted", async (_label, chunks) => {
    const client = clientFor(chunks)
    const consume = async () => {
      for await (const event of client.sendMessage({ text: "hello" })) {
        expect(event.type).toBe("token")
      }
    }
    await expect(consume()).rejects.toMatchObject({ code: "STREAM_INTERRUPTED" })
  })

  it("accepts a terminal error event", async () => {
    const client = clientFor([
      'data: {"type":"error","error":{"code":"INTERNAL_ERROR","message":"Failed"}}\n\n',
    ])
    const events = []
    for await (const event of client.sendMessage({ text: "hello" })) events.push(event)
    expect(events.map((event) => event.type)).toEqual(["error"])
  })
})
