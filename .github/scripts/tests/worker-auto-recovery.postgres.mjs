// Opt-in SQL proof: an invocation-owned, network-isolated disposable PostgreSQL.
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { RECOVERY_UNKNOWN_SQL } from "../../../ops/worker/worker-recovery-probe.mjs"
if (process.env.LYRASHIELD_RUN_WORKER_RECOVERY_POSTGRES_PROOF !== "1")
  throw new Error("Enable isolated recovery PostgreSQL proof explicitly")
const name = `lyrashield-recovery-pg-${randomUUID()}`
const docker = (args, input) =>
  execFileSync("docker", args, { input, encoding: "utf8", timeout: 30000 })
const sql = (input) =>
  docker(["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], input)
const ambiguous = () => sql(RECOVERY_UNKNOWN_SQL).trim() === "t"
try {
  docker([
    "run",
    "--rm",
    "--detach",
    "--name",
    name,
    "--network=none",
    "--env",
    "POSTGRES_PASSWORD=isolated-recovery-fixture",
    "postgres@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb",
  ])
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      docker(["exec", name, "pg_isready", "-U", "postgres"])
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  sql(`CREATE TABLE "Scan" (id text PRIMARY KEY, "workspaceId" text, "sponsorAccountId" text, "createdById" text);
CREATE TABLE "ScanCapacityReservation" ("scanId" text PRIMARY KEY, "workspaceId" text, "accountId" text, state text, "stoppedAt" timestamptz);
CREATE TABLE "ScanEvent" ("scanId" text, stage text);
CREATE TABLE "ScanDispatchOperation" ("operationId" text, "scanId" text, "workspaceId" text, state text);
CREATE TABLE "ScanPhysicalExecution" ("operationId" text, "scanId" text, "workspaceId" text, state text);`)
  assert.equal(ambiguous(), false)
  sql(`INSERT INTO "Scan" VALUES ('scan','workspace',NULL,'account');
INSERT INTO "ScanCapacityReservation" VALUES ('scan','workspace','account','REVIEW_REQUIRED',NULL);
INSERT INTO "ScanEvent" VALUES ('scan','billable_boundary');`)
  assert.equal(ambiguous(), false, "persisted claim quarantines held reservation")
  sql('DELETE FROM "ScanEvent";')
  assert.equal(ambiguous(), true, "unmarked ambiguous funded work cannot authorize recovery")
  sql(`INSERT INTO "ScanDispatchOperation" VALUES ('operation','scan','workspace','UNKNOWN');`)
  assert.equal(
    ambiguous(),
    true,
    "shadow UNKNOWN alone cannot quarantine an unmarked legacy paid claim"
  )
  sql(`INSERT INTO "ScanEvent" VALUES ('scan','billable_boundary');`)
  assert.equal(ambiguous(), false, "lifetime claim and held reservation preserve quarantine")
  sql(`UPDATE "ScanCapacityReservation" SET "accountId"='foreign';`)
  assert.equal(ambiguous(), true, "payer identity mismatch cannot be hidden by UNKNOWN")
  sql(`UPDATE "ScanCapacityReservation" SET "accountId"='account';
INSERT INTO "ScanPhysicalExecution" VALUES ('operation','scan','workspace','UNKNOWN');`)
  assert.equal(ambiguous(), false)
  sql(`UPDATE "ScanDispatchOperation" SET state='ACTIVE';`)
  assert.equal(ambiguous(), true, "unquarantined UNKNOWN physical state fails closed")
  assert.equal(sql('SELECT state FROM "ScanCapacityReservation";').trim(), "REVIEW_REQUIRED")
  assert.equal(sql('SELECT count(*) FROM "ScanPhysicalExecution";').trim(), "1")
  console.log(
    JSON.stringify({
      isolatedRecoverySql: "PASS",
      preservedClaimAndHold: "PASS",
      inconsistentAuthority: "HELD",
    })
  )
} finally {
  docker(["rm", "--force", name])
}
