import { createHash, randomUUID } from "node:crypto"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

export const EVIDENCE_KEY_REF = "vault/lyrashield-evidence-key/v1"

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
 * A missing evidence-store configuration cannot become healthy through a job
 * retry. Keep it distinct from an upload failure so callers do not replay a
 * completed, billable engine run before failing closed.
 */
export class EvidenceStorageConfigurationError extends Error {
  constructor() {
    super("Evidence storage is not configured")
    this.name = "EVIDENCE_STORAGE_CONFIGURATION"
  }
}

function isS3Configured(): boolean {
  return !!(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY)
}

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || "auto",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY ?? "",
      secretAccessKey: env.S3_SECRET_KEY ?? "", // gitleaks:allow - environment lookup, not a credential
    },
    forcePathStyle: true,
  })
}

function computeChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function buildKey(
  workspaceId: string,
  findingId: string,
  type: string,
  artifactId: string
): string {
  return `evidence/${workspaceId}/${findingId}/${type}/${artifactId}`
}

export async function uploadEvidence(params: UploadEvidenceParams): Promise<UploadEvidenceResult> {
  const {
    workspaceId,
    findingId,
    type,
    artifactId = randomUUID(),
    content,
    contentType = "text/plain; charset=utf-8",
    encryptionKeyRef = EVIDENCE_KEY_REF,
  } = params

  const checksum = computeChecksum(content)
  const key = buildKey(workspaceId, findingId, type, artifactId)

  if (!isS3Configured()) {
    logger.error("Evidence storage is not configured", {
      workspaceId,
      findingId,
      type,
      artifactId,
    })
    throw new EvidenceStorageConfigurationError()
  }

  const client = getS3Client()

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: Buffer.from(content, "utf8"),
        ContentType: contentType,
        ServerSideEncryption: "AES256",
        ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
      })
    )

    return {
      storageUri: `s3://${env.S3_BUCKET}/${key}`,
      checksum,
      encryptionKeyRef,
    }
  } catch (err) {
    logger.error("Failed to upload evidence to S3", {
      workspaceId,
      findingId,
      type,
      artifactId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw new Error("Failed to store evidence", { cause: err })
  }
}
