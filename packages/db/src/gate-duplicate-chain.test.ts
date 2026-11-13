import { expect, it } from "vitest"
import { prepareGateFindingInputs, type loadGateFindings } from "./gate-retest-input"

type GateFinding = Awaited<ReturnType<typeof loadGateFindings>>["findings"][number]
it("resolves long duplicate chains and cycles without recursion", () => {
  const base = {
    severity: "HIGH",
    verificationStatus: "DETECTED",
    scanId: "scan",
    dedupeKey: "key",
    lastSeenAt: new Date(0),
    disposition: null,
    dispositionActorUserId: null,
    dispositionReason: null,
    dispositionAssessmentId: null,
    dispositionAt: null,
    verificationReceipts: [],
  }
  const findings = Array.from({ length: 9000 }, (_, i) => ({
    ...base,
    id: `f-${i}`,
    status: "DUPLICATE",
    canonicalFindingId: `f-${i + 1}`,
  }))
  findings.push({ ...base, id: "f-9000", status: "FIXED", canonicalFindingId: null as never })
  const result = prepareGateFindingInputs(findings as GateFinding[], new Set(["f-9000"]), "scan")
  expect(result[0]?.duplicateCanonicalResolved).toBe(true)
  expect(result[8999]?.duplicateCanonicalResolved).toBe(true)
  findings[9000]!.status = "DUPLICATE"
  findings[9000]!.canonicalFindingId = "f-0"
  expect(
    prepareGateFindingInputs(findings as GateFinding[], new Set(), "scan")[0]
      ?.duplicateCanonicalResolved
  ).toBe(false)
})
