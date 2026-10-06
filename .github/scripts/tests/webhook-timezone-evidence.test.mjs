import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { migrationDatabaseIdentity } from "../migration-database-identity.mjs"

const script = ".github/scripts/verify-webhook-timezone-evidence.mjs"
const sourceSha = "a".repeat(40)
const migrationUrl = "postgresql://operator:private@db.example:5432/lyrashield?schema=public"
const identity = migrationDatabaseIdentity(migrationUrl)
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" })
const receiptFields = {
  schemaVersion: "webhook-timezone-review/v1",
  sourceSha,
  legacyTimezone: "UTC",
  reviewedAt: new Date().toISOString(),
  evidenceRef: "gh://ecryptoguru/lyrashield-ai/actions/runs/123456789",
  reviewer: "platform-operator",
  databaseIdentitySha256: identity,
}
const fieldOrder = [
  "schemaVersion",
  "sourceSha",
  "legacyTimezone",
  "reviewedAt",
  "evidenceRef",
  "reviewer",
  "databaseIdentitySha256",
]

function signedReceipt(fields) {
  const orderedFields = Object.fromEntries(fieldOrder.map((key) => [key, fields[key]]))
  return {
    ...orderedFields,
    signature: sign(null, Buffer.from(JSON.stringify(orderedFields)), privateKey).toString(
      "base64"
    ),
  }
}

const makeReceipt = (overrides = {}) => signedReceipt({ ...receiptFields, ...overrides })
const baseReceipt = makeReceipt()

function verify(receipt, overrides = {}) {
  const suppliedReceipt =
    receipt && typeof receipt === "object" && !Array.isArray(receipt) && !("signature" in receipt)
      ? signedReceipt(receipt)
      : receipt
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      WEBHOOK_LEGACY_TIMEZONE_REVIEW_RECEIPT:
        suppliedReceipt === undefined ? "" : JSON.stringify(suppliedReceipt),
      WEBHOOK_LEGACY_TIMEZONE_REVIEW_PUBLIC_KEY_PEM: publicKeyPem,
      EXPECTED_SOURCE_SHA: sourceSha,
      MIGRATION_DATABASE_URL: migrationUrl,
      ...overrides,
    },
  })
}

test("accepts a recent UTC review bound to the current source and migration database", () => {
  const result = verify(baseReceipt)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /timezone evidence verified/)
  assert.doesNotMatch(result.stdout + result.stderr, /private|123456789|platform-operator/)
})

for (const [name, receipt, overrides] of [
  ["missing receipt", undefined, {}],
  ["malformed receipt", "{", {}],
  ["unsupported schema", makeReceipt({ schemaVersion: "other" }), {}],
  ["non-UTC legacy timezone", makeReceipt({ legacyTimezone: "local" }), {}],
  ["unbound source", makeReceipt({ sourceSha: "b".repeat(40) }), {}],
  ["database mismatch", makeReceipt({ databaseIdentitySha256: "d".repeat(64) }), {}],
  [
    "tampered signed database identity",
    { ...baseReceipt, databaseIdentitySha256: "d".repeat(64) },
    {},
  ],
  ["missing evidence reference", makeReceipt({ evidenceRef: "" }), {}],
  ["invalid review timestamp", makeReceipt({ reviewedAt: "yesterday" }), {}],
  ["future review timestamp", makeReceipt({ reviewedAt: "2999-01-01T00:00:00Z" }), {}],
  ["stale review", makeReceipt({ reviewedAt: "2025-01-01T00:00:00.000Z" }), {}],
  ["malformed signature", { ...baseReceipt, signature: "not-base64!" }, {}],
  [
    "invalid signature",
    { ...baseReceipt, signature: Buffer.from("wrong signature").toString("base64") },
    {},
  ],
  ["unexpected receipt field", { ...baseReceipt, extra: true }, {}],
  ["missing verification key", baseReceipt, { WEBHOOK_LEGACY_TIMEZONE_REVIEW_PUBLIC_KEY_PEM: "" }],
  ["invalid migration URL", baseReceipt, { MIGRATION_DATABASE_URL: "postgres://bad" }],
]) {
  test(`fails closed for ${name}`, () => assert.notEqual(verify(receipt, overrides).status, 0))
}

test("production cutover validates the receipt before claiming maintenance", async () => {
  const { readFile } = await import("node:fs/promises")
  const workflow = await readFile(".github/workflows/deploy-azure-runtime.yml", "utf8")
  const verifyIndex = workflow.indexOf("- name: Verify webhook timezone evidence")
  const loginIndex = workflow.indexOf("- name: Log in to Azure")
  const claimIndex = workflow.indexOf("- name: Claim webhook maintenance admission stop")
  const mutationIndex = workflow.indexOf("- name: Ensure app and scanner system identities")
  assert.ok(verifyIndex >= 0)
  assert.ok(verifyIndex < loginIndex)
  assert.ok(verifyIndex < claimIndex)
  assert.ok(verifyIndex < mutationIndex)
  assert.match(
    workflow,
    /WEBHOOK_LEGACY_TIMEZONE_REVIEW_RECEIPT:\s*\$\{\{ secrets\.WEBHOOK_LEGACY_TIMEZONE_REVIEW_RECEIPT \}\}/
  )
  assert.match(
    workflow,
    /WEBHOOK_LEGACY_TIMEZONE_REVIEW_PUBLIC_KEY_PEM:\s*\$\{\{ secrets\.WEBHOOK_LEGACY_TIMEZONE_REVIEW_PUBLIC_KEY_PEM \}\}/
  )
})
