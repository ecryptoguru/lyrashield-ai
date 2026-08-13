import {
  EVIDENCE_KEY_REF,
  EvidenceStorageConfigurationError,
  assertEvidenceStorageConfigured,
  uploadEncryptedArtifact,
} from "@lyrashield/evidence-storage"

export { EVIDENCE_KEY_REF, EvidenceStorageConfigurationError, assertEvidenceStorageConfigured }

export interface UploadEvidenceParams {
  workspaceId: string
  findingId: string
  type: string
  artifactId?: string
  content: string
  contentType?: string
  encryptionKeyRef?: string
}

export interface UploadEvidenceResult {
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
    encryptionKeyRef: params.encryptionKeyRef,
  })
  return {
    storageUri: result.storageUri,
    checksum: result.checksum,
    encryptionKeyRef: result.encryptionKeyRef,
  }
}
