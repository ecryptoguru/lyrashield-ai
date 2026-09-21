/**
 * Scan quality surface — the one-time, bounded projection of what a stored
 * scan's evidence actually shows. All numbers derive from persisted rows
 * (scan record, coverage receipts, finding verification tiers, result
 * manifest, ingestion warnings); nothing is model-claimed or recomputed from
 * live state. Heuristics are labeled in the surface itself.
 *
 * Deliberately separate from getScanWithEvents: this adds aggregate queries
 * (finding group-bys), so it belongs on the one-time detail/quality read, not
 * the poll path.
 */
import {
  buildScanQualitySurface,
  type ScanQualityInput,
  type ScanQualitySurface,
} from "@lyrashield/types"
import { withWorkspaceRLS } from "./rls"

export async function getScanQualitySurface(
  scanId: string,
  workspaceId: string
): Promise<ScanQualitySurface | null> {
  const loaded = await withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
      select: {
        id: true,
        status: true,
        mode: true,
        determinismMode: true,
        durationMs: true,
        llmRequestCount: true,
      },
    })
    if (!scan) return null

    const [receipts, findings, manifest] = await Promise.all([
      tx.scanCoverageReceipt.findMany({
        where: { scanId },
        select: {
          scanner: true,
          controlId: true,
          status: true,
          reason: true,
          metadata: true,
        },
        orderBy: { controlId: "asc" },
        // Same bound as the detail poll — 500 covers the full registry; a
        // larger tail is non-poll-critical and reported via receiptsTotal.
        take: 500,
      }),
      tx.finding.findMany({
        where: { workspaceId, deletedAt: null, candidates: { some: { scanId } } },
        select: { verificationStatus: true, severity: true },
        // Findings are small rows; the cap only bounds an extreme case, and
        // the surface reports exactly what was read — never an implied total.
        take: 1000,
      }),
      tx.scanResultManifest.findUnique({
        where: { scanId },
        select: { checksum: true, manifest: true },
      }),
    ])
    return { scan, receipts, findings, manifest }
  })

  if (!loaded) return null

  const manifestRecord =
    loaded.manifest?.manifest &&
    typeof loaded.manifest.manifest === "object" &&
    !Array.isArray(loaded.manifest.manifest)
      ? (loaded.manifest.manifest as Record<string, unknown>)
      : null
  const warnings = manifestRecord?.ingestionWarnings
  const attachments =
    manifestRecord?.attachments &&
    typeof manifestRecord.attachments === "object" &&
    !Array.isArray(manifestRecord.attachments)
      ? (manifestRecord.attachments as Record<string, unknown>)
      : null

  const qualityInput: ScanQualityInput = {
    scan: {
      status: loaded.scan.status,
      mode: loaded.scan.mode,
      determinismMode: loaded.scan.determinismMode,
      durationMs: loaded.scan.durationMs,
      llmRequestCount: loaded.scan.llmRequestCount,
    },
    receipts: loaded.receipts.map((receipt) => ({
      scanner: receipt.scanner,
      controlId: receipt.controlId,
      status: receipt.status,
      reason: receipt.reason,
      metadata:
        receipt.metadata && typeof receipt.metadata === "object" && !Array.isArray(receipt.metadata)
          ? (receipt.metadata as Record<string, unknown>)
          : null,
    })),
    findings: loaded.findings.map((finding) => ({
      verificationStatus: finding.verificationStatus,
      severity: finding.severity,
    })),
    manifestChecksum: loaded.manifest?.checksum ?? null,
    ingestionWarnings: Array.isArray(warnings)
      ? warnings.filter((w): w is string => typeof w === "string").slice(0, 50)
      : [],
    attachments:
      attachments &&
      typeof attachments.count === "number" &&
      typeof attachments.totalBytes === "number"
        ? { count: attachments.count, totalBytes: attachments.totalBytes }
        : null,
  }

  return buildScanQualitySurface(qualityInput)
}
