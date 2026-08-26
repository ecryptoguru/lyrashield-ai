import { createHash, randomUUID } from "node:crypto"
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { env } from "@lyrashield/config"
import { assertEvidenceEncrypted } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  ENVELOPE_KEY_REF,
  EvidenceEnvelopeError,
  isEnvelope,
  openEnvelope,
  readEnvelopeKeyRef,
  resolveEnvelopeKek,
  sealEnvelope,
  verifyEnvelopeShape,
} from "./envelope"

export { EvidenceEnvelopeError, isEnvelope, verifyEnvelopeShape } from "./envelope"

/**
 * Key reference recorded for new artifacts. Objects are envelope-encrypted
 * client-side (per-object data key wrapped under the configured KEK) before
 * they reach the bucket; see ./envelope.ts.
 */
export const EVIDENCE_KEY_REF = ENVELOPE_KEY_REF
const LOCAL_EVIDENCE_KEY_REF = "local-hkdf/better-auth-secret/lyrashield-evidence/v1"
const VERSIONED_EVIDENCE_KEY_REF = /^envkeystore\/lyrashield-evidence-kek\/v([1-9][0-9]*)$/

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

function activeEvidenceKeyRef(): string {
  const keyRef = env.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF || EVIDENCE_KEY_REF
  assertEvidenceEncrypted(keyRef)
  return keyRef
}

function evidenceKekKeyring(): Record<string, string> {
  let keyring: unknown
  try {
    keyring = JSON.parse(env.LYRASHIELD_EVIDENCE_KEK_KEYRING || "{}")
  } catch (error) {
    throw new EvidenceEnvelopeError("LYRASHIELD_EVIDENCE_KEK_KEYRING is not valid JSON", {
      cause: error,
    })
  }
  if (!keyring || typeof keyring !== "object" || Array.isArray(keyring)) {
    throw new EvidenceEnvelopeError("LYRASHIELD_EVIDENCE_KEK_KEYRING must be a JSON object")
  }
  const validated: Record<string, string> = {}
  const activeKeyRef = activeEvidenceKeyRef()
  const activeVersionMatch = VERSIONED_EVIDENCE_KEY_REF.exec(activeKeyRef)
  if (!activeVersionMatch) {
    throw new EvidenceEnvelopeError("Active evidence envelope key reference is not versioned")
  }
  const activeKek = env.LYRASHIELD_EVIDENCE_KEK || ""
  for (const [keyRef, secret] of Object.entries(keyring)) {
    assertEvidenceEncrypted(keyRef)
    if (typeof secret !== "string") {
      throw new EvidenceEnvelopeError("LYRASHIELD_EVIDENCE_KEK_KEYRING values must be strings")
    }
    resolveEnvelopeKek(secret)
    const historicalVersion = VERSIONED_EVIDENCE_KEY_REF.exec(keyRef)
    if (!historicalVersion || Number(historicalVersion[1]) >= Number(activeVersionMatch[1])) {
      throw new EvidenceEnvelopeError("Historical evidence envelope key reference is invalid")
    }
    if (secret === activeKek) {
      throw new EvidenceEnvelopeError("Active and historical evidence envelope keys must differ")
    }
    validated[keyRef] = secret
  }
  for (let version = 1; version < Number(activeVersionMatch[1]); version += 1) {
    if (!validated[`envkeystore/lyrashield-evidence-kek/v${version}`]) {
      throw new EvidenceEnvelopeError("Evidence envelope keyring is missing a prior version")
    }
  }
  return validated
}

function resolveEvidenceKek(keyRef: string): Buffer {
  if (keyRef === activeEvidenceKeyRef()) {
    return resolveEnvelopeKek(env.LYRASHIELD_EVIDENCE_KEK || undefined)
  }
  const secret = evidenceKekKeyring()[keyRef]
  if (typeof secret !== "string") {
    throw new EvidenceEnvelopeError("Evidence envelope key reference is invalid")
  }
  return resolveEnvelopeKek(secret)
}

export function assertEvidenceStorageConfigured(): void {
  if (isLocalEvidenceConfigured()) {
    assertEvidenceEncrypted(LOCAL_EVIDENCE_KEY_REF)
    return
  }
  if (isS3Configured()) {
    // Fail closed: without a valid KEK the artifact could only be stored
    // unencrypted, and evidence holds PoC exploit code and captured secrets.
    resolveEvidenceKek(activeEvidenceKeyRef())
    evidenceKekKeyring()
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

function assertValidKeyComponent(value: string): void {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) {
    throw new Error("Invalid evidence storage key component")
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
  for (const part of [workspaceId, namespace, ownerId, type, artifactId]) {
    if (part !== undefined) assertValidKeyComponent(part)
  }
  const parts = ["evidence", workspaceId]
  if (namespace) parts.push(namespace)
  parts.push(ownerId, type, `${artifactId}-${checksum}`)
  return parts.join("/")
}

export async function uploadEncryptedArtifact(
  input: UploadEncryptedArtifactInput
): Promise<UploadEncryptedArtifactResult> {
  const activeKeyRef = activeEvidenceKeyRef()
  if (input.encryptionKeyRef !== undefined && input.encryptionKeyRef !== activeKeyRef) {
    throw new Error("encryptionKeyRef is internal-only")
  }
  const {
    workspaceId,
    ownerId,
    type,
    content,
    namespace,
    artifactId = randomUUID(),
    contentType = "application/octet-stream",
    encryptionKeyRef = activeKeyRef,
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
  const kek = resolveEvidenceKek(encryptionKeyRef)

  // Envelope-encrypt before the object leaves this process: the bucket only
  // ever receives ciphertext sealed under a per-object data key, wrapped by
  // the configured KEK. Provider-managed SSE alone would leave the plaintext
  // readable by the storage operator.
  const envelope = sealEnvelope(payload, kek, encryptionKeyRef)
  if (!verifyEnvelopeShape(envelope)) {
    throw new EvidenceEnvelopeError(
      "Refusing to store evidence: envelope failed shape verification"
    )
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: envelope,
        ContentType: contentType,
        // R2 applies AES-256 encryption at rest automatically and rejects the
        // S3 per-object ServerSideEncryption option. Other S3-compatible stores
        // retain the explicit fail-closed encryption request as defense in
        // depth beneath the client-side envelope.
        ...(isCloudflareR2Endpoint(env.S3_ENDPOINT)
          ? {}
          : { ServerSideEncryption: "AES256" as const }),
        // Object integrity covers the bytes actually uploaded (the envelope);
        // the plaintext checksum below is the content digest recorded in the
        // evidence manifest.
        ChecksumSHA256: Buffer.from(
          createHash("sha256").update(envelope).digest("hex"),
          "hex"
        ).toString("base64"),
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

export interface ReadEncryptedArtifactResult {
  content: Buffer
  /** sha256 of the decrypted plaintext. */
  checksum: string
  /** Key reference authenticated by the encrypted artifact. */
  encryptionKeyRef: string
  /** Always false; non-envelope S3 objects fail closed. */
  legacy: false
}

/**
 * Read an evidence artifact back and decrypt it. Envelope-encrypted objects
 * are authenticated with both GCM tags; a tampered object fails closed.
 * Objects written before envelope encryption are rejected rather than returned
 * as unauthenticated plaintext.
 */
export async function readEncryptedArtifact(
  storageUri: string,
  expectedWorkspaceId: string
): Promise<ReadEncryptedArtifactResult> {
  assertValidKeyComponent(expectedWorkspaceId)
  if (storageUri.startsWith("file:")) {
    if (!isLocalEvidenceConfigured()) throw new EvidenceStorageConfigurationError()
    const { readLocalEvidence } = await import(/* turbopackIgnore: true */ "./local.js")
    const content = await readLocalEvidence(storageUri, expectedWorkspaceId)
    return {
      content,
      checksum: computeChecksum(content),
      encryptionKeyRef: LOCAL_EVIDENCE_KEY_REF,
      legacy: false,
    }
  }

  const parsed = new URL(storageUri)
  const key = parsed.pathname.slice(1)
  if (
    parsed.protocol !== "s3:" ||
    parsed.hostname !== env.S3_BUCKET ||
    !key.startsWith(`evidence/${expectedWorkspaceId}/`)
  ) {
    throw new Error("Evidence storage URI does not belong to workspace")
  }
  if (!isS3Configured()) throw new EvidenceStorageConfigurationError()

  const response = await getS3Client().send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key })
  )
  const body = Buffer.from(await response.Body!.transformToByteArray())

  if (!isEnvelope(body)) {
    throw new EvidenceEnvelopeError("Evidence object is not envelope-encrypted")
  }

  const envelopeKeyRef = readEnvelopeKeyRef(body)
  const kek = resolveEvidenceKek(envelopeKeyRef)
  const { plaintext, keyRef } = openEnvelope(body, kek)
  if (keyRef !== envelopeKeyRef) {
    throw new EvidenceEnvelopeError("Evidence envelope key reference is invalid")
  }
  return {
    content: plaintext,
    checksum: computeChecksum(plaintext),
    encryptionKeyRef: keyRef,
    legacy: false,
  }
}

/**
 * Best-effort compensation used only after immutable metadata persistence fails.
 * Callers must never expose the private storage URI.
 */
export async function deleteEncryptedArtifact(
  storageUri: string,
  expectedWorkspaceId: string
): Promise<void> {
  assertValidKeyComponent(expectedWorkspaceId)
  if (storageUri.startsWith("file:")) {
    if (!isLocalEvidenceConfigured()) throw new EvidenceStorageConfigurationError()
    const { deleteLocalEvidence } = await import(/* turbopackIgnore: true */ "./local.js")
    await deleteLocalEvidence(storageUri, expectedWorkspaceId)
    return
  }

  const parsed = new URL(storageUri)
  const key = parsed.pathname.slice(1)
  if (
    parsed.protocol !== "s3:" ||
    parsed.hostname !== env.S3_BUCKET ||
    !key.startsWith(`evidence/${expectedWorkspaceId}/`)
  ) {
    throw new Error("Evidence storage URI does not belong to workspace")
  }
  if (!isS3Configured()) throw new EvidenceStorageConfigurationError()
  await getS3Client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
}
