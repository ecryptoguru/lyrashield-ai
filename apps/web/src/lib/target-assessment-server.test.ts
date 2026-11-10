import { describe, expect, it, vi } from "vitest"
import { countTargetRemediation, loadTargetAssessmentPanels } from "./target-assessment-server"

describe("target assessment panel loading", () => {
  it("isolates a failed remediation panel without discarding gate or spend", async () => {
    const result = await loadTargetAssessmentPanels(
      {
        workspaceId: "ws-1",
        targetId: "target-1",
        actorUserId: "user-1",
        latestScanId: "scan-1",
        latestScanStartedAt: new Date("2026-11-05T00:00:00.000Z"),
      },
      {
        loadGate: vi.fn().mockResolvedValue(null),
        loadRemediation: vi.fn().mockRejectedValue(new Error("database detail must not leak")),
        loadSpend: vi.fn().mockResolvedValue(null),
      }
    )

    expect(result.gate).toEqual({ status: "available", value: null })
    expect(result.remediation).toEqual({ status: "unavailable", code: "REMEDIATION_UNAVAILABLE" })
    expect(result.spend).toEqual({ status: "available", value: null })
  })
})

describe("countTargetRemediation", () => {
  it("separates new, recurring, resolved and uncertain current identities", () => {
    const scanStartedAt = new Date("2026-11-05T00:00:00.000Z")
    const counts = countTargetRemediation(
      [
        {
          severity: "HIGH",
          status: "OPEN",
          firstSeenAt: new Date("2026-11-05T00:01:00.000Z"),
          lastSeenAt: new Date("2026-11-05T00:01:00.000Z"),
          observedInCurrentScan: true,
        },
        {
          severity: "MEDIUM",
          status: "OPEN",
          firstSeenAt: new Date("2026-11-01T00:00:00.000Z"),
          lastSeenAt: new Date("2026-11-05T00:02:00.000Z"),
          observedInCurrentScan: true,
        },
        {
          severity: "LOW",
          status: "FIXED",
          trustedRetest: true,
          firstSeenAt: new Date("2026-11-01T00:00:00.000Z"),
          lastSeenAt: new Date("2026-11-05T00:03:00.000Z"),
          observedInCurrentScan: false,
        },
        {
          severity: "LOW",
          status: "FIXED",
          firstSeenAt: new Date("2026-11-01T00:00:00.000Z"),
          lastSeenAt: new Date("2026-11-05T00:03:00.000Z"),
          observedInCurrentScan: false,
        },
        {
          severity: "HIGH",
          status: "DUPLICATE",
          firstSeenAt: new Date("2026-11-01T00:00:00.000Z"),
          lastSeenAt: new Date("2026-11-05T00:04:00.000Z"),
          observedInCurrentScan: false,
        },
      ],
      scanStartedAt
    )

    expect(counts).toEqual({
      newFindings: 1,
      recurringFindings: 1,
      resolvedFindings: 1,
      uncertainMatches: 2,
      blockingFindings: 1,
    })
  })
})
