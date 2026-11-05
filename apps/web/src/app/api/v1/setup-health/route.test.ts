import { beforeEach, describe, expect, it, vi } from "vitest"

const legacyGet = vi.hoisted(() => vi.fn())

vi.mock("../../scans/eligibility/route", () => ({ GET: legacyGet }))

import { GET } from "./route"

function request(values: Record<string, string | string[]>) {
  const url = new URL("http://localhost/api/v1/setup-health")
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item)
  }
  return new Request(url)
}

const query = {
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "STANDARD",
  workflow: "REVIEW_TARGET",
}

describe("GET /api/v1/setup-health", () => {
  beforeEach(() => legacyGet.mockReset())

  it("projects a legacy denial into the shared reason/recovery contract", async () => {
    legacyGet.mockResolvedValueOnce(
      Response.json({
        success: true,
        data: {
          allowed: false,
          code: "DOMAIN_VERIFICATION_REQUIRED",
          message: "Verify control of this domain once.",
          limitations: [],
        },
      })
    )

    const response = await GET(request(query))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(legacyGet).toHaveBeenCalledWith(expect.objectContaining({ url: expect.any(String) }))
    expect(body.data).toMatchObject({
      version: "lyrashield-setup-health/1.0.0",
      status: "blocked",
      allowed: false,
      primaryCheck: "DOMAIN_VERIFICATION_REQUIRED",
      checks: [
        {
          code: "DOMAIN_VERIFICATION_REQUIRED",
          status: "blocked",
          recoveryAction: "VERIFY_DOMAIN",
        },
      ],
    })
    expect(body.data.scopeFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it("keeps a valid review ready while retaining submission-time limitations", async () => {
    legacyGet.mockResolvedValueOnce(
      Response.json({
        success: true,
        data: {
          allowed: true,
          code: null,
          message: null,
          limitations: ["Comparison refs resolve only when the scan is submitted."],
        },
      })
    )

    const body = await (await GET(request(query))).json()

    expect(body.data.status).toBe("ready")
    expect(body.data.allowed).toBe(true)
    expect(body.data.limitations).toEqual([
      "Comparison refs resolve only when the scan is submitted.",
    ])
  })

  it("passes authentication errors through without a health snapshot", async () => {
    legacyGet.mockResolvedValueOnce(
      Response.json(
        { success: false, error: { code: "FORBIDDEN", message: "Forbidden" } },
        { status: 403 }
      )
    )

    const response = await GET(request(query))

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("FORBIDDEN")
  })
})
