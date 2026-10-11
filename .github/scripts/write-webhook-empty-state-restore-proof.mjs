// Runs only after exact-object restore, schema/audit and application readiness
// gates succeed. The public artifact contains digests/provenance only.
import { readFileSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { prepareVerifiedBackupConnection } from "./prepare-verified-backup-connection.mjs"
import {
  canonical,
  sha256,
  requireValue,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
const env = process.env
let stage = "backup-digests"
try {
  for (const key of [
    "BACKUP_ENCRYPTED_SHA256",
    "BACKUP_DUMP_SHA256",
    "BACKUP_DATABASE_IDENTITY_SHA256",
  ])
    requireValue(/^[a-f0-9]{64}$/.test(env[key] || ""), "Missing exact backup digest")
  stage = "backup-provenance"
  requireValue(
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(env.BACKUP_DAY || "") &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ""),
    "Invalid backup provenance"
  )
  const directory = env.RUNNER_TEMP
  const objectKey = `daily/lyrashield-${env.BACKUP_DAY}-${env.GITHUB_RUN_ID}.dump.gpg`
  stage = "database-identity"
  const backupIdentitySha256 = prepareVerifiedBackupConnection(
    env.PRODUCTION_DATABASE_DIRECT_URL
  ).identitySha256
  requireValue(
    backupIdentitySha256 === env.BACKUP_DATABASE_IDENTITY_SHA256,
    "Backup producer database identity differs from proof"
  )
  stage = "restore-evidence"
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
  stage = "proof-write"
  writeFileSync(join(directory, "webhook-empty-state-restore-proof.json"), canonical(proof), {
    mode: 0o600,
    flag: "wx",
  })
} catch (error) {
  // Exact fixed messages only: never print the URL, rejected key/value, file
  // path, provider response, exception stack or restored row context.
  const reasons = new Map([
    ["Unsupported backup compatibility option", "unsupported-compatibility"],
    ["backup database URL requires one explicit supported TLS mode", "tls-verification-required"],
    ["Backup producer database identity differs from proof", "producer-identity-mismatch"],
    ["backup database URL requires sslmode=verify-full", "tls-verification-required"],
    ["Backup requires direct/session PostgreSQL", "direct-session-required"],
    ["backup database URL contains a duplicate query parameter", "duplicate-parameter"],
    ["backup database URL contains an unsupported or unsafe query parameter", "unsafe-parameter"],
    [
      "backup database URL has different effective node-postgres and Prisma targets",
      "target-mismatch",
    ],
    ["backup database URL principal differs from the approved expectation", "principal-mismatch"],
    ["backup database URL must target postgres/public", "database-scope-mismatch"],
    [
      "backup database URL host is not a recognized Supabase direct or pooler endpoint",
      "unrecognized-endpoint",
    ],
  ])
  const reason = reasons.get(error?.message) ?? "validation-or-io-failure"
  const diagnostic = `Restore proof failed (${stage}/${reason}).\n`
  // The workflow opens FD 3 before redirecting sensitive operations privately.
  // Only this allowlisted diagnostic can reach it; ordinary callers use stderr.
  try {
    writeSync(env.RESTORE_PROOF_DIAGNOSTIC_FD === "3" ? 3 : 2, diagnostic)
  } catch {
    writeSync(2, diagnostic)
  }
  process.exitCode = 1
}
