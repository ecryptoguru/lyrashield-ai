import { createHash } from "crypto"
import { getWorkspaceContext, verifyStoredManifestChecksum, withWorkspaceRLS } from "@lyrashield/db"
import { checksum } from "./checksum"
import { buildCoverageReceipts, receiptIdentityCoverageIssues } from "./coverage-receipts"
import {
  MANIFEST_VERSION,
  SCANNER_CONTRACT_VERSION,
  type ResultManifestInput,
} from "./manifest-types"

export async function persistResultManifest(input: ResultManifestInput): Promise<void> {
  const workspaceId = getWorkspaceContext()
  if (!workspaceId) {
    throw new Error("workspace context is required for persistResultManifest")
  }

  const coverage = buildCoverageReceipts({
    ...input,
    coverageIssues: [...input.coverageIssues, ...receiptIdentityCoverageIssues(input)],
  })
  const manifest = {
    version: MANIFEST_VERSION,
    target: {
      id: input.target.id,
      type: input.target.type,
      repository: input.target.repoFullName ?? null,
      branch: input.target.branch ?? null,
      // Keep URL contents out of the manifest while retaining an integrity signal.
      urlChecksum: input.target.url ? checksum(input.target.url) : null,
    },
    sourceCheckoutAvailable: input.sourceCheckoutAvailable,
    scannerContractVersion: SCANNER_CONTRACT_VERSION,
    urlExecution: input.urlExecution ?? null,
    engineExecution: input.engineExecution ?? null,
    sourceExecution: input.sourceExecution ?? null,
    accounting: input.accounting ?? null,
    // Exact product/image/engine identity of the worker that produced this
    // result. Bound into the checksum so a manifest cannot be re-attributed.
    workerExecution: input.workerExecution ?? null,
    terminalOutcome: input.terminalOutcome ?? null,
    // Coverage limitations are part of the immutable result contract. Keep
    // their bounded subjects and reasons in the manifest, not only in the
    // mutable receipt table.
    coverage,
    // ── run.json 1.1 evidence links (additive; absent keys on 1.0 scans) ──
    // The threat-model and exchange-export entries are checksum-bound
    // references to encrypted artifacts. Neither is proof of verification —
    // the threat model is a declared model and exchange refs are evidence
    // pointers.
    ...(input.scopedCoverage
      ? {
          scopedCoverage: {
            schemaVersion: input.scopedCoverage.schemaVersion ?? null,
            entryCount: input.scopedCoverage.entries.length,
            gapCount: input.scopedCoverage.gaps.length,
            completeness: input.scopedCoverage.completeness ?? null,
          },
        }
      : {}),
    ...(input.threatModel ? { threatModel: input.threatModel } : {}),
    ...(input.httpExchangeEvidence ? { httpExchangeEvidence: input.httpExchangeEvidence } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.ingestionWarnings?.length
      ? { ingestionWarnings: input.ingestionWarnings.slice(0, 100) }
      : {}),
  }
  const manifestChecksumInput = JSON.stringify(manifest)
  if (manifestChecksumInput === undefined) {
    throw new Error("Scan result manifest checksum input is unavailable")
  }
  const manifestChecksum = createHash("sha256").update(manifestChecksumInput).digest("hex")

  await withWorkspaceRLS(workspaceId, async (tx) => {
    const existing = await tx.scanResultManifest.findUnique({ where: { scanId: input.scanId } })
    if (existing) {
      const integrity = verifyStoredManifestChecksum(existing)
      if (integrity === "MISMATCH" || existing.checksum !== manifestChecksum) {
        throw new Error("Scan result manifest already exists with different contents")
      }
    }

    await tx.scanCoverageReceipt.createMany({
      data: coverage.map((receipt) => ({ scanId: input.scanId, ...receipt })),
      skipDuplicates: true,
    })

    if (!existing) {
      await tx.scanResultManifest.create({
        data: {
          scanId: input.scanId,
          version: MANIFEST_VERSION,
          manifest,
          checksum: manifestChecksum,
          checksumInput: manifestChecksumInput,
        },
      })
    }
  })
}
