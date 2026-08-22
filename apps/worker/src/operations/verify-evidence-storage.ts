import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3"
import {
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

export async function verifyEvidenceStorage(): Promise<void> {
  assertEvidenceStorageConfigured()

  const proofId = randomUUID()
  const marker = `lyrashield-evidence-proof:${proofId}`
  const client = getS3Client()
  let storageUri: string | undefined
  let key: string | undefined

  try {
    const uploaded = await uploadEncryptedArtifact({
      workspaceId: `ops-proof-${proofId}`,
      namespace: "operational",
      ownerId: proofId,
      type: "storage-proof",
      artifactId: proofId,
      content: marker,
      contentType: "text/plain; charset=utf-8",
    })
    storageUri = uploaded.storageUri
    key = objectKey(storageUri)

    const raw = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
    const ciphertext = Buffer.from(await raw.Body!.transformToByteArray())
    if (!isEnvelope(ciphertext) || ciphertext.includes(Buffer.from(marker, "utf8"))) {
      throw new Error("Evidence proof found plaintext or a malformed envelope in object storage")
    }

    const read = await readEncryptedArtifact(storageUri)
    if (
      read.legacy ||
      read.content.toString("utf8") !== marker ||
      read.checksum !== uploaded.checksum
    ) {
      throw new Error("Evidence proof could not round-trip the encrypted artifact")
    }

    const publicUrl = new URL(`${env.S3_BUCKET}/${key}`, `${env.S3_ENDPOINT}/`)
    const unauthenticated = await fetch(publicUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    if (unauthenticated.ok) {
      throw new Error("Evidence proof object was readable without storage credentials")
    }
  } finally {
    if (storageUri) await deleteEncryptedArtifact(storageUri)
    if (key) await assertObjectDeleted(client, key)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyEvidenceStorage()
    .then(() => console.log("EVIDENCE_STORAGE_PROOF_OK"))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
