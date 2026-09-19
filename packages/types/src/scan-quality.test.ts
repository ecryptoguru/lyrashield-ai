import { describe, expect, it } from "vitest"
import {
  buildScanQualitySurface,
  SCAN_QUALITY_METRICS,
  SCAN_QUALITY_SURFACE_VERSION,
  SCAN_RESULT_SURFACES,
  SCAN_SURFACE_PARITY,
  type ScanQualityInput,
} from "./scan-quality"

const baseInput: ScanQualityInput = {
  scan: {
    status: "COMPLETED",
    mode: "STANDARD",
    determinismMode: "default",
    durationMs: 1000,
    llmRequestCount: 5,
  },
  receipts: [
    { scanner: "sast", controlId: "vibe-01", status: "COMPLETED" },
    { scanner: "sast", controlId: "vibe-02", status: "FAILED", reason: "crash" },
    { scanner: "engine", controlId: "engine-scope:auth", status: "COMPLETED" },
    { scanner: "engine", controlId: "engine-gap:0", status: "PARTIAL" },
  ],
  findings: [
    { verificationStatus: "DETECTED", severity: "HIGH" },
    { verificationStatus: "VERIFIED", severity: "CRITICAL" },
  ],
  manifestChecksum: "abc123",
  ingestionWarnings: ["w1"],
  attachments: { count: 2, totalBytes: 100 },
}

describe("buildScanQualitySurface", () => {
  it("is deterministic — same evidence builds an identical surface", async () => {
    const a = await buildScanQualitySurface(baseInput)
    const b = await buildScanQualitySurface(baseInput)
    expect(a.surfaceChecksum).toBe(b.surfaceChecksum)
    expect(a).toEqual(b)
    expect(a.version).toBe(SCAN_QUALITY_SURFACE_VERSION)
  })

  it("counts engine-declared receipts separately from measured outcomes", async () => {
    const surface = await buildScanQualitySurface(baseInput)
    expect(surface.facts.coverage.engineDeclaredReceipts).toBe(2)
    expect(surface.facts.coverage.receiptsTotal).toBe(4)
    // The heuristic is computed over all applicable receipts including the
    // engine-declared ones — the basis string says so.
    expect(surface.estimates.assessedReceiptRatio.value).toBeCloseTo(0.5)
    expect(surface.estimates.assessedReceiptRatio.kind).toBe("heuristic")
    expect(surface.estimates.assessedReceiptRatio.basis).toContain("engine-declared")
  })

  it("keeps DETECTED, VALIDATED and VERIFIED distinct — never promoted", async () => {
    const surface = await buildScanQualitySurface(baseInput)
    expect(surface.facts.findings.byVerificationStatus.DETECTED).toBe(1)
    expect(surface.facts.findings.byVerificationStatus.VERIFIED).toBe(1)
    expect(surface.facts.findings.validatedCount).toBe(0)
    expect(surface.facts.findings.verifiedCount).toBe(1)
    // VALIDATED is deterministic checking, not independent verification —
    // the ratio only counts VERIFIED.
    expect(surface.estimates.verifiedFindingRatio.value).toBe(0.5)
  })

  it("reports nulls instead of fabricated ratios when evidence is absent", async () => {
    const surface = await buildScanQualitySurface({
      scan: { status: "FAILED", mode: "QUICK" },
      receipts: [],
      findings: [],
      manifestChecksum: null,
      ingestionWarnings: [],
    })
    expect(surface.facts.evidence.manifestPresent).toBe(false)
    expect(surface.facts.evidence.manifestChecksum).toBeNull()
    expect(surface.estimates.assessedReceiptRatio.value).toBeNull()
    expect(surface.estimates.verifiedFindingRatio.value).toBeNull()
    expect(surface.facts.findings.total).toBe(0)
  })

  it("unlabeled/legacy verification states count as UNLABELED, not implied", async () => {
    const surface = await buildScanQualitySurface({
      ...baseInput,
      findings: [{ verificationStatus: null, severity: "LOW" }, { severity: "LOW" }],
    })
    expect(surface.facts.findings.byVerificationStatus.UNLABELED).toBe(2)
    expect(surface.facts.findings.nonConclusiveCount).toBe(2)
  })

  it("labels deterministic runs truthfully", async () => {
    const surface = await buildScanQualitySurface({
      ...baseInput,
      scan: { ...baseInput.scan, determinismMode: "targeted_scanner" },
    })
    expect(surface.facts.deterministicRun).toBe(true)
    const nondeterministic = await buildScanQualitySurface({
      ...baseInput,
      scan: { ...baseInput.scan, determinismMode: null },
    })
    expect(nondeterministic.facts.deterministicRun).toBe(false)
  })
})

describe("SCAN_SURFACE_PARITY", () => {
  it("is complete: every metric × every surface has a valid cell", () => {
    for (const metric of SCAN_QUALITY_METRICS) {
      const row = SCAN_SURFACE_PARITY[metric]
      expect(row).toBeDefined()
      for (const surface of SCAN_RESULT_SURFACES) {
        expect(["measured", "derived", "not_reported"]).toContain(row[surface])
      }
    }
    expect(Object.keys(SCAN_SURFACE_PARITY).sort()).toEqual([...SCAN_QUALITY_METRICS].sort())
  })

  it("surfaces sharing the API payload agree on API-carried fields", () => {
    // rest_api_v1, sdk, cli and mcp all consume the same GET /scans/[id]
    // projection — their cells must agree for fields that payload carries.
    for (const metric of ["scan_status", "coverage_receipts", "manifest_checksum"] as const) {
      const row = SCAN_SURFACE_PARITY[metric]
      expect(row.rest_api_v1).toBe(row.sdk)
      expect(row.sdk).toBe(row.cli)
      expect(row.cli).toBe(row.mcp)
    }
  })

  it("is embedded identically in every computed surface", async () => {
    const surface = await buildScanQualitySurface(baseInput)
    expect(surface.parity).toEqual(SCAN_SURFACE_PARITY)
  })
})
