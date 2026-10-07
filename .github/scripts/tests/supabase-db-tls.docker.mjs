#!/usr/bin/env node
// Real PostgreSQL TLS and installed Prisma/pg regression. No production access.
// Candidate CI: WORKER_IMAGE=registry/worker@sha256:... node this-file
// Local development only: add --overlay-source with an already-cached image.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const overlay = process.argv.includes("--overlay-source")
const workerImage = process.env.WORKER_IMAGE
assert(workerImage, "WORKER_IMAGE is required; images must already be present locally")
if (!overlay)
  assert(/@sha256:[a-f0-9]{64}$/.test(workerImage), "Candidate image must be digest pinned")
const postgresImage = process.env.POSTGRES_IMAGE || "postgres:16"
const prefix = `lyrashield-db-tls-${randomBytes(6).toString("hex")}`
const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
const fixtures = path.join(directory, "public")
fs.mkdirSync(fixtures, { mode: 0o755 })
const host = "aws-0.fixture.pooler.supabase.com"
const wrongHost = "aws-1.fixture.pooler.supabase.com"
const password = randomBytes(24).toString("hex")
const runtimeUser = "fixture_runtime.abcdefghijklmnopqrst"
let stage = "initialization"
let networkCreated = false
const containers = new Set()

function run(command, args, timeout = 60_000) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  }).trim()
}
function write(name, value, mode = 0o600) {
  fs.writeFileSync(path.join(directory, name), value, { mode })
}
function openssl(args) {
  return run("openssl", args)
}
function cleanup() {
  for (const name of containers) {
    try {
      run("docker", ["rm", "-f", "-v", name])
    } catch {
      /* only owned containers */
    }
  }
  if (networkCreated) {
    try {
      run("docker", ["network", "rm", prefix])
    } catch {
      /* only owned network */
    }
  }
  fs.rmSync(directory, { recursive: true, force: true })
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cleanup()
    process.exit(1)
  })

// This script runs with the worker's installed tsx, pg, Prisma adapter and logger.
// Only fixture CA/data and this test driver are mounted in exact-candidate mode.
const driver = String.raw`
import assert from "node:assert/strict"
import fs from "node:fs"
import { createHash } from "node:crypto"
import tls from "node:tls"
const packageRoot = fs.realpathSync("/app/apps/worker/node_modules/@lyrashield/db")
const { createBoundedPgAdapter } = await import(packageRoot + "/src/pool.ts")
const hash = value => createHash("sha256").update(value).digest("hex")
const certificateCodes = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"])
const settings = JSON.parse(fs.readFileSync("/fixtures/settings.json", "utf8"))
const modes = ["sslmode=require&uselibpqcompat=true", "sslmode=require&uselibpqcompat=1", "sslmode=verify-full"]
let passed = 0
for (const mode of modes) {
  for (const user of [settings.runtimeUser, "postgres"]) {
    const target = process.env.TEST_CASE === "wrong-host" ? settings.wrongHost : settings.host
    const raw = "postgresql://" + encodeURIComponent(user) + ":" + settings.password + "@" + target + ":5432/postgres?" + mode
    const envKey = user === "postgres" ? "DATABASE_SYSTEM_URL" : "DATABASE_URL"
    process.env[envKey] = raw
    const before = hash(process.env[envKey])
    const factory = createBoundedPgAdapter(raw, user === "postgres" ? "db:system" : "db")
    const adapter = await factory.connect()
    const pool = adapter.underlyingDriver()
    assert.equal(pool.options.connectionString, undefined)
    assert.equal(pool.options.ssl.rejectUnauthorized, true)
    assert.equal(pool.options.host, target)
    assert.equal(pool.options.port, 5432)
    assert.equal(pool.options.user, user)
    assert.equal(pool.options.database, "postgres")
    try {
      const client = await pool.connect()
      try {
        assert.equal(client.connection.stream.authorized, true)
        assert.equal(tls.checkServerIdentity(target, client.connection.stream.getPeerCertificate()), undefined)
      } finally { client.release() }
      const result = await adapter.queryRaw({ sql: "SELECT current_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_catalog.pg_roles WHERE rolname=current_user", args: [], argTypes: [] })
      assert.equal(result.rows[0][0], user)
      if (user === settings.runtimeUser) assert.deepEqual(result.rows[0].slice(1), [false, false, false, false])
      else assert.equal(result.rows[0][1], true)
      assert.equal(process.env.TEST_CASE, "positive", "Untrusted certificate unexpectedly accepted")
    } catch (error) {
      if (process.env.TEST_CASE === "positive") throw error
      assert(certificateCodes.has(error.code), "Negative must fail with a certificate validation code")
      if (process.env.TEST_CASE === "wrong-host") assert.equal(error.code, "ERR_TLS_CERT_ALTNAME_INVALID")
    } finally { await adapter.dispose() }
    assert.equal(process.env[envKey], raw)
    assert.equal(hash(process.env[envKey]), before)
    passed++
  }
}
if (process.env.TEST_CASE === "positive") {
  const base = "postgresql://" + encodeURIComponent(settings.runtimeUser) + ":" + settings.password + "@" + settings.host + ":5432/postgres?sslmode=require&uselibpqcompat=true"
  for (const suffix of ["&host=evil.invalid", "&user=postgres", "&password=other", "&sslrootcert=/fixture-must-not-be-read", "&sslmode=disable", "&ssl=false", "&options=-c%20search_path%3Devil", "&uselibpqcompat=unexpected"]) {
    assert.throws(() => createBoundedPgAdapter(base + suffix), /^Error: Invalid Supabase database connection configuration$/)
    passed++
  }
}
console.log(JSON.stringify({ suite: "supabase-db-tls", case: process.env.TEST_CASE, passed }))
`

try {
  stage = "inspect cached images"
  run("docker", ["image", "inspect", workerImage])
  run("docker", ["image", "inspect", postgresImage])
  stage = "generate disposable certificates"
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(directory, "ca.key"),
    "-out",
    path.join(fixtures, "ca.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=LyraShield disposable test CA",
  ])
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(directory, "server.key"),
    "-out",
    path.join(directory, "server.csr"),
    "-subj",
    `/CN=${host}`,
  ])
  write("extensions", `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\n`)
  openssl([
    "x509",
    "-req",
    "-in",
    path.join(directory, "server.csr"),
    "-CA",
    path.join(fixtures, "ca.crt"),
    "-CAkey",
    path.join(directory, "ca.key"),
    "-CAcreateserial",
    "-out",
    path.join(directory, "server.crt"),
    "-days",
    "1",
    "-extfile",
    path.join(directory, "extensions"),
  ])
  write("postgres.env", `POSTGRES_PASSWORD=${password}\n`)
  write(
    "init.sql",
    `CREATE ROLE "${runtimeUser}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;\n`,
    0o644
  )
  write("public/settings.json", JSON.stringify({ host, wrongHost, password, runtimeUser }), 0o644)
  write("public/test.mts", driver, 0o644)
  stage = "start isolated PostgreSQL"
  run("docker", ["network", "create", "--internal", prefix])
  networkCreated = true
  const postgres = `${prefix}-postgres`
  containers.add(postgres)
  run("docker", [
    "run",
    "--pull=never",
    "--detach",
    "--name",
    postgres,
    "--network",
    prefix,
    "--network-alias",
    host,
    "--network-alias",
    wrongHost,
    "--env-file",
    path.join(directory, "postgres.env"),
    "--mount",
    `type=bind,src=${directory},dst=/fixture,readonly`,
    "--entrypoint",
    "sh",
    postgresImage,
    "-ec",
    "cp /fixture/server.crt /tmp/server.crt; cp /fixture/server.key /tmp/server.key; chown postgres:postgres /tmp/server.*; chmod 600 /tmp/server.key; cp /fixture/init.sql /docker-entrypoint-initdb.d/tls-fixture.sql; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key",
  ])
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      run("docker", ["exec", postgres, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"], 5000)
      ready = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  assert(ready, "Disposable PostgreSQL did not become ready")
  const mounts = []
  if (overlay) {
    const packageRoot = run("docker", [
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--entrypoint",
      "node",
      workerImage,
      "-e",
      "process.stdout.write(require('fs').realpathSync('/app/apps/worker/node_modules/@lyrashield/db'))",
    ])
    assert(packageRoot.startsWith("/app/") && !packageRoot.includes("\n"))
    for (const name of ["pool.ts", "connection-config.ts"])
      mounts.push(
        "--mount",
        `type=bind,src=${path.join(root, "packages/db/src", name)},dst=${packageRoot}/src/${name},readonly`
      )
  }
  const results = []
  for (const testCase of ["positive", "wrong-ca", "wrong-host"]) {
    stage = `real adapter ${testCase}`
    const name = `${prefix}-${testCase}`
    containers.add(name)
    const output = run(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        name,
        "--network",
        prefix,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=32m",
        "--env",
        `TEST_CASE=${testCase}`,
        ...(testCase === "wrong-ca" ? [] : ["--env", "NODE_EXTRA_CA_CERTS=/fixtures/ca.crt"]),
        "--mount",
        `type=bind,src=${fixtures},dst=/fixtures,readonly`,
        ...mounts,
        "--entrypoint",
        "/app/apps/worker/node_modules/.bin/tsx",
        workerImage,
        "/fixtures/test.mts",
      ],
      90_000
    )
    containers.delete(name)
    const result = JSON.parse(
      output.split("\n").findLast((line) => line.startsWith('{"suite":"supabase-db-tls"'))
    )
    results.push(result)
    console.log(JSON.stringify(result))
  }
  assert.deepEqual(
    results.map((result) => result.passed),
    [14, 6, 6]
  )
  console.log(
    JSON.stringify({
      suite: "supabase-db-tls",
      status: "PASS",
      total: 26,
      mode: overlay ? "local-source-overlay" : "exact-candidate",
      workerImage,
    })
  )
} catch (error) {
  // Never print Docker output, which could contain connection details on failure.
  console.error(`Supabase database TLS regression failed during: ${stage}`)
  if (error instanceof assert.AssertionError) console.error(error.message)
  process.exitCode = 1
} finally {
  cleanup()
}
