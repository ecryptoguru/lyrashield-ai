import { createHash } from "node:crypto"
import { Pool } from "pg"
import { z } from "zod"
import { canonicalJson } from "@lyrashield/runtime-control"
import {
  ScanExecutionPlanSchema,
  SCAN_ATTACHMENT_MAX_TOTAL_BYTES,
  scanAttachmentStagingName,
} from "@lyrashield/types"
import { bindScanPreparationContext } from "@lyrashield/db/src/scan-preparation-context"

const requestSchema = z
  .object({
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/),
    credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
type Attachment = {
  id: string
  workspaceId: string
  filename: string
  mediaType: string
  byteLength: number
  checksum: string
  storageUri: string
  encryptionKeyRef: string
}

/** Fixed root service invokes this checked source reader, never arbitrary SQL or a moving ref. */
export async function readPreparationSource(pool: Pool, input: unknown) {
  const request = requestSchema.parse(input)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SET LOCAL statement_timeout='5s'")
    await client.query("SELECT app.require_scan_preparation_source_role()")
    await bindScanPreparationContext(client, request.operationId)
    const gate = await client.query<{ held: boolean }>(
      "SELECT pg_try_advisory_xact_lock_shared(1819234670,1) AS held"
    )
    if (gate.rows[0]?.held !== true) throw new Error("Source authority is busy")
    const assigned = await client.query<{
      workerGrantId: string
      workerInstanceId: string
      authorityEpochId: string
    }>("SELECT * FROM app.require_scan_dispatch_worker_stage($1,$2)", [
      request.operationId,
      request.credentialHash,
    ])
    if (assigned.rowCount !== 1) throw new Error("Source worker assignment unavailable")
    const result = await client.query<{
      operationId: string
      scanId: string
      workspaceId: string
      executionPlan: unknown
      executionPlanHash: string
      targetSnapshotDigest: string
      scopeDigest: string
      policyDigest: string
      target: {
        id: string
        type: string
        repoProvider: string | null
        repoFullName: string | null
        installationId: string | null
      }
    }>(
      `SELECT o."operationId",s.id AS "scanId",s."workspaceId",s."executionPlan",s."executionPlanHash",
      app.scan_target_snapshot_digest(t.id) AS "targetSnapshotDigest",app.scan_dispatch_scope_digest(s.id) AS "scopeDigest",
      app.scan_policy_digest(s."policyId") AS "policyDigest",to_jsonb(t) AS target
      FROM "ScanDispatchOperation" o JOIN "Scan" s ON s.id=o."scanId" AND s."workspaceId"=o."workspaceId"
      JOIN "Target" t ON t.id=s."targetId" AND t."workspaceId"=s."workspaceId"
      JOIN "Workspace" w ON w.id=s."workspaceId" AND w."deletedAt" IS NULL
      JOIN "WorkspaceMember" m ON m."workspaceId"=s."workspaceId" AND m."userId"=s."createdById" AND m.status='active'
      JOIN users u ON u.id=s."createdById"
      WHERE o."operationId"=$1 AND o."workspaceId"=current_setting('app.current_workspace_id',true)
      AND o.state IN ('QUEUED','WAITING_CAPACITY','PREPARING') AND s."deletedAt" IS NULL AND t."deletedAt" IS NULL
      AND t.status='active' AND o."requestDigest"=app.scan_dispatch_scope_digest(s.id)
      AND ((s."delegatedConnectionId" IS NULL AND s."delegatedAuthorizationVersion" IS NULL) OR EXISTS(SELECT 1 FROM agent_connections c
        WHERE c.id=s."delegatedConnectionId" AND c."workspaceId"=s."workspaceId" AND c."userId"=s."createdById"
        AND c.status='ACTIVE' AND c."revokedAt" IS NULL AND (c."expiresAt" IS NULL OR c."expiresAt">clock_timestamp())
        AND c."authorizationVersion"=s."delegatedAuthorizationVersion" AND 'lyrashield.write'=ANY(c.scopes)
        AND (s.mode::text=ANY(ARRAY(SELECT upper(profile) FROM unnest(c."allowedProfiles") AS profile)))
        AND (CASE WHEN s."triggerType"='retest' THEN 'retest.create' ELSE 'scan.create' END)=ANY(c."allowedOperations")
        AND (c."allTargets" OR s."targetId"=ANY(c."allowedTargetIds"))
        AND c.scopes IS NOT NULL AND c."allowedProfiles" IS NOT NULL AND c."allowedOperations" IS NOT NULL AND c."allowedTargetIds" IS NOT NULL
        AND array_position(c.scopes,NULL) IS NULL AND array_position(c."allowedProfiles",NULL) IS NULL
        AND array_position(c."allowedOperations",NULL) IS NULL AND array_position(c."allowedTargetIds",NULL) IS NULL
        AND EXISTS(SELECT 1 FROM delegated_scan_provenance p JOIN agent_operations provenance ON provenance.id=p."operationId"
          WHERE p."scanId"=s.id AND p."workspaceId"=s."workspaceId" AND p."targetId"=s."targetId" AND p."connectionId"=c.id
          AND p."authorizationVersion"=c."authorizationVersion" AND p."scanExecutionPlanHash"=s."executionPlanHash"
          AND p."operationInputHash"=provenance."inputHash" AND provenance."connectionId"=c.id AND provenance."principalId"=c.id
          AND provenance."principalType"='OAUTH_CONNECTION' AND provenance."authorizationVersion"=c."authorizationVersion"
          AND provenance."resultReference"=s.id AND provenance."workspaceId"=s."workspaceId"
          AND provenance."operationName"=(CASE WHEN s."triggerType"='retest' THEN 'retest.create' ELSE 'scan.create' END)
          AND provenance.status IN ('EXECUTING','COMPLETED') AND provenance."admissionProofHash" ~ '^[a-f0-9]{64}$')))`,
      [request.operationId]
    )
    if (result.rowCount !== 1) throw new Error("Persisted source plan unavailable")
    const row = result.rows[0]!,
      plan = ScanExecutionPlanSchema.parse(row.executionPlan)
    if (
      !plan.source?.revision ||
      plan.targetType !== "REPO" ||
      row.target.type !== "REPO" ||
      !["REVIEW_TARGET", "REVIEW_CHANGES"].includes(plan.workflow) ||
      createHash("sha256").update(canonicalJson(plan)).digest("hex") !== row.executionPlanHash ||
      row.target.repoProvider?.toLowerCase() !== "github" ||
      !row.target.repoFullName ||
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(row.target.repoFullName) ||
      row.target.repoFullName.split("/").some((part) => part === "." || part === "..") ||
      !row.target.installationId ||
      !/^[1-9][0-9]*$/.test(row.target.installationId) ||
      !Number.isSafeInteger(Number(row.target.installationId))
    )
      throw new Error("Pinned GitHub source unavailable")
    const integration = await client.query(
      `SELECT id FROM "Integration" WHERE "workspaceId"=$1
      AND type='GITHUB' AND "externalId"=$2 AND status='active' AND "deletedAt" IS NULL`,
      [row.workspaceId, row.target.installationId]
    )
    if (integration.rowCount !== 1) throw new Error("Repository integration unavailable")
    const attachments = plan.attachmentIds.length
      ? (
          await client.query<Attachment>(
            `SELECT id,"workspaceId",filename,"mediaType","byteLength",checksum,"storageUri","encryptionKeyRef"
      FROM "ScanAttachment" WHERE "workspaceId"=$1 AND id=ANY($2::text[]) AND status='ACTIVE' AND "deletedAt" IS NULL ORDER BY id`,
            [row.workspaceId, plan.attachmentIds]
          )
        ).rows
      : []
    if (
      attachments.length !== plan.attachmentIds.length ||
      attachments.reduce((sum, item) => sum + item.byteLength, 0) > SCAN_ATTACHMENT_MAX_TOTAL_BYTES
    )
      throw new Error("Approved attachments unavailable")
    await client.query("COMMIT")
    const { workerGrantId, workerInstanceId, authorityEpochId } = assigned.rows[0]!
    return {
      ...row,
      executionPlan: plan,
      workerGrantId,
      workerInstanceId,
      authorityEpochId,
      attachments: attachments.map((item) => ({
        ...item,
        stagingName: scanAttachmentStagingName(item.id, item.filename),
      })),
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

// Only the installed root producer starts this fixed, immutable program with a private stdin pipe.
if (process.argv[1]?.endsWith("/preparation-source.ts")) {
  if (!process.env.LYRASHIELD_PREPARATION_SOURCE_DATABASE_URL)
    throw new Error("Source reader installation unavailable")
  const pool = new Pool({
    connectionString: process.env.LYRASHIELD_PREPARATION_SOURCE_DATABASE_URL,
    max: 1,
  })
  const deadline = setTimeout(() => process.exit(1), 45_000)
  try {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of process.stdin) {
      length += chunk.length
      if (length > 1024) throw new Error("Source request exceeds bound")
      chunks.push(chunk)
    }
    const result = await readPreparationSource(pool, JSON.parse(Buffer.concat(chunks).toString()))
    process.stdout.write(canonicalJson(result))
  } catch {
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    await pool.end()
  }
}
