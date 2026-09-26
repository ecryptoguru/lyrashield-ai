import { describe, it, expect, vi, beforeEach } from "vitest"
import { LyraShieldClient } from "../client"
import { getScanEligibility, ScanEligibilitySchema } from "../resources/scan-eligibility"

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response
}

const ELIGIBILITY_RESPONSE = {
  allowed: true,
  code: null,
  message: null,
  plan: "PRO",
  isTrial: false,
  remainingMinutes: 120,
}

describe("getScanEligibility", () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let client: LyraShieldClient

  beforeEach(() => {
    mockFetch = vi.fn()
    client = new LyraShieldClient({
      apiKey: "test-key",
      apiUrl: "http://localhost:3000",
      workspaceId: "ws-1",
      fetchFn: mockFetch as unknown as typeof fetch,
    })
  })

  it("issues GET /api/v1/scans/eligibility with the normalized query", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ success: true, data: ELIGIBILITY_RESPONSE }))

    const res = await getScanEligibility(client, {
      targetId: "t-1",
      goal: "TEST_APP",
      mode: "STANDARD",
    })

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe("GET")
    expect(init.body).toBeUndefined()
    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/api/v1/scans/eligibility")
    expect(parsed.searchParams.get("workspaceId")).toBe("ws-1")
    expect(parsed.searchParams.get("targetId")).toBe("t-1")
    expect(parsed.searchParams.get("goal")).toBe("TEST_APP")
    expect(parsed.searchParams.get("mode")).toBe("STANDARD")
    expect(res.allowed).toBe(true)
    expect(res.plan).toBe("PRO")
    expect(res.remainingMinutes).toBe(120)
  })

  it("forwards workflow inputs and repeats attachmentIds", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ success: true, data: ELIGIBILITY_RESPONSE }))

    await getScanEligibility(client, {
      targetId: "t-1",
      goal: "CHECK_PR",
      mode: "QUICK",
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
      headRef: "feature/42",
      attachmentIds: ["att_1", "att_2"],
    })

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.searchParams.get("workflow")).toBe("REVIEW_CHANGES")
    expect(parsed.searchParams.get("baseRef")).toBe("main")
    expect(parsed.searchParams.get("headRef")).toBe("feature/42")
    expect(parsed.searchParams.getAll("attachmentIds")).toEqual(["att_1", "att_2"])
  })

  it("prefers an explicit workspaceId over the client default", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ success: true, data: ELIGIBILITY_RESPONSE }))

    await getScanEligibility(client, {
      workspaceId: "ws-other",
      targetId: "t-1",
      goal: "TEST_APP",
      mode: "STANDARD",
    })

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).searchParams.get("workspaceId")).toBe("ws-other")
  })

  it("returns allowed:false denials as a successful parsed read", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        success: true,
        data: {
          allowed: false,
          code: "NO_MINUTES_REMAINING",
          message: "Your agent-minute balance is exhausted.",
          plan: "FREE",
          isTrial: false,
          remainingMinutes: 0,
          blockers: [
            { code: "NO_MINUTES_REMAINING", message: "Your agent-minute balance is exhausted." },
          ],
        },
      })
    )

    const res = await getScanEligibility(client, {
      targetId: "t-1",
      goal: "TEST_APP",
      mode: "STANDARD",
    })

    expect(res.allowed).toBe(false)
    expect(res.code).toBe("NO_MINUTES_REMAINING")
    expect(res.blockers?.[0]?.code).toBe("NO_MINUTES_REMAINING")
  })

  it("parses server-derived advisory fields and tolerates extra keys", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        success: true,
        data: {
          ...ELIGIBILITY_RESPONSE,
          canonicalMode: "STANDARD",
          canonicalProfileId: "REPO_STANDARD",
          supportedModes: [
            {
              id: "CODE_REVIEW",
              label: "Code scan",
              goal: "TEST_APP",
              mode: "STANDARD",
              workflow: "REVIEW_TARGET",
              available: true,
              futureField: { nested: true },
            },
          ],
          expectedScannerFamilies: ["Engine code scan", "Secrets"],
          blockers: [],
          limitations: ["Comparison refs resolve to immutable revisions at submission."],
          unexpectedServerField: "ignored",
        },
      })
    )

    const res = await getScanEligibility(client, {
      targetId: "t-1",
      goal: "TEST_APP",
      mode: "STANDARD",
    })

    expect(res.canonicalMode).toBe("STANDARD")
    expect(res.canonicalProfileId).toBe("REPO_STANDARD")
    expect(res.supportedModes?.[0]?.id).toBe("CODE_REVIEW")
    expect(res.expectedScannerFamilies).toContain("Secrets")
    expect(res.limitations).toHaveLength(1)
  })

  it("throws a typed error when the response envelope fails", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(
        { success: false, error: { code: "TARGET_NOT_FOUND", message: "Target not found" } },
        404
      )
    )

    await expect(
      getScanEligibility(client, { targetId: "missing", goal: "TEST_APP", mode: "SAFE" })
    ).rejects.toMatchObject({ status: 404, code: "TARGET_NOT_FOUND" })
  })

  it("forwards a caller abort signal as REQUEST_ABORTED before any fetch", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      getScanEligibility(
        client,
        { targetId: "t-1", goal: "TEST_APP", mode: "STANDARD" },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: "REQUEST_ABORTED" })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe("ScanEligibilitySchema", () => {
  it("requires the core verdict fields and leaves advisory fields optional", () => {
    const parsed = ScanEligibilitySchema.parse(ELIGIBILITY_RESPONSE)
    expect(parsed.allowed).toBe(true)
    expect(parsed.canonicalMode).toBeUndefined()
    expect(parsed.supportedModes).toBeUndefined()
  })

  it("rejects a payload missing the verdict fields", () => {
    expect(() => ScanEligibilitySchema.parse({ allowed: true })).toThrow()
    expect(() =>
      ScanEligibilitySchema.parse({ allowed: "yes", code: null, message: null, plan: "PRO" })
    ).toThrow()
  })
})
