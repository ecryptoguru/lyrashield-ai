import { beforeEach, describe, expect, it } from "vitest"
import { parseLiteScorecardToken } from "../../../lib/lite-scorecard"
import { POST } from "./route"

describe("POST /api/lite-scorecards", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long"
    process.env.NEXT_PUBLIC_MARKETING_URL = "http://localhost:4321"
  })

  it("creates a signed public card containing only aggregate counters", async () => {
    const response = await POST(
      new Request("http://localhost:3001/api/lite-scorecards", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:4321" },
        body: JSON.stringify({ needsAttention: 1, worthReviewing: 2, looksOk: 3 }),
      })
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as { url: string }
    const token = body.url.split("/").at(-1)!
    expect(parseLiteScorecardToken(token)).toMatchObject({
      needsAttention: 1,
      worthReviewing: 2,
      looksOk: 3,
    })
  })

  it("rejects target and finding detail fields", async () => {
    const response = await POST(
      new Request("http://localhost:3001/api/lite-scorecards", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:4321" },
        body: JSON.stringify({
          needsAttention: 1,
          worthReviewing: 2,
          looksOk: 3,
          target: "https://private.test",
        }),
      })
    )
    expect(response.status).toBe(400)
  })
})
