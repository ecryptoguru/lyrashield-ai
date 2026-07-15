import { describe, expect, it } from "vitest"
import { MAX_WAITLIST_BODY_BYTES, RequestBodyError, parseBoundedBody } from "./request-body"

describe("parseBoundedBody", () => {
  it("parses JSON and URL-encoded waitlist submissions", async () => {
    const json = new Request("https://lyrashieldai.com/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email: "qa@example.com" }),
    })
    const form = new Request("https://lyrashieldai.com/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=qa%40example.com&source=landing",
    })

    await expect(parseBoundedBody(json)).resolves.toEqual({ email: "qa@example.com" })
    await expect(parseBoundedBody(form)).resolves.toEqual({
      email: "qa@example.com",
      source: "landing",
    })
  })

  it("rejects an oversized streamed body even without Content-Length", async () => {
    const request = new Request("https://lyrashieldai.com/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_WAITLIST_BODY_BYTES + 1))
          controller.close()
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" })

    await expect(parseBoundedBody(request)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    } satisfies Partial<RequestBodyError>)
  })

  it("rejects unsupported media types before reading the body", async () => {
    const request = new Request("https://lyrashieldai.com/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=test" },
      body: "--test--",
    })

    await expect(parseBoundedBody(request)).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    } satisfies Partial<RequestBodyError>)
  })
})
