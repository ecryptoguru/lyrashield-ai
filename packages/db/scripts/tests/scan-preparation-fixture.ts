import { randomUUID, createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type pg from "pg"
import { buildScanExecutionPlan, ScanExecutionPlanSchema } from "@lyrashield/types"
import { computeScanExecutionPlanHash } from "../../src/scan-execution-plan"
import { commandDigest } from "../../src/scan-dispatch-authority-broker-methods"
import { publishFixtureOutbox } from "./queue-outbox-fixture"

export type PreparationFixture = {
  userId: string
  workspaceId: string
  targetId: string
  scanId: string
  operationId: string
  grantId: string
  epochId: string
  instanceId: string
}

export async function preparationFixture(
  owner: pg.Pool,
  maxBudgetUsd = 1,
  prefix = "fence",
  planInput?: Parameters<typeof buildScanExecutionPlan>[0],
  delegated = false,
  capacityState: "RESERVED" | "WAITING" = "RESERVED",
  authority: { epochId?: string; grantExpiresAt?: Date } = {}
) {
  const suffix = `${prefix}-${randomUUID()}`
  const f: PreparationFixture = {
    userId: `${suffix}-user`,
    workspaceId: `${suffix}-workspace`,
    targetId: `${suffix}-target`,
    scanId: `${suffix}-scan`,
    operationId: `${suffix}-operation`,
    grantId: `${suffix}-grant`,
    epochId: authority.epochId ?? "authority-shared-open-epoch",
    instanceId: `${suffix}-instance`,
  }
  const plan = ScanExecutionPlanSchema.parse({
    ...buildScanExecutionPlan({
      ...planInput,
      targetType: planInput?.targetType ?? "REPO",
      mode: planInput?.mode ?? "SAFE",
      source: planInput?.source ?? { revision: "a".repeat(40) },
    }),
    limits: { maxBudgetUsd, maxDurationMs: 60000, maxEngineMs: 48000, scannerReserveMs: 12000 },
  })
  await owner.query(
    `INSERT INTO users(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [f.userId, `${f.userId}@example.test`]
  )
  await owner.query(
    `INSERT INTO "Workspace"(id,name,slug,"createdAt","updatedAt") VALUES($1,$1,$1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [f.workspaceId]
  )
  await owner.query(
    `INSERT INTO "WorkspaceMember"(id,"workspaceId","userId",role,status,"createdAt","updatedAt") VALUES($1,$2,$3,'VIEWER','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [`${suffix}-member`, f.workspaceId, f.userId]
  )
  await owner.query(
    `INSERT INTO "BillingAccount"(id,"accountId",status,"currentPlan","createdAt","updatedAt") VALUES($1,$2,'active','PRO',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [`${suffix}-billing`, f.userId]
  )
  await owner.query(
    `INSERT INTO "Target"(id,"workspaceId",type,name,"createdAt","updatedAt") VALUES($1,$2,'REPO',$1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [f.targetId, f.workspaceId]
  )
  if (delegated)
    await owner.query(
      `INSERT INTO agent_connections(id,"workspaceId","userId","clientType",status,scopes,"allowedTargetIds","allowedOperations","allowedProfiles","authorizationVersion","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,'fixture','ACTIVE',ARRAY['lyrashield.write'],ARRAY[$4],ARRAY['scan.create'],ARRAY['SAFE'],1,CURRENT_TIMESTAMP+interval '1 minute',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [`${suffix}-connection`, f.workspaceId, f.userId, f.targetId]
    )
  await owner.query(
    `INSERT INTO "Scan"(id,"workspaceId","targetId",goal,mode,status,"triggerType","accountingVersion","executionPlan","executionPlanHash","createdById","sponsorAccountId","delegatedConnectionId","delegatedAuthorizationVersion","createdAt","updatedAt") VALUES($1,$2,$3,$7::"ScanGoal",$8::"ScanMode",'QUEUED','manual',2,$4::jsonb,$5,$6,$6,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      f.scanId,
      f.workspaceId,
      f.targetId,
      JSON.stringify(plan),
      computeScanExecutionPlanHash(plan),
      f.userId,
      plan.workflow === "REVIEW_CHANGES" ? "CHECK_PR" : "TEST_APP",
      planInput?.mode ?? "SAFE",
      delegated ? `${suffix}-connection` : null,
      delegated ? 1 : null,
    ]
  )
  if (delegated) {
    await owner.query(
      `INSERT INTO agent_operations(id,"workspaceId","connectionId","operationName","idempotencyKey","inputHash","principalType","principalId","authorizationVersion",status,"resultReference","admissionProofHash","createdAt","updatedAt") VALUES($1,$2,$3,'scan.create',$1,$4,'OAUTH_CONNECTION',$3,1,'COMPLETED',$5,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [
        `${suffix}-outer`,
        f.workspaceId,
        `${suffix}-connection`,
        createHash("sha256").update(suffix).digest("hex"),
        f.scanId,
      ]
    )
    await owner.query(
      `INSERT INTO delegated_scan_provenance("operationId","workspaceId","scanId","targetId","connectionId","authorizationVersion","operationInputHash","scanExecutionPlanHash","createdAt") VALUES($1,$2,$3,$4,$5,1,$6,$7,CURRENT_TIMESTAMP)`,
      [
        `${suffix}-outer`,
        f.workspaceId,
        f.scanId,
        f.targetId,
        `${suffix}-connection`,
        createHash("sha256").update(suffix).digest("hex"),
        computeScanExecutionPlanHash(plan),
      ]
    )
  }
  await owner.query(
    `INSERT INTO "ScanDispatchOperation"("operationId","scanId","workspaceId","protocolVersion","requestDigest",state,"createdAt","updatedAt") VALUES($1,$2,$3,3,app.scan_dispatch_scope_digest($2),'QUEUED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [f.operationId, f.scanId, f.workspaceId]
  )
  await publishFixtureOutbox(owner, f.scanId, f.operationId)
  await owner.query(
    `INSERT INTO "UserScanSlot"("userId","scanId","workspaceId") VALUES($1,$2,$3)`,
    [f.userId, f.scanId, f.workspaceId]
  )
  await owner.query(
    `INSERT INTO "ScanCapacityReservation"("scanId","accountId","workspaceId","userId",state,"accountingVersion",multiplier,"poolMinutes","fundedMinutes","runtimeLimitMs","createdAt","updatedAt") VALUES($1,$2,$3,$2,$4,2,1,$5,$5,60000,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [f.scanId, f.userId, f.workspaceId, capacityState, capacityState === "RESERVED" ? 2 : 0]
  )
  await owner.query(
    `INSERT INTO "ScanWorkerInstanceGrant"(id,"authorityEpochId","instanceId","credentialHash","issuedAt","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP,coalesce($5::timestamp,CURRENT_TIMESTAMP+interval '1 hour'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      f.grantId,
      f.epochId,
      f.instanceId,
      createHash("sha256").update(f.grantId).digest("hex"),
      authority.grantExpiresAt ?? null,
    ]
  )
  return f
}

export function preparationInput(f: PreparationFixture) {
  return {
    operationId: f.operationId,
    authorityEpochId: f.epochId,
    workerInstanceId: f.instanceId,
    workerGrantId: f.grantId,
    expiresAt: new Date(Date.now() + 60000),
  }
}

export async function insertPreparationAttempt(
  client: pg.PoolClient,
  f: PreparationFixture,
  options: {
    expiresAt?: Date
    authorityMetadata?: {
      authorityAcceptedAt?: Date
      authorityTransactionId?: string
      authorityDeadlineAt?: Date | "infinity"
    }
  } = {}
) {
  const attemptId = `${f.operationId}-attempt`
  const values = [
    f.operationId,
    attemptId,
    f.epochId,
    f.grantId,
    f.scanId,
    options.expiresAt ?? null,
  ]
  // Legacy rows are inserted before the additive metadata columns exist.
  // Both statements are fixed SQL; caller metadata is always a bound value.
  if (options.authorityMetadata) {
    await client.query(
      `INSERT INTO "ScanDispatchAttempt"("operationId","attemptId","scanId","workspaceId","initiatingUserId","sponsorAccountId","targetId","targetSnapshotDigest","executionPlanHash","scopeDigest","policyId","policyVersion","policyDigest","attachmentIds",mode,goal,"maxBudgetUsd","maxRuntimeMs","authorityEpochId","workerInstanceGrantId","expiresAt","authorityAcceptedAt","authorityTransactionId","authorityDeadlineAt") SELECT $1,$2,s.id,s."workspaceId",s."createdById",s."sponsorAccountId",s."targetId",app.scan_target_snapshot_digest(s."targetId"),s."executionPlanHash",app.scan_dispatch_scope_digest(s.id),s."policyId",'dispatch-v1',app.scan_policy_digest(s."policyId"),'{}',s.mode,s.goal,(s."executionPlan"#>>'{limits,maxBudgetUsd}')::numeric,60000,$3,$4,coalesce($6::timestamp,CURRENT_TIMESTAMP+interval '10 minutes'),$7::timestamp,$8::text,$9::timestamp FROM "Scan" s WHERE s.id=$5`,
      [
        ...values,
        options.authorityMetadata.authorityAcceptedAt ?? null,
        options.authorityMetadata.authorityTransactionId ?? null,
        options.authorityMetadata.authorityDeadlineAt ?? null,
      ]
    )
    return attemptId
  }
  await client.query(
    `INSERT INTO "ScanDispatchAttempt"("operationId","attemptId","scanId","workspaceId","initiatingUserId","sponsorAccountId","targetId","targetSnapshotDigest","executionPlanHash","scopeDigest","policyId","policyVersion","policyDigest","attachmentIds",mode,goal,"maxBudgetUsd","maxRuntimeMs","authorityEpochId","workerInstanceGrantId","expiresAt") SELECT $1,$2,s.id,s."workspaceId",s."createdById",s."sponsorAccountId",s."targetId",app.scan_target_snapshot_digest(s."targetId"),s."executionPlanHash",app.scan_dispatch_scope_digest(s.id),s."policyId",'dispatch-v1',app.scan_policy_digest(s."policyId"),'{}',s.mode,s.goal,(s."executionPlan"#>>'{limits,maxBudgetUsd}')::numeric,60000,$3,$4,coalesce($6::timestamp,CURRENT_TIMESTAMP+interval '10 minutes') FROM "Scan" s WHERE s.id=$5`,
    values
  )
  return attemptId
}

export async function sealPreparationBundle(
  client: pg.PoolClient,
  f: PreparationFixture,
  attemptId: string
) {
  await client.query(
    `INSERT INTO "ScanPhysicalExecution"("attemptId","operationId","scanId","workspaceId","authorityEpochId","workerInstanceGrantId",state,"unresolvedKey",revision,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,'RESERVED',$3,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [attemptId, f.operationId, f.scanId, f.workspaceId, f.epochId, f.grantId]
  )
  await client.query(
    `INSERT INTO "ScanDispatchOutbox"(id,"operationId","attemptId","commandType",sequence,"commandDigest",status,attempts,"availableAt","createdAt","updatedAt") VALUES($1,$2,$3,'PREPARE',1,$4,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      `${f.operationId}-command`,
      f.operationId,
      attemptId,
      commandDigest("PREPARE", f.operationId, attemptId),
    ]
  )
  await client.query(
    `UPDATE "ScanDispatchOperation" SET state='PREPARING',"updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1`,
    [f.operationId]
  )
  return `${f.operationId}-command`
}

/** Historical fixtures are created ONLY before the additive fence migration. */
async function seedLegacyAttempt(owner: pg.Pool, f: PreparationFixture) {
  const attemptId = `${f.operationId}-attempt`
  const client = await owner.connect()
  try {
    await client.query("BEGIN")
    await insertPreparationAttempt(client, f)
    await sealPreparationBundle(client, f, attemptId)
    await client.query("COMMIT")
  } finally {
    client.release()
  }
}

/** Same fresh disposable DB owns all legacy seeds; suite order cannot supply them. */
export async function applyPreparationFixtureMigration(owner: pg.Pool) {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1")
    throw new Error("Disposable fixture required")
  const migrated = await owner.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='ScanDispatchAttempt' AND column_name='authorityAcceptedAt'`
  )
  if (!migrated.rowCount) {
    for (const budget of [0, 1])
      for (let i = 0; i < 18; i++)
        await seedLegacyAttempt(owner, await preparationFixture(owner, budget, "legacy-fence"))
    // Fixed repository migration URL; no fixture or customer path input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const sql = await readFile(
      new URL(
        "../../prisma/migrations/20261111130000_scan_preparation_authority_fence/migration.sql",
        import.meta.url
      ),
      "utf8"
    )
    await owner.query(sql)
  }
  for (const [migration, table, column] of [
    ["20261113140000_scan_dispatch_command_descriptor", "ScanDispatchOutbox", "commandInputJson"],
    ["20261113150000_supervisor_receipt_ingestion", "ScanSupervisorReceipt", "journalRecordId"],
    ["20261113163000_scan_execution_action_authority", "ScanExecutionActionIntent", "id"],
  ]) {
    const installed = await owner.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
      [table, column]
    )
    if (!installed.rowCount) {
      // Fixed reviewed fixture migration names only.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sql = await readFile(
        new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url),
        "utf8"
      )
      await owner.query(sql)
    }
  }
  const executionReceipts = await owner.query(
    "SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='ScanSupervisorReceiptType' AND e.enumlabel='EXECUTOR_CREATED'"
  )
  if (!executionReceipts.rowCount) {
    // Fixed reviewed additive receipt migration, applied after its dependencies.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const sql = await readFile(
      new URL(
        "../../prisma/migrations/20261113170000_supervisor_execution_receipts/migration.sql",
        import.meta.url
      ),
      "utf8"
    )
    await owner.query(sql)
  }
  const nativeResolution =
    await owner.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app' AND p.proname='scan_execution_invocation_resolution_guard'
      AND position('invocation resolution lacks exact confirmed original native ACK' in p.prosrc)>0
    UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app' AND p.proname='scan_supervisor_preparation_completed'`)
  if (!nativeResolution.rowCount) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const sql = await readFile(
      new URL(
        "../../prisma/migrations/20261113181000_supervisor_native_invocation_resolution/migration.sql",
        import.meta.url
      ),
      "utf8"
    )
    await owner.query(sql)
  }
  const completion = await owner.query(
    "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_supervisor_preparation_completed'"
  )
  if (!completion.rowCount) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const sql = await readFile(
      new URL(
        "../../prisma/migrations/20261113200000_supervisor_preparation_completion/migration.sql",
        import.meta.url
      ),
      "utf8"
    )
    await owner.query(sql)
  }
  // The guard-scoping migration must land after the migration that creates the
  // original zero-argument predicate.
  const scopedGuard = await owner.query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app' AND p.proname='scan_execution_invocation_pending'
      AND position('workspace_id' in p.prosrc)>0`
  )
  if (!scopedGuard.rowCount) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const sql = await readFile(
      new URL(
        "../../prisma/migrations/20261114010000_scope_invocation_guard_to_workspace/migration.sql",
        import.meta.url
      ),
      "utf8"
    )
    await owner.query(sql)
  }
}

const usedLegacy = new Set<string>()
export async function legacyPreparationFixture(
  owner: pg.Pool,
  maxBudgetUsd = 1
): Promise<PreparationFixture> {
  const rows = await owner.query(
    `SELECT s."createdById" AS "userId",s."workspaceId",s."targetId",s.id AS "scanId",a."operationId",a."workerInstanceGrantId" AS "grantId",a."authorityEpochId" AS "epochId",g."instanceId" FROM "ScanDispatchAttempt" a JOIN "Scan" s ON s.id=a."scanId" JOIN "ScanWorkerInstanceGrant" g ON g.id=a."workerInstanceGrantId" WHERE a."authorityAcceptedAt" IS NULL AND a."operationId" LIKE 'legacy-fence-%' AND a."maxBudgetUsd"=$1 AND EXISTS(SELECT 1 FROM "ScanDispatchOperation" o WHERE o."operationId"=a."operationId" AND o.state='PREPARING') AND EXISTS(SELECT 1 FROM "ScanPhysicalExecution" p WHERE p."attemptId"=a."attemptId" AND p.state='RESERVED') ORDER BY a."operationId"`,
    [maxBudgetUsd]
  )
  const row = rows.rows.find((r) => !usedLegacy.has(r.operationId))
  if (!row) throw new Error("Historical preparation fixture exhausted or unavailable")
  usedLegacy.add(row.operationId)
  return row
}

/** Reads the historical preparation proof; it does not invoke or simulate new preparation. */
export async function historicalPreparation(owner: pg.Pool, f: PreparationFixture) {
  const r = await owner.query(
    `SELECT a."attemptId",c.id AS "commandId" FROM "ScanDispatchAttempt" a JOIN "ScanDispatchOutbox" c ON c."operationId"=a."operationId" AND c."commandType"='PREPARE' WHERE a."operationId"=$1 AND a."authorityAcceptedAt" IS NULL`,
    [f.operationId]
  )
  if (!r.rows[0]) throw new Error("Original historical proof unavailable")
  return {
    kind: "committed" as const,
    state: "PREPARING" as const,
    operationId: f.operationId,
    ...r.rows[0],
  }
}

export async function installPreparationFixtureRole(owner: pg.Pool) {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1")
    throw new Error("Disposable fixture required")
  const revokeTemporary =
    "DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()); END $$;"
  if (
    (await owner.query("SELECT 1 FROM pg_roles WHERE rolname='dispatch_prepare_broker'")).rowCount
  ) {
    await owner.query(revokeTemporary)
    return
  }
  const password = process.env.DISPATCH_PREPARATION_BROKER_PASSWORD
  if (!password || password.length !== 48 || !/^[a-f0-9]{48}$/.test(password))
    throw new Error("Fixture broker password unavailable")
  await owner.query(`
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dispatch_prepare_broker') THEN
 CREATE ROLE dispatch_prepare_broker LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
END IF; END $$;
${revokeTemporary}
GRANT USAGE ON SCHEMA public,app TO dispatch_prepare_broker;
GRANT SELECT ON "Workspace","WorkspaceMember",users,"BillingAccount",agent_connections,agent_operations,delegated_scan_provenance,"Target","Policy","Scan","UserScanSlot","ScanCapacityReservation","ScanEvent","ScanAuthorityEpoch","ScanWorkerInstanceGrant","ScanDispatchOperation","ScanDispatchAttempt","ScanQueueOutbox","ScanDispatchOutbox","ScanPhysicalExecution","ScanDispatchStart","ScanSupervisorReceipt","ScanPhysicalExecutionTransition","ScanDispatchReleaseReceipt" TO dispatch_prepare_broker;
GRANT UPDATE("updatedAt") ON "Scan","ScanAuthorityEpoch","ScanWorkerInstanceGrant","ScanCapacityReservation","ScanQueueOutbox" TO dispatch_prepare_broker;
GRANT UPDATE(state,"updatedAt") ON "ScanDispatchOperation" TO dispatch_prepare_broker;
-- Immutable attempt identity allows row locks only; mutation trigger still rejects writes.
GRANT UPDATE("attemptId") ON "ScanDispatchAttempt" TO dispatch_prepare_broker;
GRANT INSERT ON "ScanDispatchAttempt","ScanDispatchOutbox","ScanPhysicalExecution" TO dispatch_prepare_broker;
GRANT EXECUTE ON FUNCTION app.scan_dispatch_command_input_valid(text,text,text),app.scan_preparation_plan_json(jsonb),app.scan_preparation_context(text),app.require_scan_preparation_role(),app.require_scan_execution_action_role(),app.scan_preparation_gate_held(),app.scan_execution_gate_held(),app.check_scan_current_execution_authority(text,timestamp,text),app.acquire_scan_preparation_gate(),app.check_scan_preparation_authority(text,timestamp),app.scan_dispatch_scope_digest(text),app.scan_target_snapshot_digest(text),app.scan_policy_digest(text),public.digest(bytea,text) TO dispatch_prepare_broker;
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['ScanDispatchOperation','ScanDispatchAttempt','ScanDispatchOutbox','ScanPhysicalExecution','ScanDispatchStart','ScanSupervisorReceipt','ScanPhysicalExecutionTransition','ScanDispatchReleaseReceipt'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=name AND policyname='fixture_preparation_scope') THEN
   IF name IN ('ScanDispatchOperation','ScanDispatchAttempt','ScanPhysicalExecution') THEN
    EXECUTE format('CREATE POLICY fixture_preparation_scope ON public.%I FOR ALL TO dispatch_prepare_broker USING ("workspaceId"=app.current_workspace_id()) WITH CHECK ("workspaceId"=app.current_workspace_id())',name);
   ELSE
    EXECUTE format('CREATE POLICY fixture_preparation_scope ON public.%I FOR ALL TO dispatch_prepare_broker USING (EXISTS(SELECT 1 FROM "ScanDispatchAttempt" a WHERE a."attemptId"=%I."attemptId" AND a."workspaceId"=app.current_workspace_id()))',name,name);
   END IF;
  END IF;
 END LOOP;
END $$;
CREATE POLICY fixture_preparation_epoch ON "ScanAuthorityEpoch" FOR SELECT TO dispatch_prepare_broker USING (true);
CREATE POLICY fixture_preparation_epoch_lock ON "ScanAuthorityEpoch" FOR UPDATE TO dispatch_prepare_broker USING (true);
CREATE POLICY fixture_preparation_grant ON "ScanWorkerInstanceGrant" FOR SELECT TO dispatch_prepare_broker USING (true);
CREATE POLICY fixture_preparation_grant_lock ON "ScanWorkerInstanceGrant" FOR UPDATE TO dispatch_prepare_broker USING (true);
CREATE POLICY fixture_preparation_queue ON "ScanQueueOutbox" FOR ALL TO dispatch_prepare_broker USING (EXISTS(SELECT 1 FROM "ScanDispatchOperation" o WHERE o."operationId"="ScanQueueOutbox"."operationId" AND o."workspaceId"=app.current_workspace_id()));
`)
}

/** Restricted fixture revoker; never grants a production role or broad UPDATE. */
export async function installPreparationRevokerRole(owner: pg.Pool) {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1")
    throw new Error("Disposable fixture required")
  const password = process.env.DISPATCH_AUTHORITY_REVOKER_PASSWORD
  if (!password || password.length !== 48 || !/^[a-f0-9]{48}$/.test(password))
    throw new Error("Fixture revoker password unavailable")
  await owner.query(`
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dispatch_authority_revoker') THEN
 CREATE ROLE dispatch_authority_revoker LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
END IF; EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()); END $$;
GRANT USAGE ON SCHEMA public,app TO dispatch_authority_revoker;
GRANT SELECT ON "ScanWorkerInstanceGrant","ScanAuthorityEpoch" TO dispatch_authority_revoker;
GRANT UPDATE("revokedAt","updatedAt") ON "ScanWorkerInstanceGrant" TO dispatch_authority_revoker;
GRANT UPDATE("isOpen","openKey","closedAt","updatedAt") ON "ScanAuthorityEpoch" TO dispatch_authority_revoker;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='ScanWorkerInstanceGrant' AND policyname='fixture_authority_revoker') THEN
  CREATE POLICY fixture_authority_revoker ON "ScanWorkerInstanceGrant" FOR ALL TO dispatch_authority_revoker USING(id LIKE 'authority-race-%') WITH CHECK(id LIKE 'authority-race-%');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='ScanAuthorityEpoch' AND policyname='fixture_authority_revoker') THEN
  CREATE POLICY fixture_authority_revoker ON "ScanAuthorityEpoch" FOR ALL TO dispatch_authority_revoker USING(id LIKE 'authority-race-%') WITH CHECK(id LIKE 'authority-race-%');
 END IF;
END $$;
`)
}
