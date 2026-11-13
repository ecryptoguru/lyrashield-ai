import { createHash } from "node:crypto"
import { assertEvidenceEncrypted } from "@lyrashield/db"
import {
  EvidenceStorageConfigurationError,
  uploadScanArtifact,
} from "../../engine/evidence-storage"
import type { ParsedHttpExchangeExport } from "../../engine/output-parser-types"

export async function storeHttpExchangeExport(params: {
  artifact: ParsedHttpExchangeExport
  workspaceId: string
  scanId: string
  captureRequiresExport: boolean
  assertCanStart: () => void
}) {
  const { artifact, workspaceId, scanId, captureRequiresExport, assertCanStart } = params
  assertCanStart()
  const upload = () =>
    uploadScanArtifact({
      workspaceId,
      scanId,
      type: "http_exchanges",
      artifactId: "http-exchanges",
      content: artifact.document,
      contentType: "application/json; charset=utf-8",
    })
  // Retry only the retained bytes inside the existing grace period. Never replay the engine.
  const uploaded = await upload().catch((error: unknown) => {
    if (!captureRequiresExport || error instanceof EvidenceStorageConfigurationError) throw error
    assertCanStart()
    return upload()
  })
  assertEvidenceEncrypted(uploaded.encryptionKeyRef)
  if (
    captureRequiresExport &&
    uploaded.checksum !== createHash("sha256").update(artifact.document).digest("hex")
  ) {
    throw new Error("Stored HTTP export checksum did not match capture evidence")
  }
  return {
    checksum: uploaded.checksum,
    byteLength: uploaded.byteLength,
    exchangeCount: artifact.exchangeCount,
    ...(artifact.schemaVersion ? { schemaVersion: artifact.schemaVersion } : {}),
  }
}
