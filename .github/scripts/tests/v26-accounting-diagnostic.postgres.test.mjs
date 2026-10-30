import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import test from "node:test"
import { collectLegacyAccountingDiagnostic } from "../v26-accounting-diagnostic.mjs"

const disposableUrl = process.env.V26_ACCOUNTING_DIAGNOSTIC_TEST_POSTGRES_URL
const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url))

test(
  "accounting diagnostic reads an isolated PostgreSQL snapshot with forced RLS",
  { skip: !disposableUrl, timeout: 60_000 },
  async (t) => {
    const url = new URL(disposableUrl)
    assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol))
    // Never inherit connection-string options that could redirect the socket.
    url.search = ""
    const suffix = randomUUID().replaceAll("-", "")
    const database = `v26_accounting_${suffix}`
    const restrictedRole = `v26_reader_${suffix}`
    const scopedRole = `v26_bypass_${suffix}`
    const quote = (name) => `"${name}"`
    const { Client } = require("pg")
    const admin = new Client({ connectionString: url.toString(), ssl: false })
    let client
    await admin.connect()
    try {
      const adminRole = await admin.query(
        "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user"
      )
      assert.equal(
        adminRole.rows[0]?.rolsuper,
        true,
        "isolated fixture requires a disposable superuser"
      )
      await admin.query(`CREATE DATABASE ${quote(database)}`)
      await admin.query(`CREATE ROLE ${quote(restrictedRole)} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
      await admin.query(`CREATE ROLE ${quote(scopedRole)} NOLOGIN NOSUPERUSER BYPASSRLS`)
      url.pathname = `/${database}`
      client = new Client({ connectionString: url.toString(), ssl: false })
      await client.connect()
      await client.query(`
        CREATE TYPE public."ScanStatus" AS ENUM
          ('QUEUED','PREFLIGHT','RUNNING','VERIFYING','REQUIRES_APPROVAL','COMPLETED','PARTIAL','FAILED','CANCELLED','STOPPED_BUDGET','TIMED_OUT');
        CREATE TABLE public."Scan" (
          id text PRIMARY KEY, "workspaceId" text NOT NULL, "createdById" text NOT NULL,
          "sponsorAccountId" text, status public."ScanStatus" NOT NULL, "startedAt" timestamp(3),
          "endedAt" timestamp(3), "finalizationStartedAt" timestamp(3), "deletedAt" timestamp(3)
        );
        CREATE TABLE public."ScanEvent" (
          id text PRIMARY KEY, "scanId" text NOT NULL, stage text NOT NULL, metadata jsonb, "deletedAt" timestamp(3)
        );
        CREATE TABLE public."UsageRecord" (
          id text PRIMARY KEY, "workspaceId" text, "accountId" text, kind text NOT NULL,
          "idempotencyKey" text UNIQUE, "deletedAt" timestamp(3), metadata jsonb
        );
        ALTER TABLE public."Scan" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public."Scan" FORCE ROW LEVEL SECURITY;
        ALTER TABLE public."ScanEvent" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public."ScanEvent" FORCE ROW LEVEL SECURITY;
        ALTER TABLE public."UsageRecord" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public."UsageRecord" FORCE ROW LEVEL SECURITY;
        CREATE POLICY invisible_scans ON public."Scan" USING (false);
        CREATE POLICY invisible_events ON public."ScanEvent" USING (false);
        CREATE POLICY invisible_usage ON public."UsageRecord" USING (false);
        GRANT SELECT ON public."Scan", public."ScanEvent", public."UsageRecord" TO ${quote(restrictedRole)}, ${quote(scopedRole)}
      `)

      await t.test("empty database inventory is bounded diagnostic evidence only", async () => {
        const observed = await collectLegacyAccountingDiagnostic(client)
        assert.equal(observed.status, "NO_DETECTED_DB_BLOCKERS")
        assert.equal(observed.cutoverReady, false)
      })

      await t.test(
        "soft-deleted active scans and unfinished finalization remain visible",
        async () => {
          await client.query(`INSERT INTO public."Scan" VALUES
          ('scan-private','workspace-private','creator-private','account-private','VERIFYING',
           '2026-10-30 01:00:00',NULL,'2026-10-30 01:00:30','2026-10-30 01:01:00')`)
          const observed = await collectLegacyAccountingDiagnostic(client)
          assert.equal(observed.status, "REVIEW_REQUIRED")
          assert.equal(observed.counts.activeScans, 1)
          assert.equal(observed.counts.unfinishedFinalizations, 1)
          assert.doesNotMatch(JSON.stringify(observed), /private/)
        }
      )

      await t.test(
        "an RLS-restricted role cannot mistake hidden rows for an empty inventory",
        async () => {
          await client.query(`SET ROLE ${quote(restrictedRole)}`)
          try {
            const hidden = await client.query('SELECT count(*)::int AS n FROM public."Scan"')
            assert.equal(hidden.rows[0].n, 0)
            const observed = await collectLegacyAccountingDiagnostic(client)
            assert.equal(observed.status, "REVIEW_REQUIRED")
            assert.equal(observed.counts.malformedSnapshot, 1)
            assert.equal(observed.cutoverReady, false)
          } finally {
            await client.query("RESET ROLE")
          }
        }
      )

      await t.test("a separately authorized bypass role sees the same forced-RLS row", async () => {
        await client.query(`SET ROLE ${quote(scopedRole)}`)
        try {
          const observed = await collectLegacyAccountingDiagnostic(client)
          assert.equal(observed.counts.activeScans, 1)
          assert.equal(observed.counts.malformedSnapshot, 0)
          assert.equal(observed.cutoverReady, false)
        } finally {
          await client.query("RESET ROLE")
        }
      })

      await t.test(
        "a terminal intent requires exact, undeleted account and scan receipt binding",
        async () => {
          await client.query(
            `UPDATE public."Scan" SET status = 'COMPLETED', "endedAt" = '2026-10-30 01:02:00'`
          )
          const intent = {
            workspaceId: "workspace-private",
            accountId: "account-private",
            idempotencyKey: "workspace-private:scan-private:engine_run",
            automaticReplayAllowed: false,
          }
          await client.query(
            `INSERT INTO public."ScanEvent" VALUES ('event','scan-private','billing_settlement_intent',$1,'2026-10-30 02:00:00')`,
            [JSON.stringify(intent)]
          )
          let observed = await collectLegacyAccountingDiagnostic(client)
          assert.equal(
            observed.counts.unsettledIntents,
            1,
            "deleted intent still represents an obligation"
          )
          await client.query(
            `INSERT INTO public."UsageRecord" VALUES ('receipt','workspace-private','other','agent_minutes', $1,NULL,$2)`,
            [intent.idempotencyKey, JSON.stringify({ scanId: "scan-private", accountId: "other" })]
          )
          observed = await collectLegacyAccountingDiagnostic(client)
          assert.equal(observed.counts.unsettledIntents, 1)
          await client.query(
            `UPDATE public."UsageRecord" SET "accountId"='account-private', metadata=$1`,
            [JSON.stringify({ scanId: "scan-private", accountId: "account-private" })]
          )
          observed = await collectLegacyAccountingDiagnostic(client)
          assert.equal(observed.status, "NO_DETECTED_DB_BLOCKERS")
          assert.equal(observed.counts.settledReceipts, 1)
          assert.equal(observed.cutoverReady, false)
          await client.query(`UPDATE public."UsageRecord" SET kind = 'pool_grant'`)
          observed = await collectLegacyAccountingDiagnostic(client)
          assert.equal(observed.status, "REVIEW_REQUIRED")
          assert.equal(observed.counts.unsettledIntents, 1)
          assert.equal(observed.historyDispositionComplete, false)
        }
      )

      await t.test(
        "old terminal scan without intent is unknown, not an invented debt",
        async () => {
          await client.query(`DELETE FROM public."ScanEvent"; DELETE FROM public."UsageRecord"`)
          const observed = await collectLegacyAccountingDiagnostic(client)
          assert.equal(observed.status, "NO_DETECTED_DB_BLOCKERS")
          assert.equal(observed.historyDispositionComplete, false)
          assert.equal(observed.counts.unknownDisposition, 1)
          assert.equal(observed.counts.unsettledIntents, 0)
        }
      )

      await t.test(
        "a wrong-kind receipt occupying a scan key blocks without an intent",
        async () => {
          await client.query(
            `INSERT INTO public."UsageRecord" VALUES ('wrong-kind','workspace-private','account-private','pool_grant',$1,NULL,$2)`,
            [
              "workspace-private:scan-private:engine_run",
              JSON.stringify({ scanId: "scan-private", accountId: "account-private" }),
            ]
          )
          const observed = await collectLegacyAccountingDiagnostic(client)
          assert.equal(observed.status, "REVIEW_REQUIRED")
          assert.equal(observed.counts.unboundReceipts, 1)
          assert.equal(observed.historyDispositionComplete, false)
          await client.query(`DELETE FROM public."UsageRecord" WHERE id = 'wrong-kind'`)
        }
      )

      await t.test("retained usage survives hard-deleted source scan and workspace", async () => {
        await client.query(
          `INSERT INTO public."UsageRecord" VALUES ('retained',NULL,NULL,'agent_minutes',NULL,NULL,$1)`,
          [JSON.stringify({ scanId: "deleted-scan", accountId: "historical-account" })]
        )
        const observed = await collectLegacyAccountingDiagnostic(client)
        assert.equal(observed.status, "NO_DETECTED_DB_BLOCKERS")
        assert.equal(observed.counts.orphanHistoryReceipts, 1)
        assert.equal(observed.counts.unsettledIntents, 0)
        assert.equal(observed.historyDispositionComplete, false)
        assert.doesNotMatch(JSON.stringify(observed), /historical|deleted-scan/)
      })

      await t.test("more than the bounded retained receipt inventory fails closed", async () => {
        await client.query(`INSERT INTO public."UsageRecord" (id,kind)
          SELECT 'receipt-' || n, 'agent_minutes' FROM generate_series(1, 10000) n`)
        const observed = await collectLegacyAccountingDiagnostic(client)
        assert.equal(observed.status, "REVIEW_REQUIRED")
        assert.equal(observed.counts.malformedSnapshot, 1)
        await client.query(`DELETE FROM public."UsageRecord"`)
      })

      await t.test("a partial schema or more than the bounded inventory fails closed", async () => {
        await client.query('ALTER TABLE public."Scan" RENAME COLUMN "endedAt" TO "oldEndedAt"')
        assert.equal((await collectLegacyAccountingDiagnostic(client)).status, "REVIEW_REQUIRED")
        await client.query('ALTER TABLE public."Scan" RENAME COLUMN "oldEndedAt" TO "endedAt"')
        await client.query('ALTER TABLE public."Scan" ADD COLUMN "accountingVersion" integer')
        assert.equal((await collectLegacyAccountingDiagnostic(client)).counts.malformedSnapshot, 1)
        await client.query('ALTER TABLE public."Scan" DROP COLUMN "accountingVersion"')
        await client.query('CREATE TABLE public."UserScanSlot" (id text)')
        assert.equal((await collectLegacyAccountingDiagnostic(client)).counts.malformedSnapshot, 1)
        await client.query('DROP TABLE public."UserScanSlot"')
        await client.query(`INSERT INTO public."Scan" (id,"workspaceId","createdById",status)
          SELECT 'generated-' || n, 'workspace', 'user', 'QUEUED'
          FROM generate_series(1, 10000) n`)
        const observed = await collectLegacyAccountingDiagnostic(client)
        assert.equal(observed.status, "REVIEW_REQUIRED")
        assert.equal(observed.counts.malformedSnapshot, 1)
      })
    } finally {
      if (client) await client.end()
      await admin.query(`DROP DATABASE IF EXISTS ${quote(database)}`)
      await admin.query(`DROP ROLE IF EXISTS ${quote(restrictedRole)}`)
      await admin.query(`DROP ROLE IF EXISTS ${quote(scopedRole)}`)
      await admin.end()
    }
  }
)
