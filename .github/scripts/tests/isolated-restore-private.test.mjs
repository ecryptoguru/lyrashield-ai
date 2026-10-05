import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  symlinkSync,
  realpathSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

const helper = fileURLToPath(new URL("../isolated-restore-private.sh", import.meta.url))
const repository = fileURLToPath(new URL("../../../", import.meta.url))
const workflow = readFileSync(
  new URL("../../workflows/production-backup.yml", import.meta.url),
  "utf8"
)
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1, `Missing step ${name}`)
  const end = workflow.indexOf("\n      - name:", start + 1)
  return workflow.slice(start, end < 0 ? undefined : end)
}
function runBlock(name) {
  const block = step(name).split("        run: |\n")[1]
  assert.ok(block, `Missing shell block ${name}`)
  return block
    .split("\n")
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n")
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lyra-private-restore-test-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const base = join(root, "runner"),
    bin = join(root, "bin"),
    calls = join(root, "calls")
  mkdirSync(base)
  mkdirSync(bin)
  writeFileSync(calls, "")
  // The helper uses GNU stat on Linux. This local metadata-only mock provides
  // the same two fields on macOS without weakening the helper's checks.
  writeFileSync(
    join(bin, "stat"),
    `#!${process.execPath}\nconst fs=require('node:fs');const s=process.argv[4].startsWith('/proc/')?{uid:Number(process.env.MOCK_PROC_UID??process.getuid()),mode:448}:fs.statSync(process.argv[4]);console.log(process.argv[3]==='%u'?s.uid:(s.mode&511).toString(8));\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/bash\nprintf "docker %s\\n" "$*" >> "$MOCK_CALLS"\necho PRIVATE_DOCKER_ERROR >&2\nexit 1\n',
    { mode: 0o755 }
  )
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: base,
    GITHUB_ENV: join(root, "github-env"),
    MOCK_CALLS: calls,
    GITHUB_RUN_ID: "4321",
  }
  const run = (script, extra = {}) =>
    spawnSync("bash", ["-c", script], {
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 5000,
      cwd: repository,
    })
  const prepare = run(`bash ${quote(helper)} prepare`)
  assert.equal(prepare.status, 0, prepare.stderr)
  const directory = readFileSync(env.GITHUB_ENV, "utf8").trim().split("=")[1]
  assert.equal(directory.startsWith(base + "/lyrashield-isolated."), true)
  return { root, base, bin, directory, calls, run }
}

function restoreMocks(f) {
  const executable = (name, body) =>
    writeFileSync(join(f.bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
  executable(
    "sha256sum",
    `const fs=require('node:fs'),crypto=require('node:crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);`
  )
  executable(
    "aws",
    `const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({command:'aws',args})+'\\n');const value=k=>args[args.indexOf(k)+1];if(args[0]!=='s3api'||args[1]!=='get-object'||value('--if-match')!=='"abc123"'||process.env.MOCK_FETCH_FAIL==='true'){console.error('PRIVATE_FETCH_CREDENTIAL_ERROR');process.exit(42)}fs.writeFileSync(args.at(-1),process.env.MOCK_CIPHER);`
  )
  executable(
    "gpg",
    `const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({command:'gpg',args})+'\\n');fs.readFileSync(0);if(process.env.MOCK_DECRYPT_FAIL==='true'){console.error('PRIVATE_DECRYPT_ROW_CONTEXT');process.exit(43)}fs.writeFileSync(args[args.indexOf('--output')+1],process.env.MOCK_PLAIN);console.error('PRIVATE_DECRYPT_DIAGNOSTIC');`
  )
  executable(
    "docker",
    `const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({command:'docker',args})+'\\n');if(args.includes('--list'))console.log('1; 2615 2200 SCHEMA - app restore');if(args.includes('pg_restore')&&!args.includes('--list')&&process.env.MOCK_RESTORE_FAIL==='true'){console.error('PRIVATE_RESTORE_PERSONAL_ROW');process.exit(44)}`
  )
}
const fixtureDigest = (value) => createHash("sha256").update(value).digest("hex")
for (const scenario of [
  "valid",
  "ciphertext tamper",
  "plaintext tamper",
  "ETag tamper",
  "fetch failure",
  "decrypt failure",
  "restore failure",
]) {
  test(`actual exact-object restore block: ${scenario}`, (t) => {
    const f = fixture(t)
    restoreMocks(f)
    const env = {
      ISOLATED_RESTORE: "true",
      ISOLATED_RESTORE_TEMP: f.directory,
      BACKUP_DAY: "2026-10-05",
      BACKUP_ENCRYPTED_SHA256: fixtureDigest("SYNTHETIC_CIPHERTEXT"),
      BACKUP_DUMP_SHA256: fixtureDigest("SYNTHETIC_PRIVATE_DUMP"),
      BACKUP_ETAG: '"abc123"',
      BACKUP_ENCRYPTION_PASSPHRASE: "SYNTHETIC_NOT_A_SECRET",
      R2_BACKUP_BUCKET: "synthetic-backup",
      R2_S3_ENDPOINT: "https://synthetic.invalid",
      MOCK_CIPHER: "SYNTHETIC_CIPHERTEXT",
      MOCK_PLAIN: "SYNTHETIC_PRIVATE_DUMP",
    }
    if (scenario === "ciphertext tamper") env.MOCK_CIPHER = "ALTERED_CIPHERTEXT"
    if (scenario === "plaintext tamper") env.MOCK_PLAIN = "ALTERED_PRIVATE_DUMP"
    if (scenario === "ETag tamper") env.BACKUP_ETAG = '"def456"'
    if (scenario === "fetch failure") env.MOCK_FETCH_FAIL = "true"
    if (scenario === "decrypt failure") env.MOCK_DECRYPT_FAIL = "true"
    if (scenario === "restore failure") env.MOCK_RESTORE_FAIL = "true"
    const result = f.run(
      runBlock("Restore the exact produced encrypted backup into PostgreSQL 17"),
      env
    )
    assert.equal(result.status === 0, scenario === "valid", result.stderr)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const fetch = calls.find((call) => call.command === "aws")
    assert.ok(fetch)
    assert.equal(
      fetch.args[fetch.args.indexOf("--key") + 1],
      "daily/lyrashield-2026-10-05-4321.dump.gpg"
    )
    assert.equal(fetch.args[fetch.args.indexOf("--if-match") + 1], env.BACKUP_ETAG)
    const launch = calls.find(
      (call) => call.command === "docker" && call.args[0] === "run" && call.args.includes("-d")
    )
    assert.equal(Boolean(launch), ["valid", "restore failure"].includes(scenario))
    if (launch) assert.equal(launch.args[launch.args.indexOf("-p") + 1], "127.0.0.1:5433:5432")
    const restore = calls.find(
      (call) =>
        call.command === "docker" &&
        call.args.includes("pg_restore") &&
        !call.args.includes("--list")
    )
    assert.equal(Boolean(restore), ["valid", "restore failure"].includes(scenario))
    if (["ETag tamper", "fetch failure", "ciphertext tamper"].includes(scenario))
      assert.equal(
        calls.some((call) => call.command === "gpg"),
        false
      )
    const log = readFileSync(join(f.directory, "private-operation.log"), "utf8")
    if (["ETag tamper", "fetch failure"].includes(scenario))
      assert.match(log, /PRIVATE_FETCH_CREDENTIAL_ERROR/)
    if (scenario === "decrypt failure") assert.match(log, /PRIVATE_DECRYPT_ROW_CONTEXT/)
    if (scenario === "restore failure") assert.match(log, /PRIVATE_RESTORE_PERSONAL_ROW/)
    const cleanup = f.run(`bash ${quote(helper)} cleanup`, { ISOLATED_RESTORE_TEMP: f.directory })
    assert.equal(cleanup.status, 0, cleanup.stderr)
    assert.equal(
      existsSync(f.directory),
      false,
      "partial ciphertext/plaintext and private errors must be removed"
    )
  })
}

for (const exitCode of [0, 7]) {
  test(`actual helper keeps success/failure output private (exit ${exitCode})`, (t) => {
    const f = fixture(t)
    const result = f.run(
      `source ${quote(helper)}\nprintf '%s\\n' PRIVATE_ROW_STDOUT\nprintf '%s\\n' PRIVATE_CREDENTIAL_STDERR >&2\nprintf '%s' "$RUNNER_TEMP" > "$RUNNER_TEMP/observed-temp"\nprintf '%s' "$ISOLATED_RESTORE_BIND" > "$RUNNER_TEMP/observed-bind"\nexit ${exitCode}`,
      { ISOLATED_RESTORE_TEMP: f.directory }
    )
    assert.equal(result.status, exitCode)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.equal(
      readFileSync(join(f.directory, "private-operation.log"), "utf8"),
      "PRIVATE_ROW_STDOUT\nPRIVATE_CREDENTIAL_STDERR\n"
    )
    assert.equal(readFileSync(join(f.directory, "observed-temp"), "utf8"), f.directory)
    assert.equal(readFileSync(join(f.directory, "observed-bind"), "utf8"), "127.0.0.1:")
  })
}

function processMocks(start = "1234567", group = "987654", session = "987654") {
  const fields = Array(20).fill("0")
  fields[0] = "R"
  fields[2] = group
  fields[3] = session
  fields[19] = start
  return `kill() { printf 'kill %s\\n' "$*" >> "$MOCK_CALLS"; }\ncat() { if [ "$1" = /proc/987654/stat ]; then printf '%s\\n' ${quote("987654 (mock worker) " + fields.join(" "))}; else command cat "$@"; fi; }\nexport -f kill cat\n`
}
test("actual cleanup removes private plaintext/logs/proof and targets only mocked process group and containers", (t) => {
  const f = fixture(t)
  for (const name of ["backup.dump", "audit.json", "private-operation.log", "restore-web.log"])
    writeFileSync(join(f.directory, name), "PRIVATE_DATA")
  writeFileSync(join(f.directory, "web.identity"), "987654 1234567\n", { mode: 0o600 })
  writeFileSync(join(f.base, "webhook-empty-state-restore-proof.json"), "DIGEST_PROOF")
  const result = f.run(processMocks() + `bash ${quote(helper)} cleanup`, {
    ISOLATED_RESTORE_TEMP: f.directory,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  assert.equal(existsSync(f.directory), false)
  assert.equal(existsSync(join(f.base, "webhook-empty-state-restore-proof.json")), false)
  assert.equal(
    readFileSync(f.calls, "utf8"),
    "kill -0 -- -987654\nkill -KILL -- -987654\ndocker rm -fv lyrashield-isolated-backup-4321\ndocker rm -fv lyrashield-restore-postgres lyrashield-restore-redis\n"
  )
})

test("record-web binds owner/session/group/start time and stale identity cannot signal a reused group", (t) => {
  const f = fixture(t)
  const record = f.run(processMocks() + `bash ${quote(helper)} record-web 987654`, {
    ISOLATED_RESTORE_TEMP: f.directory,
  })
  assert.equal(record.status, 0, record.stderr)
  assert.equal(readFileSync(join(f.directory, "web.identity"), "utf8"), "987654 1234567\n")
  const stale = f.run(processMocks("9999999") + `bash ${quote(helper)} cleanup`, {
    ISOLATED_RESTORE_TEMP: f.directory,
  })
  assert.notEqual(stale.status, 0)
  assert.doesNotMatch(readFileSync(f.calls, "utf8"), /kill -KILL/)
  assert.equal(existsSync(f.directory), false, "private data is still cleaned on identity mismatch")
})

for (const kind of [
  "foreign uid",
  "foreign session",
  "foreign process group",
  "symlink identity",
  "writable identity",
]) {
  test(`cleanup rejects ${kind} before sending a destructive signal`, (t) => {
    const f = fixture(t),
      record = join(f.directory, "web.identity")
    if (kind === "symlink identity") {
      const other = join(f.directory, "other.identity")
      writeFileSync(other, "987654 1234567\n", { mode: 0o600 })
      symlinkSync(other, record)
    } else
      writeFileSync(record, "987654 1234567\n", {
        mode: kind === "writable identity" ? 0o666 : 0o600,
      })
    const mock =
      kind === "foreign session"
        ? processMocks("1234567", "987654", "123456")
        : kind === "foreign process group"
          ? processMocks("1234567", "123456", "987654")
          : processMocks()
    const result = f.run(mock + `bash ${quote(helper)} cleanup`, {
      ISOLATED_RESTORE_TEMP: f.directory,
      ...(kind === "foreign uid" ? { MOCK_PROC_UID: String(process.getuid() + 1) } : {}),
    })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(readFileSync(f.calls, "utf8"), /kill -KILL/)
    assert.equal(existsSync(f.directory), false)
  })
}

test("cleanup without a prepared directory is a no-op", (t) => {
  const f = fixture(t)
  const result = f.run(`bash ${quote(helper)} cleanup`, { ISOLATED_RESTORE_TEMP: "" })
  assert.equal(result.status, 0)
  assert.equal(readFileSync(f.calls, "utf8"), "")
  assert.equal(existsSync(f.directory), true)
})

for (const kind of ["wrong prefix", "symlink", "world writable", "traversal", "nested child"]) {
  test(`unsafe ${kind} path is rejected before cleanup or log redirection`, (t) => {
    const f = fixture(t)
    let unsafe
    if (kind === "wrong prefix") {
      unsafe = join(f.base, "unrelated")
      mkdirSync(unsafe, { mode: 0o700 })
    }
    if (kind === "symlink") {
      unsafe = join(f.base, "lyrashield-isolated.link")
      symlinkSync(f.directory, unsafe)
    }
    if (kind === "world writable") {
      unsafe = f.directory
      chmodSync(unsafe, 0o777)
    }
    if (kind === "traversal") {
      unsafe = f.directory + "/../victim"
      mkdirSync(resolve(unsafe), { mode: 0o700 })
    }
    if (kind === "nested child") {
      unsafe = join(f.directory, "child")
      mkdirSync(unsafe, { mode: 0o700 })
    }
    const victim = resolve(unsafe),
      marker = join(victim, "keep-private")
    writeFileSync(marker, "KEEP")
    for (const mode of ["source", "cleanup"]) {
      const result = f.run(`bash ${quote(helper)} ${mode}`, { ISOLATED_RESTORE_TEMP: unsafe })
      assert.notEqual(result.status, 0, `${kind} must be rejected in ${mode}`)
      assert.equal(existsSync(marker), true)
      assert.equal(existsSync(join(victim, "private-operation.log")), false)
    }
    assert.equal(readFileSync(f.calls, "utf8"), "")
  })
}

test("opt-in reviewed-source binding runs the actual guard and rejects expanded dispatches", (t) => {
  const f = fixture(t),
    guard = runBlock("Bind isolated restore to the reviewed source"),
    sha = "a".repeat(40)
  const accepted = {
    EXPECTED_SOURCE_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_RUN_ATTEMPT: "1",
    RESTORE_REQUESTED: "true",
  }
  assert.equal(f.run(guard, accepted).status, 0)
  for (const change of [
    { EXPECTED_SOURCE_SHA: "b".repeat(40) },
    { EXPECTED_SOURCE_SHA: "bad" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { RESTORE_REQUESTED: "false" },
  ])
    assert.notEqual(f.run(guard, { ...accepted, ...change }).status, 0)
  assert.match(workflow, /isolated_restore:\n[\s\S]*?default: false/)
  assert.match(step("Retain last N days of backups"), /if: \$\{\{ !inputs\.isolated_restore \}\}/)
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.isolated_restore/)
  assert.match(workflow, /timeout-minutes: \$\{\{ inputs\.isolated_restore && 20 \|\| 360 \}\}/)
  assert.match(workflow, /timeout-minutes: \$\{\{ inputs\.isolated_restore && 25 \|\| 360 \}\}/)
})

test("sensitive phases capture logs before work; exact-object linkage and digest-only artifacts remain", () => {
  for (const name of [
    "Verify production backup configuration",
    "Create, encrypt, and upload backup",
    "Restore the exact produced encrypted backup into PostgreSQL 17",
    "Verify schema and audit chains",
    "Start the application against the restored database",
    "Emit public-safe exact-object restore proof",
  ]) {
    const run = runBlock(name)
    assert.match(run, /source \.github\/scripts\/isolated-restore-private\.sh/)
    const lines = run.split("\n")
    assert.ok(
      lines
        .slice(0, 3)
        .some((line) => line.includes("source .github/scripts/isolated-restore-private.sh")),
      name
    )
  }
  assert.match(workflow, /--if-match "\$BACKUP_ETAG"/)
  assert.match(
    workflow,
    /BACKUP_ENCRYPTED_SHA256: \$\{\{ needs\.backup\.outputs\.encrypted_sha256 \}\}/
  )
  assert.match(workflow, /BACKUP_DUMP_SHA256: \$\{\{ needs\.backup\.outputs\.dump_sha256 \}\}/)
  assert.match(workflow, /-p "\$\{ISOLATED_RESTORE_BIND:-\}5433:5432"/)
  assert.match(workflow, /-p "\$\{ISOLATED_RESTORE_BIND:-\}6379:6379"/)
  assert.match(workflow, /web_command=\(setsid bash -c/)
  assert.match(workflow, /exec pnpm[^\n]*--hostname 127\.0\.0\.1/)
  assert.match(workflow, /isolated-restore-private\.sh record-web "\$\$" \|\| exit 1/)
  for (const name of [
    "Remove private isolated backup files",
    "Remove private isolated restore files and process group",
  ])
    assert.match(step(name), /always\(\) && inputs\.isolated_restore/)
  const artifact = step("Publish digest-only restore provenance")
  assert.match(artifact, /path: \$\{\{ runner\.temp \}\}\/webhook-empty-state-restore-proof\.json/)
  assert.doesNotMatch(artifact, /audit\.json|backup\.dump|private-operation\.log|restore-web\.log/)
})

test("first isolated container removal deletes anonymous restored-data volumes", () => {
  const firstCleanup = step("Clean up isolated restore services")
  assert.match(
    firstCleanup,
    /if \[ "\$ISOLATED_RESTORE" = true \]; then\n[\s\S]*?docker rm -fv lyrashield-restore-postgres lyrashield-restore-redis/
  )
  assert.match(
    firstCleanup,
    /else\n\s+docker rm -f lyrashield-restore-postgres lyrashield-restore-redis/
  )
  assert.ok(
    workflow.indexOf("Clean up isolated restore services") <
      workflow.indexOf("Remove private isolated restore files and process group")
  )
  const cleanupHelper = readFileSync(helper, "utf8")
  assert.match(cleanupHelper, /docker rm -fv "lyrashield-isolated-backup-/)
  assert.match(cleanupHelper, /docker rm -fv lyrashield-restore-postgres lyrashield-restore-redis/)
})
