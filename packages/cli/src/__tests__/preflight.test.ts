import { beforeEach, describe, expect, it, vi } from "vitest"
import { getScanEligibility } from "@lyrashield/sdk"
import { handlePreflight } from "../commands/preflight.js"
import type { Output } from "../output.js"

vi.mock("@lyrashield/sdk", () => ({ getScanEligibility: vi.fn() }))
vi.mock("../client.js", () => ({ createClient: vi.fn(async () => ({ request: vi.fn() })) }))
vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(async () => ({ workspaceId: "ws-1" })),
  requireWorkspace: vi.fn((creds: { workspaceId: string }) => creds.workspaceId),
}))

function output(): Output {
  return {
    json: true,
    quiet: false,
    log: vi.fn(),
    notice: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    result: vi.fn(),
    fail: vi.fn() as never,
  }
}

describe("preflight command", () => {
  beforeEach(() => vi.clearAllMocks())

  it("sends normalized advisory input without submitting a scan", async () => {
    vi.mocked(getScanEligibility).mockResolvedValue({ allowed: true, code: null } as never)
    const out = output()
    const code = await handlePreflight(
      [
        "--target",
        "target-1",
        "--goal",
        "check_pr",
        "--mode",
        "quick",
        "--workflow",
        "review_changes",
        "--base",
        "main",
        "--head",
        "feature",
        "--attachment",
        "attachment-1",
      ],
      out
    )
    expect(code).toBe(0)
    expect(getScanEligibility).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws-1",
      targetId: "target-1",
      goal: "CHECK_PR",
      mode: "QUICK",
      workflow: "REVIEW_CHANGES",
      baseRef: "main",
      headRef: "feature",
      attachmentIds: ["attachment-1"],
    })
    expect(out.result).toHaveBeenCalledWith({ allowed: true, code: null })
  })

  it("returns 1 with the denial payload", async () => {
    const denial = { allowed: false, code: "TRIAL_AVAILABLE", message: "Start trial" }
    vi.mocked(getScanEligibility).mockResolvedValue(denial as never)
    const out = output()
    expect(await handlePreflight(["--target", "target-1"], out)).toBe(1)
    expect(out.result).toHaveBeenCalledWith(denial)
  })

  it("rejects invalid workflow flags before any network request", async () => {
    const out = output()
    expect(await handlePreflight(["--target", "target-1", "--base", "main"], out)).toBe(2)
    expect(getScanEligibility).not.toHaveBeenCalled()
  })
})
