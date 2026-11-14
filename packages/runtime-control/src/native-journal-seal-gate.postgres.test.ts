import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NativeInstalledJournalSealGate } from "./native-journal-seal-gate"
import type { AuthoritySqlPool } from "./postgres-mirror"

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: vi.fn(() => ({ uid: 0, mode: 0o100644, isSymbolicLink: () => false })),
}))
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>()
  return {
    ...real,
    execFileSync: vi.fn((file: string, args: string[], options: unknown) =>
      file === "/usr/bin/python3"
        ? Buffer.from(JSON.stringify(policy))
        : Reflect.apply(real.execFileSync, real, [file, args, options])
    ),
  }
})

const native = process.env.LYRASHIELD_NATIVE_JOURNAL_SEAL_GATE === "1"
const source = "a".repeat(40),
  role = "lyrashield_journal_seal_control"
const stream = { epochId: "epoch-test", supervisorInstanceId: "supervisor-test" }
const policy = {
  schema: "lyrashield-journal-seal-control/1",
  productRevision: source,
  ...stream,
  epoch: 1,
  streamId: "stream-test",
  originalKeyHash: "b".repeat(64),
  wrapperKeyHash: "c".repeat(64),
  checkpointKeyHash: "d".repeat(64),
  controlAccountId: "e".repeat(32),
  controlCredentialId: "a".repeat(32),
  controlBucket: "control-test",
  genesisRecordHash: "f".repeat(64),
  databaseRole: role,
  authorityDigest: "sha256:" + "1".repeat(64),
  runtimePolicyDigest: "sha256:" + "2".repeat(64),
}
describe.skipIf(!native)(
  "native PostgreSQL installed stream gate (source loader fixture; real SQL role/locks)",
  () => {
    const container = "lyrashield-pin-gate-" + randomUUID()
    let admin: pg.Pool, runtime: pg.Pool, gate: NativeInstalledJournalSealGate
    beforeAll(async () => {
      execFileSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          container,
          "-e",
          "POSTGRES_PASSWORD=disposable-pin-fixture",
          "-p",
          "127.0.0.1::5432",
          "postgres:17-alpine",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      )
      const port = execFileSync("docker", ["port", container, "5432/tcp"])
        .toString()
        .trim()
        .split(":")
        .at(-1)
      admin = new pg.Pool({
        connectionString: `postgresql://postgres:disposable-pin-fixture@127.0.0.1:${port}/postgres`,
      })
      for (let n = 0; n < 80; n++) {
        try {
          await admin.query("SELECT 1")
          break
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      await admin.query(`CREATE SCHEMA app; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE TEMP ON DATABASE postgres FROM PUBLIC;
      CREATE TABLE "ScanAuthorityEpoch"(id text PRIMARY KEY,epoch integer UNIQUE,"isOpen" boolean,"openKey" text UNIQUE,"updatedAt" timestamptz);
      CREATE TABLE "ScanSupervisorJournalStream"(id text PRIMARY KEY,"authorityEpochId" text REFERENCES "ScanAuthorityEpoch", "supervisorInstanceId" text,"originalKeyHash" text,"wrapperKeyHash" text,"updatedAt" timestamptz);
      CREATE ROLE ${role} LOGIN PASSWORD 'disposable-pin-fixture';
      GRANT USAGE ON SCHEMA public,app TO ${role};
      GRANT SELECT ON "ScanAuthorityEpoch","ScanSupervisorJournalStream" TO ${role};
      GRANT UPDATE("updatedAt") ON "ScanAuthorityEpoch","ScanSupervisorJournalStream" TO ${role};`)
      await admin.query(`INSERT INTO "ScanAuthorityEpoch" VALUES('epoch-test',1,true,'open',now())`)
      await admin.query(
        `INSERT INTO "ScanSupervisorJournalStream" VALUES('stream-test','epoch-test','supervisor-test',$1,$2,now())`,
        [policy.originalKeyHash, policy.wrapperKeyHash]
      )
      runtime = new pg.Pool({
        connectionString: `postgresql://${role}:disposable-pin-fixture@127.0.0.1:${port}/postgres`,
      })
      gate = new NativeInstalledJournalSealGate(runtime as unknown as AuthoritySqlPool, source)
      // Cryptographic/protected-file loading is tested against real Linux RSA
      // fixtures separately. This seam isolates actual PostgreSQL gate behavior.
      vi.spyOn(process, "getuid").mockReturnValue(0)
    }, 30_000)
    afterAll(async () => {
      vi.restoreAllMocks()
      await runtime?.end()
      await admin?.end()
      try {
        execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" })
      } catch {
        /* Only owned fixture. */
      }
    })
    it("accepts actual narrowly granted direct role and exact installed stream", async () => {
      expect(
        await gate.withAuthorizedStream(stream, async ({ assertActive }) => {
          assertActive()
          return "held"
        })
      ).toBe("held")
    })
    it("rejects actual changed stream fingerprint before callback", async () => {
      await admin.query(`UPDATE "ScanSupervisorJournalStream" SET "originalKeyHash"=$1`, [
        "9".repeat(64),
      ])
      let called = false
      await expect(
        gate.withAuthorizedStream(stream, async () => {
          called = true
        })
      ).rejects.toThrow()
      expect(called).toBe(false)
      await admin.query(`UPDATE "ScanSupervisorJournalStream" SET "originalKeyHash"=$1`, [
        policy.originalKeyHash,
      ])
    })
    it("blocks real epoch revocation while invocation is inside row/session gate", async () => {
      await gate.withAuthorizedStream(stream, async ({ assertActive }) => {
        const revoker = await admin.connect()
        try {
          await revoker.query("SET lock_timeout='200ms'")
          await expect(
            revoker.query(`UPDATE "ScanAuthorityEpoch" SET "isOpen"=false,"openKey"=null`)
          ).rejects.toMatchObject({ code: "55P03" })
          assertActive()
        } finally {
          revoker.release()
        }
      })
      await admin.query(`UPDATE "ScanAuthorityEpoch" SET "isOpen"=false,"openKey"=null`)
      await expect(gate.withAuthorizedStream(stream, async () => "must not run")).rejects.toThrow()
      await admin.query(`UPDATE "ScanAuthorityEpoch" SET "isOpen"=true,"openKey"='open'`)
    })
    it("connection loss invalidates the actual held gate before next CAS invocation", async () => {
      await expect(
        gate.withAuthorizedStream(stream, async ({ assertActive }) => {
          await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND state='idle in transaction'`,
            [role]
          )
          await new Promise((r) => setTimeout(r, 50))
          assertActive()
        })
      ).rejects.toThrow()
    })
  }
)
