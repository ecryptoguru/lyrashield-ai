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
          PRODUCTION_DATABASE_DIRECT_URL:
            direct.replace("verify-full", "require") + "&uselibpqcompat=1",
          BACKUP_DATABASE_IDENTITY_SHA256: normalizeBackupConnection(direct).identitySha256,
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
    { PRODUCTION_DATABASE_DIRECT_URL: direct.replace("verify-full", "disable") },
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
    "missing producer identity",
    { BACKUP_DATABASE_IDENTITY_SHA256: "" },
    "backup-digests/validation-or-io-failure",
  ],
  [
    "invalid producer identity",
    { BACKUP_DATABASE_IDENTITY_SHA256: "private-rejected-value" },
    "backup-digests/validation-or-io-failure",
  ],
  [
    "mismatched producer identity",
    { BACKUP_DATABASE_IDENTITY_SHA256: "d".repeat(64) },
    "database-identity/producer-identity-mismatch",
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
              BACKUP_DATABASE_IDENTITY_SHA256: normalizeBackupConnection(direct).identitySha256,
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
        assert.equal(result.stderr.replace(expected, ""), "")
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

test("the backup client upgrades legacy TLS before connecting without changing logical identity", async () => {
  const { prepareVerifiedBackupConnection } =
    await import("../prepare-verified-backup-connection.mjs")
  const expected = normalizeBackupConnection(direct)
  for (const mode of ["require", "verify-full"]) {
    const raw = direct.replace("verify-full", mode) + "&uselibpqcompat=1"
    const prepared = prepareVerifiedBackupConnection(raw)
    assert.equal(prepared.url, expected.url)
    assert.equal(prepared.identitySha256, expected.identitySha256)
    const transport = new URL(prepared.libpqUrl)
    assert.equal(transport.searchParams.get("sslmode"), "verify-full")
    assert.equal(transport.searchParams.get("sslrootcert"), "/tmp/supabase-root-2021-ca.crt")
    assert.equal(transport.searchParams.get("gssencmode"), "disable")
    assert.equal(transport.searchParams.has("schema"), false)
    assert.equal(transport.searchParams.has("uselibpqcompat"), false)
    assert.equal(transport.hostname, new URL(direct).hostname)
    assert.equal(transport.username, new URL(direct).username)
    assert.equal(transport.password, new URL(direct).password)
    assert.equal(transport.pathname, new URL(direct).pathname)
  }
  assert.throws(() => normalizeBackupConnection(direct.replace("verify-full", "require")))
})

test("verified backup preparation preserves the raw parameter, TLS and identity rejection boundary", async () => {
  const { prepareVerifiedBackupConnection } =
    await import("../prepare-verified-backup-connection.mjs")
  for (const raw of [
    null,
    "x".repeat(8193),
    "not-a-url",
    direct.replace("verify-full", "disable"),
    direct.replace("verify-full", "prefer"),
    direct.replace("&sslmode=verify-full", ""),
    direct + "&%73slmode=require",
    direct + "&sslmode=verify-full",
    direct + "&uselibpqcompat=0",
    direct + "&uselibpqcompat=1&%75selibpqcompat=1",
    direct + "&sslrootcert=system",
    direct + "&sslrootcert=/untrusted/path",
    direct + "&gssencmode=require",
    direct + "&host=evil.invalid",
    direct + "&hostaddr=127.0.0.1",
    direct + "&%75ser=attacker",
    direct + "&password=other",
    direct + "&options=-c%20search_path%3Devil",
    direct.replace(":5432/", ":6543/"),
    direct.replace("postgres:fixture-only", "worker_runtime:fixture-only"),
    direct.replace("schema=public", "schema=private"),
    direct.replace("/postgres?", "/other?"),
    direct + "#fragment",
  ])
    assert.throws(() => prepareVerifiedBackupConnection(raw))
})
