import { z } from "zod"
import type { StoredObject } from "@lyrashield/runtime-control"
import type { CheckpointKeys, CheckpointRecord, SupervisorCheckpoint } from "./checkpoint-format"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."))
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const checkpointStreamAuthoritySchema = z
  .object({
    schema: z.literal("lyrashield-checkpoint-stream-authority/1"),
    epochId: id,
    supervisorInstanceId: id,
    state: z.literal("ACTIVE"),
    revision: z.number().int().positive().safe(),
    confirmedSequence: z.number().int().nonnegative().safe(),
    originalHash: hash,
    wrapperHash: hash,
    checkpointHash: hash,
  })
  .strict()
export type CheckpointStreamAuthority = z.infer<typeof checkpointStreamAuthoritySchema>
export interface AuthenticatedCheckpointIdentity {
  schema: "lyrashield-authenticated-checkpoint/1"
  checkpoint: SupervisorCheckpoint
  authority: CheckpointStreamAuthority
}

/**
 * All methods must enforce byte/deadline bounds before allocation and use an indexed
 * lookup rather than scan the original journal. No method may publish, repair or
 * discard history. Real protected implementations and native lifecycle are unqualified.
 */
export interface CheckpointLocalReader {
  readHeads(
    maxBytes: number
  ): Promise<{ original: unknown | null; wrapper: unknown | null; checkpoint: unknown | null }>
  readCheckpointAt(sequence: number, maxBytes: number): Promise<unknown | null>
  readSegment(checkpointHash: string, maxBytes: number): Promise<Uint8Array | null>
}
export interface CheckpointObjectReader {
  readBounded(key: string, maxBytes: number): Promise<StoredObject | null>
}
export interface CheckpointMirrorReader {
  readHead(maxBytes: number): Promise<unknown | null>
  readCheckpoint(checkpointHash: string, maxBytes: number): Promise<unknown | null>
  readRecord(sequence: number, maxBytes: number): Promise<unknown | null>
}

/**
 * Mandatory authenticated persisted authority. Returning matching caller input is
 * never sufficient: the implementation must independently resolve current active
 * epoch, rollback-resistant heads/revision, immutable range index and committed
 * checkpoint ancestry/record digest. It must reject pending or ambiguous suffixes.
 * Each record must match current operation/attempt/command/grant authority.
 * Synthetic fixture implementations do not establish production authorization.
 */
export interface CheckpointTrustPort {
  readStream(stream: {
    epochId: string
    supervisorInstanceId: string
  }): Promise<CheckpointStreamAuthority | null>
  confirmCheckpoint(
    checkpoint: SupervisorCheckpoint,
    authority: CheckpointStreamAuthority
  ): Promise<AuthenticatedCheckpointIdentity | null>
  authorizeRecord(record: CheckpointRecord, authority: CheckpointStreamAuthority): Promise<boolean>
}
export interface SupervisorCheckpointReaderOptions extends CheckpointKeys {
  epochId: string
  supervisorInstanceId: string
  local: CheckpointLocalReader
  store: CheckpointObjectReader
  mirror: CheckpointMirrorReader
  trust: CheckpointTrustPort
}
