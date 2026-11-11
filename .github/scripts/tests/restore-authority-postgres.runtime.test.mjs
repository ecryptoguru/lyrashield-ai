/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed source migrations or owned disposable fixture files. */
import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  sha256,
  DISPATCH_MIGRATION,
  dispatchDigestProbeSql,
  RESTORE_AUTHORITY_POSTGRES_IMAGE,
  RESTORE_AUTHORITY_POSTGRES_VERSION,
} from "../restore-authority-contract.mjs"
import { assertOwnedRestoreTarget, verifyRestoredAuthority } from "../verify-restored-authority.mjs"

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
    image = text(["image", "inspect", RESTORE_AUTHORITY_POSTGRES_IMAGE, "--format", "{{.Id}}"])
    assert.equal(image, RESTORE_AUTHORITY_POSTGRES_IMAGE)
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
    await t.test(
      "pinned known-good PostgreSQL catalog has no system definers and legitimate built-ins execute as invokers",
      () => {
        assert.equal(
          sql("SELECT current_setting('server_version_num');"),
          String(RESTORE_AUTHORITY_POSTGRES_VERSION)
        )
        assert.equal(sql("SELECT count(*) FROM pg_catalog.pg_proc WHERE prosecdef;"), "0")
        assert.equal(
          sql(
            "SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner JOIN pg_catalog.pg_language language ON language.oid=p.prolang WHERE p.oid='pg_catalog.pg_backend_pid()'::regprocedure AND owner.oid=10 AND language.lanname='internal' AND p.prosrc='pg_backend_pid' AND NOT p.prosecdef AND p.probin IS NULL;"
          ),
          "1"
        )
      }
    )
    sql(`CREATE ROLE authority_app_restore NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
      CREATE ROLE authority_mirror_restore NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
      CREATE ROLE authority_worker_restore NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
      CREATE ROLE authority_restore_group NOLOGIN NOSUPERUSER NOBYPASSRLS;
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
    const archiveList = text(["exec", containerId, "pg_restore", "--list", "/tmp/public-app.dump"])
    assert.doesNotMatch(archiveList, /EXTENSION.*pgcrypto/)
    const publicSchemaEntry = /^\d+; \d+ \d+ SCHEMA - public \S+$/
    assert.equal(archiveList.split("\n").filter((line) => publicSchemaEntry.test(line)).length, 1)
    // Preserve the fresh default public namespace that owns the prerequisite extension. Only
    // this exact schema-creation entry is skipped; tables, constraints, functions and rows remain.
    const restoreList = archiveList
      .split("\n")
      .map((line) => (publicSchemaEntry.test(line) ? `;${line}` : line))
      .join("\n")
    docker(["exec", "-i", containerId, "sh", "-c", "cat > /tmp/public-app.list"], restoreList)
    const restoreDispatch = (restrictedAcl = true, installExtension = true) => {
      sql("DROP DATABASE IF EXISTS lyrashield_restore; CREATE DATABASE lyrashield_restore;")
      // Prerequisite for digest-bound CHECK constraints: the archive omits pgcrypto and must
      // not be treated as self-contained. This setup touches only the owned synthetic target.
      if (installExtension)
        sql("CREATE EXTENSION pgcrypto WITH SCHEMA public;", "lyrashield_restore")
      const restored = docker(
        [
          "exec",
          containerId,
          "pg_restore",
          "-U",
          "restore",
          "-d",
          "lyrashield_restore",
          "--no-owner",
          "--no-acl",
          "--use-list=/tmp/public-app.list",
          "--exit-on-error",
          "/tmp/public-app.dump",
        ],
        undefined,
        installExtension
      )
      if (!installExtension) {
        assert.notEqual(
          restored.status,
          0,
          "missing extension must reject digest-bound schema restore"
        )
        assert.match(
          restored.stderr.toString("utf8"),
          /function public\.digest\(bytea, text\) does not exist/
        )
        return
      }
      // Fixture prerequisite only: --no-acl archives do NOT restore safe function permissions.
      // The verifier never applies this ACL setup or repairs any supplied/restored target.
      // Real restore integration needs a separately reviewed privilege-restoration step.
      if (restrictedAcl)
        sql(
          "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public,app FROM PUBLIC;",
          "lyrashield_restore"
        )
      sql(
        `GRANT USAGE ON SCHEMA public,app TO authority_app_restore;
         GRANT SELECT ON public."Policy" TO authority_app_restore;
         GRANT EXECUTE ON FUNCTION app.scan_policy_digest(text) TO authority_app_restore;
         GRANT EXECUTE ON FUNCTION app.current_workspace_id() TO authority_app_restore;
         ${installExtension ? "GRANT EXECUTE ON FUNCTION public.digest(bytea,text) TO authority_app_restore;" : ""}`,
        "lyrashield_restore"
      )
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
    await t.test("public/app archive omits pgcrypto and missing extension remains rejected", () => {
      restoreDispatch(true, false)
      assert.equal(
        sql(
          "SELECT count(*) FROM pg_catalog.pg_extension WHERE extname='pgcrypto';",
          "lyrashield_restore"
        ),
        "0"
      )
      rejected(verify())
      assert.equal(
        sql(
          "SELECT count(*) FROM pg_catalog.pg_extension WHERE extname='pgcrypto';",
          "lyrashield_restore"
        ),
        "0",
        "verification must not install the omitted extension"
      )
      restoreDispatch()
    })
    await t.test(
      "no-acl archive alone cannot establish safe privileged function permissions",
      () => {
        restoreDispatch(false)
        assert.notEqual(
          sql(
            "SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname IN ('public','app') AND has_function_privilege('authority_app_restore',p.oid,'EXECUTE');",
            "lyrashield_restore"
          ),
          "0"
        )
        rejected(verify())
        restoreDispatch()
      }
    )
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
            "SET ROLE authority_app_restore; SET search_path=pg_catalog,public; SELECT app.scan_policy_digest(NULL::text); RESET ROLE;",
            "lyrashield_restore"
          ),
          sha256('{"schemaVersion": "scan-policy/none"}')
        )
        assert.equal(
          sql(
            "SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND (n.nspname ~ '^pg_' OR n.nspname='information_schema');",
            "lyrashield_restore"
          ),
          "0"
        )
        // Existing built-in invokers remain callable; this proves functionality,
        // not authentication of the entire mutable catalog or absence of dynamic SQL bypasses.
        assert.equal(
          sql(
            "SET ROLE authority_app_restore; SELECT pg_catalog.pg_backend_pid()>0; RESET ROLE;",
            "lyrashield_restore"
          ),
          "t"
        )
        assert.equal(
          sql(
            'SELECT row_to_json(e)::text FROM public."ScanAuthorityEpoch" e;',
            "lyrashield_restore"
          ),
          before
        )
      }
    )
    await t.test("digest probe rejects name shadowing before executing the shadow", () => {
      restoreDispatch()
      sql(
        "CREATE FUNCTION pg_catalog.digest(bytea,text) RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT AS $$ BEGIN RAISE EXCEPTION 'unreviewed shadow executed'; END; $$;",
        "lyrashield_restore"
      )
      const observation = JSON.parse(
        sql(
          `BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; ${dispatchDigestProbeSql("authority_app_restore")} ROLLBACK;`,
          "lyrashield_restore"
        )
      )
      assert.deepEqual(observation, { resolution: false, digest: null })
      rejected(verify())
    })
    await t.test(
      "concurrent helper and epoch drift cannot qualify passive observations",
      async () => {
        restoreDispatch()
        let reads = 0
        const result = await verifyRestoredAuthority(config, async (_, querySql) => {
          reads++
          const observed = JSON.parse(sql(querySql, "lyrashield_restore"))
          assert.equal(observed.closed, true)
          sql(
            `CREATE OR REPLACE FUNCTION app.scan_policy_digest(policy_id text) RETURNS text LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'changed helper must never execute'; END; $$;
           INSERT INTO public."ScanAuthorityEpoch" (id,epoch,"isOpen","openKey","openedAt","updatedAt") VALUES ('concurrent-open',2,true,'open',now(),now());`,
            "lyrashield_restore"
          )
          return observed
        })
        assert.equal(reads, 1, "no restored helper may execute after the catalog observation")
        assert.equal(result.dispatch, "UNQUALIFIED")
        assert.equal(result.consistentAuthorityStateQualified, false)
        assert.equal(result.admissionAllowed, false)
        assert.equal(
          sql(
            'SELECT count(*) FROM public."ScanAuthorityEpoch" WHERE "isOpen";',
            "lyrashield_restore"
          ),
          "1"
        )
        rejected(verify())
      }
    )
    for (const schema of ["pg_catalog", "public"])
      for (const [label, argumentsSql] of [
        ["defaulted", "bytea,text,int DEFAULT 0"],
        ["variadic", "bytea,VARIADIC text[]"],
      ])
        await t.test(`rejects ${schema} ${label} digest overload before execution`, () => {
          restoreDispatch()
          sql(
            `CREATE FUNCTION ${schema}.digest(${argumentsSql}) RETURNS bytea LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RAISE EXCEPTION 'unreviewed overload executed'; END; $$;`,
            "lyrashield_restore"
          )
          // Exact-signature lookup still finds the reviewed function. It is not a resolver
          // for the actual call's defaulted/variadic candidates, so must not authorize execution.
          assert.equal(
            sql(
              "SET search_path=pg_catalog,public; SELECT pg_catalog.to_regprocedure('digest(bytea,text)')='public.digest(bytea,text)'::regprocedure;",
              "lyrashield_restore"
            ),
            "t"
          )
          assert.deepEqual(
            JSON.parse(
              sql(
                `BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; ${dispatchDigestProbeSql("authority_app_restore")} ROLLBACK;`,
                "lyrashield_restore"
              )
            ),
            { resolution: false, digest: null }
          )
          rejected(verify())
        })
    for (const [label, mutation] of [
      [
        "extension installed in an unresolved schema",
        "CREATE SCHEMA extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;",
      ],
      [
        "unreviewed extension version",
        "UPDATE pg_catalog.pg_extension SET extversion='unreviewed' WHERE extname='pgcrypto';",
      ],
      [
        "digest detached from extension membership",
        "ALTER EXTENSION pgcrypto DROP FUNCTION public.digest(bytea,text);",
      ],
      [
        "text digest detached from extension membership",
        "ALTER EXTENSION pgcrypto DROP FUNCTION public.digest(text,text);",
      ],
      [
        "extension-owned digest acquired a default argument",
        "CREATE OR REPLACE FUNCTION public.digest(bytea,text DEFAULT 'sha256') RETURNS bytea LANGUAGE c IMMUTABLE STRICT PARALLEL SAFE AS '$libdir/pgcrypto','pg_digest';",
      ],
      [
        "text digest metadata became unavailable",
        "UPDATE pg_catalog.pg_proc SET probin=NULL WHERE oid='public.digest(text,text)'::regprocedure;",
      ],
      [
        "missing helper execution grant",
        "REVOKE EXECUTE ON FUNCTION app.scan_policy_digest(text) FROM authority_app_restore;",
      ],
      [
        "missing digest execution grant",
        "REVOKE EXECUTE ON FUNCTION public.digest(bytea,text) FROM authority_app_restore;",
      ],
      [
        "missing helper schema usage grant",
        "REVOKE USAGE ON SCHEMA app FROM authority_app_restore;",
      ],
      ["missing Policy read grant", 'REVOKE SELECT ON public."Policy" FROM authority_app_restore;'],
      [
        "missing RLS helper execution grant",
        "REVOKE EXECUTE ON FUNCTION app.current_workspace_id() FROM authority_app_restore;",
      ],
      [
        "altered RLS helper",
        "CREATE OR REPLACE FUNCTION app.current_workspace_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'untrusted'::text $$;",
      ],
      [
        "digest resolved from an unreviewed system-schema shadow",
        "CREATE FUNCTION pg_catalog.digest(bytea,text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT public.digest($1,$2) $$;",
      ],
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
      [
        "constant attachment helper",
        "CREATE OR REPLACE FUNCTION app.scan_attachment_ids_valid(ids text[]) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT true $$;",
      ],
      [
        "constant target snapshot helper",
        "CREATE OR REPLACE FUNCTION app.scan_target_snapshot_digest(target_id text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT repeat('a',64) $$;",
      ],
      [
        "constant policy helper",
        "CREATE OR REPLACE FUNCTION app.scan_policy_digest(policy_id text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT repeat('a',64) $$;",
      ],
      [
        "constant dispatch scope helper",
        "CREATE OR REPLACE FUNCTION app.scan_dispatch_scope_digest(scan_id text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT repeat('a',64) $$;",
      ],
      ["helper strictness drift", "ALTER FUNCTION app.scan_policy_digest(text) STRICT;"],
      ["helper volatility drift", "ALTER FUNCTION app.scan_policy_digest(text) IMMUTABLE;"],
      [
        "helper parallel safety drift",
        "ALTER FUNCTION app.scan_policy_digest(text) PARALLEL SAFE;",
      ],
      [
        "helper search path drift",
        "ALTER FUNCTION app.scan_policy_digest(text) SET search_path=public;",
      ],
      [
        "helper signature drift",
        "ALTER FUNCTION app.scan_policy_digest(text) RENAME TO displaced_policy_digest; CREATE FUNCTION app.scan_policy_digest(text[]) RETURNS text LANGUAGE sql STABLE AS $$ SELECT repeat('a',64) $$;",
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
      sql(
        'GRANT SELECT ON public."ScanDispatchAttempt" TO authority_restore_group;',
        "lyrashield_restore"
      )
      sql("GRANT authority_restore_group TO authority_app_restore WITH INHERIT FALSE;")
      rejected(verify())
      sql("REVOKE authority_restore_group FROM authority_app_restore;")
    })
    const grantExecution = (schema, role, mode) => {
      const grantRole =
        mode === "PUBLIC" ? "PUBLIC" : mode === "direct" ? role : "authority_restore_group"
      return (
        `GRANT EXECUTE ON FUNCTION ${schema}.unreviewed_open() TO ${grantRole};` +
        (["inherited", "SET ROLE"].includes(mode)
          ? `GRANT authority_restore_group TO ${role} WITH INHERIT ${mode === "inherited" ? "TRUE" : "FALSE"};`
          : "")
      )
    }
    await t.test("restored system-definer absence is required even before an EXECUTE grant", () => {
      restoreDispatch()
      sql(
        "CREATE FUNCTION information_schema.unreviewed_private() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN; END; $$; REVOKE ALL ON FUNCTION information_schema.unreviewed_private() FROM PUBLIC;",
        "lyrashield_restore"
      )
      assert.equal(
        sql(
          "SELECT has_function_privilege('authority_app_restore','information_schema.unreviewed_private()','EXECUTE');",
          "lyrashield_restore"
        ),
        "f"
      )
      rejected(verify())
    })
    for (const schema of ["public", "app", "information_schema", "pg_catalog"])
      for (const mode of ["direct", "PUBLIC", "inherited", "SET ROLE"])
        await t.test(
          `rejects ${schema} privileged epoch opener reachable by application ${mode}`,
          () => {
            restoreDispatch()
            sql(
              `GRANT USAGE ON SCHEMA ${schema} TO authority_app_restore;
            CREATE FUNCTION ${schema}.unreviewed_open() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
            BEGIN INSERT INTO public."ScanAuthorityEpoch" (id,epoch,"isOpen","openKey","openedAt","updatedAt") VALUES ('isolated-test-open',2,true,'open',now(),now()); END; $$;
            REVOKE ALL ON FUNCTION ${schema}.unreviewed_open() FROM PUBLIC;
            ${grantExecution(schema, "authority_app_restore", mode)}`,
              "lyrashield_restore"
            )
            rejected(verify())
            assert.equal(
              sql(
                'SELECT count(*) FROM public."ScanAuthorityEpoch" WHERE "isOpen";',
                "lyrashield_restore"
              ),
              "0"
            )
            const callRole =
              mode === "SET ROLE" ? "authority_restore_group" : "authority_app_restore"
            if (mode === "SET ROLE")
              sql(
                `GRANT USAGE ON SCHEMA ${schema} TO authority_restore_group;`,
                "lyrashield_restore"
              )
            // Demonstrate the rejected capability on synthetic data, after proving verification left
            // the epoch closed. Application execution really would cross the table permission fence.
            sql(
              `SET ROLE ${callRole}; SELECT ${schema}.unreviewed_open(); RESET ROLE;`,
              "lyrashield_restore"
            )
            assert.equal(
              sql(
                'SELECT count(*) FROM public."ScanAuthorityEpoch" WHERE "isOpen";',
                "lyrashield_restore"
              ),
              "1"
            )
            sql("REVOKE authority_restore_group FROM authority_app_restore;")
          }
        )
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
        assert.equal(JSON.parse(result.stdout).mirror, "UNQUALIFIED")
        assert.equal(JSON.parse(result.stdout).consistentAuthorityStateQualified, false)
        assert.equal(JSON.parse(result.stdout).managedFailoverQualified, false)
      }
    )
    for (const schema of [
      "lyrashield_authority",
      "public",
      "app",
      "information_schema",
      "pg_catalog",
    ])
      for (const mode of ["direct", "PUBLIC", "inherited", "SET ROLE"])
        await t.test(
          `rejects ${schema} privileged stream opener reachable by mirror ${mode}`,
          () => {
            sql(
              `${schema === "app" ? "CREATE SCHEMA IF NOT EXISTS app;" : ""}
            GRANT USAGE ON SCHEMA ${schema} TO authority_mirror_restore,authority_restore_group;
            CREATE FUNCTION ${schema}.unreviewed_open() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
            BEGIN UPDATE lyrashield_authority.stream SET active=true; END; $$;
            REVOKE ALL ON FUNCTION ${schema}.unreviewed_open() FROM PUBLIC;
            ${grantExecution(schema, "authority_mirror_restore", mode)}`,
              "lyrashield_authority_restore"
            )
            rejected(verify(mirrorConfig))
            assert.equal(
              sql(
                "SELECT count(*) FROM lyrashield_authority.stream WHERE active;",
                "lyrashield_authority_restore"
              ),
              "0"
            )
            const callRole =
              mode === "SET ROLE" ? "authority_restore_group" : "authority_mirror_restore"
            sql(
              `SET ROLE ${callRole}; SELECT ${schema}.unreviewed_open(); RESET ROLE;`,
              "lyrashield_authority_restore"
            )
            assert.equal(
              sql(
                "SELECT count(*) FROM lyrashield_authority.stream WHERE active;",
                "lyrashield_authority_restore"
              ),
              "1"
            )
            sql(
              `UPDATE lyrashield_authority.stream SET active=false;
            DROP FUNCTION ${schema}.unreviewed_open();
            REVOKE USAGE ON SCHEMA ${schema} FROM authority_restore_group;`,
              "lyrashield_authority_restore"
            )
            sql("REVOKE authority_restore_group FROM authority_mirror_restore;")
            const result = verify(mirrorConfig)
            assert.equal(result.status, 0, result.stderr)
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
        "mirror function volatility drift",
        "ALTER FUNCTION lyrashield_authority.read_head(text,text) STABLE;",
        "ALTER FUNCTION lyrashield_authority.read_head(text,text) VOLATILE;",
      ],
      [
        "mirror function strictness drift",
        "ALTER FUNCTION lyrashield_authority.read_head(text,text) STRICT;",
        "ALTER FUNCTION lyrashield_authority.read_head(text,text) CALLED ON NULL INPUT;",
      ],
      [
        "mirror function execution grant option",
        "GRANT EXECUTE ON FUNCTION lyrashield_authority.read_head(text,text) TO authority_mirror_restore WITH GRANT OPTION;",
        "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION lyrashield_authority.read_head(text,text) FROM authority_mirror_restore;",
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
