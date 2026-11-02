import test from "node:test"
import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copySnapshot, verifySnapshot } from "../restore-snapshot-integrity.mjs"

const image = "postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
const repository = new URL("../../../", import.meta.url)

test(
  "owned PostgreSQL 17 archive round trip and fail-closed snapshot stages",
  { skip: process.env.RESTORE_SNAPSHOT_RUNTIME_TEST !== "1", timeout: 180_000 },
  async (t) => {
    // No DATABASE_URL, existing service, host port, production credentials or
    // dependency on developer .env. All SQL is synthetic and sent over stdin.
    const password = randomBytes(32).toString("hex")
    const docker = (args, input) => {
      const result = spawnSync("docker", args, {
        env: { ...process.env, POSTGRES_PASSWORD: password },
        input,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      })
      assert.equal(result.status, 0, "owned disposable PostgreSQL command failed")
      return result.stdout
    }
    const endpoint = JSON.parse(docker(["context", "inspect"]).toString())[0].Endpoints.docker.Host
    assert.match(process.env.DOCKER_HOST ?? endpoint, /^unix:\/\//)
    const owner = randomUUID()
    const name = `lyrashield-snapshot-test-${owner}`
    const directory = mkdtempSync(join(tmpdir(), "lyra-snapshot-runtime-"))
    let id
    t.after(() => {
      try {
        if (id) {
          const inspect = JSON.parse(docker(["inspect", id]).toString())[0]
          assert.equal(inspect.Id, id)
          assert.equal(inspect.Name, `/${name}`)
          assert.equal(inspect.Config.Labels["lyrashield.snapshot-test"], owner)
          docker(["rm", "-fv", id])
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
    id = docker(
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `lyrashield.snapshot-test=${owner}`,
        "--network",
        "none",
        "--mount",
        "type=tmpfs,destination=/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=restore",
        "-e",
        "POSTGRES_PASSWORD",
        "-e",
        "POSTGRES_DB=source",
        image,
      ],
      undefined
    )
      .toString()
      .trim()
    assert.match(id, /^[a-f0-9]{64}$/)
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      // TCP is unavailable on the temporary init server, preventing a race
      // with its shutdown before the final server starts.
      const probe = spawnSync(
        "docker",
        ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "restore", "-d", "source"],
        { timeout: 2000 }
      )
      if (probe.status === 0) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(ready, true, "owned PostgreSQL did not become ready")
    const sql = (query, db = "source") =>
      docker(
        ["exec", "-i", id, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "restore", "-d", db],
        query
      )
    sql(`CREATE DATABASE lyrashield_restore;`)
    sql(`
      CREATE SCHEMA app;
      CREATE TYPE public.state AS ENUM ('new','done');
      CREATE TABLE public."Rows" (
        id bigint, body text, bytes bytea, payload jsonb, amount numeric(19,4),
        ratio double precision, moment timestamptz, day date, tags text[], state public.state
      );
      INSERT INTO public."Rows" VALUES
        (1,E'private\\nline\\ttab\\rreturn\\\\slash世界','\\x00ff','{"nested":[null,true,"✓"]}',123456789.1234,1.2345678901234567,'2026-11-01T02:30:00+05:30','2026-11-01',ARRAY['a,b',NULL,E'line\\nbreak'],'new'),
        (2,NULL,NULL,NULL,-0.0001,'Infinity','infinity','infinity',ARRAY[]::text[],'done'),
        (2,NULL,NULL,NULL,-0.0001,'Infinity','infinity','infinity',ARRAY[]::text[],'done');
      CREATE TABLE app.empty (id text);
      CREATE TABLE app."quoted""table" ("column with space" text);
      INSERT INTO app."quoted""table" VALUES ('escaped identifier');
      CREATE TABLE public.partitioned (id integer, body text) PARTITION BY RANGE (id);
      CREATE TABLE public.child PARTITION OF public.partitioned FOR VALUES FROM (0) TO (10);
      INSERT INTO public.partitioned VALUES (1,'partition row');
      CREATE TABLE public.protected (id integer, body text);
      ALTER TABLE public.protected ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.protected FORCE ROW LEVEL SECURITY;
      CREATE POLICY invisible ON public.protected USING (false);
      INSERT INTO public.protected VALUES (1,'RLS row must be included by dump owner');
    `)
    const dump = docker([
      "exec",
      id,
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
    ])
    const digest = createHash("sha256").update(dump).digest("hex")
    writeFileSync(join(directory, "backup.dump"), dump, { mode: 0o600 })
    docker(["exec", "-i", id, "sh", "-c", "cat > /tmp/backup.dump"], dump)
    const expectedSql = docker([
      "exec",
      id,
      "pg_restore",
      "--data-only",
      "--no-owner",
      "--no-acl",
      "--file=-",
      "/tmp/backup.dump",
    ]).toString("utf8")
    const expected = await copySnapshot(expectedSql.split("\n"), digest)
    const actual = async () =>
      copySnapshot(
        docker([
          "exec",
          id,
          "pg_dump",
          "-U",
          "restore",
          "-d",
          "lyrashield_restore",
          "--data-only",
          "--schema=public",
          "--schema=app",
          "--no-owner",
          "--no-acl",
        ])
          .toString("utf8")
          .split("\n"),
        digest
      )
    const restore = () => {
      sql("DROP DATABASE lyrashield_restore; CREATE DATABASE lyrashield_restore;")
      return docker([
        "exec",
        id,
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
        "/tmp/backup.dump",
      ])
    }
    const runStages = () =>
      spawnSync("bash", ["-c", "exec 3>&1; bash .github/scripts/verify-restore-snapshot.sh"], {
        cwd: repository,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          RUNNER_TEMP: directory,
          BACKUP_DUMP_SHA256: digest,
          RESTORE_SNAPSHOT_CONTAINER: name,
        },
      })
    await t.test(
      "same archive survives later source writes and restores both schemas, empty, duplicate, escaped, typed, partition and forced-RLS rows",
      async () => {
        sql(`INSERT INTO public."Rows" (id,body) VALUES (3,'later source row');`)
        restore()
        verifySnapshot(expected, await actual())
        assert.equal(expected.tables['public."Rows"'].count, 3)
        assert.equal(expected.tables["app.empty"].count, 0)
        assert.equal(expected.tables["public.child"].count, 1)
        assert.equal(expected.tables["public.protected"].count, 1)
        const result = runStages()
        assert.equal(result.status, 0, result.stdout)
        assert.equal(result.stdout, "restore/snapshot/complete\n")
        assert.deepEqual(readdirSync(directory), ["backup.dump"])
      }
    )
    for (const [label, mutation] of [
      ["same-count content drift", `UPDATE public."Rows" SET body='changed' WHERE id=1`],
      [
        "duplicate loss",
        `DELETE FROM public."Rows" WHERE ctid IN (SELECT ctid FROM public."Rows" WHERE id=2 LIMIT 1)`,
      ],
      ["unexpected row", `INSERT INTO public."Rows" (id) VALUES (4)`],
      ["missing table", `DROP TABLE app.empty`],
      ["unexpected empty table", `CREATE TABLE app.extra (id text)`],
      ["column drift", `ALTER TABLE app.empty ADD COLUMN extra text`],
    ]) {
      await t.test(
        `rejects ${label} and identifies compare stage without row context`,
        async () => {
          restore()
          sql(mutation, "lyrashield_restore")
          const observed = await actual()
          assert.throws(() => verifySnapshot(expected, observed), /mismatch/)
          const result = runStages()
          assert.notEqual(result.status, 0)
          assert.equal(
            result.stdout,
            "restore/snapshot/reason/snapshot-content-mismatch\nrestore/snapshot/compare/failed\n"
          )
          assert.doesNotMatch(result.stdout, /private|Rows|changed|postgresql/)
          assert.deepEqual(readdirSync(directory), ["backup.dump"])
        }
      )
    }
  }
)
