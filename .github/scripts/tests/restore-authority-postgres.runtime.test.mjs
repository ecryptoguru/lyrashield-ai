/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed source migrations or owned disposable fixture files. */
import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256, DISPATCH_MIGRATION } from "../restore-authority-contract.mjs"
import { assertOwnedRestoreTarget } from "../verify-restored-authority.mjs"

const repository = new URL("../../../", import.meta.url)
const migrations = new URL("../../../packages/db/prisma/migrations/", import.meta.url)
const mirrorSource = readFileSync(
  new URL("../../../packages/runtime-control/sql/authority-mirror.sql", import.meta.url),
  "utf8"
)

test(
  "owned PostgreSQL 17 current-schema restore, role fences and independently retained mirror rollback",
  { skip: process.env.RESTORE_AUTHORITY_RUNTIME_TEST !== "1", timeout: 180_000 },
  async (t) => {
    // No service URL is accepted, no host port is published, no container can reach the network.
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"])
      assert.ok(!process.env[key])
    const password = randomBytes(32).toString("hex"),
      ownerToken = randomUUID()
    const name = `lyrashield-authority-restore-${ownerToken}`
    const root = mkdtempSync(join(tmpdir(), "lyra-authority-restore-"))
    const env = { ...process.env, POSTGRES_PASSWORD: password }
    let containerId, image
    const docker = (args, input, success = true) => {
      const result = spawnSync("docker", args, {
        input,
        env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      })
      if (success)
        assert.equal(
          result.status,
          0,
          `owned synthetic PostgreSQL command failed: ${result.stderr}`
        )
      return result
    }
    const text = (args, input) => docker(args, input).stdout.toString("utf8").trim()
    const sql = (query, database = "source") =>
      text(
        [
          "exec",
          "-i",
          containerId,
          "psql",
          "-X",
          "-qAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-h",
          "/var/run/postgresql",
          "-U",
          "restore",
          "-d",
          database,
        ],
        query
      )
    t.after(() => {
      try {
        if (containerId) {
          const observed = JSON.parse(text(["inspect", containerId]))[0]
          assertOwnedRestoreTarget(observed, {
            containerId,
            ownerToken,
            database: "lyrashield_restore",
          })
          assert.equal(observed.Image, image)
          docker(["rm", "-fv", containerId])
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
    const context = text(["context", "show"])
    assert.ok(["default", "desktop-linux"].includes(context))
    assert.match(
      JSON.parse(text(["context", "inspect", context]))[0].Endpoints.docker.Host,
      /^unix:\/\/\//
    )
    image = text(["image", "inspect", "postgres:17-alpine", "--format", "{{.Id}}"])
    assert.match(image, /^sha256:[a-f0-9]{64}$/)
    containerId = text([
      "run",
      "-d",
      "--pull=never",
      "--name",
      name,
      "--label",
      `lyrashield.authority-restore=${ownerToken}`,
      "--network",
      "none",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "-e",
      "POSTGRES_USER=restore",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=source",
      image,
    ])
    assert.match(containerId, /^[a-f0-9]{64}$/)
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        docker(
          ["exec", containerId, "pg_isready", "-h", "127.0.0.1", "-U", "restore", "-d", "source"],
          undefined,
          false
        ).status === 0
      ) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(ready, "owned PostgreSQL fixture did not become ready")
    assertOwnedRestoreTarget(JSON.parse(text(["inspect", containerId]))[0], {
      containerId,
      ownerToken,
      database: "lyrashield_restore",
    })
    sql(`CREATE ROLE authority_app_restore NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
      CREATE ROLE authority_mirror_restore NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
      CREATE ROLE authority_worker_restore NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
      CREATE TABLE public."_prisma_migrations" (migration_name text, checksum text, finished_at timestamptz, rolled_back_at timestamptz);`)
    let migrationCount = 0
    for (const directory of readdirSync(migrations).sort()) {
      if (!/^\d{14}_[a-z0-9_]+$/.test(directory)) continue
      const source = readFileSync(new URL(`${directory}/migration.sql`, migrations), "utf8")
      sql(source)
      sql(
        `INSERT INTO public."_prisma_migrations" VALUES ('${directory}','${sha256(source)}',now(),null);`
      )
      migrationCount++
    }
    assert.ok(migrationCount > 50, "full checked-out migration chain is required")
    const dump = docker([
      "exec",
      containerId,
      "pg_dump",
      "-U",
      "restore",
      "-d",
      "source",
      "--format=custom",
      "--schema=public",
      "--schema=app",
      "--no-owner",
      "--no-acl",
    ]).stdout
    docker(["exec", "-i", containerId, "sh", "-c", "cat > /tmp/public-app.dump"], dump)
    const restoreDispatch = () => {
      sql("DROP DATABASE IF EXISTS lyrashield_restore; CREATE DATABASE lyrashield_restore;")
      docker([
        "exec",
        containerId,
        "pg_restore",
        "-U",
        "restore",
        "-d",
        "lyrashield_restore",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "/tmp/public-app.dump",
      ])
    }
    restoreDispatch()
    const config = {
      schema: "lyrashield-offline-authority-restore/1",
      dispatch: {
        target: { containerId, ownerToken, database: "lyrashield_restore" },
        deniedRoles: ["authority_app_restore"],
      },
    }
    const configPath = join(root, "config.json")
    const verify = (value = config) => {
      writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 })
      return spawnSync(
        process.execPath,
        [
          new URL("../verify-restored-authority.mjs", import.meta.url).pathname,
          "--config",
          configPath,
        ],
        {
          cwd: repository,
          env: { ...process.env, LYRASHIELD_RESTORE_AUTHORITY_DISPOSABLE: "1" },
          encoding: "utf8",
          timeout: 30_000,
        }
      )
    }
    const rejected = (result) => {
      assert.equal(result.status, 1)
      assert.equal(result.stdout, "")
      assert.match(result.stderr, /^restore\/authority\/[a-z_]+; admission remains closed\n$/)
    }
    await t.test(
      "restores every checked-out migration with source-bound triggers and no open epoch",
      () => {
        const before = sql(
          'SELECT row_to_json(e)::text FROM public."ScanAuthorityEpoch" e;',
          "lyrashield_restore"
        )
        const result = verify()
        assert.equal(result.status, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).mirror, "NOT_REQUESTED")
        assert.equal(JSON.parse(result.stdout).admissionAllowed, false)
        assert.equal(
          sql(
            'SELECT row_to_json(e)::text FROM public."ScanAuthorityEpoch" e;',
            "lyrashield_restore"
          ),
          before
        )
      }
    )
    for (const [label, mutation] of [
      [
        "altered migration checksum",
        `UPDATE public."_prisma_migrations" SET checksum=repeat('a',64) WHERE migration_name='${DISPATCH_MIGRATION}';`,
      ],
      [
        "unfinished migration",
        `UPDATE public."_prisma_migrations" SET finished_at=null WHERE migration_name='${DISPATCH_MIGRATION}';`,
      ],
      [
        "disabled immutable trigger",
        'ALTER TABLE public."ScanPhysicalExecutionTransition" DISABLE TRIGGER scan_physical_execution_transition_immutable;',
      ],
      [
        "same-named no-op trigger function",
        "CREATE OR REPLACE FUNCTION app.reject_scan_physical_execution_transition_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;",
      ],
      [
        "same-named conditional trigger bypass",
        'DROP TRIGGER scan_physical_execution_transition_immutable ON public."ScanPhysicalExecutionTransition"; CREATE TRIGGER scan_physical_execution_transition_immutable BEFORE UPDATE OR DELETE ON public."ScanPhysicalExecutionTransition" FOR EACH ROW WHEN (false) EXECUTE FUNCTION app.reject_scan_physical_execution_transition_mutation();',
      ],
      [
        "trigger search path drift",
        "ALTER FUNCTION app.reject_scan_physical_execution_transition_mutation() SET search_path=public;",
      ],
      ["missing authority table", 'DROP TABLE public."ScanDispatchReleaseReceipt";'],
      [
        "missing forced RLS",
        'ALTER TABLE public."ScanAuthorityEpoch" NO FORCE ROW LEVEL SECURITY;',
      ],
      [
        "open restored epoch",
        `INSERT INTO public."ScanAuthorityEpoch" (id,epoch,"isOpen","openKey","openedAt","updatedAt") VALUES ('isolated-test-open',2,true,'open',now(),now());`,
      ],
      [
        "application authority access",
        'GRANT SELECT ON public."ScanDispatchAttempt" TO authority_app_restore;',
      ],
    ])
      await t.test(`fails closed on ${label}`, () => {
        restoreDispatch()
        sql(mutation, "lyrashield_restore")
        const epochBefore = sql(
          'SELECT json_agg(e)::text FROM public."ScanAuthorityEpoch" e;',
          "lyrashield_restore"
        )
        rejected(verify())
        assert.equal(
          sql('SELECT json_agg(e)::text FROM public."ScanAuthorityEpoch" e;', "lyrashield_restore"),
          epochBefore
        )
      })
    // Role attributes are cluster-global, but only this UUID-owned in-memory cluster exists here.
    await t.test("rejects a runtime bypass role", () => {
      restoreDispatch()
      sql("ALTER ROLE authority_app_restore BYPASSRLS;")
      rejected(verify())
      sql("ALTER ROLE authority_app_restore NOBYPASSRLS;")
    })
    await t.test("rejects authority recovered through a NOINHERIT membership", () => {
      restoreDispatch()
      sql("CREATE ROLE authority_restore_group NOLOGIN NOSUPERUSER NOBYPASSRLS;")
      sql(
        'GRANT SELECT ON public."ScanDispatchAttempt" TO authority_restore_group;',
        "lyrashield_restore"
      )
      sql("GRANT authority_restore_group TO authority_app_restore WITH INHERIT FALSE;")
      rejected(verify())
      sql("REVOKE authority_restore_group FROM authority_app_restore;")
    })
    restoreDispatch()
    sql("CREATE DATABASE lyrashield_authority_restore;")
    sql(mirrorSource, "lyrashield_authority_restore")
    sql(
      `GRANT USAGE ON SCHEMA lyrashield_authority TO authority_mirror_restore;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lyrashield_authority TO authority_mirror_restore;`,
      "lyrashield_authority_restore"
    )
    // Retained snapshots are synthetic bytes. The verifier requires an independently authenticated
    // caller snapshot in hosted use and makes no signature/managed-provider durability claim.
    const headBytes = JSON.stringify({
      sequence: 1,
      recordHash: "a".repeat(64),
      signature: "b".repeat(64),
    })
    const recordBytes = JSON.stringify({
      sequence: 1,
      hash: "a".repeat(64),
      signature: "c".repeat(64),
    })
    sql(
      `INSERT INTO lyrashield_authority.stream VALUES ('restore-test-epoch','restore-test-supervisor',false,'${headBytes}');
      INSERT INTO lyrashield_authority.record VALUES ('restore-test-epoch','restore-test-supervisor',1,'${recordBytes}');`,
      "lyrashield_authority_restore"
    )
    const retained = Buffer.from(
      JSON.stringify({
        schema: "lyrashield-restore-retained-journal/1",
        streams: [
          {
            epochId: "restore-test-epoch",
            supervisorId: "restore-test-supervisor",
            headBytes,
            records: [{ sequence: 1, recordBytes }],
          },
        ],
      })
    )
    const retainedPath = join(root, "retained.json")
    writeFileSync(retainedPath, retained, { mode: 0o600 })
    const mirrorConfig = {
      ...config,
      mirror: {
        target: { containerId, ownerToken, database: "lyrashield_authority_restore" },
        runtimeRole: "authority_mirror_restore",
        deniedRoles: ["authority_worker_restore"],
        retainedJournal: { path: retainedPath, sha256: sha256(retained) },
      },
    }
    await t.test(
      "independently configured protected mirror verifies only retained bytes with its stream closed",
      () => {
        const result = verify(mirrorConfig)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).mirror, "VERIFIED_CLOSED_RETAINED_BYTES")
        assert.equal(JSON.parse(result.stdout).managedFailoverQualified, false)
      }
    )
    for (const [label, mutation, undo] of [
      [
        "active restored mirror stream",
        "UPDATE lyrashield_authority.stream SET active=true;",
        "UPDATE lyrashield_authority.stream SET active=false;",
      ],
      [
        "worker schema access",
        "GRANT USAGE ON SCHEMA lyrashield_authority TO authority_worker_restore;",
        "REVOKE USAGE ON SCHEMA lyrashield_authority FROM authority_worker_restore;",
      ],
      [
        "mirror direct history write",
        "GRANT INSERT ON lyrashield_authority.record TO authority_mirror_restore;",
        "REVOKE INSERT ON lyrashield_authority.record FROM authority_mirror_restore;",
      ],
      [
        "public function execution",
        "GRANT EXECUTE ON FUNCTION lyrashield_authority.read_head(text,text) TO PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION lyrashield_authority.read_head(text,text) FROM PUBLIC;",
      ],
      [
        "mirror function search path drift",
        "ALTER FUNCTION lyrashield_authority.read_head(text,text) SET search_path=public;",
        "ALTER FUNCTION lyrashield_authority.read_head(text,text) SET search_path=pg_catalog;",
      ],
      [
        "worker NOINHERIT schema access",
        "GRANT USAGE ON SCHEMA lyrashield_authority TO authority_restore_group; GRANT authority_restore_group TO authority_worker_restore WITH INHERIT FALSE;",
        "REVOKE authority_restore_group FROM authority_worker_restore; REVOKE USAGE ON SCHEMA lyrashield_authority FROM authority_restore_group;",
      ],
    ])
      await t.test(`rejects ${label}`, () => {
        sql(mutation, "lyrashield_authority_restore")
        rejected(verify(mirrorConfig))
        sql(undo, "lyrashield_authority_restore")
      })
    await t.test(
      "older database mirror history cannot rewrite retained bytes or reopen its epoch",
      () => {
        const retainedBefore = readFileSync(retainedPath)
        sql(
          "DELETE FROM lyrashield_authority.record; UPDATE lyrashield_authority.stream SET head_bytes=null;",
          "lyrashield_authority_restore"
        )
        const result = verify(mirrorConfig)
        rejected(result)
        assert.match(result.stderr, /retained_journal_mismatch/)
        assert.deepEqual(readFileSync(retainedPath), retainedBefore)
        assert.equal(
          sql(
            "SELECT count(*) FROM lyrashield_authority.stream WHERE active;",
            "lyrashield_authority_restore"
          ),
          "0"
        )
        assert.equal(
          sql(
            'SELECT count(*) FROM public."ScanAuthorityEpoch" WHERE "isOpen";',
            "lyrashield_restore"
          ),
          "0"
        )
        assert.equal(
          sql("SELECT count(*) FROM lyrashield_authority.record;", "lyrashield_authority_restore"),
          "0"
        )
      }
    )
  }
)
