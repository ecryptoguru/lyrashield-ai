// Runs only after exact-object restore, schema/audit and application readiness
// gates succeed. The public artifact contains digests/provenance only.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  canonicalSupabaseDatabaseIdentity,
  hashDatabaseIdentity,
} from "../../packages/db/scripts/webhook-empty-state-contract.mjs"
import {
  canonical,
  sha256,
  requireValue,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
const env = process.env
for (const key of ["BACKUP_ENCRYPTED_SHA256", "BACKUP_DUMP_SHA256"])
  requireValue(/^[a-f0-9]{64}$/.test(env[key] || ""), "Missing exact backup digest")
requireValue(
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(env.BACKUP_DAY || "") &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ""),
  "Invalid backup provenance"
)
const directory = env.RUNNER_TEMP
const objectKey = `daily/lyrashield-${env.BACKUP_DAY}-${env.GITHUB_RUN_ID}.dump.gpg`
const backupIdentitySha256 = hashDatabaseIdentity(
  canonicalSupabaseDatabaseIdentity([env.PRODUCTION_DATABASE_DIRECT_URL])
)
const proof = {
  schemaVersion: "webhook-empty-state-restore-evidence/v2",
  runId: env.GITHUB_RUN_ID,
  sourceSha: env.GITHUB_SHA,
  completedAt: new Date().toISOString(),
  encryptedSha256: env.BACKUP_ENCRYPTED_SHA256,
  dumpSha256: env.BACKUP_DUMP_SHA256,
  objectIdSha256: sha256(`${env.R2_S3_ENDPOINT}/${env.R2_BACKUP_BUCKET}/${objectKey}`),
  versionIdSha256: sha256(env.BACKUP_ETAG),
  databaseIdentitySha256: backupIdentitySha256,
  schemaSha256: sha256(readFileSync(join(directory, "restore-schema.json"))),
  auditSha256: sha256(readFileSync(join(directory, "audit.json"))),
  readinessSha256: sha256(readFileSync(join(directory, "restore-ready.json"))),
}
writeFileSync(join(directory, "webhook-empty-state-restore-proof.json"), canonical(proof), {
  mode: 0o600,
  flag: "wx",
})
