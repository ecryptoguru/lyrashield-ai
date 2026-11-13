import { z } from "zod"
import {
  canonicalJson,
  resourceOwnershipSchema,
  executorKeySchema,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"
import { sha256Hex } from "./scan-supervisor-receipt-verifier"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z
  .object({
    operationId: id,
    attemptId: id,
    commandId: id,
    authorityEpochId: id,
    supervisorInstanceId: id,
    receiptHash: hash,
    executorKey: executorKeySchema.optional(),
  })
  .strict()
const sourceSchema = z.object({
  receiptId: z.string(),
  workspaceId: z.string(),
  scanId: z.string(),
  sourceSequence: z.string().regex(/^[0-9]+$/),
  originalInputJson: z.string(),
  wrapperInputJson: z.string(),
  headInputJson: z.string(),
  confirmedSequence: z.string().regex(/^[0-9]+$/),
  streamId: z.string(),
  commandInputJson: z.string(),
  commandInputChecksum: hash,
  uncertain: z.boolean(),
})
type SourceRow = z.infer<typeof sourceSchema>

function unavailable(): never {
  throw new ScanDispatchAuthorityError(
    "SUPERVISOR_AUTHORITY_SOURCE_UNAVAILABLE",
    "Retained supervisor authority source unavailable"
  )
}

/** Read-only original facts for the native verifier on its already-fenced connection.
 * This does not authenticate an issuer or grant action authority. The verifier must
 * authenticate both returned signed records/head against protected configured keys,
 * check its active qualified epoch and inspect original native ownership while
 * retaining this same DB gate. No caller-provided workspace or key is accepted.
 */
export async function readRetainedSupervisorAuthoritySource(
  client: AuthoritySqlConnection,
  input: unknown
) {
  const expected = identity.parse(input)
  const gate = await client.query(
    'SELECT app.scan_preparation_gate_held() AS held,app.current_workspace_id() AS "workspaceId"',
    []
  )
  if (gate.rows[0]?.held !== true || !gate.rows[0].workspaceId) unavailable()
  const result = await client.query(
    `SELECT r.id AS "receiptId",a."workspaceId",a."scanId",j.sequence::text AS "sourceSequence",
    j."originalInputJson",j."wrapperInputJson",s."headInputJson",s."confirmedSequence"::text,s.id AS "streamId",
    c."commandInputJson",c."commandInputChecksum",
    EXISTS(SELECT 1 FROM "ScanSupervisorJournalRecord" u WHERE u."streamId"=s.id AND u."operationId"=r."operationId"
      AND u."attemptId"=r."attemptId" AND u."workspaceId"=a."workspaceId" AND u.sequence<=s."confirmedSequence"
      AND (u."originalInputJson"::jsonb->'payload'->>'type'='command_recovery_hold'
        OR (u."originalInputJson"::jsonb->'payload'->>'type' IN ('command_terminal','attempt_status')
          AND u."originalInputJson"::jsonb->'payload'->>'status'='UNKNOWN'))) AS uncertain
    FROM "ScanSupervisorReceipt" r JOIN "ScanSupervisorJournalRecord" j ON j.id=r."journalRecordId"
    JOIN "ScanSupervisorJournalStream" s ON s.id=j."streamId"
    JOIN "ScanDispatchAttempt" a ON a."operationId"=r."operationId" AND a."attemptId"=r."attemptId"
    JOIN "ScanDispatchOutbox" c ON c.id=r."commandId" AND c."operationId"=r."operationId" AND c."attemptId"=r."attemptId"
    WHERE r."operationId"=$1 AND r."attemptId"=$2 AND r."commandId"=$3 AND r."authorityEpochId"=$4
      AND r."supervisorInstanceId"=$5 AND r."receiptHash"=$6 AND a."workspaceId"=app.current_workspace_id()
      AND j."workspaceId"=a."workspaceId" AND j."operationId"=r."operationId" AND j."attemptId"=r."attemptId"
      AND s."authorityEpochId"=r."authorityEpochId" AND s."supervisorInstanceId"=r."supervisorInstanceId"
      AND j.sequence<=s."confirmedSequence" AND (r."terminalStatus" IS NOT NULL OR r."eventType" IN ('resource_bound','resource_started','native_invocation_ack','attempt_prepared','prepare_invocation_completed'))
`,
    [
      expected.operationId,
      expected.attemptId,
      expected.commandId,
      expected.authorityEpochId,
      expected.supervisorInstanceId,
      expected.receiptHash,
    ]
  )
  if (result.rows.length !== 1) unavailable()
  const source = sourceSchema.parse(result.rows[0])
  const command = readStoredDispatchCommand(source.commandInputJson, source.commandInputChecksum)
  if (
    !command ||
    command.commandId !== expected.commandId ||
    (command.type === "PREPARE" &&
      (command.attempt.attemptId !== expected.attemptId ||
        command.attempt.operationId !== expected.operationId ||
        command.attempt.workspaceId !== source.workspaceId ||
        command.attempt.scanId !== source.scanId ||
        command.attempt.authorityEpochId !== expected.authorityEpochId))
  )
    unavailable()
  const original = JSON.parse(source.originalInputJson),
    wrapper = JSON.parse(source.wrapperInputJson),
    head = JSON.parse(source.headInputJson)
  if (
    original.hash !== expected.receiptHash ||
    canonicalJson(wrapper.payload.payload) !== source.originalInputJson ||
    wrapper.payload.epochId !== expected.authorityEpochId ||
    wrapper.payload.workspaceId !== source.workspaceId ||
    wrapper.payload.scanId !== source.scanId ||
    wrapper.payload.operationId !== expected.operationId ||
    wrapper.payload.attemptId !== expected.attemptId ||
    head.sequence !== Number(source.confirmedSequence) ||
    head.epochId !== expected.authorityEpochId ||
    head.supervisorInstanceId !== expected.supervisorInstanceId
  )
    unavailable()
  const ownership = expected.executorKey ? await readOwnershipSources(client, source, expected) : []
  return { ...source, command, original, wrapper, head, ownership }
}

async function readOwnershipSources(
  client: AuthoritySqlConnection,
  source: SourceRow,
  expected: z.infer<typeof identity>
) {
  if (!expected.executorKey) unavailable()
  const result = await client.query(
    `WITH matches AS (
    SELECT j."originalInputJson",j."wrapperInputJson",j.sequence,c."commandInputJson",c."commandInputChecksum",p."commandInputJson" AS "preparationInputJson",p."commandInputChecksum" AS "preparationInputChecksum"
    FROM "ScanSupervisorJournalRecord" j JOIN "ScanDispatchOutbox" c
      ON c.id=j."originalInputJson"::jsonb->'payload'->>'commandId'
      AND c."operationId"=j."operationId" AND c."attemptId"=j."attemptId" AND c."commandType" IN ('START_PAID','START_UNMETERED')
    JOIN "ScanDispatchOutbox" p ON p."operationId"=c."operationId" AND p."attemptId"=c."attemptId" AND p."commandType"='PREPARE' AND p.sequence=1
    WHERE j."streamId"=$1 AND j."operationId"=$2 AND j."attemptId"=$3 AND j."workspaceId"=$4
      AND j.sequence<=$5 AND j."originalInputJson"::jsonb->'payload'->>'type'='resource_bound'
      AND j."originalInputJson"::jsonb->'payload'->'ownership'->>'executorKey'=$6
    ) SELECT *, (SELECT count(DISTINCT ("originalInputJson"::jsonb->'payload'->'ownership'->>'ownershipId')||':'||
      ("originalInputJson"::jsonb->'payload'->'ownership'->>'containerId'))::int FROM matches) AS identities
      FROM matches ORDER BY sequence DESC LIMIT 3`,
    [
      source.streamId,
      expected.operationId,
      expected.attemptId,
      source.workspaceId,
      source.confirmedSequence,
      expected.executorKey,
    ]
  )
  const records = result.rows.map((value) => {
    const row = z
      .object({
        originalInputJson: z.string(),
        wrapperInputJson: z.string(),
        commandInputJson: z.string(),
        commandInputChecksum: hash,
        identities: z.literal(1),
        preparationInputJson: z.string(),
        preparationInputChecksum: hash,
      })
      .parse(value)
    const original = JSON.parse(row.originalInputJson),
      wrapper = JSON.parse(row.wrapperInputJson)
    if (
      canonicalJson(wrapper.payload.payload) !== row.originalInputJson ||
      wrapper.payload.workspaceId !== source.workspaceId ||
      wrapper.payload.operationId !== expected.operationId ||
      wrapper.payload.attemptId !== expected.attemptId
    )
      unavailable()
    const command = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
    const preparation = readStoredDispatchCommand(
      row.preparationInputJson,
      row.preparationInputChecksum
    )
    const ownership = resourceOwnershipSchema.parse(original.payload.ownership)
    if (
      !command ||
      (command.type !== "START_PAID" && command.type !== "START_UNMETERED") ||
      command.attemptId !== expected.attemptId ||
      command.executorKey !== expected.executorKey ||
      !preparation ||
      preparation.type !== "PREPARE" ||
      preparation.attempt.attemptId !== expected.attemptId ||
      preparation.attempt.operationId !== expected.operationId ||
      preparation.attempt.workspaceId !== source.workspaceId ||
      preparation.attempt.scanId !== source.scanId ||
      preparation.attempt.authorityEpochId !== expected.authorityEpochId ||
      !preparation.executors.some((executor) => executor.key === expected.executorKey) ||
      ownership.ownershipId !==
        `own_${sha256Hex(`${expected.attemptId}\0${command.commandId}\0${ownership.executorKey}`).slice(0, 40)}` ||
      original.payload.commandId !== command.commandId ||
      wrapper.payload.epochId !== expected.authorityEpochId ||
      original.payload.supervisorInstanceId !== expected.supervisorInstanceId
    )
      unavailable()
    return { ...row, original, wrapper, ownership, command, preparation }
  })
  if (
    !records.length ||
    records.some(
      (record) =>
        record.ownership.kind !== "container" ||
        !/^[a-f0-9]{64}$/.test(record.ownership.containerId ?? "")
    ) ||
    new Set(
      records.map((record) => `${record.ownership.ownershipId}:${record.ownership.containerId}`)
    ).size !== 1
  )
    unavailable()
  return records
}
