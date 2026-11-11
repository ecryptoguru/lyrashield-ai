/**
 * Standalone offline verification, never invoked by production-backup.yml.
 * Usage: LYRASHIELD_RESTORE_AUTHORITY_DISPOSABLE=1 node this-file --config /private/config.json
 * A 0600 config uses schema "lyrashield-offline-authority-restore/1", dispatch:
 * { target: {containerId, ownerToken, database: "lyrashield_restore"}, deniedRoles: [...] }.
 * Optional mirror has its independently owned target (database "lyrashield_authority_restore"),
 * runtimeRole, deniedRoles, retainedJournal: {path, sha256}. Retained byte snapshots use
 * schema "lyrashield-restore-retained-journal/1" and streams [{epochId, supervisorId,
 * headBytes, records: [{sequence, recordBytes}]}]. Authenticate them before use.
 * Targets must be freshly owned, network-none, nonprivileged, mount-free containers
 * with tmpfs PostgreSQL data and label lyrashield.authority-restore=<ownerToken>.
 * This checks restore fences; it neither closes nor opens epochs and grants nothing.
 */
import { spawnSync } from "node:child_process"
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs"
import { pathToFileURL } from "node:url"
import {
  RestoreAuthorityError,
  requireCheck,
  validateRestoreAuthorityConfig,
  dispatchVerificationSql,
  mirrorVerificationSql,
  parseRetainedJournal,
  retainedJournalSql,
  assertRetainedJournal,
  assertRestoredChecks,
} from "./restore-authority-contract.mjs"

const dockerOverrides = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]
export function assertLocalRestoreEnvironment(env) {
  requireCheck(
    env.LYRASHIELD_RESTORE_AUTHORITY_DISPOSABLE === "1" &&
      dockerOverrides.every((key) => !env[key]),
    "UNSAFE_RESTORE_TARGET"
  )
}
/** Check again before each read, including immutable ID and memory-backed ownership. */
export function assertOwnedRestoreTarget(observed, target) {
  requireCheck(
    observed?.Id === target.containerId &&
      observed.Name === `/lyrashield-authority-restore-${target.ownerToken}` &&
      observed.Config?.Labels?.["lyrashield.authority-restore"] === target.ownerToken &&
      observed.State?.Running === true &&
      observed.HostConfig?.NetworkMode === "none" &&
      observed.HostConfig.Privileged === false &&
      !observed.HostConfig.PidMode &&
      !observed.HostConfig.IpcMode?.startsWith("host") &&
      !observed.HostConfig.CapAdd?.length &&
      !observed.HostConfig.Binds?.length &&
      !observed.HostConfig.VolumesFrom?.length &&
      Object.keys(observed.HostConfig.PortBindings ?? {}).length === 0 &&
      Object.keys(observed.HostConfig.Tmpfs ?? {}).length === 1 &&
      typeof observed.HostConfig.Tmpfs["/var/lib/postgresql/data"] === "string" &&
      Array.isArray(observed.Mounts) &&
      observed.Mounts.length === 0,
    "UNSAFE_RESTORE_TARGET"
  )
}
export function readPrivateRestoreFile(path, maximumBytes = 8 * 1024 * 1024) {
  let fd
  try {
    // O_NOFOLLOW + fstat binds validation/read to the same file, not a symlink replacement.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    requireCheck(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= maximumBytes,
      "PRIVATE_INPUT_REJECTED"
    )
    const bytes = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null)
      if (read === 0) break
      size += read
    }
    const after = fstatSync(fd)
    requireCheck(
      size === stat.size &&
        after.size === stat.size &&
        after.mtimeMs === stat.mtimeMs &&
        after.ctimeMs === stat.ctimeMs,
      "PRIVATE_INPUT_REJECTED"
    )
    return bytes.subarray(0, size)
  } catch (error) {
    if (error instanceof RestoreAuthorityError) throw error
    throw new RestoreAuthorityError("PRIVATE_INPUT_REJECTED")
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
function docker(args, input) {
  const result = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  requireCheck(result.status === 0 && !result.error, "RESTORE_READ_UNAVAILABLE")
  return result.stdout
}
function query(target, sql) {
  const inventory = JSON.parse(docker(["inspect", target.containerId]))
  requireCheck(Array.isArray(inventory) && inventory.length === 1, "UNSAFE_RESTORE_TARGET")
  assertOwnedRestoreTarget(inventory[0], target)
  const output = docker(
    [
      "exec",
      "-i",
      target.containerId,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "/var/run/postgresql",
      "-p",
      "5432",
      "-U",
      "restore",
      "-d",
      target.database,
    ],
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s';
    SET LOCAL row_security=off; SET LOCAL standard_conforming_strings=on;
    SELECT json_build_object('visible',rolsuper OR rolbypassrls,
      'version',current_setting('server_version_num')::int BETWEEN 170000 AND 179999)::text
      FROM pg_catalog.pg_roles WHERE rolname=current_user;
    ${sql}
    ROLLBACK;`
  )
  const lines = output.trim().split("\n")
  requireCheck(lines.length === 2, "RESTORE_READ_UNAVAILABLE")
  assertRestoredChecks(JSON.parse(lines[0]), ["visible", "version"])
  return JSON.parse(lines[1])
}

export async function verifyRestoredAuthority(
  config,
  read = query,
  readFile = readPrivateRestoreFile
) {
  validateRestoreAuthorityConfig(config)
  assertRestoredChecks(
    await read(config.dispatch.target, dispatchVerificationSql(config.dispatch.deniedRoles)),
    ["migration", "tables", "triggers", "helpers", "privilegedFunctions", "closed", "roles"]
  )
  if (config.mirror) {
    const mirror = config.mirror
    const retained = parseRetainedJournal(
      readFile(mirror.retainedJournal.path),
      mirror.retainedJournal.sha256
    )
    assertRestoredChecks(
      await read(mirror.target, mirrorVerificationSql(mirror.runtimeRole, mirror.deniedRoles)),
      ["protected", "functions", "privilegedFunctions", "roles", "closed"]
    )
    for (const stream of retained.streams)
      assertRetainedJournal(stream, await read(mirror.target, retainedJournalSql(stream)))
  }
  return {
    schema: "lyrashield-offline-authority-restore-result/1",
    dispatch: "VERIFIED_CLOSED",
    mirror: config.mirror ? "VERIFIED_CLOSED_RETAINED_BYTES" : "NOT_REQUESTED",
    admissionAllowed: false,
    managedFailoverQualified: false,
  }
}
async function main() {
  assertLocalRestoreEnvironment(process.env)
  requireCheck(
    process.argv.length === 4 && process.argv[2] === "--config" && process.argv[3].startsWith("/"),
    "INVALID_CONFIGURATION"
  )
  const config = validateRestoreAuthorityConfig(
    JSON.parse(readPrivateRestoreFile(process.argv[3], 64 * 1024))
  )
  const context = docker(["context", "show"]).trim()
  requireCheck(["default", "desktop-linux"].includes(context), "UNSAFE_RESTORE_TARGET")
  const endpoint = JSON.parse(docker(["context", "inspect", context]))
  requireCheck(
    endpoint.length === 1 && /^unix:\/\/\//.test(endpoint[0].Endpoints?.docker?.Host ?? ""),
    "UNSAFE_RESTORE_TARGET"
  )
  console.log(JSON.stringify(await verifyRestoredAuthority(config)))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof RestoreAuthorityError ? error.code : "RESTORE_READ_UNAVAILABLE"
    // Never print PostgreSQL errors, SQL, identities, rows, credentials or retained bytes.
    console.error(`restore/authority/${code.toLowerCase()}; admission remains closed`)
    process.exitCode = 1
  })
}
