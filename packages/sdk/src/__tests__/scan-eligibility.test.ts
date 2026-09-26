import { describe, expect, it, vi } from "vitest"
import { LyraShieldClient } from "../client"
import { getScanEligibility } from "../resources/scan-eligibility"

const allowed = {
  version: "lyrashield-scan-eligibility/1.0.0",
  advisory: true,
  allowed: true,
  code: null,
  message: null,
  plan: "PRO",
  isTrial: false,
  remainingMinutes: 100,
  notEvaluated: ["futureCapacity"],
}

describe("getScanEligibility", () => {
  it("encodes bounded workflow and attachment inputs in one read-only GET", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: allowed }), {
          headers: { "Content-Type": "application/json" },
        })
    )
    const client = new LyraShieldClient({
      apiKey: "synthetic",
      apiUrl: "https://example.test",
      workspaceId: "ws-1",
      fetchFn,
    })
    const result = await getScanEligibility(client, {
      targetId: "target-1",
      goal: "CHECK_PR",
      mode: "QUICK",
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
      headRef: "feature/42",
      attachmentIds: ["attachment-1", "attachment-2"],
    })

    expect(result).toEqual(allowed)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    const requestUrl = new URL(url)
    expect(requestUrl.pathname).toBe("/api/v1/scans/eligibility")
    expect(requestUrl.searchParams.get("workspaceId")).toBe("ws-1")
    expect(requestUrl.searchParams.get("baseRef")).toBe("main")
    expect(requestUrl.searchParams.get("headRef")).toBe("feature/42")
    expect(requestUrl.searchParams.getAll("attachmentId")).toEqual(["attachment-1", "attachment-2"])
    expect(init.method).toBe("GET")
    expect(init.body).toBeUndefined()
  })

  it("retains a known denial as a successful read", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              ...allowed,
              allowed: false,
              code: "NO_MINUTES_REMAINING",
              message: "No minutes",
            },
          })
        )
    )
    const result = await getScanEligibility(
      new LyraShieldClient({ apiKey: "synthetic", fetchFn }),
      {
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "STANDARD",
      }
    )
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("NO_MINUTES_REMAINING")
  })

  it("rejects invalid workflow input before fetching", async () => {
    const fetchFn = vi.fn()
    expect(() =>
      getScanEligibility(new LyraShieldClient({ apiKey: "synthetic", fetchFn }), {
        targetId: "target-1",
        goal: "CHECK_PR",
        mode: "QUICK",
        workflow: "REVIEW_CHANGES",
      })
    ).toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
