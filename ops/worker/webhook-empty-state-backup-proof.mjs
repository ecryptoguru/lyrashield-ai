import { pathToFileURL } from "node:url"
// Root-owned acquisition: exact object readback and exact successful restore
// artifact, never caller JSON or a latest object selection.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  readPolicy,
  readAuthorization,
  atomicRootWrite,
  runDirectory,
} from "../../packages/db/scripts/webhook-empty-state-root-store.mjs"
import {
  canonical,
  sha256,
  requireValue,
  REPOSITORY,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
const ENABLED = false
function command(binary, args, json = false) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_000_000,
    env: { PATH: "/usr/bin:/bin", HOME: "/root" },
  })
  requireValue(result.status === 0, "Exact backup evidence acquisition failed")
  return json ? JSON.parse(result.stdout) : result.stdout
}
export function bindRestoreProof(proof, backup, policy, record) {
  requireValue(
    record.id === policy.restoreArtifactId &&
      record.expired === false &&
      record.workflow_run?.id === Number(backup.runId) &&
      record.workflow_run?.head_sha === policy.backupSourceSha,
    "Restore artifact not bound to exact successful source/run"
  )
  requireValue(
    proof.schemaVersion === "webhook-empty-state-restore-evidence/v2" &&
      proof.runId === backup.runId &&
      proof.sourceSha === policy.backupSourceSha &&
      proof.objectIdSha256 === backup.objectIdSha256 &&
      proof.versionIdSha256 === sha256(backup.versionId.slice(5)) &&
      proof.encryptedSha256 === backup.encryptedSha256 &&
      proof.dumpSha256 === backup.dumpSha256 &&
      proof.databaseIdentitySha256 === policy.databaseIdentitySha256,
    "Different backup target, object or generation was restored"
  )
  return {
    backupSha256: sha256(canonical(backup)),
    runId: proof.runId,
    completedAt: proof.completedAt,
    schemaSha256: proof.schemaSha256,
    auditSha256: proof.auditSha256,
    readinessSha256: proof.readinessSha256,
  }
}
function main() {
  try {
    requireValue(ENABLED, "Backup acquisition adapter remains disabled")
    const policy = readPolicy()
    readAuthorization(policy)
    const directory = runDirectory(policy.runId),
      target = policy.backupTarget
    requireValue(
      /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(target.endpoint || "") &&
        /^[a-z0-9][a-z0-9-]{1,62}$/.test(target.bucket || "") &&
        /^daily\/lyrashield-[0-9]{4}-[0-9]{2}-[0-9]{2}-[1-9][0-9]*\.dump\.gpg$/.test(
          target.key || ""
        ),
      "Invalid fixed backup target"
    )
    const backup = policy.backup
    requireValue(
      sha256(`${target.endpoint}/${target.bucket}/${target.key}`) === backup.objectIdSha256,
      "Backup object identifier changed"
    )
    const head = command(
      "/usr/bin/aws",
      [
        "s3api",
        "head-object",
        "--bucket",
        target.bucket,
        "--key",
        target.key,
        "--endpoint-url",
        target.endpoint,
      ],
      true
    )
    requireValue(
      head.Metadata?.sha256 === backup.dumpSha256 &&
        `etag:${head.ETag}` === backup.versionId &&
        new Date(head.LastModified).toISOString() === backup.createdAt,
      "Backup object checksum, generation or timestamp changed"
    )
    const temporary = mkdtempSync(join(directory, "backup-proof-"))
    try {
      command("/usr/bin/aws", [
        "s3api",
        "get-object",
        "--bucket",
        target.bucket,
        "--key",
        target.key,
        "--endpoint-url",
        target.endpoint,
        "--if-match",
        head.ETag,
        join(temporary, "backup.gpg"),
      ])
      requireValue(
        sha256(readFileSync(join(temporary, "backup.gpg"))) === backup.encryptedSha256,
        "Actual ciphertext differs from approved object"
      )
      const run = command(
        "/usr/bin/gh",
        ["api", `repos/${REPOSITORY}/actions/runs/${backup.runId}`],
        true
      )
      requireValue(
        run.status === "completed" &&
          run.conclusion === "success" &&
          run.head_sha === policy.backupSourceSha &&
          run.path === ".github/workflows/production-backup.yml",
        "Exact backup/restore run did not succeed"
      )
      const record = command(
        "/usr/bin/gh",
        ["api", `repos/${REPOSITORY}/actions/artifacts/${policy.restoreArtifactId}`],
        true
      )
      requireValue(
        Number.isSafeInteger(record.size_in_bytes) &&
          record.size_in_bytes > 0 &&
          record.size_in_bytes <= 65536,
        "Unbounded restore proof artifact"
      )
      const archive = spawnSync(
        "/usr/bin/gh",
        ["api", `repos/${REPOSITORY}/actions/artifacts/${policy.restoreArtifactId}/zip`],
        {
          encoding: null,
          timeout: 30_000,
          maxBuffer: 65536,
          env: { PATH: "/usr/bin:/bin", HOME: "/root" },
        }
      )
      requireValue(
        archive.status === 0 && record.digest === "sha256:" + sha256(archive.stdout),
        "Authenticated artifact digest mismatch"
      )
      writeFileSync(join(temporary, "restore.zip"), archive.stdout, { mode: 0o600, flag: "wx" })
      const proof = JSON.parse(
        command("/usr/bin/unzip", [
          "-p",
          join(temporary, "restore.zip"),
          "webhook-empty-state-restore-proof.json",
        ])
      )
      const restore = bindRestoreProof(proof, backup, policy, record)
      requireValue(
        canonical(restore) === canonical(policy.restore),
        "Restore evidence differs from root approval"
      )
      atomicRootWrite(`${directory}/backup.json`, backup)
      atomicRootWrite(`${directory}/restore.json`, restore)
    } finally {
      rmSync(temporary, { recursive: true })
    }
  } catch {
    process.stderr.write("Fixed backup/restore acquisition failed\n")
    process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
