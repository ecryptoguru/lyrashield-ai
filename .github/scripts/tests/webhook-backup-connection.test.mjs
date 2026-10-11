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

for (const [name, change, diagnostic] of [
  [
    "TLS downgrade",
    { PRODUCTION_DATABASE_DIRECT_URL: direct.replace("verify-full", "require") },
    "database-identity/tls-verification-required",
  ],
  [
    "unsafe parameter",
    { PRODUCTION_DATABASE_DIRECT_URL: direct + "&host=private-rejected-value" },
    "database-identity/unsafe-parameter",
  ],
  [
    "ambiguous flag",
    { PRODUCTION_DATABASE_DIRECT_URL: direct + "&uselibpqcompat=private-rejected-value" },
    "database-identity/unsupported-compatibility",
  ],
  [
    "invalid digest",
    { BACKUP_DUMP_SHA256: "private-rejected-value" },
    "backup-digests/validation-or-io-failure",
  ],
  [
    "invalid provenance",
    { GITHUB_SHA: "private-rejected-value" },
    "backup-provenance/validation-or-io-failure",
  ],
  ["missing evidence", { missingEvidence: true }, "restore-evidence/validation-or-io-failure"],
  ["existing proof", { existingProof: true }, "proof-write/validation-or-io-failure"],
]) {
  test(`public proof diagnostic reports ${name} without private material or exception details`, () => {
    const directory = mkdtempSync(join(tmpdir(), "private-rejected-value-"))
    try {
      if (!change.missingEvidence)
        for (const file of ["restore-schema.json", "audit.json", "restore-ready.json"])
          writeFileSync(join(directory, file), '{"private-rejected-value":true}')
      const proofPath = join(directory, "webhook-empty-state-restore-proof.json")
      if (change.existingProof) writeFileSync(proofPath, "existing-proof")
      for (const diagnosticFd of ["3", "2", "untrusted"]) {
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
              GITHUB_RUN_ID: "38153994300",
              GITHUB_SHA: "c".repeat(40),
              R2_S3_ENDPOINT: "https://private-rejected-value.invalid",
              R2_BACKUP_BUCKET: "private-rejected-value",
              BACKUP_ETAG: "private-rejected-value",
              ...change,
              RESTORE_PROOF_DIAGNOSTIC_FD: diagnosticFd,
            },
            stdio: ["ignore", "pipe", "pipe", "pipe"],
            encoding: "utf8",
          }
        )
        assert.equal(result.status, 1)
        assert.equal(result.stdout, "")
        const expected = `Restore proof failed (${diagnostic}).\n`
        if (diagnosticFd === "3") assert.equal(result.stderr.includes(expected), false)
        else assert.equal(result.stderr.split(expected).length, 2)
        // pg-connection-string schedules this fixed warning after parsing the
        // rejected require mode. It stays on private stderr in the workflow.
        const privateStderr = result.stderr.replace(expected, "").replace(/^\(node:\d+\) /, "")
        const sslWarning = `Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.

To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=require'

See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.
(Use \`node --trace-warnings ...\` to show where the warning was created)
`
        assert.equal(privateStderr, name === "TLS downgrade" ? sslWarning : "")
        assert.equal(result.output[3], diagnosticFd === "3" ? expected : "")
        const output = result.output.join("")
        for (const privateValue of [
          "private-rejected-value",
          "fixture-only",
          "localprojectfixture1",
          directory,
          "postgresql:",
          " at ",
        ])
          assert.equal(output.includes(privateValue), false)
        if (change.existingProof) assert.equal(readFileSync(proofPath, "utf8"), "existing-proof")
        else assert.throws(() => readFileSync(proofPath), /ENOENT/)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
