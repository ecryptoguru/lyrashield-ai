import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { verifyStoredManifestChecksum } from "./manifest-checksum"

const coverageSchema = z.array(
  z.object({
    scanner: z.string().min(1),
    controlId: z.string().min(1),
    status: z.string().min(1),
    reason: z.string().nullish(),
    subject: z.string().nullish(),
    metadata: z.unknown().optional(),
  })
)

type CoverageRow = z.infer<typeof coverageSchema>[number]

function normalizedCoverage(rows: CoverageRow[]) {
  return rows
    .map((row) => ({
      scanner: row.scanner,
      controlId: row.controlId,
      status: row.status,
      reason: row.reason ?? null,
      subject: row.subject ?? null,
      metadata: row.metadata ?? null,
    }))
    .sort((left, right) =>
      left.controlId < right.controlId ? -1 : left.controlId > right.controlId ? 1 : 0
    )
}

/** The evaluator's receipt rows must describe the checksum-bound manifest. */
export function isVerifiedPacketScan(
  scan: {
    id: string
    resultManifest: {
      checksum: string
      checksumInput: string | null
      manifest: unknown
    } | null
    coverageReceipts: CoverageRow[]
  },
  snapshot: { scanId: string; manifestChecksum: string },
  target: { id: string; type: string }
): boolean {
  const manifest = scan.resultManifest?.manifest as {
    target?: { id?: unknown; type?: unknown }
    terminalOutcome?: { status?: unknown }
    coverage?: unknown
  } | null
  if (
    scan.id !== snapshot.scanId ||
    verifyStoredManifestChecksum(scan.resultManifest) !== "MATCH" ||
    scan.resultManifest?.checksum !== snapshot.manifestChecksum ||
    manifest?.target?.id !== target.id ||
    manifest.target.type !== target.type ||
    manifest.terminalOutcome?.status !== "COMPLETED"
  )
    return false

  const coverage = coverageSchema.safeParse(manifest.coverage)
  if (!coverage.success) return false
  // ScanCoverageReceipt is unique by (scanId, controlId); duplicates in a
  // manifest cannot be represented by those rows and must fail closed.
  if (
    new Set(coverage.data.map((row) => row.controlId)).size !== coverage.data.length ||
    new Set(scan.coverageReceipts.map((row) => row.controlId)).size !== scan.coverageReceipts.length
  )
    return false
  return isDeepStrictEqual(
    normalizedCoverage(coverage.data),
    normalizedCoverage(scan.coverageReceipts)
  )
}
