import {
  EVIDENCE_KEY_REF,
  EvidenceStorageConfigurationError,
  assertEvidenceStorageConfigured,
  deleteEncryptedArtifact,
  uploadEncryptedArtifact,
} from "@lyrashield/evidence-storage"

export {
  EVIDENCE_KEY_REF,
  EvidenceStorageConfigurationError,
  assertEvidenceStorageConfigured,
  deleteEncryptedArtifact,
}

interface UploadEvidenceParams {
  workspaceId: string
  findingId: string
  type: string
  artifactId?: string
  content: string
  contentType?: string
}

interface UploadEvidenceResult {
  storageUri: string
  checksum: string
  encryptionKeyRef: string
}

/**
 * Backward-compatible wrapper around the shared evidence-storage package for
 * finding evidence. Preserves the original key shape by leaving the namespace
 * empty: evidence/{workspaceId}/{findingId}/{type}/{artifactId}-{checksum}.
 */
export async function uploadEvidence(params: UploadEvidenceParams): Promise<UploadEvidenceResult> {
  const result = await uploadEncryptedArtifact({
    workspaceId: params.workspaceId,
    ownerId: params.findingId,
    type: params.type,
    content: params.content,
    artifactId: params.artifactId,
    contentType: params.contentType,
  })
  return {
    storageUri: result.storageUri,
    checksum: result.checksum,
    encryptionKeyRef: result.encryptionKeyRef,
  }
}

interface UploadScanArtifactParams {
  workspaceId: string
  scanId: string
  type: string
  artifactId?: string
  content: string
  contentType?: string
}

/**
 * Scan-bound encrypted artifact (ownerId = scanId). Used for run.json 1.1
 * evidence documents — the threat-model export and the bounded redacted
 * proxy-exchange index — whose checksums are linked from the result manifest
 * and finding claim contexts.
 */
export async function uploadScanArtifact(
  params: UploadScanArtifactParams
): Promise<UploadEvidenceResult & { byteLength: number }> {
  const result = await uploadEncryptedArtifact({
    workspaceId: params.workspaceId,
    ownerId: params.scanId,
    type: params.type,
    content: params.content,
    artifactId: params.artifactId,
    contentType: params.contentType,
  })
  return {
    storageUri: result.storageUri,
    checksum: result.checksum,
    encryptionKeyRef: result.encryptionKeyRef,
    byteLength: result.byteLength,
  }
}
