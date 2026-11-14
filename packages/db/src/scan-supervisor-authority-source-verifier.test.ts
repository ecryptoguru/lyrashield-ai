import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  authorityEventSchema,
  canonicalJson,
  sha256Hex,
  SignedJournal,
} from "@lyrashield/runtime-control"
import type { AuthoritySqlConnection } from "@lyrashield/runtime-control"
import { authenticateRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source-verifier"
import type { readRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source"

const { readSource } = vi.hoisted(() => ({ readSource: vi.fn() }))
vi.mock("./scan-supervisor-authority-source", () => ({
  readRetainedSupervisorAuthoritySource: readSource,
}))
const authority = {
  streamId: "stream-one",
  authorityEpochId: "epoch-one",
  supervisorInstanceId: "supervisor-one",
  connectionString: "postgresql://fixture@localhost:1/disposable",
  originalSigningSecret: "o".repeat(48),
  originalKeyHash: sha256Hex("o".repeat(48)),
  wrapperSigningSecret: "w".repeat(48),
  wrapperKeyHash: sha256Hex("w".repeat(48)),
  readJournal: async () => null,
}
type Source = Awaited<ReturnType<typeof readRetainedSupervisorAuthoritySource>>
let root: string,
  source: Source,
  rows: { sequence: string; originalInputJson: string; wrapperInputJson: string }[],
  containerAckHash: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "native-predecessor-test-"))
  const original = new SignedJournal(
    join(root, "original"),
    authority.originalSigningSecret,
    (value) => z.record(z.string(), z.unknown()).parse(value)
  )
  const wrapper = new SignedJournal(
    join(root, "wrapper"),
    authority.wrapperSigningSecret,
    authorityEventSchema(z.unknown()).parse
  )
  rows = []
  try {
    for (const event of [
      { type: "resource_started", commandId: "start-one" },
      {
        type: "native_invocation_ack",
        nativeOperation: "CONTAINER_START_ACK",
        commandId: "start-one",
      },
      {
        type: "native_invocation_ack",
        nativeOperation: "SANDBOX_TOOL_START_ACK",
        commandId: "prepare-one",
      },
      {
        type: "native_invocation_ack",
        nativeOperation: "SANDBOX_TOOL_MUTATION_ACK",
        commandId: "prepare-one",
      },
      {
        type: "command_intent",
        commandId: "stop-one",
        command: { type: "STOP", commandId: "stop-one" },
      },
    ]) {
      const signed = await original.append({
        ...event,
        supervisorInstanceId: authority.supervisorInstanceId,
        observedAt: new Date().toISOString(),
      })
      const record = await wrapper.append({
        epochId: authority.authorityEpochId,
        operationId: "operation-one",
        attemptId: "attempt-one",
        scanId: "scan-one",
        workspaceId: "workspace-one",
        eventId: `supervisor:${signed.hash}`,
        payload: signed,
      })
      if (event.nativeOperation === "CONTAINER_START_ACK") containerAckHash = signed.hash
      rows.push({
        sequence: String(record.sequence),
        originalInputJson: canonicalJson(signed),
        wrapperInputJson: canonicalJson(record),
      })
      const { payload, ...headBinding } = record.payload
      void payload
      const unsigned = {
        schema: "lyrashield-independent-authority-head/1",
        supervisorInstanceId: authority.supervisorInstanceId,
        ...headBinding,
        sequence: record.sequence,
        previousHash: record.previousHash,
        recordHash: record.hash,
      }
      const headInputJson = canonicalJson({
        ...unsigned,
        signature: createHmac("sha256", authority.wrapperSigningSecret)
          .update(canonicalJson(unsigned))
          .digest("hex"),
      })
      source = {
        receiptId: "receipt-one",
        workspaceId: "workspace-one",
        scanId: "scan-one",
        sourceSequence: "1",
        originalInputJson: rows[0]!.originalInputJson,
        wrapperInputJson: rows[0]!.wrapperInputJson,
        commandInputJson: canonicalJson({ type: "START_UNMETERED", commandId: "start-one" }),
        commandInputChecksum: sha256Hex(
          canonicalJson({ type: "START_UNMETERED", commandId: "start-one" })
        ),
        uncertain: false,
        streamId: authority.streamId,
        headInputJson,
        confirmedSequence: String(record.sequence),
        ownership: [],
      }
    }
  } finally {
    await original.close()
    await wrapper.close()
  }
})
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

function connection(history = rows): AuthoritySqlConnection {
  readSource.mockResolvedValue(source)
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("AS held")
        ? [
            {
              headInputJson: source.headInputJson,
              confirmedSequence: source.confirmedSequence,
              held: true,
            },
          ]
        : history,
    })),
    release: vi.fn(),
  }
}

describe("authenticated lifecycle predecessor", () => {
  it("keeps container ACK as predecessor across retained tool ACKs and STOP intent", async () => {
    const authenticated = await authenticateRetainedSupervisorAuthoritySource(
      source,
      authority,
      connection()
    )
    expect(authenticated.head.sequence).toBe(5)
    expect(authenticated.currentAttemptReceipt).toBe(containerAckHash)
    expect(authenticated.commandPredecessors.get("stop-one")).toBe(containerAckHash)
  })

  it("still authenticates tool ACK bytes even though they do not advance lifecycle state", async () => {
    const changed = structuredClone(rows)
    const tool = JSON.parse(changed[2]!.originalInputJson)
    tool.payload.nativeOperation = "SANDBOX_TOOL_MUTATION_ACK"
    changed[2]!.originalInputJson = canonicalJson(tool)
    await expect(
      authenticateRetainedSupervisorAuthoritySource(source, authority, connection(changed))
    ).rejects.toThrow()
  })
})
