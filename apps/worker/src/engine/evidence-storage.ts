/* eslint-disable security/detect-non-literal-fs-filename -- local paths are resolved below the configured evidence root */
import { createCipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { dirname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { env } from "@lyrashield/config"
import { assertEvidenceEncrypted } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export const EVIDENCE_KEY_REF = "vault/lyrashield-evidence-key/v1"
const LOCAL_EVIDENCE_KEY_REF = "local-hkdf/better-auth-secret/lyrashield-evidence/v1"
const LOCAL_EVIDENCE_KEY_INFO = "lyrashield-local-evidence-v1"

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

function computeChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
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
  findingId: string,
  type: string,
  artifactId: string,
  checksum: string
): string {
  return `evidence/${workspaceId}/${findingId}/${type}/${artifactId}-${checksum}`
}

function getLocalEvidencePath(key: string): string {
  const root = resolve(
    env.LYRASHIELD_LOCAL_EVIDENCE_DIR || join(process.cwd(), ".lyrashield", "evidence")
  )
  const path = resolve(root, `${key}.enc`)
  const pathFromRoot = relative(root, path)
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("Invalid local evidence path")
  }
  return path
}

function encryptLocalEvidence(content: string): Buffer {
  // ponytail: derive a purpose-specific local key from the required dev secret; add a dedicated key only if local key rotation is needed.
  const key = Buffer.from(
    hkdfSync("sha256", env.BETTER_AUTH_SECRET, "", LOCAL_EVIDENCE_KEY_INFO, 32)
  )
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

async function storeLocalEvidence(
  key: string,
  content: string,
  checksum: string
): Promise<UploadEvidenceResult> {
  const path = getLocalEvidencePath(key)
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, encryptLocalEvidence(content), { mode: 0o600 })
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
    return {
      storageUri: pathToFileURL(path).toString(),
      checksum,
      encryptionKeyRef: LOCAL_EVIDENCE_KEY_REF,
    }
  } catch (err) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    logger.error("Failed to store local evidence", {
      error: err instanceof Error ? err.message : String(err),
    })
    throw new Error("Failed to store local evidence", { cause: err })
  }
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
  const key = buildKey(workspaceId, findingId, type, artifactId, checksum)

  if (isLocalEvidenceConfigured()) {
    assertEvidenceEncrypted(LOCAL_EVIDENCE_KEY_REF)
    return storeLocalEvidence(key, content, checksum)
  }

  if (!isS3Configured()) {
    logger.error("Evidence storage is not configured", {
      workspaceId,
      findingId,
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
        Body: Buffer.from(content, "utf8"),
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
