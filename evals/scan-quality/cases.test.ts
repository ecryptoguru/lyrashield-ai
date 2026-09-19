import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CASE_DIR, runCase, validateCase, type QualityCase } from "./lib"
import {
  buildScanQualitySurface,
  SCAN_QUALITY_METRICS,
  SCAN_QUALITY_SURFACE_VERSION,
  SCAN_RESULT_SURFACES,
  SCAN_SURFACE_PARITY,
} from "../../packages/types/src/scan-quality"

function loadCases(): QualityCase[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CASE_DIR is the fixed corpus dir
  return readdirSync(CASE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      // Case filenames come from the on-disk corpus directory listing.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const raw: unknown = JSON.parse(readFileSync(join(CASE_DIR, file), "utf8"))
      const validated = validateCase(raw, file)
      if (!validated.ok) throw new Error(validated.problems.join("; "))
      return validated.value
    })
}

const cases = loadCases()

describe("scan-quality eval corpus", () => {
  it("has unique case ids and a minimum corpus size", () => {
    expect(cases.length).toBeGreaterThanOrEqual(3)
    const ids = cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const qualityCase of cases) {
      expect(qualityCase.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it("every case passes its stored-evidence assertions", async () => {
    for (const qualityCase of cases) {
      const result = await runCase(qualityCase)
      expect(result.status, `${qualityCase.id}: ${result.reasons.join("; ")}`).toBe("pass")
    }
  })

  it("the surface is deterministic — identical input builds identical output", async () => {
    for (const qualityCase of cases) {
      const a = await buildScanQualitySurface(qualityCase.evidence)
      const b = await buildScanQualitySurface(qualityCase.evidence)
      expect(a.surfaceChecksum).toBe(b.surfaceChecksum)
      expect(a).toEqual(b)
    }
  })
})

describe("surface parity table", () => {
  it("covers every metric × every surface with a valid cell", () => {
    for (const metric of SCAN_QUALITY_METRICS) {
      const row = SCAN_SURFACE_PARITY[metric]
      expect(row, `missing parity row for ${metric}`).toBeDefined()
      for (const surface of SCAN_RESULT_SURFACES) {
        expect(
          ["measured", "derived", "not_reported"].includes(row[surface]),
          `invalid parity cell ${metric}/${surface}`
        ).toBe(true)
      }
    }
  })

  it("publishes the same parity table inside every computed surface", async () => {
    for (const qualityCase of cases) {
      const surface = await buildScanQualitySurface(qualityCase.evidence)
      expect(surface.parity).toEqual(SCAN_SURFACE_PARITY)
    }
  })

  it("claims 'measured' only where the metric exists in the surface facts", async () => {
    // Every metric the parity table reports must correspond to a field the
    // computed surface actually publishes — the table can never claim a
    // report that the projection does not carry.
    const metricToFactPath: Record<string, string[]> = {
      scan_status: ["facts.scanStatus"],
      finding_count: ["facts.findings.total"],
      verification_mix: [
        "facts.findings.byVerificationStatus",
        "facts.findings.validatedCount",
        "facts.findings.verifiedCount",
      ],
      coverage_receipts: ["facts.coverage.receiptsTotal", "facts.coverage.byStatus"],
      manifest_checksum: ["facts.evidence.manifestChecksum"],
      ingestion_warnings: ["facts.evidence.ingestionWarningCount"],
      quality_surface: ["surfaceChecksum"],
    }
    for (const metric of SCAN_QUALITY_METRICS) {
      expect(metricToFactPath[metric], `metric ${metric} has no fact mapping`).toBeDefined()
    }
    for (const qualityCase of cases) {
      const surface = await buildScanQualitySurface(qualityCase.evidence)
      for (const [metric, paths] of Object.entries(metricToFactPath)) {
        for (const path of paths) {
          let current: unknown = surface
          for (const segment of path.split(".")) {
            current =
              current && typeof current === "object"
                ? (current as Record<string, unknown>)[segment]
                : undefined
          }
          expect(current, `${qualityCase.id}: ${metric} → ${path} missing`).not.toBeUndefined()
        }
      }
    }
    expect(SCAN_QUALITY_SURFACE_VERSION).toBe("lyrashield-scan-quality/1.0.0")
  })
})
