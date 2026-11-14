import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SignedJournal } from "@lyrashield/runtime-control"
import { supervisorJournalEventSchema } from "./journal-events"
import type { SupervisorAuthorityJournal } from "./authority-journal"
import { createSupervisorNativeResultReader } from "./native-result"
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const binding = {
  operationId: "operation-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  scanId: "scan-1",
  authorityEpochId: "epoch-1",
  authorityRevision: 1,
  workerIdentity: "worker-1",
  billingMode: "PAID",
  expiresAt: "2026-11-14T15:00:00.000Z",
}
const ownership = {
  executorKey: "engine",
  kind: "container",
  ownershipId: "own-engine-1",
  containerId: "c".repeat(64),
}
const input = { operationId: binding.operationId, attemptId: binding.attemptId, offset: 0 }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "native-result-"))
  roots.push(root)
  const source = new SignedJournal(
    join(root, "original"),
    "s".repeat(48),
    supervisorJournalEventSchema.parse
  )
  const common = { supervisorInstanceId: "supervisor-1", observedAt: "2026-11-14T14:00:00.000Z" }
  await source.append(
    supervisorJournalEventSchema.parse({
      ...common,
      type: "attempt_prepared",
      commandId: "prepare-1",
      binding,
      executors: [
        {
          key: "engine",
          spec: {
            kind: "container",
            image: `fixture@sha256:${"a".repeat(64)}`,
            argv: [],
            env: {},
            network: "fixture",
            cpus: 1,
            memoryMb: 64,
            pidsLimit: 16,
            readOnly: true,
          },
        },
      ],
    })
  )
  for (const event of [
    {
      type: "resource_create_planned",
      commandId: "prepare-1",
      attemptId: binding.attemptId,
      executorKey: "engine",
      kind: "container",
      ownershipId: ownership.ownershipId,
    },
    { type: "resource_bound", commandId: "prepare-1", attemptId: binding.attemptId, ownership },
    {
      type: "resource_create_acknowledged",
      commandId: "prepare-1",
      attemptId: binding.attemptId,
      executorKey: "engine",
    },
    {
      type: "resource_start_planned",
      commandId: "prepare-1",
      attemptId: binding.attemptId,
      executorKey: "engine",
    },
    {
      type: "resource_started",
      commandId: "prepare-1",
      attemptId: binding.attemptId,
      executorKey: "engine",
      ownership,
    },
    { type: "attempt_status", attemptId: binding.attemptId, status: "RUNNING" },
  ])
    await source.append(supervisorJournalEventSchema.parse({ ...common, ...event }))
  let changed = false
  const page = vi.fn(async () => {
    const tail = (await source.load()).at(-1)!
    return {
      snapshotHead: { sequence: tail.sequence, hash: changed ? "f".repeat(64) : tail.hash },
      records: [{ payload: { payload: tail } }],
    }
  })
  const journal = { load: () => source.load(), readCursor: page } as unknown as Pick<
    SupervisorAuthorityJournal,
    "load" | "readCursor"
  >
  const consume = vi.fn(async () => ({}))
  const readNative = vi.fn(async () => ({
    schema: 1,
    offset: 0,
    totalBytes: 3,
    sha256: "a".repeat(64),
    chunkBase64: "YWJj",
  }))
  const read = createSupervisorNativeResultReader({
    journal,
    consumeReceipts: consume,
    readNative,
    epochId: binding.authorityEpochId,
    supervisorInstanceId: common.supervisorInstanceId,
  })
  return {
    read,
    consume,
    readNative,
    source,
    changeHead: () => {
      changed = true
    },
  }
}
describe("private native result ownership selection", () => {
  it("selects only the authenticated started engine and rechecks scope after root read", async () => {
    const f = await setup()
    expect(await f.read(input)).toEqual({
      ...input,
      kind: "available",
      sha256: `sha256:${"a".repeat(64)}`,
      totalBytes: 3,
      base64: "YWJj",
      eof: true,
    })
    expect(f.readNative).toHaveBeenCalledWith(ownership, 0)
    expect(f.consume).toHaveBeenCalledTimes(2)
    await f.source.close()
  })
  it("rejects a foreign attempt or operation before native read", async () => {
    const f = await setup()
    expect((await f.read({ ...input, operationId: "foreign-operation" })).kind).toBe("unknown")
    expect((await f.read({ ...input, attemptId: "foreign-attempt" })).kind).toBe("unknown")
    expect(f.readNative).not.toHaveBeenCalled()
    await f.source.close()
  })
  it("does not return available bytes after authority or journal changes", async () => {
    const f = await setup()
    f.readNative.mockImplementation(async () => {
      f.changeHead()
      return { schema: 1, offset: 0, totalBytes: 3, sha256: "a".repeat(64), chunkBase64: "YWJj" }
    })
    expect((await f.read(input)).kind).toBe("unknown")
    f.consume.mockRejectedValueOnce(new Error("Worker scope revoked"))
    await expect(f.read(input)).rejects.toThrow("Worker scope revoked")
    await f.source.close()
  })
  it("keeps unavailable root capture pending and rejects caller filesystem fields", async () => {
    const f = await setup()
    f.readNative.mockRejectedValue(new Error("Capture unavailable"))
    expect((await f.read(input)).kind).toBe("pending")
    await expect(f.read({ ...input, path: "/private" })).rejects.toThrow()
    await f.source.close()
  })
})
