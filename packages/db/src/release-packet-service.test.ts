import { describe, expect, it } from "vitest"
import { classifyReleaseFindings } from "./release-packet-service"

const scanStartedAt = new Date("2026-11-05T00:00:00.000Z")

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "finding-1",
    dedupeKey: "dedupe-1",
    title: "Tenant scope missing",
    severity: "HIGH",
    status: "OPEN",
    verificationStatus: "DETECTED",
    sourceRevision: "a".repeat(40),
    baseCommit: "a".repeat(40),
    firstSeenAt: new Date("2026-11-04T00:00:00.000Z"),
    lastSeenAt: new Date("2026-11-05T00:01:00.000Z"),
    trustedRetest: false,
    retestState: "none" as const,
    fixProposal: null as null | { status: string; baseCommit: string | null },
    ...overrides,
  }
}

describe("classifyReleaseFindings", () => {
  it("uses dedupe identity to separate new and recurring findings", () => {
    const result = classifyReleaseFindings({
      findings: [finding(), finding({ id: "finding-2", dedupeKey: "dedupe-2" })],
      currentObservedKeys: new Set(["dedupe-1", "dedupe-2"]),
      baselineObservedKeys: new Set(["dedupe-1"]),
      currentScanStartedAt: scanStartedAt,
      assessedIdentity: { kind: "COMMIT", value: "a".repeat(40) },
      uncertainCandidateCount: 0,
    })

    expect(result.counts).toMatchObject({ newFindings: 1, recurringFindings: 1 })
    expect(result.findings.map((item) => item.category).sort()).toEqual(["new", "recurring"])
  })

  it("marks base-revision drift as a stale proposal", () => {
    const result = classifyReleaseFindings({
      findings: [
        finding({
          fixProposal: { status: "ready", baseCommit: "b".repeat(40) },
        }),
      ],
      currentObservedKeys: new Set(["dedupe-1"]),
      baselineObservedKeys: new Set(),
      currentScanStartedAt: scanStartedAt,
      assessedIdentity: { kind: "COMMIT", value: "a".repeat(40) },
      uncertainCandidateCount: 0,
    })
    expect(result.findings[0]?.proposalState).toBe("stale")
  })

  it("counts resolution only with a trusted retest and preserves unsupported fixes as uncertain", () => {
    const result = classifyReleaseFindings({
      findings: [
        finding({
          id: "resolved",
          status: "FIXED",
          trustedRetest: true,
          retestState: "trusted",
        }),
        finding({ id: "unsupported", status: "FIXED", trustedRetest: false }),
      ],
      currentObservedKeys: new Set(),
      baselineObservedKeys: new Set(["dedupe-1"]),
      currentScanStartedAt: scanStartedAt,
      assessedIdentity: { kind: "COMMIT", value: "a".repeat(40) },
      uncertainCandidateCount: 0,
    })
    expect(result.counts.resolvedFindings).toBe(1)
    expect(result.counts.uncertainMatches).toBe(1)
    expect(result.findings.find((item) => item.findingId === "unsupported")?.category).toBe(
      "uncertain"
    )
  })

  it("bounds detail rows while retaining exact counts", () => {
    const findings = Array.from({ length: 105 }, (_, index) =>
      finding({ id: `finding-${index}`, dedupeKey: `dedupe-${index}` })
    )
    const result = classifyReleaseFindings({
      findings,
      currentObservedKeys: new Set(findings.map((item) => item.dedupeKey)),
      baselineObservedKeys: new Set(),
      currentScanStartedAt: scanStartedAt,
      assessedIdentity: { kind: "COMMIT", value: "a".repeat(40) },
      uncertainCandidateCount: 2,
      detailLimit: 100,
    })
    expect(result.counts.newFindings).toBe(105)
    expect(result.counts.uncertainMatches).toBe(2)
    expect(result.findings).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })
})
