import { z } from "zod"
import {
  authorityEventSchema,
  canonicalJson,
  verifyJournalRecord,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"
import {
  checkReceiptKeys,
  receiptFailure,
  verifyHead,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"
import { verifySupervisorReceiptHmac } from "./scan-supervisor-receipt-verifier"
import { readRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source"
type Source = Awaited<ReturnType<typeof readRetainedSupervisorAuthoritySource>>
const bytesSchema = z.object({
  sequence: z.string().regex(/^[0-9]+$/),
  originalInputJson: z.string(),
  wrapperInputJson: z.string(),
})
export function authenticateRetainedSupervisorHistoryBytes(
  bytes: { originalInputJson: string; wrapperInputJson: string },
  authority: SupervisorReceiptAuthority
) {
  const original = verifyJournalRecord(
    JSON.parse(bytes.originalInputJson),
    authority.originalSigningSecret,
    (value) => z.record(z.string(), z.unknown()).parse(value)
  )
  const wrapper = verifyJournalRecord(
    JSON.parse(bytes.wrapperInputJson),
    authority.wrapperSigningSecret,
    authorityEventSchema(z.unknown()).parse
  )
  const hmac = verifySupervisorReceiptHmac({
    record: original,
    expectedInstanceId: authority.supervisorInstanceId,
    secret: authority.originalSigningSecret,
    expectedKeyHash: authority.originalKeyHash,
  })
  if (
    !hmac.ok ||
    canonicalJson(wrapper.payload.payload) !== bytes.originalInputJson ||
    wrapper.payload.epochId !== authority.authorityEpochId ||
    wrapper.payload.eventId !== `supervisor:${original.hash}` ||
    wrapper.sequence !== original.sequence
  )
    receiptFailure("SUPERVISOR_AUTHORITY_SOURCE_MISMATCH")
  return { original, wrapper }
}

/** Native verifier only: protected installation keys and the same still-fenced DB connection.
 * Reauthenticates the retained original and ownership chain through the current
 * confirmed signed head. It does not qualify a restored epoch or authorize action.
 */
export async function authenticateRetainedSupervisorAuthoritySource(
  source: Source,
  authority: SupervisorReceiptAuthority,
  client: AuthoritySqlConnection
) {
  checkReceiptKeys(authority)
  if (source.streamId !== authority.streamId) receiptFailure("SUPERVISOR_STREAM_NOT_INSTALLED")
  const current = await client.query(
    `SELECT "headInputJson","confirmedSequence"::text,app.scan_preparation_gate_held() AS held
    FROM "ScanSupervisorJournalStream" WHERE id=$1 AND "authorityEpochId"=$2 AND "supervisorInstanceId"=$3
      AND "originalKeyHash"=$4 AND "wrapperKeyHash"=$5`,
    [
      authority.streamId,
      authority.authorityEpochId,
      authority.supervisorInstanceId,
      authority.originalKeyHash,
      authority.wrapperKeyHash,
    ]
  )
  if (
    current.rows.length !== 1 ||
    current.rows[0]?.held !== true ||
    current.rows[0].headInputJson !== source.headInputJson ||
    current.rows[0].confirmedSequence !== source.confirmedSequence
  )
    receiptFailure("SUPERVISOR_SNAPSHOT_CHANGED")
  const head = verifyHead(JSON.parse(source.headInputJson), authority)
  const authenticated = authenticateRetainedSupervisorHistoryBytes(source, authority)
  const fresh = await readRetainedSupervisorAuthoritySource(client, {
    operationId: authenticated.wrapper.payload.operationId,
    attemptId: authenticated.wrapper.payload.attemptId,
    commandId: authenticated.original.payload.commandId,
    authorityEpochId: authority.authorityEpochId,
    supervisorInstanceId: authority.supervisorInstanceId,
    receiptHash: authenticated.original.hash,
    ...(source.ownership.length
      ? { executorKey: source.ownership[0]!.original.payload.ownership.executorKey }
      : {}),
  })
  if (
    fresh.originalInputJson !== source.originalInputJson ||
    fresh.wrapperInputJson !== source.wrapperInputJson
  )
    receiptFailure("SUPERVISOR_AUTHORITY_SOURCE_MISMATCH")
  const ownership = fresh.ownership.map((bytes) => ({
    ...bytes,
    ...authenticateRetainedSupervisorHistoryBytes(bytes, authority),
  }))
  const first = [authenticated, ...ownership].sort(
    (a, b) => a.wrapper.sequence - b.wrapper.sequence
  )[0]!
  let sequence = first.wrapper.sequence - 1,
    originalHash = first.original.previousHash,
    wrapperHash = first.wrapper.previousHash
  let tail = first.wrapper
  const required = new Map(
    [authenticated, ...ownership].map((record) => [record.wrapper.sequence, record.wrapper.hash])
  )
  let currentAttemptReceipt = ""
  const commandPredecessors = new Map<string, string>()
  for (;;) {
    const result = await client.query(
      `SELECT sequence::text,"originalInputJson","wrapperInputJson" FROM "ScanSupervisorJournalRecord"
      WHERE "streamId"=$1 AND sequence>$2::bigint AND sequence<=$3::bigint ORDER BY "ScanSupervisorJournalRecord".sequence LIMIT 100`,
      [authority.streamId, String(sequence), String(head.sequence)]
    )
    for (const value of result.rows) {
      const row = bytesSchema.parse(value),
        record = authenticateRetainedSupervisorHistoryBytes(row, authority)
      if (
        record.wrapper.sequence !== sequence + 1 ||
        Number(row.sequence) !== record.wrapper.sequence ||
        record.wrapper.previousHash !== wrapperHash ||
        record.original.previousHash !== originalHash ||
        (required.has(record.wrapper.sequence) &&
          required.get(record.wrapper.sequence) !== record.wrapper.hash)
      )
        receiptFailure("SUPERVISOR_AUTHORITY_SOURCE_MISMATCH")
      required.delete(record.wrapper.sequence)
      if (
        record.wrapper.payload.operationId === authenticated.wrapper.payload.operationId &&
        record.wrapper.payload.attemptId === authenticated.wrapper.payload.attemptId &&
        record.wrapper.payload.workspaceId === authenticated.wrapper.payload.workspaceId
      ) {
        const event = record.original.payload
        if (event.type === "command_intent") {
          const command = z
            .object({ commandId: z.string(), type: z.string() })
            .passthrough()
            .parse(event.command)
          if (command.type !== "PREPARE")
            commandPredecessors.set(command.commandId, currentAttemptReceipt)
        } else if (
          !["prepare_invocation_completed", "native_invocation_retired"].includes(
            String(event.type)
          ) &&
          !(
            event.type === "native_invocation_ack" &&
            ["SANDBOX_TOOL_START_ACK", "SANDBOX_TOOL_MUTATION_ACK"].includes(
              String(event.nativeOperation)
            )
          )
        ) {
          currentAttemptReceipt = record.original.hash
        }
      }
      sequence = record.wrapper.sequence
      wrapperHash = record.wrapper.hash
      originalHash = record.original.hash
      tail = record.wrapper
    }
    if (result.rows.length < 100) break
  }
  if (
    required.size ||
    sequence !== head.sequence ||
    wrapperHash !== head.recordHash ||
    tail.previousHash !== head.previousHash ||
    tail.payload.operationId !== head.operationId ||
    tail.payload.scanId !== head.scanId ||
    tail.payload.workspaceId !== head.workspaceId ||
    tail.payload.attemptId !== head.attemptId ||
    tail.payload.eventId !== head.eventId
  )
    receiptFailure("SUPERVISOR_HEAD_MISMATCH")
  return { ...fresh, ...authenticated, head, ownership, currentAttemptReceipt, commandPredecessors }
}
