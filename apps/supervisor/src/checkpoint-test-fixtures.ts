import { fixtureAuthorityFence } from "./test-fixtures"
import {
  checkpointKeys,
  checkpointStream,
  fixtureHead,
  fixtureRecordBytes,
} from "./checkpoint-evidence-fixtures"
export { checkpointKeys, checkpointStream, fixtureHead } from "./checkpoint-evidence-fixtures"
import { constants } from "node:fs"
import { mkdtemp, open, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  SignedJournal,
  authorityEventSchema,
  canonicalJson,
  sha256Hex,
  type AuthorityHead,
  type AuthorityMirror,
  type ConditionalObjectStore,
  type StoredObject,
  type SupervisorCommand,
  type SupervisorRecoveryRequest,
} from "@lyrashield/runtime-control"
import { SupervisorAuthorityJournal } from "./authority-journal"
import { SupervisorService } from "./service"
import { supervisorJournalEventSchema, type SupervisorJournalEvent } from "./journal-events"
import {
  CHECKPOINT_GENESIS,
  CHECKPOINT_LIMITS,
  buildCheckpointCandidate,
  checkpointSame,
  checkpointSign,
  type CheckpointOriginal,
  type CheckpointRecord,
  type SupervisorCheckpoint,
} from "./checkpoint-format"
import { SupervisorCheckpointReader } from "./checkpoint-reader"
import type {
  CheckpointStreamAuthority,
  SupervisorCheckpointReaderOptions,
} from "./checkpoint-ports"

export const checkpointBinding = {
  attemptId: "attempt-checkpoint-1",
  scanId: "scan-checkpoint-1",
  workspaceId: "workspace-checkpoint-1",
  operationId: "operation-checkpoint-1",
  authorityEpochId: checkpointStream.epochId,
  authorityRevision: 9,
  workerIdentity: "worker-checkpoint-1",
  billingMode: "UNMETERED" as const,
  expiresAt: "2026-11-11T20:00:00.000Z",
}
export const checkpointPrepare: Extract<SupervisorCommand, { type: "PREPARE" }> = {
  type: "PREPARE",
  commandId: "prepare-checkpoint-1",
  attempt: checkpointBinding,
  executors: [
    {
      key: "scanner",
      spec: {
        kind: "container",
        image: "fixture@sha256:" + "a".repeat(64),
        argv: [],
        env: {},
        network: "fixture",
        cpus: 1,
        memoryMb: 64,
        pidsLimit: 16,
        readOnly: true,
        grantEnvName: "LLM_API_KEY",
      },
    },
  ],
}
export const checkpointCursor = {
  ...checkpointStream,
  afterSequence: 0,
  afterHash: CHECKPOINT_GENESIS,
  limit: 17,
}
export const recoverySelector: SupervisorRecoveryRequest = {
  ...checkpointStream,
  workspaceId: checkpointBinding.workspaceId,
  scanId: checkpointBinding.scanId,
  operationId: checkpointBinding.operationId,
  attemptId: checkpointBinding.attemptId,
  commandId: checkpointPrepare.commandId,
  expectedCommandHash: sha256Hex(canonicalJson(checkpointPrepare)),
}
const prefix = `epochs/${checkpointStream.epochId}/supervisors/${checkpointStream.supervisorInstanceId}`
export class CheckpointFixtureStore implements ConditionalObjectStore {
  objects = new Map<string, StoredObject>()
  writes = 0
  reads: { key: string; maxBytes: number; bytes: number }[] = []
  loseOnRecord = false
  beforeRead?: (key: string) => Promise<void>
  async read(key: string) {
    return this.objects.get(key) ?? null
  }
  async readBounded(key: string, maxBytes: number) {
    await this.beforeRead?.(key)
    const object = this.objects.get(key) ?? null
    this.reads.push({ key, maxBytes, bytes: object?.bytes.byteLength ?? 0 })
    if (object && object.bytes.byteLength > maxBytes)
      throw new Error("bounded object read exceeded limit")
    return object ? { ...object, bytes: Buffer.from(object.bytes) } : null
  }
  async put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ) {
    const previous = this.objects.get(key)
    if (
      ("ifNoneMatch" in condition && previous) ||
      ("ifMatch" in condition && previous?.etag !== condition.ifMatch)
    )
      return "conflict" as const
    this.objects.set(key, { bytes: Buffer.from(bytes), etag: `"fixture-${++this.writes}"` })
    if (this.loseOnRecord && key.includes("/records/")) {
      this.loseOnRecord = false
      throw new Error("record applied but reply lost")
    }
    return "written" as const
  }
}
export class CheckpointFixtureMirror implements AuthorityMirror {
  head: AuthorityHead | null = null
  records = new Map<number, CheckpointRecord>()
  checkpoints = new Map<string, unknown>()
  writes = 0
  recordReads: number[] = []
  headReads = 0
  checkpointReads = 0
  async readHead() {
    this.headReads++
    return structuredClone(this.head)
  }
  async readRecord(sequence: number) {
    this.recordReads.push(sequence)
    return structuredClone(this.records.get(sequence) ?? null)
  }
  async readCheckpoint(hash: string) {
    this.checkpointReads++
    return structuredClone(this.checkpoints.get(hash) ?? null)
  }
  async compareAndAppend(
    previous: AuthorityHead | null,
    head: AuthorityHead,
    record: CheckpointRecord
  ) {
    if (
      checkpointSame(head, this.head) &&
      checkpointSame(this.records.get(record.sequence) ?? null, record)
    )
      return "written" as const
    if (!checkpointSame(previous, this.head)) return "conflict" as const
    this.head = structuredClone(head)
    this.records.set(record.sequence, structuredClone(record))
    this.writes++
    return "written" as const
  }
}
async function readFixtureFile(path: string, maxBytes: number): Promise<Uint8Array> {
  // Test-only path is rooted in the owned fixture directory; no user path is accepted.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("bounded fixture segment metadata differs")
    const buffer = Buffer.alloc(maxBytes + 1)
    const result = await file.read(buffer, 0, maxBytes + 1, 0)
    if (result.bytesRead > maxBytes) throw new Error("bounded fixture segment exceeds limit")
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await file.close()
  }
}

interface FixtureState {
  root: string
  store: CheckpointFixtureStore
  mirror: CheckpointFixtureMirror
  heads: {
    original: CheckpointOriginal | null
    wrapper: CheckpointRecord | null
    checkpoint: SupervisorCheckpoint | null
  }
  authorityState: {
    active: boolean
    records: boolean
    unavailable: boolean
    current: CheckpointStreamAuthority
  }
  accepted: Map<string, SupervisorCheckpoint>
  acceptedRecords: Map<number, CheckpointRecord>
  index: Map<number, string>
  calls: {
    localHeads: number
    localIndex: number
    localSegments: number
    localBytes: number
    stream: number
    checkpoint: number
    authorize: number
  }
  journal: SupervisorAuthorityJournal
  nativeWrapper: SignedJournal<CheckpointRecord["payload"]>
}

export async function createCheckpointFixture(count = 130) {
  const root = await mkdtemp(join(tmpdir(), "supervisor-checkpoint-"))
  const store = new CheckpointFixtureStore(),
    mirror = new CheckpointFixtureMirror()
  const nativeOriginal = new SignedJournal(
    join(root, "original.jsonl"),
    checkpointKeys.originalSigningSecret,
    (value) => supervisorJournalEventSchema.parse(value)
  )
  const nativeWrapper = new SignedJournal<CheckpointRecord["payload"]>(
    join(root, "wrapper.jsonl"),
    checkpointKeys.wrapperSigningSecret,
    (value) => authorityEventSchema(z.custom<CheckpointOriginal>()).parse(value)
  )
  const heads: FixtureState["heads"] = {
    original: null,
    wrapper: null,
    checkpoint: null,
  }
  const originalPort = {
    load: () => nativeOriginal.load(),
    loadBounded: (limits: { maxRecords: number; maxBytes: number }) =>
      nativeOriginal.loadBounded(limits),
    confirmRecord: (record: CheckpointOriginal) => nativeOriginal.confirmRecord(record),
    append: async (event: SupervisorJournalEvent) => {
      const record = await nativeOriginal.append(event)
      heads.original = record
      return record
    },
  }
  const wrapperPort = {
    load: () => nativeWrapper.load(),
    loadBounded: (limits: { maxRecords: number; maxBytes: number }) =>
      nativeWrapper.loadBounded(limits),
    confirmRecord: (record: CheckpointRecord) => nativeWrapper.confirmRecord(record),
    append: async (event: CheckpointRecord["payload"]) => {
      const record = await nativeWrapper.append(event)
      heads.wrapper = record
      return record
    },
  }
  const authorityState: FixtureState["authorityState"] = {
    active: true,
    records: true,
    unavailable: false,
    current: {
      schema: "lyrashield-checkpoint-stream-authority/1",
      ...checkpointStream,
      state: "ACTIVE",
      revision: 1,
      confirmedSequence: 0,
      originalHash: CHECKPOINT_GENESIS,
      wrapperHash: CHECKPOINT_GENESIS,
      checkpointHash: CHECKPOINT_GENESIS,
    },
  }
  const accepted = new Map<string, SupervisorCheckpoint>(),
    acceptedRecords = new Map<number, CheckpointRecord>(),
    index = new Map<number, string>()
  const calls = {
    localHeads: 0,
    localIndex: 0,
    localSegments: 0,
    localBytes: 0,
    stream: 0,
    checkpoint: 0,
    authorize: 0,
  }
  const journal = new SupervisorAuthorityJournal({
    original: originalPort,
    local: wrapperPort,
    store,
    mirror,
    ...checkpointStream,
    signingSecret: checkpointKeys.wrapperSigningSecret,
    authorize: async (_event, binding) =>
      authorityState.records && checkpointSame(binding, checkpointBinding),
    authorizeStream: async () => authorityState.active,
    authorizeRecovery: async (request, _original, command, binding) =>
      authorityState.records &&
      checkpointSame(binding, checkpointBinding) &&
      checkpointSame(request, recoverySelector) &&
      checkpointSame(command, checkpointPrepare),
  })
  const state = {
    root,
    store,
    mirror,
    heads,
    authorityState,
    accepted,
    acceptedRecords,
    index,
    calls,
    journal,
    nativeWrapper,
  }
  const options = fixtureReaderOptions(state)
  await populateFixture(count, originalPort, wrapperPort, store, mirror)
  // Actual adapter readback independently validates both native files and the synthetic R2/DB formats.
  await journal.load()
  const publish = () => publishFixture(state)
  const effects = { create: 0, start: 0, inspect: 0, stop: 0, provider: 0 }
  const service = fixtureService(journal, effects)
  await publish()
  const resetCounts = () => {
    for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0
    store.reads = []
    mirror.recordReads = []
    mirror.headReads = 0
    mirror.checkpointReads = 0
  }
  resetCounts()
  return {
    root,
    store,
    mirror,
    heads,
    options,
    journal,
    nativeOriginal,
    nativeWrapper,
    authorityState,
    accepted,
    acceptedRecords,
    index,
    calls,
    effects,
    service,
    publish,
    resetCounts,
    reader: new SupervisorCheckpointReader(options),
    freshReader: () => new SupervisorCheckpointReader(options),
    close: async () => {
      await nativeOriginal.close()
      await nativeWrapper.close()
    },
  }
}

function fixtureReaderOptions(state: FixtureState): SupervisorCheckpointReaderOptions {
  const { root, store, mirror, heads, calls, accepted, index, acceptedRecords, authorityState } =
    state
  return {
    ...checkpointKeys,
    ...checkpointStream,
    store,
    mirror: {
      readHead: () => mirror.readHead(),
      readRecord: (sequence) => mirror.readRecord(sequence),
      readCheckpoint: (hash) => mirror.readCheckpoint(hash),
    },
    local: {
      readHeads: async () => {
        calls.localHeads++
        return structuredClone(heads)
      },
      readCheckpointAt: async (sequence) => {
        calls.localIndex++
        return structuredClone(accepted.get(index.get(sequence) ?? "") ?? null)
      },
      readSegment: async (hash, maxBytes) => {
        calls.localSegments++
        const bytes = await readFixtureFile(join(root, `${hash}.json`), maxBytes)
        calls.localBytes += bytes.byteLength
        return bytes
      },
    },
    trust: {
      readStream: async () => {
        calls.stream++
        if (authorityState.unavailable) throw new Error("trusted authority unavailable")
        return authorityState.active ? structuredClone(authorityState.current) : null
      },
      confirmCheckpoint: async (checkpoint, authority) => {
        calls.checkpoint++
        const known = accepted.get(checkpoint.checkpointHash)
        if (
          !known ||
          index.get(checkpoint.firstSequence) !== checkpoint.checkpointHash ||
          !checkpointSame(known, checkpoint) ||
          !checkpointSame(authority, authorityState.current)
        )
          return null
        return {
          schema: "lyrashield-authenticated-checkpoint/1",
          checkpoint: structuredClone(known),
          authority: structuredClone(authorityState.current),
        }
      },
      authorizeRecord: async (record, authority) => {
        calls.authorize++
        return (
          authorityState.records &&
          checkpointSame(record, acceptedRecords.get(record.sequence)) &&
          checkpointSame(authority, authorityState.current)
        )
      },
    },
  }
}

async function publishFixture(state: FixtureState) {
  const {
    root,
    journal,
    nativeWrapper,
    accepted,
    mirror,
    store,
    index,
    acceptedRecords,
    heads,
    authorityState,
  } = state
  const records = (await journal.load(), await nativeWrapper.load())
  let previous: SupervisorCheckpoint | null = null
  for (let offset = 0; offset < records.length; offset += CHECKPOINT_LIMITS.records) {
    const candidate = buildCheckpointCandidate(
      records.slice(offset, offset + CHECKPOINT_LIMITS.records),
      previous,
      checkpointStream,
      checkpointKeys
    )
    // Test-only checkpoint names are validated SHA-256 hashes under the owned fixture root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(join(root, `${candidate.checkpoint.checkpointHash}.json`), candidate.bytes, {
      mode: 0o600,
    })
    accepted.set(candidate.checkpoint.checkpointHash, structuredClone(candidate.checkpoint))
    mirror.checkpoints.set(
      candidate.checkpoint.checkpointHash,
      structuredClone(candidate.checkpoint)
    )
    store.objects.set(`${prefix}/checkpoints/${candidate.checkpoint.checkpointHash}`, {
      bytes: Buffer.from(canonicalJson(candidate.checkpoint)),
      etag: '"checkpoint-fixture"',
    })
    for (const record of records.slice(offset, offset + CHECKPOINT_LIMITS.records)) {
      index.set(record.sequence, candidate.checkpoint.checkpointHash)
      acceptedRecords.set(record.sequence, structuredClone(record))
    }
    previous = candidate.checkpoint
  }
  heads.checkpoint = previous
  authorityState.current = {
    ...authorityState.current,
    revision: authorityState.current.revision + 1,
    confirmedSequence: records.length,
    originalHash: heads.original?.hash ?? CHECKPOINT_GENESIS,
    wrapperHash: heads.wrapper?.hash ?? CHECKPOINT_GENESIS,
    checkpointHash: previous?.checkpointHash ?? CHECKPOINT_GENESIS,
  }
}

async function populateFixture(
  count: number,
  original: { append(event: SupervisorJournalEvent): Promise<CheckpointOriginal> },
  wrapper: { append(event: CheckpointRecord["payload"]): Promise<CheckpointRecord> },
  store: CheckpointFixtureStore,
  mirror: CheckpointFixtureMirror
) {
  for (let offset = 0; offset < count; offset++) {
    const common = {
      supervisorInstanceId: checkpointStream.supervisorInstanceId,
      observedAt: "2026-11-11T10:00:00.000Z",
    }
    const event: SupervisorJournalEvent =
      offset === 0
        ? { ...common, type: "command_intent", command: checkpointPrepare }
        : offset === 1
          ? {
              ...common,
              type: "attempt_prepared",
              commandId: checkpointPrepare.commandId,
              binding: checkpointBinding,
              executors: checkpointPrepare.executors,
            }
          : {
              ...common,
              type: "attempt_status",
              commandId: checkpointPrepare.commandId,
              attemptId: checkpointBinding.attemptId,
              status: "UNKNOWN",
            }
    const signed = await original.append(event)
    const record = await wrapper.append({
      epochId: checkpointStream.epochId,
      operationId: checkpointBinding.operationId,
      scanId: checkpointBinding.scanId,
      workspaceId: checkpointBinding.workspaceId,
      attemptId: checkpointBinding.attemptId,
      eventId: `supervisor:${signed.hash}`,
      payload: signed,
    })
    store.objects.set(`${prefix}/records/${record.sequence}`, {
      bytes: fixtureRecordBytes(record),
      etag: '"record-fixture"',
    })
    store.objects.set(`${prefix}/head`, {
      bytes: Buffer.from(canonicalJson(fixtureHead(record))),
      etag: '"head-fixture"',
    })
    const acknowledgement = {
      schema: "lyrashield-supervisor-observed-mirror-ack/1",
      head: fixtureHead(record),
    }
    store.objects.set(`${prefix}/acknowledgements/${record.sequence}`, {
      bytes: Buffer.from(
        canonicalJson({
          ...acknowledgement,
          signature: checkpointSign(checkpointKeys.wrapperSigningSecret, acknowledgement),
        })
      ),
      etag: '"ack-fixture"',
    })
    mirror.records.set(record.sequence, structuredClone(record))
    mirror.head = fixtureHead(record)
  }
}
function fixtureService(
  journal: SupervisorAuthorityJournal,
  effects: { create: number; start: number; inspect: number; stop: number; provider: number }
) {
  return new SupervisorService({
    authorityFence: fixtureAuthorityFence,
    journal,
    signingSecret: checkpointKeys.wrapperSigningSecret,
    ...checkpointStream,
    admission: "closed",
    providerGatewayUrl: "http://127.0.0.1:1",
    policy: {
      allowedImages: new Set(),
      allowedNetworks: new Set(),
      allowedProcessCommands: new Set(),
      allowedCwdRoots: [tmpdir()],
      allowedCgroupRoot: tmpdir(),
    },
    executor: {
      create: async () => {
        effects.create++
        throw new Error("unexpected physical create")
      },
      start: async () => {
        effects.start++
        throw new Error("unexpected start")
      },
      inspect: async () => {
        effects.inspect++
        return { state: "ABSENT" }
      },
      stop: async () => {
        effects.stop++
        return { state: "ABSENT" }
      },
    },
    providerGateway: {
      issueGrant: async () => {
        effects.provider++
        throw new Error("unexpected grant")
      },
      findGrantByRequest: async () => {
        effects.provider++
        return null
      },
      inspectGrant: async () => {
        effects.provider++
        return null
      },
      revokeGrant: async () => {
        effects.provider++
        throw new Error("unexpected revoke")
      },
    },
  })
}
