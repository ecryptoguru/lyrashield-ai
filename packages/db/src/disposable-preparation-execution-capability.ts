import { z } from "zod"
import {
  authorityActionSchema,
  canonicalJson,
  sha256Hex,
  type AuthorityAction,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"
import { verifyRuntimeQualificationSignature } from "@lyrashield/security/sandbox-publication-record"
import {
  observeDisposableExecutionContext,
  type DisposablePreparationFixture,
} from "./disposable-preparation-observations"
import {
  preparationStagingRecordSchema,
  trustedPreparationHostPolicySchema,
  preparationProofFailure,
} from "./trusted-preparation-proof"

const identity = z.string().min(3).max(192)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const sourceSchema = z
  .object({
    streamId: identity,
    supervisorInstanceId: identity,
    originalKeyHash: hash,
    wrapperKeyHash: hash,
  })
  .strict()
/** Native test composition only. A real managed staging proof cannot authorize a production database. */
export function createDisposablePreparationExecutionCapability(options: {
  hostPolicy: unknown
  fixture: DisposablePreparationFixture
  managedProof: unknown
}) {
  const policy = trustedPreparationHostPolicySchema.parse(options.hostPolicy)
  const fixture = Object.freeze({ ...options.fixture })
  const envelope = z
    .object({ raw: z.string().min(1), result: z.unknown() })
    .strict()
    .parse(options.managedProof)
  verifyRuntimeQualificationSignature(envelope.raw, envelope.result)
  const record = preparationStagingRecordSchema.parse(JSON.parse(envelope.raw))
  if (
    canonicalJson(record) !== envelope.raw ||
    record.purpose !== "disposable-preparation" ||
    policy.provider.providerId !== "test-provider" ||
    record.hostPolicyChecksum !== sha256Hex(canonicalJson(policy)) ||
    canonicalJson(record.executionContext) !== canonicalJson(policy.executionContext) ||
    record.authorityEpochId !== policy.authorityEpochId ||
    process.env.GITHUB_ACTIONS
  )
    preparationProofFailure()
  return Object.freeze({
    async verifyAction(client: AuthoritySqlConnection, input: AuthorityAction) {
      const action = authorityActionSchema.parse(input)
      if (
        !["EXECUTOR_CREATE", "EXECUTOR_START"].includes(action.phase) ||
        action.operationId !== record.operationId ||
        action.attemptId !== record.attemptId ||
        action.scanId !== record.scanId ||
        action.workspaceId !== record.workspaceId ||
        action.authorityEpochId !== record.authorityEpochId ||
        Date.parse(record.issuedAt) > Date.now() ||
        Date.parse(record.expiresAt) <= Date.now()
      )
        preparationProofFailure()
      const observed = observeDisposableExecutionContext(fixture)
      if (canonicalJson(observed.context) !== canonicalJson(record.executionContext))
        preparationProofFailure()
      const database = await client.query(
        `SELECT system_identifier::text AS "systemIdentifier",d.oid::text AS "databaseOid",
      current_database() AS database,app.scan_preparation_gate_held() AS held FROM pg_catalog.pg_control_system(),pg_catalog.pg_database d
      WHERE d.datname=current_database()`,
        []
      )
      const actual = database.rows[0],
        expected = observed.evidence.evidence.database
      if (
        database.rows.length !== 1 ||
        actual?.held !== true ||
        actual.database !== fixture.database ||
        actual.systemIdentifier !== expected.systemIdentifier ||
        actual.databaseOid !== expected.databaseOid
      )
        preparationProofFailure()
      const epoch = await client.query(
        `SELECT e.epoch::text FROM "ScanAuthorityEpoch" e JOIN "ScanDispatchAttempt" a ON a."authorityEpochId"=e.id
      JOIN "Scan" s ON s.id=a."scanId" AND s."workspaceId"=a."workspaceId"
      WHERE e.id=$1 AND e."isOpen"=true AND e."openKey"='open' AND e.epoch=(SELECT max(epoch) FROM "ScanAuthorityEpoch")
      AND a."attemptId"=$2 AND a."operationId"=$3 AND a."scanId"=$4 AND a."workspaceId"=$5
      AND a."targetSnapshotDigest"=$6 AND a."scopeDigest"=$7 AND a."policyDigest"=$8 AND s."executionPlanHash"=$9
      AND app.scan_preparation_gate_held() FOR SHARE OF e,a,s`,
        [
          record.authorityEpochId,
          record.attemptId,
          record.operationId,
          record.scanId,
          record.workspaceId,
          record.targetSnapshotDigest,
          record.scopeDigest,
          record.policyDigest,
          record.executionPlanHash,
        ]
      )
      if (epoch.rows.length !== 1) preparationProofFailure()
      // A unique already-installed private source stream must own this original
      // operation. The caller cannot select its supervisor or signing identities.
      const stream = await client.query(
        `SELECT s.id AS "streamId",s."supervisorInstanceId",s."originalKeyHash",s."wrapperKeyHash"
      FROM "ScanSupervisorJournalStream" s WHERE s."authorityEpochId"=$1 AND EXISTS
      (SELECT 1 FROM "ScanSupervisorJournalRecord" r WHERE r."streamId"=s.id AND r."operationId"=$2 AND r."attemptId"=$3 AND r."workspaceId"=$4)
      AND app.scan_preparation_gate_held() FOR SHARE OF s`,
        [record.authorityEpochId, record.operationId, record.attemptId, record.workspaceId]
      )
      if (stream.rows.length !== 1) preparationProofFailure()
      const source = sourceSchema.parse(stream.rows[0])
      const after = observeDisposableExecutionContext(fixture)
      if (
        canonicalJson(after.context) !== canonicalJson(observed.context) ||
        canonicalJson(after.evidence.evidence) !== canonicalJson(observed.evidence.evidence)
      )
        preparationProofFailure()
      const held = await client.query("SELECT app.scan_preparation_gate_held() AS held", [])
      if (held.rows.length !== 1 || held.rows[0]?.held !== true) preparationProofFailure()
      return Object.freeze({
        purpose: "disposable-staging" as const,
        epochId: record.authorityEpochId,
        epoch: Number(epoch.rows[0]?.epoch),
        sourceRevision: policy.productRevision,
        runtimePolicyDigest: "sha256:" + record.hostPolicyChecksum,
        authorityDigest: "sha256:" + sha256Hex(envelope.raw),
        ...source,
      })
    },
  })
}
