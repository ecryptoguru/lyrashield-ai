import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, createHmac } from "node:crypto"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import {
  SignedJournal,
  authorityEventSchema,
  canonicalJson,
  createJournalSeal,
  StoredJournalSealEvidenceReader,
  ProtectedJournalSealPinStore,
  R2ConditionalObjectStore,
  type AuthorityHead,
  type AuthorityEvent,
  type JournalRecord,
  type StoredObject,
  type JournalSealControlGate,
} from "@lyrashield/runtime-control"
import { SupervisorAuthorityJournal } from "./authority-journal"
import {
  supervisorJournalEventSchema,
  supervisorJournalRecordSchema,
  type SupervisorJournalEvent,
} from "./journal-events"
import { createSealedRecoveryCandidate, validateSealedRecoverySnapshot } from "./sealed-recovery"
import { sealedRecoverySchema } from "./sealed-recovery-schema"
import { loadSealedRecoveryBase } from "./sealed-recovery-load"
import { commandRequestHash } from "./service-common"

const roots: string[] = []
const epochId = "epoch-test-1",
  supervisorInstanceId = "supervisor-test-1"
const sourceKey = "o".repeat(48),
  wrapperKey = "w".repeat(48)
const sealKey = "s".repeat(48)
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const binding = {
  attemptId: "attempt-test-1",
  scanId: "scan-test-1",
  workspaceId: "workspace-test-1",
  operationId: "operation-test-1",
  authorityEpochId: epochId,
  authorityRevision: 1,
  workerIdentity: "worker-test-1",
  billingMode: "UNMETERED" as const,
  expiresAt: "2026-12-01T00:00:00.000Z",
}
const executors = [
  {
    key: "sandbox" as const,
    spec: {
      kind: "container" as const,
      image: "sha256:test",
      argv: [],
      env: {},
      network: "none",
      cpus: 1,
      memoryMb: 128,
      pidsLimit: 16,
      readOnly: true,
      grantEnvName: "LLM_API_KEY",
    },
  },
]
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(paid = false) {
  const root = await mkdtemp(join(tmpdir(), "sealed-recovery-"))
  roots.push(root)
  const original = new SignedJournal(join(root, "original"), sourceKey, (value) =>
    supervisorJournalEventSchema.parse(value)
  )
  const local = new SignedJournal<AuthorityEvent<JournalRecord<SupervisorJournalEvent>>>(
    join(root, "wrapper"),
    wrapperKey,
    (value) => authorityEventSchema(supervisorJournalRecordSchema).parse(value)
  )
  const objects = new Map<string, StoredObject>()
  let writes = 0
  const store = {
    read: async (key: string) => objects.get(key) ?? null,
    readBounded: async (key: string, maxBytes: number) => {
      const value = objects.get(key) ?? null
      if (value && value.bytes.byteLength > maxBytes) throw new Error("oversized")
      return value
    },
    put: async (
      key: string,
      bytes: Uint8Array,
      condition: { ifNoneMatch: true } | { ifMatch: string }
    ) => {
      const old = objects.get(key)
      if (
        ("ifNoneMatch" in condition && old) ||
        ("ifMatch" in condition && condition.ifMatch !== old?.etag)
      )
        return "conflict" as const
      objects.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++writes}` })
      return "written" as const
    },
  }
  let head: AuthorityHead | null = null
  let sealHead: ReturnType<typeof createJournalSeal> | null = null
  const wrappers = new Map<number, JournalRecord<unknown>>()
  const mirror = {
    readHead: async () => head,
    readHeadBounded: async () => head,
    readRecord: async (sequence: number) => wrappers.get(sequence) ?? null,
    readRecordBounded: async (sequence: number) => wrappers.get(sequence) ?? null,
    readSealHeadBounded: async () => sealHead,
    readSealBounded: async (revision: number) =>
      sealHead?.revision === revision ? sealHead : null,
    compareAndAppend: async (
      previous: AuthorityHead | null,
      next: AuthorityHead,
      record: JournalRecord<unknown>
    ) => {
      if (
        canonicalJson(head) === canonicalJson(next) &&
        canonicalJson(wrappers.get(record.sequence)) === canonicalJson(record)
      )
        return "written" as const
      if (canonicalJson(head) !== canonicalJson(previous)) return "conflict" as const
      head = next
      wrappers.set(record.sequence, structuredClone(record))
      return "written" as const
    },
  }
  const journal = new SupervisorAuthorityJournal({
    original,
    local,
    store,
    mirror,
    epochId,
    supervisorInstanceId,
    signingSecret: wrapperKey,
    authorize: async () => true,
    authorizeStream: async () => true,
    authorizeRecovery: async () => true,
  })
  const base = { supervisorInstanceId, observedAt: "2026-11-12T00:00:00.000Z" }
  const attemptBinding = { ...binding, billingMode: paid ? ("PAID" as const) : binding.billingMode }
  const provider = paid
    ? {
        providerId: "azure-ai",
        maxRequests: 4,
        costReservationMicros: 100,
        maxReservedCostMicros: 1000,
      }
    : undefined
  await journal.append({
    ...base,
    type: "command_intent",
    command: {
      type: "PREPARE",
      commandId: "command-prepare-1",
      attempt: attemptBinding,
      executors,
      ...(provider ? { provider } : {}),
    },
  })
  await journal.append({
    ...base,
    type: "attempt_prepared",
    commandId: "command-prepare-1",
    binding: attemptBinding,
    executors,
    ...(provider ? { provider } : {}),
  })
  await journal.append({
    ...base,
    type: "command_intent",
    command: {
      type: paid ? "START_PAID" : "START_UNMETERED",
      commandId: "command-start-1",
      attemptId: binding.attemptId,
      executorKey: "sandbox",
      expectedReceiptHash: "0".repeat(64),
    },
  })
  return {
    journal,
    original,
    local,
    objects,
    wrappers,
    store,
    mirror,
    setSeal: (value: ReturnType<typeof createJournalSeal>) => {
      sealHead = value
    },
  }
}

async function pinnedFixture() {
  const f = await fixture()
  const stream = { epochId, supervisorInstanceId }
  const candidate = await createSealedRecoveryCandidate(f.journal, { ...stream, lastSequence: 3 })
  const original = Buffer.concat(
    (await f.original.readRawRange(0, { maxBytes: 8192, maxRecords: 3 })).records
  )
  const wrapper = Buffer.concat(
    (await f.local.readRawRange(0, { maxBytes: 8192, maxRecords: 3 })).records
  )
  const head = (await f.mirror.readHead())!
  const prefix = `epochs/${epochId}/supervisors/${supervisorInstanceId}`
  const journalAck = f.objects.get(`${prefix}/acknowledgements/3`)!.bytes
  const seal = createJournalSeal(
    {
      schema: "lyrashield-journal-seal/2",
      ...stream,
      revision: 1,
      firstSequence: 1,
      lastSequence: 3,
      previousSealHash: "0".repeat(64),
      originalPreviousHash: "0".repeat(64),
      wrapperPreviousHash: "0".repeat(64),
      originalLastHash: candidate.originalLastHash,
      wrapperLastHash: candidate.wrapperLastHash,
      originalSegmentSha256: digest(original),
      wrapperSegmentSha256: digest(wrapper),
      originalBytes: original.length,
      wrapperBytes: wrapper.length,
      recordCount: 3,
      independentHeadHash: digest(Buffer.from(canonicalJson(head))),
      observedJournalAckHash: digest(journalAck),
      originalSegmentStartSequence: 1,
      wrapperSegmentStartSequence: 1,
      originalByteOffset: original.length,
      wrapperByteOffset: wrapper.length,
      recoverySnapshotSha256: candidate.sha256,
      recoverySnapshotBytes: candidate.bytes.byteLength,
    },
    sealKey
  )
  const put = async (key: string, value: Uint8Array | string) => {
    expect(await f.store.put(key, Buffer.from(value), { ifNoneMatch: true })).toBe("written")
  }
  const ackBody = {
    schema: "lyrashield-journal-seal-observed-mirror-ack/1",
    ...stream,
    revision: seal.revision,
    sealHash: seal.sealHash,
  }
  const ack = canonicalJson({
    ...ackBody,
    signature: createHmac("sha256", sealKey).update(canonicalJson(ackBody)).digest("hex"),
  })
  await put(`${prefix}/seal-head`, canonicalJson(seal))
  await put(`${prefix}/seals/${seal.sealHash}`, canonicalJson(seal))
  await put(`${prefix}/seal-acknowledgements/${seal.sealHash}`, ack)
  await put(`${prefix}/seal-segments/${seal.sealHash}/original`, original)
  await put(`${prefix}/seal-segments/${seal.sealHash}/wrapper`, wrapper)
  await put(`${prefix}/seal-journal-heads/${seal.independentHeadHash}`, canonicalJson(head))
  const snapshotKey = `${prefix}/recovery-snapshots/${seal.sealHash}`
  await put(snapshotKey, candidate.bytes)
  f.setSeal(seal)
  const evidence = new StoredJournalSealEvidenceReader({
    ...stream,
    store: f.store,
    mirror: f.mirror,
    headSigningSecret: wrapperKey,
    sealSigningSecret: sealKey,
    originalSigningSecret: sourceKey,
    wrapperSigningSecret: wrapperKey,
    validateOriginal: (value) => supervisorJournalEventSchema.parse(value),
  })
  const controlObjects = new Map<string, { bytes: Buffer; etag: string }>()
  let controlWrites = 0
  const client = {
    async send(command: {
      input: {
        Key?: string
        IfNoneMatch?: string
        IfMatch?: string
        Body?: Uint8Array
      }
    }) {
      const key = command.input.Key!,
        existing = controlObjects.get(key)
      if (command.constructor.name === "GetObjectCommand") {
        if (!existing) throw { $metadata: { httpStatusCode: 404 } }
        return {
          ETag: existing.etag,
          ContentLength: existing.bytes.length,
          Body: Readable.from([existing.bytes]),
        }
      }
      if (
        (command.input.IfNoneMatch === "*" && existing) ||
        (command.input.IfMatch && command.input.IfMatch !== existing?.etag)
      )
        throw { $metadata: { httpStatusCode: 412 } }
      controlObjects.set(key, {
        bytes: Buffer.from(command.input.Body as Uint8Array),
        etag: `"etag-${++controlWrites}"`,
      })
      return {}
    },
  }
  const control = new R2ConditionalObjectStore(
    client as unknown as ConstructorParameters<typeof R2ConditionalObjectStore>[0],
    "recovery-control"
  )
  const genesisBody = {
    schema: "lyrashield-root-control-seal-genesis/1",
    productRevision: "a".repeat(40),
    ...stream,
  }
  const genesis = Buffer.from(
    canonicalJson({
      ...genesisBody,
      signature: createHmac("sha256", sealKey).update(canonicalJson(genesisBody)).digest("hex"),
    })
  )
  await control.put(`journal-seal-pins/${epochId}/${supervisorInstanceId}/current`, genesis, {
    ifNoneMatch: true,
  })
  const options = {
    ...stream,
    epoch: 1,
    productRevision: "a".repeat(40),
    checkpointSecret: sealKey,
    checkpointKeyHash: digest(Buffer.from(sealKey)),
    controlAccountId: "a".repeat(32),
    controlBucket: "recovery-control",
    genesisRecordHash: digest(genesis),
  }
  const gate: JournalSealControlGate = {
    withAuthorizedStream: async (_stream, fn) =>
      fn({
        policy: {
          schema: "lyrashield-journal-seal-control/1",
          productRevision: options.productRevision,
          epochId,
          epoch: options.epoch,
          streamId: `supervisor:${supervisorInstanceId}`,
          supervisorInstanceId,
          originalKeyHash: digest(Buffer.from(sourceKey)),
          wrapperKeyHash: digest(Buffer.from(wrapperKey)),
          checkpointKeyHash: options.checkpointKeyHash,
          controlAccountId: options.controlAccountId,
          controlCredentialId: "b".repeat(32),
          controlBucket: options.controlBucket,
          genesisRecordHash: options.genesisRecordHash,
          authorityDigest: `sha256:${"a".repeat(64)}`,
          runtimePolicyDigest: `sha256:${"b".repeat(64)}`,
          databaseRole: "lyrashield_journal_seal_control",
        },
        assertActive: () => undefined,
      }),
  }
  const pin = new ProtectedJournalSealPinStore(control, evidence, gate, options)
  expect(await pin.compareAndAdvance({ stream, expected: null })).toBe("advanced")
  return { ...f, stream, candidate, seal, snapshotKey, evidence, pin }
}

describe("sealed supervisor recovery candidate", () => {
  it("retains the signed provider request through sorted recovery and rejects a foreign origin", async () => {
    const f = await fixture(true)
    try {
      await f.journal.append({
        type: "provider_grants_bound",
        supervisorInstanceId,
        observedAt: "2026-11-12T00:00:00.000Z",
        commandId: "command-start-1",
        attemptId: binding.attemptId,
        grants: [{ providerId: "azure-ai", grantId: "provider-grant-1", revoked: false }],
      })
      const candidate = await createSealedRecoveryCandidate(f.journal, {
        epochId,
        supervisorInstanceId,
        lastSequence: 4,
      })
      const snapshot = sealedRecoverySchema.parse(
        JSON.parse(Buffer.from(candidate.bytes).toString())
      )
      const grant = snapshot.attempts[0]!.state.grants[0]![1]
      expect(grant.grantRequestId).toBe("command-start-1")
      validateSealedRecoverySnapshot(snapshot)
      grant.grantRequestId = "command-prepare-1"
      expect(() => validateSealedRecoverySnapshot(snapshot)).toThrow("resource binding differs")
      delete grant.grantRequestId
      expect(() => validateSealedRecoverySnapshot(snapshot)).not.toThrow()
    } finally {
      await f.original.close()
      await f.local.close()
    }
  })

  it("folds verified history without discarding historical keys or unresolved states", async () => {
    const f = await fixture()
    try {
      const candidate = await createSealedRecoveryCandidate(f.journal, {
        epochId,
        supervisorInstanceId,
        lastSequence: 3,
      })
      const decoded = JSON.parse(Buffer.from(candidate.bytes).toString("utf8"))
      expect(candidate.originalLastHash).toBe((await f.original.load()).at(-1)!.hash)
      expect(candidate.wrapperLastHash).toBe((await f.local.load()).at(-1)!.hash)
      expect(decoded.sequence).toBe(3)
      expect(decoded.commands.map((entry: { id: string }) => entry.id)).toEqual([
        "command-prepare-1",
        "command-start-1",
      ])
      expect(
        decoded.commands.find((entry: { id: string }) => entry.id === "command-start-1").state
          .status
      ).toBe("UNKNOWN")
      expect(decoded.attempts[0].state.status).toBe("UNKNOWN")
    } finally {
      await f.original.close()
      await f.local.close()
    }
  })

  it("rejects missing historical independent evidence instead of producing a snapshot", async () => {
    const f = await fixture()
    try {
      const key = [...f.objects.keys()].find((value) => value.endsWith("/records/1"))!
      f.objects.delete(key)
      await expect(
        createSealedRecoveryCandidate(f.journal, { epochId, supervisorInstanceId, lastSequence: 3 })
      ).rejects.toThrow()
    } finally {
      await f.original.close()
      await f.local.close()
    }
  })

  it("keeps a recovery hold UNKNOWN even if a later terminal record exists", async () => {
    const f = await fixture()
    try {
      const original = (await f.original.load())[2]!
      if (original.payload.type !== "command_intent") throw new Error("unexpected fixture")
      const base = { supervisorInstanceId, observedAt: "2026-11-12T00:00:00.000Z" }
      await f.journal.append({
        ...base,
        type: "command_recovery_hold",
        commandId: "command-start-1",
        attemptId: binding.attemptId,
        expectedCommandHash: commandRequestHash(original.payload.command),
        recoveredSequence: original.sequence,
        recoveredHash: original.hash,
      })
      await f.journal.append({
        ...base,
        type: "command_terminal",
        commandId: "command-start-1",
        attemptId: binding.attemptId,
        status: "STARTED",
      })
      const candidate = await createSealedRecoveryCandidate(f.journal, {
        epochId,
        supervisorInstanceId,
        lastSequence: 5,
      })
      const decoded = JSON.parse(Buffer.from(candidate.bytes).toString("utf8"))
      expect(
        decoded.commands.find((entry: { id: string }) => entry.id === "command-start-1").state
          .status
      ).toBe("UNKNOWN")
      expect(decoded.attempts[0].state.status).toBe("UNKNOWN")
    } finally {
      await f.original.close()
      await f.local.close()
    }
  })

  it("loads complete UNKNOWN recovery state only from a current protected v2 seal", async () => {
    const f = await pinnedFixture()
    try {
      const loaded = await loadSealedRecoveryBase({
        stream: f.stream,
        pin: f.pin,
        evidence: f.evidence,
        store: f.store,
      })
      expect(loaded.sequence).toBe(3)
      expect(loaded.commands.size).toBe(2)
      expect(loaded.commands.get("command-start-1")?.status).toBe("UNKNOWN")
      expect(loaded.attempts.get("attempt-test-1")?.status).toBe("UNKNOWN")
      expect(loaded.attempts.get("attempt-test-1")?.plans.get("sandbox")?.spec.kind).toBe(
        "container"
      )
      const snapshot = f.objects.get(f.snapshotKey)!
      const changed = Buffer.from(snapshot.bytes)
      changed[0] = changed[0]! ^ 1
      f.objects.set(f.snapshotKey, { ...snapshot, bytes: changed })
      await expect(
        loadSealedRecoveryBase({
          stream: f.stream,
          pin: f.pin,
          evidence: f.evidence,
          store: f.store,
        })
      ).rejects.toThrow(/snapshot|digest|unavailable/i)
      f.objects.delete(f.snapshotKey)
      await expect(
        loadSealedRecoveryBase({
          stream: f.stream,
          pin: f.pin,
          evidence: f.evidence,
          store: f.store,
        })
      ).rejects.toThrow(/snapshot|unavailable/i)
    } finally {
      await f.original.close()
      await f.local.close()
    }
  })
})
