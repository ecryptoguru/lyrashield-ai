import { describe, expect, it, vi } from "vitest"
import { apiGet } from "@/lib/api-client"
import { checkVisibleScanEligibility, prepareVisibleScan } from "./scans-webmcp"
import type { TargetItem } from "./scan-types"

vi.mock("@/lib/api-client", () => ({ apiGet: vi.fn() }))

const target: TargetItem = {
  id: "target1",
  name: "Example",
  type: "REPO",
  url: null,
  apiSpecUrl: null,
  repoFullName: "owner/repo",
}

describe("dashboard WebMCP scan preflight", () => {
  it("derives workspace and target from the page and labels the result advisory", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({
      allowed: true,
      code: null,
      message: null,
      plan: "STARTER",
      isTrial: false,
      remainingMinutes: 25,
    })
    const result = await checkVisibleScanEligibility(
      { targetName: "Example", reviewType: "CODE_REVIEW" },
      "ws1",
      [target],
      "CODE_REVIEW",
      new AbortController().signal
    )
    expect(result).toMatchObject({ allowed: true, advisory: true, remainingMinutes: 25 })
    const url = new URL(vi.mocked(apiGet).mock.calls[0]![0], "https://app.test")
    expect(url.pathname).toBe("/api/scans/eligibility")
    expect(url.searchParams.get("workspaceId")).toBe("ws1")
    expect(url.searchParams.get("targetId")).toBe("target1")
  })

  it("rejects ambiguous targets and unavailable profiles before calling the API", async () => {
    vi.mocked(apiGet).mockClear()
    const signal = new AbortController().signal
    await expect(
      checkVisibleScanEligibility(
        { targetName: "Example" },
        "ws1",
        [target, target],
        "CODE_REVIEW",
        signal
      )
    ).rejects.toThrow("uniquely")
    await expect(
      checkVisibleScanEligibility(
        { targetName: "Example", reviewType: "BAD" },
        "ws1",
        [target],
        "CODE_REVIEW",
        signal
      )
    ).rejects.toThrow("unavailable")
    expect(apiGet).not.toHaveBeenCalled()
  })
})

describe("prepare scan WebMCP", () => {
  function setters() {
    return {
      setSelectedTarget: vi.fn(),
      setSelectedPreset: vi.fn(),
      setShowCreate: vi.fn(),
      setModeResetNotice: vi.fn(),
    }
  }

  it("shows advisory blockers and prepares only the page-owned target, without submitting", async () => {
    vi.mocked(apiGet).mockClear()
    vi.mocked(apiGet).mockResolvedValueOnce({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
      message: "No minutes remain",
      plan: "STARTER",
      isTrial: false,
      remainingMinutes: 0,
    })
    const ui = setters()
    const result = await prepareVisibleScan(
      {
        targetName: "Example",
        reviewType: "CODE_REVIEW",
        workspaceId: "foreign",
        targetId: "foreign",
      } as { targetName: string; reviewType: string },
      "ws1",
      [target],
      "CODE_REVIEW",
      ui,
      new AbortController().signal
    )
    expect(result).toMatchObject({
      prepared: true,
      eligibility: { allowed: false, code: "NO_MINUTES_REMAINING", advisory: true },
    })
    expect(ui.setSelectedTarget).toHaveBeenCalledWith("target1")
    const url = new URL(vi.mocked(apiGet).mock.calls[0]![0], "https://app.test")
    expect(url.searchParams.get("workspaceId")).toBe("ws1")
    expect(url.searchParams.get("targetId")).toBe("target1")
    expect(url.search).not.toContain("foreign")
  })

  it("does not open the form or disclose allowance after session revocation", async () => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiGet).mockRejectedValueOnce(new Error("Unauthorized"))
    const ui = setters()
    await expect(
      prepareVisibleScan(
        { targetName: "Example" },
        "ws1",
        [target],
        "CODE_REVIEW",
        ui,
        new AbortController().signal
      )
    ).rejects.toThrow("Unauthorized")
    expect(ui.setSelectedTarget).not.toHaveBeenCalled()
    expect(ui.setShowCreate).not.toHaveBeenCalled()
  })
})
