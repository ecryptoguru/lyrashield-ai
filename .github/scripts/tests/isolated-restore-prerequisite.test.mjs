/* eslint-disable security/detect-non-literal-fs-filename -- Owner-only synthetic test inputs. */
import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
  realpathSync,
  truncateSync,
  mkdirSync,
  existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  prepareRestoreList,
  assertPrerequisiteTarget,
  runIsolatedRestorePrerequisite,
  MAX_ARCHIVE_BYTES,
  readPrivatePrerequisiteInput,
} from "../isolated-restore-prerequisite.mjs"
import { sha256, RESTORE_AUTHORITY_POSTGRES_IMAGE } from "../restore-authority-contract.mjs"

const toc = `; Archive created at 2026-11-11
;     Dumped from database version: 17.11
;     Dumped by pg_dump version: 17.11
1; 2615 2200 SCHEMA - public restore
2; 2615 9999 SCHEMA - app restore
3; 1259 10000 TABLE public Policy restore
4; 0 10000 TABLE DATA public Policy restore
5; 0 0 COMMENT - SCHEMA public restore
`
const id = "a".repeat(64)
function inventory(token) {
  return {
    Id: id,
    Image: RESTORE_AUTHORITY_POSTGRES_IMAGE,
    Name: `/lyrashield-restore-prerequisite-${token}`,
    State: { Running: true },
    Config: { Labels: { "lyrashield.restore-prerequisite": token } },
    Mounts: [],
    HostConfig: {
      NetworkMode: "none",
      Privileged: false,
      Memory: 768 * 1024 * 1024,
      PidsLimit: 128,
      NanoCpus: 2_000_000_000,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: {
        "/var/lib/postgresql/data": "rw,noexec,nosuid,size=512m",
        "/tmp": "rw,noexec,nosuid,size=96m",
        "/var/run/postgresql": "rw,noexec,nosuid,size=8m",
      },
    },
  }
}
function fixture(t, behavior = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lyra-prerequisite-unit-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const archivePath = join(root, "backup.dump"),
    bytes = Buffer.from("PGDMPsynthetic-unit-bytes")
  writeFileSync(archivePath, bytes, { mode: 0o600 })
  const config = {
    schema: "lyrashield-isolated-restore-prerequisite/1",
    archivePath,
    expectedSha256: sha256(bytes),
    sourceRevision: "b".repeat(40),
  }
  const calls = []
  let token,
    diagnosticRead = false
  const execute = (command, args, options) => {
    calls.push({ command, args, options })
    let output = "",
      status = 0
    if (args[0] === "context" && args[1] === "show") output = "default"
    if (args[0] === "context" && args[1] === "inspect")
      output = JSON.stringify([
        { Endpoints: { docker: { Host: behavior.endpoint ?? "unix:///test" } } },
      ])
    if (args[0] === "image") output = behavior.image ?? RESTORE_AUTHORITY_POSTGRES_IMAGE
    if (args[0] === "run") {
      token = args[args.indexOf("--label") + 1].split("=")[1]
      output = id
    }
    if (args[0] === "inspect") {
      const value = inventory(token)
      if (behavior.badIdentity || (behavior.lateSubstitution && diagnosticRead))
        value.Config.Labels = {}
      output = JSON.stringify([value])
    }
    if (args.includes("--list")) output = behavior.toc ?? toc
    if (args[0] === "rm" && behavior.cleanupFailure) status = 1
    if (args.includes("pg_restore") && !args.includes("--list")) {
      if (behavior.restoreFailure) status = 1
    }
    if (args.includes("psql")) {
      const source = options.input
      if (source.includes("BEGIN ISOLATION LEVEL")) {
        if (source.includes("SELECT current_setting('server_version_num')")) output = "170011"
        else if (source.includes("'migration',")) {
          diagnosticRead = true
          output = JSON.stringify({
            migration: true,
            tables: true,
            triggers: true,
            helpers: true,
            extension: true,
            systemDefiners: true,
            privilegedFunctions: true,
            closed: true,
            roles: !behavior.badGrants,
          })
        } else if (source.includes("pg_auth_members") && behavior.badProfile) output = "f"
        else if (source.includes("p.prosrc='pg_digest'") && behavior.badExtension) output = "f"
        else if (source.includes("c.relowner") && behavior.badOwner) output = "f"
        else output = "t"
      }
    }
    return { status, stdout: Buffer.from(output), stderr: Buffer.from("PRIVATE_SENTINEL") }
  }
  const options = {
    execute,
    env: {
      LYRASHIELD_RESTORE_PREREQUISITE_DISPOSABLE: "1",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      UNRELATED_INPUT: "PRIVATE_SENTINEL",
    },
  }
  return { root, config, calls, options }
}

test("TOC filtering preserves all content except the one public schema create", () => {
  assert.equal(prepareRestoreList(toc), toc.replace("1; 2615", ";1; 2615"))
})
for (const [name, change] of [
  ["legacy public-only", (value) => value.replace(/^2;.*\n/m, "")],
  ["other PostgreSQL major", (value) => value.replaceAll("17.11", "18.1")],
  ["duplicate public schema", (value) => value + "6; 2615 10001 SCHEMA - public restore\n"],
  ["duplicate entry ID", (value) => value + "1; 1259 10001 TABLE public Other restore\n"],
  ["ACL", (value) => value + "6; 0 0 ACL public TABLE Policy restore\n"],
  ["default ACL", (value) => value + "6; 0 0 DEFAULT ACL public DEFAULT PRIVILEGES restore\n"],
  ["extension", (value) => value + "6; 3079 10001 EXTENSION - pgcrypto restore\n"],
  [
    "other namespace",
    (value) => value + "6; 1259 10001 TABLE lyrashield_authority record restore\n",
  ],
  [
    "digest overload",
    (value) => value + "6; 1255 10001 FUNCTION public digest(bytea, text, integer) restore\n",
  ],
  ["view", (value) => value + "6; 1259 10001 VIEW public Policy restore\n"],
])
  test(`rejects unsupported TOC: ${name}`, () =>
    assert.throws(() => prepareRestoreList(change(toc))))

test("archive binding and private directory checks precede every Docker operation", async (t) => {
  const f = fixture(t)
  for (const config of [
    { ...f.config, expectedSha256: "0".repeat(64) },
    { ...f.config, serviceUrl: "PRIVATE_SENTINEL" },
    { ...f.config, sourceRevision: "invalid" },
  ])
    await assert.rejects(runIsolatedRestorePrerequisite(config, f.options))
  chmodSync(f.root, 0o755)
  await assert.rejects(runIsolatedRestorePrerequisite(f.config, f.options))
  chmodSync(f.root, 0o700)
  const link = join(f.root, "link.dump")
  symlinkSync(f.config.archivePath, link)
  await assert.rejects(
    runIsolatedRestorePrerequisite({ ...f.config, archivePath: link }, f.options)
  )
  chmodSync(f.config.archivePath, 0o644)
  await assert.rejects(runIsolatedRestorePrerequisite(f.config, f.options))
  assert.equal(f.calls.length, 0)
})

test("oversize archives and Docker overrides fail before parsing or container creation", async (t) => {
  const f = fixture(t)
  truncateSync(f.config.archivePath, MAX_ARCHIVE_BYTES + 1)
  await assert.rejects(runIsolatedRestorePrerequisite(f.config, f.options))
  await assert.rejects(
    runIsolatedRestorePrerequisite(f.config, {
      ...f.options,
      env: { ...f.options.env, DOCKER_HOST: "unix:///different" },
    })
  )
  assert.equal(f.calls.length, 0)
})
test("synthetic restore uses no inherited credentials, mounts, ports, cleanup names or superuser restore session", async (t) => {
  const f = fixture(t),
    result = await runIsolatedRestorePrerequisite(f.config, f.options)
  assert.equal(result.schema, "lyrashield-isolated-restore-prerequisite-result/1")
  assert.equal(result.authorityDiagnostic.dispatch, "UNQUALIFIED")
  assert.equal(result.productionApplicable, false)
  assert.equal(result.sourceAclRestored, false)
  assert.equal(result.admissionAllowed, false)
  assert.equal(result.managedFailoverQualified, false)
  const run = f.calls.find((call) => call.args[0] === "run")
  assert.equal(run.args[run.args.indexOf("--network") + 1], "none")
  assert.ok(!run.args.some((arg) => ["--volume", "-v", "--mount", "-p", "--publish"].includes(arg)))
  const restore = f.calls.find(
    (call) => call.args.includes("pg_restore") && call.args.includes("--exit-on-error")
  )
  assert.equal(restore.args[restore.args.indexOf("-U") + 1], "isolated_restore_writer")
  assert.ok(!restore.args.includes("--clean") && !restore.args.includes("--role"))
  assert.ok(restore.options.env.PGPASSWORD)
  assert.ok(!restore.args.includes(restore.options.env.PGPASSWORD))
  assert.ok(f.calls.every((call) => !JSON.stringify(call.options.env).includes("PRIVATE_SENTINEL")))
  assert.ok(
    f.calls.every(
      (call) => call.options.timeout === 120_000 && call.options.maxBuffer <= 2 * 1024 * 1024
    )
  )
  const reads = f.calls.filter(
    (call) => call.args.includes("psql") && call.options.input.includes("READ ONLY")
  )
  assert.ok(reads.length >= 5)
  assert.ok(
    reads.every(
      (call) =>
        call.options.input.includes("statement_timeout='10s'") &&
        call.options.input.endsWith("ROLLBACK;")
    )
  )
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-fv", id])
  assert.equal(f.calls.at(-2).args[0], "inspect")
})
for (const behavior of [
  { restoreFailure: true },
  { badGrants: true },
  { badProfile: true },
  { badExtension: true },
  { badOwner: true },
  { toc: toc + "INVALID\n" },
])
  test(`failed restore/precondition cleans only the exact owned target: ${JSON.stringify(behavior)}`, async (t) => {
    const f = fixture(t, behavior)
    await assert.rejects(runIsolatedRestorePrerequisite(f.config, f.options))
    assert.deepEqual(f.calls.at(-1).args, ["rm", "-fv", id])
  })
test("substituted ownership refuses cleanup and withholds success", async (t) => {
  const f = fixture(t, { badIdentity: true })
  await assert.rejects(runIsolatedRestorePrerequisite(f.config, f.options))
  assert.ok(!f.calls.some((call) => call.args[0] === "rm"))
})
test("substitution after successful observations refuses removal and withholds the result", async (t) => {
  const f = fixture(t, { lateSubstitution: true })
  await assert.rejects(runIsolatedRestorePrerequisite(f.config, f.options))
  assert.ok(
    f.calls.some(
      (call) => call.args.includes("psql") && call.options.input.includes("'migration',")
    )
  )
  assert.ok(!f.calls.some((call) => call.args[0] === "rm"))
})
test("failed owned cleanup withholds otherwise successful observations", async (t) => {
  const f = fixture(t, { cleanupFailure: true })
  await assert.rejects(runIsolatedRestorePrerequisite(f.config, f.options))
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-fv", id])
})
for (const behavior of [{ endpoint: "tcp://remote.example:2375" }, { image: "unreviewed" }])
  test("remote context and unexpected images fail before container creation", async (t) => {
    const f = fixture(t, behavior)
    await assert.rejects(runIsolatedRestorePrerequisite(f.config, f.options))
    assert.ok(!f.calls.some((call) => call.args[0] === "run"))
  })
test("exact identity validation rejects host access, mounts and resource-limit changes", () => {
  const token = "b".repeat(36),
    value = inventory(token)
  assertPrerequisiteTarget(value, id, token)
  for (const patch of [
    { NetworkMode: "bridge" },
    { Privileged: true },
    { Binds: ["/tmp:/tmp"] },
    { PortBindings: { "5432/tcp": [{}] } },
    { Memory: 0 },
    { PidsLimit: 0 },
    { NanoCpus: 0 },
    { SecurityOpt: [] },
    { ReadonlyRootfs: false },
    { CapAdd: ["SYS_ADMIN"] },
    { PidMode: "host" },
  ])
    assert.throws(() =>
      assertPrerequisiteTarget(
        { ...value, HostConfig: { ...value.HostConfig, ...patch } },
        id,
        token
      )
    )
  assert.throws(() => assertPrerequisiteTarget({ ...value, Mounts: [{}] }, id, token))
})
test("CLI failure emits only its fixed public diagnostic", (t) => {
  const f = fixture(t),
    config = join(f.root, "config.json")
  writeFileSync(config, JSON.stringify({ invalidField: "PRIVATE_SENTINEL" }), { mode: 0o600 })
  const result = spawnSync(
    process.execPath,
    [new URL("../isolated-restore-prerequisite.mjs", import.meta.url).pathname, "--config", config],
    { env: { PATH: process.env.PATH }, encoding: "utf8" }
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "restore/prerequisite/failed; authority and production remain unqualified\n"
  )
})

function privateConfigFixture(t) {
  const f = fixture(t),
    directory = join(f.root, "config"),
    bin = join(f.root, "bin")
  mkdirSync(directory, { mode: 0o700 })
  mkdirSync(bin, { mode: 0o700 })
  const path = join(directory, "input.json"),
    marker = join(f.root, "docker-called")
  writeFileSync(path, JSON.stringify(f.config), { mode: 0o600 })
  // A fake Docker executable proves rejection happens at the CLI input boundary.
  // The authenticated archive remains in its separate valid private parent.
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(1);\n`,
    { mode: 0o700 }
  )
  const invoke = (input) =>
    spawnSync(
      process.execPath,
      [
        new URL("../isolated-restore-prerequisite.mjs", import.meta.url).pathname,
        "--config",
        input,
      ],
      {
        cwd: f.root,
        env: { PATH: bin, HOME: process.env.HOME, LYRASHIELD_RESTORE_PREREQUISITE_DISPOSABLE: "1" },
        encoding: "utf8",
        timeout: 5000,
      }
    )
  return { ...f, directory, path, marker, invoke }
}
test("absolute private config reaches only the fake Docker control", (t) => {
  const f = privateConfigFixture(t)
  assert.deepEqual(JSON.parse(readPrivatePrerequisiteInput(f.path, 4096)), f.config)
  assert.equal(f.invoke(f.path).status, 1)
  assert.equal(existsSync(f.marker), true)
})
for (const scenario of [
  "relative",
  "noncanonical",
  "parent symlink",
  "ancestor symlink",
  "file symlink",
  "parent group readable",
  "parent world readable",
  "parent group writable",
  "config group readable",
]) {
  test(`CLI rejects config path before Docker: ${scenario}`, (t) => {
    const f = privateConfigFixture(t)
    let input = f.path
    if (scenario === "relative") input = "config/input.json"
    if (scenario === "noncanonical") input = `${f.directory}/../config/input.json`
    if (scenario === "parent symlink") {
      const link = join(f.root, "config-link")
      symlinkSync(f.directory, link)
      input = join(link, "input.json")
    }
    if (scenario === "ancestor symlink") {
      const link = `${f.root}-link`
      symlinkSync(f.root, link)
      t.after(() => rmSync(link))
      input = join(link, "config", "input.json")
    }
    if (scenario === "file symlink") {
      input = join(f.directory, "linked.json")
      symlinkSync(f.path, input)
    }
    if (scenario === "parent group readable") chmodSync(f.directory, 0o750)
    if (scenario === "parent world readable") chmodSync(f.directory, 0o755)
    if (scenario === "parent group writable") chmodSync(f.directory, 0o770)
    if (scenario === "config group readable") chmodSync(f.path, 0o640)
    assert.throws(() => readPrivatePrerequisiteInput(input, 4096), {
      code: "PRIVATE_INPUT_REJECTED",
    })
    const result = f.invoke(input)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.equal(
      result.stderr,
      "restore/prerequisite/failed; authority and production remain unqualified\n"
    )
    assert.equal(existsSync(f.marker), false)
  })
}
