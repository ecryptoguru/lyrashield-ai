import { createPublicKey, verify } from "node:crypto"
import { migrationDatabaseIdentity } from "./migration-database-identity.mjs"

const fail = (message) => {
  throw new Error(`${message}. Production webhook cutover requires current operator evidence.`)
}
const signedFields = [
  "schemaVersion",
  "sourceSha",
  "legacyTimezone",
  "reviewedAt",
  "evidenceRef",
  "reviewer",
  "databaseIdentitySha256",
]

try {
  const encoded = process.env.WEBHOOK_LEGACY_TIMEZONE_REVIEW_RECEIPT
  if (!encoded || encoded.length > 4096) fail("Missing or oversized timezone evidence receipt")

  let receipt
  try {
    receipt = JSON.parse(encoded)
  } catch {
    fail("Timezone evidence receipt is not valid JSON")
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    fail("Timezone evidence receipt must be an object")

  const expectedSourceSha = process.env.EXPECTED_SOURCE_SHA
  if (!/^[a-f0-9]{40}$/.test(expectedSourceSha ?? ""))
    fail("Expected deployment source identity is invalid")
  if (
    receipt.schemaVersion !== "webhook-timezone-review/v1" ||
    receipt.sourceSha !== expectedSourceSha ||
    receipt.legacyTimezone !== "UTC"
  )
    fail("Timezone evidence is not bound to this UTC cutover source")

  if (
    typeof receipt.reviewedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      receipt.reviewedAt
    )
  )
    fail("Timezone evidence review timestamp is invalid")
  const reviewedAt = Date.parse(receipt.reviewedAt)
  const now = Date.now()
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000
  if (
    !Number.isFinite(reviewedAt) ||
    reviewedAt > now + 5 * 60 * 1000 ||
    now - reviewedAt > maxAgeMs
  )
    fail("Timezone evidence review timestamp is stale or in the future")

  if (
    typeof receipt.evidenceRef !== "string" ||
    receipt.evidenceRef.length > 512 ||
    !/^(https:\/\/\S+|gh:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+)$/.test(
      receipt.evidenceRef
    )
  )
    fail("Timezone evidence reference is missing or invalid")
  if (typeof receipt.reviewer !== "string" || !/^[A-Za-z0-9_.@+-]{3,120}$/.test(receipt.reviewer))
    fail("Timezone evidence reviewer identity is missing or invalid")

  const actualDatabaseIdentity = migrationDatabaseIdentity(process.env.MIGRATION_DATABASE_URL)
  if (
    typeof receipt.databaseIdentitySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.databaseIdentitySha256) ||
    receipt.databaseIdentitySha256 !== actualDatabaseIdentity
  )
    fail("Timezone evidence database identity does not match the migration target")

  if (
    Object.keys(receipt).length !== signedFields.length + 1 ||
    Object.keys(receipt).some((key) => ![...signedFields, "signature"].includes(key)) ||
    typeof receipt.signature !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(receipt.signature)
  )
    fail("Timezone evidence signature is missing or malformed")

  let publicKey
  try {
    publicKey = createPublicKey(process.env.WEBHOOK_LEGACY_TIMEZONE_REVIEW_PUBLIC_KEY_PEM ?? "")
  } catch {
    fail("Timezone evidence verification key is missing or invalid")
  }
  if (publicKey.asymmetricKeyType !== "ed25519")
    fail("Timezone evidence verification key must use Ed25519")
  const payload = JSON.stringify(Object.fromEntries(signedFields.map((key) => [key, receipt[key]])))
  if (!verify(null, Buffer.from(payload), publicKey, Buffer.from(receipt.signature, "base64")))
    fail("Timezone evidence signature verification failed")

  console.log(
    "Webhook legacy timezone evidence verified for the reviewed source and migration database."
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
