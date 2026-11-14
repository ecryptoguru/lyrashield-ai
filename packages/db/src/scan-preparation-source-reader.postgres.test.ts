import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
  preparationFixture,
} from "../scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { canonicalJson } from "@lyrashield/runtime-control"

await vi.hoisted(async () => {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({
    ...process.env,
    RLS_RUNTIME_DATABASE_URL: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
  })
})
const enabled =
  process.env.SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST === "1" &&
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1"
let owner: pg.Pool, reader: pg.Pool
const role = "source_fixture_" + randomBytes(12).toString("hex")
const password = randomBytes(24).toString("hex")
const worker = queueFixtureWorker()

describe.skipIf(!enabled)(
  "purpose-specific preparation source reader on disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
      await worker.open()
      await applyPreparationFixtureMigration(owner)
      await installPreparationFixtureRole(owner)
      if (
        !(
          await owner.query(
            "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='require_scan_preparation_source_role'"
          )
        ).rowCount
      )
        await owner.query(
          await readFile(
            new URL(
              "../prisma/migrations/20261114170000_scan_preparation_source_reader/migration.sql",
              import.meta.url
            ),
            "utf8"
          )
        )
      // Both interpolations are generated lowercase hex, never request/environment text.
      await owner.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT`
      )
      await owner.query(`DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC,${role}',current_database()); END $$;
      GRANT lyrashield_preparation_source_reader TO ${role} WITH SET FALSE`)
      const url = new URL(process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!)
      url.username = role
      url.password = password
      reader = new pg.Pool({ connectionString: url.toString(), max: 1 })
    })
    afterAll(async () => {
      await reader?.end()
      await worker.close()
      if (owner) {
        if ((await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount)
          await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`)
        await owner.end()
      }
    })
    it("accepts a direct readonly source login while denying staging without its shared source gate", async () => {
      await expect(
        reader.query("SELECT app.require_scan_preparation_source_role()")
      ).resolves.toBeDefined()
      await expect(
        reader.query(
          "SELECT * FROM app.require_scan_dispatch_worker_stage('operation-fixture',$1)",
          ["a".repeat(64)]
        )
      ).rejects.toMatchObject({ code: "42501" })
    })
    it("rejects per-column mutation privileges", async () => {
      await owner.query(`GRANT UPDATE ("branch") ON "Target" TO ${role}`)
      try {
        await expect(
          reader.query("SELECT app.require_scan_preparation_source_role()")
        ).rejects.toMatchObject({ code: "42501" })
      } finally {
        await owner.query(`REVOKE UPDATE ("branch") ON "Target" FROM ${role}`)
      }
    })
    it("rejects unrelated PREPARE capabilities", async () => {
      await owner.query(
        `GRANT EXECUTE ON FUNCTION app.assign_scan_dispatch_worker(text) TO ${role}`
      )
      try {
        await expect(
          reader.query("SELECT app.require_scan_preparation_source_role()")
        ).rejects.toMatchObject({ code: "42501" })
      } finally {
        await owner.query(
          `REVOKE EXECUTE ON FUNCTION app.assign_scan_dispatch_worker(text) FROM ${role}`
        )
      }
    })
    it("reads an assigned exact persisted revision and closes revoked membership before source network", async () => {
      const { readPreparationSource } = await import("../../../apps/broker/src/preparation-source")
      const fixture = await preparationFixture(owner, 1, "source-reader")
      await owner.query(
        `UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=CURRENT_TIMESTAMP WHERE id<>$1 AND "revokedAt" IS NULL`,
        [fixture.grantId]
      )
      const targetId = fixture.targetId + "-github",
        scanId = fixture.scanId + "-github",
        operationId = fixture.operationId + "-github"
      const attachmentId = scanId + "-attachment"
      const plan = buildScanExecutionPlan({
        targetType: "REPO",
        mode: "STANDARD",
        source: { revision: "a".repeat(40) },
        attachmentIds: [attachmentId],
      })
      const hash = createHash("sha256").update(canonicalJson(plan)).digest("hex")
      await owner.query(
        `INSERT INTO "Target"(id,"workspaceId",type,name,"repoProvider","repoFullName","installationId","createdAt","updatedAt")
        VALUES($1,$2,'REPO',$1,'github','owner/source','123',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [targetId, fixture.workspaceId]
      )
      await owner.query(
        `INSERT INTO "Scan"(id,"workspaceId","targetId",goal,mode,status,"triggerType","accountingVersion","executionPlan","executionPlanHash","createdById","sponsorAccountId","createdAt","updatedAt")
        VALUES($1,$2,$3,'TEST_APP','STANDARD','QUEUED','manual',2,$4::jsonb,$5,$6,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [scanId, fixture.workspaceId, targetId, canonicalJson(plan), hash, fixture.userId]
      )
      await owner.query(
        `INSERT INTO "ScanDispatchOperation"("operationId","scanId","workspaceId","protocolVersion","requestDigest",state,"createdAt","updatedAt")
        VALUES($1,$2,$3,3,app.scan_dispatch_scope_digest($2),'QUEUED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [operationId, scanId, fixture.workspaceId]
      )
      await owner.query(
        `INSERT INTO "ScanDispatchWorkerAssignment"("operationId","workspaceId","workerGrantId","authorityEpochId") VALUES($1,$2,$3,$4)`,
        [operationId, fixture.workspaceId, fixture.grantId, fixture.epochId]
      )
      await owner.query(
        `INSERT INTO "Integration"(id,"workspaceId",type,name,"externalId",status,"createdAt","updatedAt") VALUES($1,$2,'GITHUB','source','123','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [fixture.targetId + "-integration", fixture.workspaceId]
      )
      await owner.query(
        `INSERT INTO "ScanAttachment"(id,"workspaceId",filename,"mediaType","byteLength",checksum,"storageUri","encryptionKeyRef","createdById")
         VALUES($1,$2,'notes.txt','text/plain',7,$3,$4,'kms://fixture/evidence/1',$5)`,
        [
          attachmentId,
          fixture.workspaceId,
          "f".repeat(64),
          "s3://fixture/" + fixture.workspaceId + "/" + attachmentId,
          fixture.userId,
        ]
      )
      const request = {
        operationId,
        credentialHash: createHash("sha256").update(fixture.grantId).digest("hex"),
      }
      const source = await readPreparationSource(reader, request)
      expect(source.executionPlan.source?.revision).toBe("a".repeat(40))
      expect(source.workspaceId).toBe(fixture.workspaceId)
      expect(source.attachments).toHaveLength(1)
      const broker = new pg.Pool({
        connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
        max: 1,
      })
      async function checkAttachments() {
        const client = await broker.connect()
        try {
          await client.query("BEGIN")
          await client.query(
            "SELECT set_config('app.current_workspace_id',$1,true),set_config('app.current_account_id',$2,true)",
            [fixture.workspaceId, fixture.userId]
          )
          await client.query("SELECT app.acquire_scan_preparation_gate()")
          return await client.query(
            "SELECT * FROM app.check_scan_preparation_authority($1,(clock_timestamp()+interval '5 seconds')::timestamp)",
            [scanId]
          )
        } finally {
          await client.query("ROLLBACK")
          client.release()
        }
      }
      try {
        await expect(checkAttachments()).resolves.toMatchObject({ rowCount: 1 })
        await owner.query(`UPDATE "ScanAttachment" SET status='DELETED' WHERE id=$1`, [
          attachmentId,
        ])
        await expect(checkAttachments()).rejects.toThrow("attachments unavailable")
        await expect(readPreparationSource(reader, request)).rejects.toThrow(
          "attachments unavailable"
        )
        await owner.query(`UPDATE "ScanAttachment" SET status='ACTIVE' WHERE id=$1`, [attachmentId])
      } finally {
        await broker.end()
      }
      await owner.query(
        `UPDATE "WorkspaceMember" SET status='removed' WHERE "workspaceId"=$1 AND "userId"=$2`,
        [fixture.workspaceId, fixture.userId]
      )
      await expect(readPreparationSource(reader, request)).rejects.toThrow(
        "Persisted source plan unavailable"
      )
    })
  }
)
