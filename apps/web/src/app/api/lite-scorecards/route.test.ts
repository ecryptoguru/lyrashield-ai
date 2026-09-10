import { beforeEach, describe, expect, it, vi } from "vitest"

// vi.mock factories are hoisted above every declaration, so the mock fn must
// come from vi.hoisted (the launch-readiness-server test pattern).
const mocks = vi.hoisted(() => ({ verifyTurnstile: vi.fn() }))
vi.mock("../../../lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))

import { parseLiteScorecardToken } from "../../../lib/lite-scorecard"
import { POST } from "./route"

function request(body: unknown) {
  return new Request("http://localhost:3001/api/lite-scorecards", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:4321" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/lite-scorecards", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long"
    process.env.NEXT_PUBLIC_MARKETING_URL = "http://localhost:4321"
    mocks.verifyTurnstile.mockResolvedValue(true)
  })

  it("creates a signed public card containing only aggregate counters", async () => {
    const response = await POST(
      request({
        needsAttention: 1,
        worthReviewing: 2,
        looksOk: 3,
        turnstileToken: "verified-token",
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

  it("rejects a mint without a valid Turnstile token (v16 2.3)", async () => {
    mocks.verifyTurnstile.mockResolvedValue(false)
    const response = await POST(
      request({
        needsAttention: 1,
        worthReviewing: 2,
        looksOk: 3,
        turnstileToken: "forged-or-expired",
      })
    )
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe("bot_check_failed")
  })

  it("rejects target and finding detail fields", async () => {
    const response = await POST(
      request({
        needsAttention: 1,
        worthReviewing: 2,
        looksOk: 3,
        turnstileToken: "verified-token",
        target: "https://private.test",
      })
    )
    expect(response.status).toBe(400)
  })
})
