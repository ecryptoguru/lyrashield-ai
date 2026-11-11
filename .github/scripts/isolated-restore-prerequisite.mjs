/**
 * Unwired, disposable-only preparation for a current public/app custom archive.
 * The caller MUST obtain expectedSha256/sourceRevision from authenticated producer
 * metadata before calling this helper. A digest computed from the supplied file
 * does not authenticate its origin. No production credential or service URL is accepted.
 * Named-relation/catalog queries can invoke restored code. Isolation/read-only are
 * bounded defenses, not a non-execution or sole-writer guarantee. Results stay UNQUALIFIED.
 */
import { spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import {
  RESTORE_AUTHORITY_POSTGRES_IMAGE,
  RESTORE_AUTHORITY_POSTGRES_VERSION,
  RestoreAuthorityError,
  requireCheck,
  sha256,
} from "./restore-authority-contract.mjs"
import { readPrivateRestoreFile, verifyRestoredAuthority } from "./verify-restored-authority.mjs"

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const database = "lyrashield_restore"
const writer = "isolated_restore_writer"
const probe = "isolated_restore_probe"
const dataTmpfs = "rw,noexec,nosuid,size=512m"
const archiveTmpfs = "rw,noexec,nosuid,size=96m"
const socketTmpfs = "rw,noexec,nosuid,size=8m"
const entry =
  /^(\d+); \d+ \d+ (FK CONSTRAINT|TABLE DATA|SEQUENCE SET|ROW SECURITY|SCHEMA|COMMENT|TYPE|TABLE|SEQUENCE|FUNCTION|DEFAULT|CONSTRAINT|INDEX|TRIGGER|POLICY) (public|app|-) (.+) \S+$/

/** Accept the reviewed object classes only; preserve every entry except public CREATE SCHEMA. */
export function prepareRestoreList(text) {
  requireCheck(
    typeof text === "string" && Buffer.byteLength(text) <= 2 * 1024 * 1024,
    "UNSUPPORTED_ARCHIVE"
  )
  requireCheck(
    /;\s+Dumped from database version: 17\.\d/.test(text) &&
      /;\s+Dumped by pg_dump version: 17\.\d/.test(text),
    "UNSUPPORTED_ARCHIVE"
  )
  const ids = new Set(),
    schemas = new Set()
  const lines = text.split("\n").map((line) => {
    if (!line || line.startsWith(";")) return line
    const match = line.match(entry)
    requireCheck(match && !ids.has(match[1]) && ids.size < 20_000, "UNSUPPORTED_ARCHIVE")
    ids.add(match[1])
    const [, , descriptor, schema, name] = match
    if (descriptor === "SCHEMA") {
      requireCheck(
        schema === "-" && ["public", "app"].includes(name) && !schemas.has(name),
        "UNSUPPORTED_ARCHIVE"
      )
      schemas.add(name)
      return name === "public" ? `;${line}` : line
    }
    requireCheck(
      schema !== "-" ||
        (descriptor === "COMMENT" && ["SCHEMA public", "SCHEMA app"].includes(name)),
      "UNSUPPORTED_ARCHIVE"
    )
    // This archive omits extensions. Supplying extension objects or digest replacements
    // is a different contract, even when the TOC calls them ordinary functions.
    requireCheck(
      !(
        descriptor === "FUNCTION" &&
        schema === "public" &&
        /^(digest|hmac|crypt|gen_salt|gen_random_bytes|gen_random_uuid|pgp_[a-z_]+)\(/.test(name)
      ),
      "UNSUPPORTED_ARCHIVE"
    )
    return line
  })
  requireCheck(schemas.size === 2 && ids.size > 2, "UNSUPPORTED_ARCHIVE")
  return lines.join("\n")
}

export function assertPrerequisiteTarget(value, id, token) {
  requireCheck(
    value?.Id === id &&
      value.Image === RESTORE_AUTHORITY_POSTGRES_IMAGE &&
      value.Name === `/lyrashield-restore-prerequisite-${token}` &&
      value.Config?.Labels?.["lyrashield.restore-prerequisite"] === token &&
      value.HostConfig?.NetworkMode === "none" &&
      value.HostConfig.Privileged === false &&
      !value.HostConfig.PidMode &&
      !value.HostConfig.IpcMode?.startsWith("host") &&
      !value.HostConfig.CapAdd?.length &&
      !value.HostConfig.Binds?.length &&
      !value.HostConfig.VolumesFrom?.length &&
      Object.keys(value.HostConfig.PortBindings ?? {}).length === 0 &&
      value.HostConfig.Memory === 768 * 1024 * 1024 &&
      value.HostConfig.PidsLimit === 128 &&
      value.HostConfig.NanoCpus === 2_000_000_000 &&
      value.HostConfig.ReadonlyRootfs === true &&
      value.HostConfig.Tmpfs?.["/var/lib/postgresql/data"] === dataTmpfs &&
      value.HostConfig.Tmpfs?.["/tmp"] === archiveTmpfs &&
      value.HostConfig.Tmpfs?.["/var/run/postgresql"] === socketTmpfs &&
      Object.keys(value.HostConfig.Tmpfs).length === 3 &&
      value.HostConfig.SecurityOpt?.includes("no-new-privileges") &&
      Array.isArray(value.Mounts) &&
      value.Mounts.length === 0,
    "UNSAFE_RESTORE_TARGET"
  )
}

function readArchive(config) {
  requireCheck(
    config?.schema === "lyrashield-isolated-restore-prerequisite/1" &&
      Object.keys(config).sort().join(",") === "archivePath,expectedSha256,schema,sourceRevision" &&
      typeof config.archivePath === "string" &&
      isAbsolute(config.archivePath) &&
      /^[a-f0-9]{64}$/.test(config.expectedSha256) &&
      /^[a-f0-9]{40}$/.test(config.sourceRevision),
    "PRIVATE_INPUT_REJECTED"
  )
  const parent = dirname(config.archivePath)
  // The caller owns the input directory. Copy verified bytes through stdin, never reopen
  // the archive for docker cp: a path replacement must not change the inspected bytes.
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = lstatSync(parent)
    requireCheck(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o700 &&
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        realpathSync(parent) === parent,
      "PRIVATE_INPUT_REJECTED"
    )
  } catch {
    throw new RestoreAuthorityError("PRIVATE_INPUT_REJECTED")
  }
  const bytes = readPrivateRestoreFile(config.archivePath, MAX_ARCHIVE_BYTES)
  requireCheck(
    bytes.length > 5 &&
      bytes.subarray(0, 5).toString("ascii") === "PGDMP" &&
      sha256(bytes) === config.expectedSha256,
    "ARCHIVE_BINDING_REJECTED"
  )
  return bytes
}

export async function runIsolatedRestorePrerequisite(config, options = {}) {
  const env = options.env ?? process.env
  requireCheck(
    env.LYRASHIELD_RESTORE_PREREQUISITE_DISPOSABLE === "1" &&
      ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].every(
        (key) => !env[key]
      ),
    "UNSAFE_RESTORE_TARGET"
  )
  const archive = readArchive(config)
  const execute = options.execute ?? spawnSync
  // Explicit child environment prevents inherited provider/database credentials or libpq
  // service settings reaching Docker or restored code. Passwords are synthetic only.
  const childEnv = { PATH: env.PATH, HOME: env.HOME, LANG: "C.UTF-8" }
  const password = randomBytes(32).toString("hex")
  const writerPassword = randomBytes(32).toString("hex")
  const token = randomUUID()
  let id
  const docker = (args, input, extraEnv = {}, allowFailure = false) => {
    const result = execute("docker", args, {
      input,
      env: { ...childEnv, ...extraEnv },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    })
    requireCheck(allowFailure || (!result.error && result.status === 0), "RESTORE_COMMAND_FAILED")
    return result
  }
  const text = (args, input, extraEnv) =>
    docker(args, input, extraEnv).stdout.toString("utf8").trim()
  const owned = () => {
    const inventory = JSON.parse(text(["inspect", id]))
    requireCheck(Array.isArray(inventory) && inventory.length === 1, "UNSAFE_RESTORE_TARGET")
    assertPrerequisiteTarget(inventory[0], id, token)
    return inventory[0]
  }
  const sql = (source) => {
    requireCheck(owned().State?.Running === true, "UNSAFE_RESTORE_TARGET")
    return text(
      [
        "exec",
        "-i",
        id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "restore",
        "-d",
        database,
      ],
      source
    )
  }
  const read = (source) =>
    sql(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s';
    SET LOCAL search_path=pg_catalog; SET LOCAL row_security=off;
    ${source}\nROLLBACK;`)
  try {
    const context = text(["context", "show"])
    requireCheck(["default", "desktop-linux"].includes(context), "UNSAFE_RESTORE_TARGET")
    const endpoint = JSON.parse(text(["context", "inspect", context]))
    requireCheck(
      endpoint.length === 1 && /^unix:\/\/\//.test(endpoint[0]?.Endpoints?.docker?.Host),
      "UNSAFE_RESTORE_TARGET"
    )
    requireCheck(
      text(["image", "inspect", RESTORE_AUTHORITY_POSTGRES_IMAGE, "--format", "{{.Id}}"]) ===
        RESTORE_AUTHORITY_POSTGRES_IMAGE,
      "UNSAFE_RESTORE_TARGET"
    )
    id = text(
      [
        "run",
        "-d",
        "--pull=never",
        "--name",
        `lyrashield-restore-prerequisite-${token}`,
        "--label",
        `lyrashield.restore-prerequisite=${token}`,
        "--network",
        "none",
        "--memory",
        "768m",
        "--pids-limit",
        "128",
        "--cpus",
        "2",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        `/var/lib/postgresql/data:${dataTmpfs}`,
        "--tmpfs",
        `/tmp:${archiveTmpfs}`,
        "--tmpfs",
        `/var/run/postgresql:${socketTmpfs}`,
        "-e",
        "POSTGRES_USER=restore",
        "-e",
        "POSTGRES_PASSWORD",
        "-e",
        `POSTGRES_DB=${database}`,
        RESTORE_AUTHORITY_POSTGRES_IMAGE,
      ],
      undefined,
      { POSTGRES_PASSWORD: password }
    )
    requireCheck(/^[a-f0-9]{64}$/.test(id), "UNSAFE_RESTORE_TARGET")
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      owned()
      if (
        docker(
          ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "restore", "-d", database],
          undefined,
          {},
          true
        ).status === 0
      ) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    requireCheck(ready, "RESTORE_COMMAND_FAILED")
    requireCheck(
      read(`SELECT current_setting('server_version_num');`) ===
        String(RESTORE_AUTHORITY_POSTGRES_VERSION),
      "UNSUPPORTED_EXTENSION"
    )
    owned()
    docker(["exec", "-i", id, "sh", "-c", "umask 077; cat > /tmp/backup.dump"], archive)
    owned()
    const list = prepareRestoreList(text(["exec", id, "pg_restore", "--list", "/tmp/backup.dump"]))
    owned()
    docker(["exec", "-i", id, "sh", "-c", "umask 077; cat > /tmp/restore.list"], list)
    // Only fixed prerequisite SQL runs as bootstrap owner. Restore authenticates as the
    // limited writer, rather than SET ROLE inside a superuser-authenticated session.
    sql(`CREATE EXTENSION pgcrypto WITH SCHEMA public VERSION '1.3';
      CREATE ROLE ${writer} LOGIN PASSWORD '${writerPassword}' NOSUPERUSER NOBYPASSRLS
        NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT CONNECT,CREATE ON DATABASE ${database} TO ${writer};
      ALTER SCHEMA public OWNER TO ${writer};
      GRANT USAGE,CREATE ON SCHEMA public TO ${writer};`)
    requireCheck(
      read(`SELECT count(*)=2 AND bool_and(n.nspname='public' AND e.extname='pgcrypto'
      AND e.extversion='1.3' AND en.nspname='public' AND p.prosrc='pg_digest'
      AND p.probin='$libdir/pgcrypto' AND l.lanname='c' AND NOT p.prosecdef
      AND p.proargtypes IN ('17 25'::oidvector,'25 25'::oidvector)
      AND p.pronargdefaults=0 AND p.provariadic=0)
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_proc'::regclass
        AND d.objid=p.oid AND d.deptype='e'
      LEFT JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
      LEFT JOIN pg_catalog.pg_namespace en ON en.oid=e.extnamespace
      WHERE p.proname='digest' AND n.nspname IN ('public','pg_catalog');`) === "t",
      "UNSUPPORTED_EXTENSION"
    )
    owned()
    docker(
      [
        "exec",
        "-e",
        "PGPASSWORD",
        id,
        "pg_restore",
        "-h",
        "127.0.0.1",
        "-U",
        writer,
        "-d",
        database,
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "--use-list=/tmp/restore.list",
        "/tmp/backup.dump",
      ],
      undefined,
      { PGPASSWORD: writerPassword }
    )
    // Reject unexpected restored ownership before installing the explicitly synthetic ACL.
    requireCheck(
      read(`SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','app') AND c.relowner <> '${writer}'::regrole)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','app') AND p.proowner <> '${writer}'::regrole
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
            JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
            WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
              AND e.extname='pgcrypto' AND e.extversion='1.3'));`) === "t",
      "UNSUPPORTED_OWNERSHIP"
    )
    sql(`ALTER ROLE ${writer} NOLOGIN PASSWORD NULL;
      REVOKE ALL ON SCHEMA public,app FROM PUBLIC;
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public,app FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE ${writer} IN SCHEMA public,app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      CREATE ROLE ${probe} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT USAGE ON SCHEMA public,app TO ${probe};
      GRANT SELECT ON public."Policy" TO ${probe};
      GRANT EXECUTE ON FUNCTION public.digest(bytea,text),app.scan_policy_digest(text),app.current_workspace_id() TO ${probe};`)
    requireCheck(
      read(`SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE member IN ('${writer}'::regrole,'${probe}'::regrole)
          OR roleid IN ('${writer}'::regrole,'${probe}'::regrole))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('${writer}','${probe}')
        AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))
      AND NOT pg_catalog.has_schema_privilege('${probe}','public','CREATE')
      AND NOT pg_catalog.has_schema_privilege('${probe}','app','CREATE')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
        ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='Policy'
        AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
        ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app')
        AND CASE WHEN c.relkind IN ('r','v','m','p','f') THEN (((c.relname <> 'Policy' OR n.nspname <> 'public')
          AND pg_catalog.has_table_privilege('${probe}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
          OR pg_catalog.has_table_privilege('${probe}',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
          ELSE false END)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
        ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app')
        AND CASE WHEN c.relkind='S' THEN
          pg_catalog.has_sequence_privilege('${probe}',c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n
        ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app')
        AND p.oid NOT IN ('public.digest(bytea,text)'::regprocedure,
          'app.scan_policy_digest(text)'::regprocedure,'app.current_workspace_id()'::regprocedure)
        AND pg_catalog.has_function_privilege('${probe}',p.oid,'EXECUTE'));`) === "t",
      "UNSUPPORTED_ACL"
    )
    const diagnostic = await verifyRestoredAuthority(
      {
        schema: "lyrashield-offline-authority-restore/1",
        dispatch: {
          target: { containerId: id, ownerToken: token, database },
          deniedRoles: [probe],
        },
      },
      async (_target, source) => JSON.parse(read(source))
    )
    return {
      schema: "lyrashield-isolated-restore-prerequisite-result/1",
      archiveSha256: config.expectedSha256,
      sourceRevision: config.sourceRevision,
      archiveBytes: archive.length,
      schemaRestore: "OBSERVED",
      extension: "pgcrypto-1.3-public",
      privilegeProfile: "synthetic-policy-read/1",
      sourceAclRestored: false,
      producerAuthenticatedByHelper: false,
      productionApplicable: false,
      authorityDiagnostic: diagnostic,
      admissionAllowed: false,
      managedFailoverQualified: false,
    }
  } finally {
    if (id && /^[a-f0-9]{64}$/.test(id)) {
      // Revalidate immutable ID, image and ownership before removal, including stopped targets.
      // If identity is no longer ours, refuse removal and withhold every successful result.
      owned()
      docker(["rm", "-fv", id])
    }
  }
}

async function main() {
  requireCheck(
    process.argv.length === 4 && process.argv[2] === "--config",
    "PRIVATE_INPUT_REJECTED"
  )
  const config = JSON.parse(readPrivateRestoreFile(process.argv[3], 4096).toString("utf8"))
  const result = await runIsolatedRestorePrerequisite(config)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Child diagnostics and private inputs never escape to the public channel.
    process.stderr.write(
      "restore/prerequisite/failed; authority and production remain unqualified\n"
    )
    process.exitCode = 1
  })
}
