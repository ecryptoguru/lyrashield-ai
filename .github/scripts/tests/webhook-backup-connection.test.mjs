import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { normalizeBackupConnection } from "../../../packages/db/scripts/webhook-backup-connection.mjs"
import { parsePostgresConnectionTarget } from "../../../packages/db/scripts/webhook-empty-state-contract.mjs"

const direct =
  "postgresql://postgres:fixture-only@db.localprojectfixture1.supabase.co:5432/postgres?schema=public&sslmode=verify-full"

test("backup compatibility flags preserve verified TLS, credentials and logical identity", () => {
  const expected = normalizeBackupConnection(direct)
  for (const flag of ["uselibpqcompat=1", "uselibpqcompat=true", "%75selibpqcompat=1"]) {
    for (const raw of [direct + "&" + flag, direct.replace("?", "?" + flag + "&")]) {
      const actual = normalizeBackupConnection(raw)
      assert.equal(actual.identitySha256, expected.identitySha256)
      const target = parsePostgresConnectionTarget(actual.url)
      assert.equal(target.url.searchParams.get("sslmode"), "verify-full")
      assert.equal(target.url.searchParams.has("uselibpqcompat"), false)
      assert.equal(target.host, "db.localprojectfixture1.supabase.co")
      assert.equal(target.user, "postgres")
      assert.equal(target.url.password, "fixture-only")
    }
  }
})

test("backup normalization rejects unsafe TLS, identity changes and ambiguous options", () => {
  for (const raw of [
    direct + "&uselibpqcompat=0",
    direct + "&uselibpqcompat=false",
    direct + "&uselibpqcompat=unexpected",
    direct + "&uselibpqcompat=1&%75selibpqcompat=true",
    direct + "&uselibpqcompat=1&host=evil.invalid",
    direct + "&uselibpqcompat=1&%75ser=attacker",
    direct + "&uselibpqcompat=1&password=other",
    direct + "&uselibpqcompat=1&options=-c%20search_path%3Devil",
    direct + "&uselibpqcompat=1&sslrootcert=/fixture-must-not-be-read",
    direct + "&uselibpqcompat=1&sslmode=verify-full",
    direct.replace("sslmode=verify-full", "sslmode=require&uselibpqcompat=1"),
    direct.replace("sslmode=verify-full", "sslmode=disable&uselibpqcompat=1"),
    direct.replace("&sslmode=verify-full", "&uselibpqcompat=1"),
    direct.replace("postgres:fixture-only", "worker_runtime:fixture-only") + "&uselibpqcompat=1",
    direct.replace(":5432/", ":6543/") + "&uselibpqcompat=1",
    direct.replace("schema=public", "schema=private") + "&uselibpqcompat=1",
    direct.replace("/postgres?", "/other?") + "&uselibpqcompat=1",
    direct + "&uselibpqcompat=1#fragment",
    "not-a-url",
    null,
    "x".repeat(8193),
  ])
    assert.throws(() => normalizeBackupConnection(raw))
  // This exception is backup-only; maintenance and runtime parsers stay strict.
  assert.throws(() => parsePostgresConnectionTarget(direct + "&uselibpqcompat=1"), /unsupported/)
})

test("public restore proof accepts backup compatibility without publishing connection material", () => {
  const directory = mkdtempSync(join(tmpdir(), "launch-restore-proof-"))
  try {
    for (const name of ["restore-schema.json", "audit.json", "restore-ready.json"])
      writeFileSync(join(directory, name), "{}")
    const result = spawnSync(
      process.execPath,
      [".github/scripts/write-webhook-empty-state-restore-proof.mjs"],
      {
        cwd: new URL("../../../", import.meta.url),
        env: {
          ...process.env,
          RUNNER_TEMP: directory,
          PRODUCTION_DATABASE_DIRECT_URL: direct + "&uselibpqcompat=1",
          BACKUP_ENCRYPTED_SHA256: "a".repeat(64),
          BACKUP_DUMP_SHA256: "b".repeat(64),
          BACKUP_DAY: "2026-10-11",
          GITHUB_RUN_ID: "38124206168",
          GITHUB_SHA: "c".repeat(40),
          R2_S3_ENDPOINT: "https://fixture.invalid",
          R2_BACKUP_BUCKET: "fixture-only",
          BACKUP_ETAG: "fixture-version",
        },
        encoding: "utf8",
      }
    )
    assert.equal(result.status, 0, result.stderr)
    const bytes = readFileSync(join(directory, "webhook-empty-state-restore-proof.json"), "utf8")
    assert.equal(
      JSON.parse(bytes).databaseIdentitySha256,
      normalizeBackupConnection(direct).identitySha256
    )
    for (const value of [
      "fixture-only",
      "localprojectfixture1",
      "postgresql:",
      "uselibpqcompat",
      "fixture.invalid",
    ])
      assert.equal(bytes.includes(value), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
