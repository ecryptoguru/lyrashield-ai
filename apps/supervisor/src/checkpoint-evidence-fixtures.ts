import { canonicalJson, type AuthorityHead } from "@lyrashield/runtime-control"
import { checkpointSign, type CheckpointRecord } from "./checkpoint-format"

export const checkpointKeys = {
  originalSigningSecret: "o".repeat(48),
  wrapperSigningSecret: "w".repeat(48),
  checkpointSigningSecret: "c".repeat(48),
}
export const checkpointStream = {
  epochId: "epoch-checkpoint-1",
  supervisorInstanceId: "supervisor-checkpoint-1",
}
export function fixtureHead(record: CheckpointRecord): AuthorityHead {
  const { epochId, operationId, scanId, workspaceId, attemptId, eventId } = record.payload
  const body = {
    schema: "lyrashield-independent-authority-head/1" as const,
    supervisorInstanceId: checkpointStream.supervisorInstanceId,
    epochId,
    operationId,
    scanId,
    workspaceId,
    attemptId,
    eventId,
    sequence: record.sequence,
    previousHash: record.previousHash,
    recordHash: record.hash,
  }
  return { ...body, signature: checkpointSign(checkpointKeys.wrapperSigningSecret, body) }
}
export function fixtureRecordBytes(record: CheckpointRecord): Uint8Array {
  const body = {
    schema: "lyrashield-independent-authority-record/1",
    supervisorInstanceId: checkpointStream.supervisorInstanceId,
    record,
  }
  return Buffer.from(
    canonicalJson({
      ...body,
      signature: checkpointSign(checkpointKeys.wrapperSigningSecret, body),
    }),
    "utf8"
  )
}
