import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import {
  EvidenceEnvelopeError,
  assertEvidenceStorageConfigured,
  deleteEncryptedArtifact,
  isEnvelope,
  readEncryptedArtifact,
  uploadEncryptedArtifact,
} from "@lyrashield/evidence-storage"
import { env } from "@lyrashield/config"

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || "auto",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY ?? "",
      secretAccessKey: env.S3_SECRET_KEY ?? "",
    },
    forcePathStyle: true,
  })
}

function objectKey(storageUri: string): string {
  const parsed = new URL(storageUri)
  if (parsed.protocol !== "s3:" || parsed.hostname !== env.S3_BUCKET) {
    throw new Error("Evidence proof received an invalid storage URI")
  }
  return parsed.pathname.slice(1)
}

async function assertObjectDeleted(client: S3Client, key: string): Promise<void> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status === 404) return
    throw error
  }
  throw new Error("Evidence proof artifact still exists after cleanup")
}

export interface EvidenceStorageProofResult {
  encryptedRoundTrip: true
  crossWorkspaceDenied: true
  tamperRejected: true
  unauthenticatedDenied: true
  cleanupVerified: true
}

export async function verifyEvidenceStorage(): Promise<EvidenceStorageProofResult> {
  assertEvidenceStorageConfigured()

  const proofId = randomUUID()
  const client = getS3Client()
  const artifacts: Array<{ storageUri: string; key: string; workspaceId: string }> = []
  let proof: Omit<EvidenceStorageProofResult, "cleanupVerified"> | undefined

  try {
    const uploads = []
    for (const suffix of ["a", "b"] as const) {
      const workspaceId = `ops-proof-${proofId}-${suffix}`
      const marker = `lyrashield-evidence-proof:${proofId}:${suffix}`
      const uploaded = await uploadEncryptedArtifact({
        workspaceId,
        namespace: "operational",
        ownerId: proofId,
        type: "storage-proof",
        artifactId: `${proofId}-${suffix}`,
        content: marker,
        contentType: "text/plain; charset=utf-8",
      })
      const key = objectKey(uploaded.storageUri)
      artifacts.push({ storageUri: uploaded.storageUri, key, workspaceId })
      uploads.push({ uploaded, marker, key, workspaceId })
    }

    const [primary, isolation] = uploads
    if (!primary || !isolation) throw new Error("Evidence proof did not create both artifacts")

    const raw = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: primary.key }))
    const ciphertext = Buffer.from(await raw.Body!.transformToByteArray())
    if (!isEnvelope(ciphertext) || ciphertext.includes(Buffer.from(primary.marker, "utf8"))) {
      throw new Error("Evidence proof found plaintext or a malformed envelope in object storage")
    }

    const read = await readEncryptedArtifact(primary.uploaded.storageUri, primary.workspaceId)
    if (
      read.legacy ||
      read.content.toString("utf8") !== primary.marker ||
      read.checksum !== primary.uploaded.checksum
    ) {
      throw new Error("Evidence proof could not round-trip the encrypted artifact")
    }

    try {
      await readEncryptedArtifact(primary.uploaded.storageUri, isolation.workspaceId)
      throw new Error("Evidence proof allowed a cross-workspace read")
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Evidence storage URI does not belong to workspace"
      ) {
        throw error
      }
    }

    const tampered = Buffer.from(ciphertext)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
    await client.send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: primary.key, Body: tampered })
    )
    try {
      await readEncryptedArtifact(primary.uploaded.storageUri, primary.workspaceId)
      throw new Error("Evidence proof accepted a tampered artifact")
    } catch (error) {
      if (!(error instanceof EvidenceEnvelopeError)) throw error
    }

    const publicUrl = new URL(`${env.S3_BUCKET}/${isolation.key}`, `${env.S3_ENDPOINT}/`)
    const unauthenticated = await fetch(publicUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    const unauthenticatedBody = unauthenticated.status === 400 ? await unauthenticated.text() : ""
    const r2AuthorizationDenial =
      unauthenticated.status === 400 &&
      unauthenticatedBody.includes("<Code>InvalidArgument</Code>") &&
      unauthenticatedBody.includes("<Message>Authorization</Message>")
    if (
      unauthenticated.status !== 401 &&
      unauthenticated.status !== 403 &&
      !r2AuthorizationDenial
    ) {
      throw new Error(
        `Evidence proof received ambiguous unauthenticated status ${unauthenticated.status}`
      )
    }

    proof = {
      encryptedRoundTrip: true,
      crossWorkspaceDenied: true,
      tamperRejected: true,
      unauthenticatedDenied: true,
    }
  } finally {
    await Promise.all(
      artifacts.map(async ({ storageUri, key, workspaceId }) => {
        await deleteEncryptedArtifact(storageUri, workspaceId)
        await assertObjectDeleted(client, key)
      })
    )
  }

  if (!proof) throw new Error("Evidence storage proof did not complete")
  return { ...proof, cleanupVerified: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyEvidenceStorage()
    .then(() => console.log("EVIDENCE_STORAGE_PROOF_OK"))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
