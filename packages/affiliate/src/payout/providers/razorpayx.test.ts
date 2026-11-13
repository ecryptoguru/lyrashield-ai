import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: {
    RAZORPAYX_API_KEY: "key_test",
    RAZORPAYX_API_SECRET: "secret_test",
    RAZORPAYX_ACCOUNT_NUMBER: "2323230000000000",
  },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { createRazorpayXProvider } from "./razorpayx"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("RazorpayX payout provider", () => {
  it("sends paise, fund account, source account, and payout idempotency", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ id: "pout_1", status: "processing" }, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await createRazorpayXProvider().send(
      "payout_1",
      "idempotency_1",
      "125.4500",
      "INR",
      {
        type: "razorpayx",
        fundAccountId: "fa_1",
        maskedDisplay: "•••• 4242",
      }
    )

    expect(result).toEqual({ success: false, pending: true, providerPayoutId: "pout_1" })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.razorpay.com/v1/payouts")
    expect(new Headers(init.headers).get("X-Payout-Idempotency")).toBe("idempotency_1")
    expect(JSON.parse(String(init.body))).toEqual(
      expect.objectContaining({
        account_number: "2323230000000000",
        fund_account_id: "fa_1",
        amount: 12545,
        currency: "INR",
        reference_id: "payout_1",
      })
    )
  })

  it("treats only provider processed state as confirmed paid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ id: "pout_2", status: "processed" }))
    )
    await expect(
      createRazorpayXProvider().send("payout_2", "idempotency_2", "1.0000", "INR", {
        type: "razorpayx",
        fundAccountId: "fa_2",
      })
    ).resolves.toEqual({ success: true, providerPayoutId: "pout_2" })
  })

  it.each([
    [503, { id: "pout_3", status: "processing" }],
    [500, { id: "pout_error", status: "rejected" }],
    [200, { id: "pout_4", status: "mystery" }],
  ])("keeps ambiguous HTTP/status outcomes unconfirmed", async (status, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })))
    const result = await createRazorpayXProvider().send(
      "payout_3",
      "idempotency_3",
      "1.0000",
      "INR",
      {
        type: "razorpayx",
        fundAccountId: "fa_3",
      }
    )
    expect(result.success).toBe(false)
    expect(result).not.toHaveProperty("rejected")
  })

  it("marks only an explicit provider rejection as rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ id: "pout_5", status: "rejected" }))
    )
    await expect(
      createRazorpayXProvider().send("payout_5", "idempotency_5", "1.0000", "INR", {
        type: "razorpayx",
        fundAccountId: "fa_5",
      })
    ).resolves.toEqual({
      success: false,
      rejected: true,
      providerPayoutId: "pout_5",
      error: "RazorpayX rejected the payout",
    })
  })

  it("bounds provider calls with a 30-second timeout and keeps timeouts ambiguous", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort())
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError")
      return Promise.resolve(Response.json({ id: "unused", status: "processed" }))
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await createRazorpayXProvider().send(
      "payout_timeout",
      "idempotency_timeout",
      "1.0000",
      "INR",
      {
        type: "razorpayx",
        fundAccountId: "fa_timeout",
      }
    )

    expect(timeout).toHaveBeenCalledWith(30_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.success).toBe(false)
    expect(result).not.toHaveProperty("rejected")
  })

  it("does not trust oversized provider responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "pout_large", status: "processing" }), {
          status: 200,
          headers: { "content-length": String(64 * 1024 + 1) },
        })
      )
    )

    const result = await createRazorpayXProvider().send(
      "payout_large",
      "idempotency_large",
      "1.0000",
      "INR",
      {
        type: "razorpayx",
        fundAccountId: "fa_large",
      }
    )

    expect(result.success).toBe(false)
    expect(result).not.toHaveProperty("pending")
    expect(result).not.toHaveProperty("rejected")
  })

  it("bounds streamed provider responses when Content-Length is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024 + 1))
            controller.close()
          },
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await createRazorpayXProvider().send(
      "payout_stream",
      "idempotency_stream",
      "1.0000",
      "INR",
      {
        type: "razorpayx",
        fundAccountId: "fa_stream",
      }
    )

    expect(result).toMatchObject({ success: false, error: "RazorpayX outcome unconfirmed" })
    expect(result).not.toHaveProperty("pending")
    expect(result).not.toHaveProperty("rejected")
  })
})
