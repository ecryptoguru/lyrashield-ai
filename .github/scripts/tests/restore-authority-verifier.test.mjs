/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed workflow source or owned temporary test files. */
import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  sha256,
  validateRestoreAuthorityConfig,
  dispatchVerificationSql,
  mirrorVerificationSql,
  parseRetainedJournal,
  assertRetainedJournal,
} from "../restore-authority-contract.mjs"
import {
  assertLocalRestoreEnvironment,
  assertOwnedRestoreTarget,
  readPrivateRestoreFile,
  verifyRestoredAuthority,
} from "../verify-restored-authority.mjs"

const target = (database = "lyrashield_restore") => ({
  containerId: "a".repeat(64),
  ownerToken: randomUUID(),
  database,
})
const config = () => ({
  schema: "lyrashield-offline-authority-restore/1",
  dispatch: { target: target(), deniedRoles: ["authority_app_restore"] },
})
const closed = {
  migration: true,
  tables: true,
  triggers: true,
  helpers: true,
  privilegedFunctions: true,
  closed: true,
  roles: true,
}
const mirrorClosed = {
  protected: true,
  functions: true,
  privilegedFunctions: true,
  closed: true,
  roles: true,
}
const retainedStream = {
  epochId: "epoch-2",
  supervisorId: "supervisor-1",
  headBytes: "retained-private-signed-head",
  records: [{ sequence: 1, recordBytes: "retained-private-signed-record" }],
}
const retainedBytes = Buffer.from(
  JSON.stringify({ schema: "lyrashield-restore-retained-journal/1", streams: [retainedStream] })
)
function withMirror() {
  const value = config()
  value.mirror = {
    target: target("lyrashield_authority_restore"),
    runtimeRole: "mirror_restore",
    deniedRoles: ["authority_worker_restore"],
    retainedJournal: { path: "/private/retained.json", sha256: sha256(retainedBytes) },
  }
  return value
}
function inventory(value) {
  return {
    Id: value.containerId,
    Name: `/lyrashield-authority-restore-${value.ownerToken}`,
    Config: { Labels: { "lyrashield.authority-restore": value.ownerToken } },
    State: { Running: true },
    HostConfig: {
      NetworkMode: "none",
      Privileged: false,
      PortBindings: {},
      Tmpfs: { "/var/lib/postgresql/data": "rw,size=512m" },
    },
    Mounts: [],
  }
}

test("standalone opt-in preserves production backup behavior and never accepts connection URLs", async () => {
  const workflow = readFileSync(
    new URL("../../workflows/production-backup.yml", import.meta.url),
    "utf8"
  )
  assert.doesNotMatch(workflow, /verify-restored-authority|LYRASHIELD_RESTORE_AUTHORITY_DISPOSABLE/)
  const value = config()
  validateRestoreAuthorityConfig(value)
  for (const mutation of [
    (item) => {
      item.databaseUrl = "postgresql://secret@production.invalid/postgres"
    },
    (item) => {
      item.dispatch.target.database = "postgres"
    },
    (item) => {
      item.dispatch.target.databaseUrl = "postgresql://secret@production.invalid/postgres"
    },
    (item) => {
      item.dispatch.deniedRoles = ["runtime';SELECT 1;--"]
    },
    (item) => {
      item.dispatch.deniedRoles = []
    },
  ]) {
    const bad = structuredClone(value)
    mutation(bad)
    assert.throws(() => validateRestoreAuthorityConfig(bad))
  }
  let reads = 0
  await assert.rejects(
    verifyRestoredAuthority({ ...value, enableEpoch: true }, async () => {
      reads++
      return closed
    })
  )
  assert.equal(reads, 0)
})
test("Docker host overrides and missing disposable opt-in fail before any database read", () => {
  assert.throws(() => assertLocalRestoreEnvironment({}))
  const env = { LYRASHIELD_RESTORE_AUTHORITY_DISPOSABLE: "1" }
  assertLocalRestoreEnvironment(env)
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    assert.throws(() => assertLocalRestoreEnvironment({ ...env, [key]: "unexpected" }))
  }
})
for (const [label, mutate] of [
  [
    "ID drift",
    (item) => {
      item.Id = "b".repeat(64)
    },
  ],
  [
    "foreign owner",
    (item) => {
      item.Config.Labels["lyrashield.authority-restore"] = randomUUID()
    },
  ],
  [
    "foreign name",
    (item) => {
      item.Name = "/production-postgres"
    },
  ],
  [
    "network access",
    (item) => {
      item.HostConfig.NetworkMode = "bridge"
    },
  ],
  [
    "host PID access",
    (item) => {
      item.HostConfig.PidMode = "host"
    },
  ],
  [
    "privileged container",
    (item) => {
      item.HostConfig.Privileged = true
    },
  ],
  [
    "additional capabilities",
    (item) => {
      item.HostConfig.CapAdd = ["SYS_ADMIN"]
    },
  ],
  [
    "published port",
    (item) => {
      item.HostConfig.PortBindings = { "5432/tcp": [{}] }
    },
  ],
  [
    "host bind",
    (item) => {
      item.HostConfig.Binds = ["/host:/data"]
    },
  ],
  [
    "persistent volume",
    (item) => {
      item.Mounts.push({ Type: "volume", Destination: "/var/lib/postgresql/data" })
    },
  ],
  [
    "missing memory data",
    (item) => {
      item.HostConfig.Tmpfs = {}
    },
  ],
  [
    "extra mount",
    (item) => {
      item.Mounts.push({ Type: "bind", Destination: "/private" })
    },
  ],
])
  test(`rejects unsafe target: ${label}`, () => {
    const value = target(),
      observed = inventory(value)
    assertOwnedRestoreTarget(observed, value)
    mutate(observed)
    assert.throws(() => assertOwnedRestoreTarget(observed, value))
  })
test("private inputs reject symlinks and group-readable files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "restore-authority-private-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "input.json"),
    link = join(root, "link")
  writeFileSync(file, retainedBytes, { mode: 0o600 })
  assert.deepEqual(readPrivateRestoreFile(file), retainedBytes)
  assert.throws(() => readPrivateRestoreFile(file, 1))
  chmodSync(file, 0o640)
  assert.throws(() => readPrivateRestoreFile(file))
  chmodSync(file, 0o600)
  symlinkSync(file, link)
  assert.throws(() => readPrivateRestoreFile(link))
})
for (const check of Object.keys(closed))
  test(`dispatch fails closed on ${check} drift`, async () => {
    for (const value of [false, null, undefined]) {
      await assert.rejects(
        verifyRestoredAuthority(config(), async () => ({ ...closed, [check]: value })),
        { code: "RESTORED_AUTHORITY_REJECTED" }
      )
    }
  })
test("public/app verification never claims mirror or admission qualification", async () => {
  let reads = 0
  assert.deepEqual(
    await verifyRestoredAuthority(config(), async () => {
      reads++
      return closed
    }),
    {
      schema: "lyrashield-offline-authority-restore-result/1",
      dispatch: "VERIFIED_CLOSED",
      mirror: "NOT_REQUESTED",
      admissionAllowed: false,
      managedFailoverQualified: false,
    }
  )
  assert.equal(reads, 1)
})
test("mirror requires an independent target, protected closed schema, and exact retained history", async () => {
  const value = withMirror()
  const bad = structuredClone(value)
  bad.mirror.target = bad.dispatch.target
  assert.throws(() => validateRestoreAuthorityConfig(bad), {
    code: "MIRROR_TARGET_NOT_INDEPENDENT",
  })
  const read = async (_, sql) =>
    sql.includes("'migration'")
      ? closed
      : sql.includes("'protected'")
        ? mirrorClosed
        : retainedStream
  const result = await verifyRestoredAuthority(value, read, () => retainedBytes)
  assert.equal(result.mirror, "VERIFIED_CLOSED_RETAINED_BYTES")
  for (const field of Object.keys(mirrorClosed)) {
    await assert.rejects(
      verifyRestoredAuthority(
        value,
        async (target, sql) =>
          sql.includes("'protected'") ? { ...mirrorClosed, [field]: false } : read(target, sql),
        () => retainedBytes
      )
    )
  }
  await assert.rejects(
    verifyRestoredAuthority(
      value,
      async (target, sql) =>
        sql.includes("'headBytes'") ? { headBytes: null, records: [] } : read(target, sql),
      () => retainedBytes
    ),
    { code: "RETAINED_JOURNAL_MISMATCH" }
  )
})
test("retained journal checksum, scope and complete record sequence are required", () => {
  parseRetainedJournal(retainedBytes, sha256(retainedBytes))
  assert.throws(() => parseRetainedJournal(retainedBytes, "a".repeat(64)))
  for (const mutate of [
    (item) => {
      item.streams.push(item.streams[0])
    },
    (item) => {
      item.streams[0].records[0].sequence = 2
    },
    (item) => {
      item.streams[0].epochId = "' OR true;--"
    },
    (item) => {
      item.enableEpoch = true
    },
  ]) {
    const item = JSON.parse(retainedBytes)
    mutate(item)
    const bytes = Buffer.from(JSON.stringify(item))
    assert.throws(() => parseRetainedJournal(bytes, sha256(bytes)))
  }
  for (const observed of [
    { headBytes: "different", records: retainedStream.records },
    { headBytes: retainedStream.headBytes, records: [] },
    { headBytes: retainedStream.headBytes, records: [{ sequence: 1, recordBytes: "different" }] },
  ]) {
    assert.throws(() => assertRetainedJournal(retainedStream, observed), {
      code: "RETAINED_JOURNAL_MISMATCH",
    })
  }
})
test("generated observations stay read-only and bind executable source rather than trigger names alone", () => {
  const dispatch = dispatchVerificationSql(["authority_app_restore"])
  const mirror = mirrorVerificationSql("mirror_restore", ["authority_worker_restore"])
  assert.match(dispatch, /p\.prosrc=/)
  assert.match(dispatch, /t\.tgtype=/)
  assert.match(dispatch, /checksum='[a-f0-9]{64}'/)
  assert.match(mirror, /NOT EXISTS .*active/s)
  assert.match(mirror, /p\.proconfig\s*=ARRAY\['search_path=pg_catalog'\]/)
  for (const name of [
    "scan_attachment_ids_valid",
    "scan_target_snapshot_digest",
    "scan_policy_digest",
    "scan_dispatch_scope_digest",
  ]) {
    assert.ok(dispatch.includes(`p.proname='${name}'`))
  }
  for (const sql of [dispatch, mirror]) {
    assert.match(sql, /'privilegedFunctions'/)
    assert.match(sql, /WHERE p\.prosecdef AND n\.nspname !~/)
    assert.match(sql, /has_function_privilege\(reachable\.oid,p\.oid,'EXECUTE'\)/)
    assert.match(sql, /pg_has_role\('[a-z_]+',reachable\.oid,'MEMBER'\)/)
    assert.match(sql, /p\.proargnames/)
    assert.match(sql, /p\.proparallel='u'/)
    assert.match(sql, /NOT p\.proleakproof/)
  }
  // SQL function bodies appear only as escaped literals, never executed during observation.
  assert.ok(dispatch.startsWith("SELECT "))
  assert.ok(mirror.startsWith("SELECT "))
})
test("CLI rejection never emits private input bytes or database details", (t) => {
  const root = mkdtempSync(join(tmpdir(), "restore-authority-cli-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "config.json")
  writeFileSync(path, JSON.stringify({ secret: "PRIVATE_SENTINEL" }), { mode: 0o600 })
  const result = spawnSync(
    process.execPath,
    [new URL("../verify-restored-authority.mjs", import.meta.url).pathname, "--config", path],
    { encoding: "utf8", env: { ...process.env, LYRASHIELD_RESTORE_AUTHORITY_DISPOSABLE: "1" } }
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "restore/authority/invalid_configuration; admission remains closed\n")
})
