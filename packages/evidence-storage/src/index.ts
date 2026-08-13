import { createHash, randomUUID } from "node:crypto"
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { env } from "@lyrashield/config"
import { assertEvidenceEncrypted } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export const EVIDENCE_KEY_REF = "vault/lyrashield-evidence-key/v1"
const LOCAL_EVIDENCE_KEY_REF = "local-hkdf/better-auth-secret/lyrashield-evidence/v1"

export interface UploadEncryptedArtifactInput {
  workspaceId: string
  ownerId: string
  type: string
  content: string | Buffer
  namespace?: string
  artifactId?: string
  contentType?: string
  encryptionKeyRef?: string
}

export interface UploadEncryptedArtifactResult {
  storageUri: string
  checksum: string
  encryptionKeyRef: string
  byteLength: number
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

function isLocalEvidenceConfigured(): boolean {
  return env.NODE_ENV !== "production" && env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE === "1"
}

export function assertEvidenceStorageConfigured(): void {
  if (isLocalEvidenceConfigured()) {
    assertEvidenceEncrypted(LOCAL_EVIDENCE_KEY_REF)
    return
  }
  if (isS3Configured()) {
    assertEvidenceEncrypted(EVIDENCE_KEY_REF)
    return
  }
  throw new EvidenceStorageConfigurationError()
}

let s3Client: S3Client | null = null

function getS3Client(): S3Client {
  if (s3Client) return s3Client
  s3Client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || "auto",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY ?? "",
      secretAccessKey: env.S3_SECRET_KEY ?? "", // gitleaks:allow - environment lookup, not a credential
    },
    forcePathStyle: true,
  })
  return s3Client
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")
}

function computeChecksum(content: string | Buffer): string {
  return createHash("sha256").update(toBuffer(content)).digest("hex")
}

function isCloudflareR2Endpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false

  try {
    const hostname = new URL(endpoint).hostname.toLowerCase()
    return hostname === "r2.cloudflarestorage.com" || hostname.endsWith(".r2.cloudflarestorage.com")
  } catch {
    return false
  }
}

function buildKey(
  workspaceId: string,
  namespace: string | undefined,
  ownerId: string,
  type: string,
  artifactId: string,
  checksum: string
): string {
  const parts = ["evidence", workspaceId]
  if (namespace) parts.push(namespace)
  parts.push(ownerId, type, `${artifactId}-${checksum}`)
  return parts.join("/")
}

export async function uploadEncryptedArtifact(
  input: UploadEncryptedArtifactInput
): Promise<UploadEncryptedArtifactResult> {
  const {
    workspaceId,
    ownerId,
    type,
    content,
    namespace,
    artifactId = randomUUID(),
    contentType = "application/octet-stream",
    encryptionKeyRef = EVIDENCE_KEY_REF,
  } = input

  const payload = toBuffer(content)
  const checksum = computeChecksum(payload)
  const byteLength = payload.length
  const key = buildKey(workspaceId, namespace, ownerId, type, artifactId, checksum)

  if (isLocalEvidenceConfigured()) {
    assertEvidenceEncrypted(LOCAL_EVIDENCE_KEY_REF)
    const { storeLocalEvidence } = await import(/* turbopackIgnore: true */ "./local.js")
    return storeLocalEvidence(key, content, checksum, LOCAL_EVIDENCE_KEY_REF)
  }

  if (!isS3Configured()) {
    logger.error("Evidence storage is not configured", {
      workspaceId,
      ownerId,
      type,
      artifactId,
    })
    assertEvidenceStorageConfigured()
  }

  const client = getS3Client()
  assertEvidenceEncrypted(encryptionKeyRef)

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: payload,
        ContentType: contentType,
        // R2 applies AES-256 encryption at rest automatically and rejects the
        // S3 per-object ServerSideEncryption option. Other S3-compatible stores
        // retain the explicit fail-closed encryption request.
        ...(isCloudflareR2Endpoint(env.S3_ENDPOINT)
          ? {}
          : { ServerSideEncryption: "AES256" as const }),
        ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
      })
    )

    return {
      storageUri: `s3://${env.S3_BUCKET}/${key}`,
      checksum,
      encryptionKeyRef,
      byteLength,
    }
  } catch (err) {
    logger.error("Failed to upload evidence to S3", {
      workspaceId,
      ownerId,
      type,
      artifactId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw new Error("Failed to store evidence", { cause: err })
  }
}

/**
 * Best-effort compensation used only after immutable metadata persistence fails.
 * Callers must never expose the private storage URI.
 */
export async function deleteEncryptedArtifact(storageUri: string): Promise<void> {
  if (storageUri.startsWith("file:")) {
    if (!isLocalEvidenceConfigured()) throw new EvidenceStorageConfigurationError()
    const { deleteLocalEvidence } = await import(/* turbopackIgnore: true */ "./local.js")
    await deleteLocalEvidence(storageUri)
    return
  }

  const parsed = new URL(storageUri)
  const key = parsed.pathname.slice(1)
  if (
    parsed.protocol !== "s3:" ||
    parsed.hostname !== env.S3_BUCKET ||
    !key.startsWith("evidence/")
  ) {
    throw new Error("Invalid evidence storage URI")
  }
  if (!isS3Configured()) throw new EvidenceStorageConfigurationError()
  await getS3Client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
}
