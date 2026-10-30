import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createHash, randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { copySnapshot, verifySnapshot } from "../restore-snapshot-integrity.mjs"
const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url))
const { Pool } = require("pg")

test(
  "same custom archive restores matching private rows and rejects later content drift",
  {
    skip: process.env.RESTORE_SNAPSHOT_RUNTIME_TEST !== "1",
  },
  async (t) => {
    assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
    const address = new URL(process.env.DATABASE_URL)
    assert.ok(["localhost", "127.0.0.1"].includes(address.hostname))
    assert.equal(address.pathname, "/lyrashield")
    const container = process.env.RESTORE_SNAPSHOT_TEST_CONTAINER
    assert.equal(
      container,
      "lyrashield-v26-postgres",
      "use only the explicitly named disposable service"
    )
    const pool = new Pool({ connectionString: address.href, max: 1 })
    const schema = `snapshot_${randomBytes(8).toString("hex")}`
    t.after(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await pool.end()
    })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE "${schema}".business_rows (id text, body text)`)
    await pool.query(`INSERT INTO "${schema}".business_rows VALUES ($1,$2),($3,$4),($3,$4)`, [
      "1",
      "private\nline\tvalue",
      "2",
      "duplicate",
    ])
    function docker(args, input) {
      const result = spawnSync(
        "docker",
        ["exec", "-i", "--env", "PGPASSWORD", container, ...args],
        {
          input,
          env: { ...process.env, PGPASSWORD: decodeURIComponent(address.password) },
          timeout: 20_000,
        }
      )
      assert.equal(result.status, 0, "disposable PostgreSQL client failed")
      return result.stdout
    }
    const dump = docker([
      "pg_dump",
      "-U",
      decodeURIComponent(address.username),
      "-d",
      "lyrashield",
      `--schema=${schema}`,
      "--format=custom",
      "--no-owner",
      "--no-acl",
    ])
    const digest = createHash("sha256").update(dump).digest("hex")
    const expectedSql = docker(
      ["pg_restore", "--data-only", "--no-owner", "--no-acl", "--file=-"],
      dump
    ).toString("utf8")
    const expected = await copySnapshot(expectedSql.split("\n"), digest)
    // Later source writes must not redefine expected content for the archive.
    await pool.query(`INSERT INTO "${schema}".business_rows VALUES ('3','later-live-row')`)
    await pool.query(`TRUNCATE "${schema}".business_rows`)
    docker(
      [
        "pg_restore",
        "-U",
        decodeURIComponent(address.username),
        "-d",
        "lyrashield",
        "--data-only",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
      ],
      dump
    )
    const actual = async () =>
      copySnapshot(
        docker([
          "pg_dump",
          "-U",
          decodeURIComponent(address.username),
          "-d",
          "lyrashield",
          `--schema=${schema}`,
          "--data-only",
          "--no-owner",
          "--no-acl",
        ])
          .toString("utf8")
          .split("\n"),
        digest
      )
    verifySnapshot(expected, await actual())
    await pool.query(`UPDATE "${schema}".business_rows SET body='changed' WHERE id='1'`)
    const drifted = await actual()
    assert.throws(() => verifySnapshot(expected, drifted), /mismatch/)
  }
)
