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
  type AuthorityAction,
} from "@lyrashield/runtime-control"
import {
  readScanNativeRetainedGuard,
  readScanNativeRetirementGuard,
} from "./scan-native-retained-authority-reader"

const action: AuthorityAction = {
  phase: "EXECUTOR_START",
  operationId: "operation-one",
  attemptId: "attempt-one",
  commandId: "start-one",
  scanId: "scan-one",
  workspaceId: "workspace-one",
  authorityEpochId: "epoch-one",
  authorityRevision: 1,
  authorityChecksum: "a".repeat(64),
  actionChecksum: "b".repeat(64),
  executorKey: "scanner",
}
const authority = {
  streamId: "stream-one",
  authorityEpochId: "epoch-one",
  supervisorInstanceId: "supervisor-one",
  connectionString: "postgresql://fixture:fixture@localhost:1/lyrashield_test",
  originalSigningSecret: "o".repeat(48),
  originalKeyHash: sha256Hex("o".repeat(48)),
  wrapperSigningSecret: "w".repeat(48),
  wrapperKeyHash: sha256Hex("w".repeat(48)),
  readJournal: async () => null,
}
let root: string, row: Record<string, unknown>
const stop = {
  type: "STOP",
  commandId: "stop-one",
  attemptId: action.attemptId,
  expectedReceiptHash: "c".repeat(64),
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "native-retained-test-"))
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
  try {
    const signed = await original.append({
      type: "command_intent",
      command: stop,
      supervisorInstanceId: authority.supervisorInstanceId,
      observedAt: new Date().toISOString(),
    })
    const record = await wrapper.append({
      epochId: action.authorityEpochId,
      operationId: action.operationId,
      attemptId: action.attemptId,
      scanId: action.scanId,
      workspaceId: action.workspaceId,
      eventId: `supervisor:${signed.hash}`,
      payload: signed,
    })
    const unsigned = {
      schema: "lyrashield-independent-authority-head/1",
      supervisorInstanceId: authority.supervisorInstanceId,
      ...record.payload,
      eventId: record.payload.eventId,
      sequence: record.sequence,
      previousHash: record.previousHash,
      recordHash: record.hash,
    }
    const { payload: _payload, ...headFields } = unsigned
    void _payload
    const head = {
      ...headFields,
      signature: createHmac("sha256", authority.wrapperSigningSecret)
        .update(canonicalJson(headFields))
        .digest("hex"),
    }
    row = {
      bindingInputJson: canonicalJson(action),
      commandInputJson: canonicalJson(stop),
      commandInputChecksum: sha256Hex(canonicalJson(stop)),
      originalInputJson: canonicalJson(signed),
      wrapperInputJson: canonicalJson(record),
      headInputJson: canonicalJson(head),
      confirmedSequence: String(record.sequence),
      streamId: authority.streamId,
      sourceSequence: String(record.sequence),
    }
  } finally {
    await original.close()
    await wrapper.close()
  }
})
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})
function connection(value: Record<string, unknown> | null = row) {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT *") && value ? [value] : [],
    })),
    release: vi.fn(),
  }
}
describe("retained root read authentication", () => {
  it("authenticates original and independent wrapper STOP signatures with exact scoped guard", async () => {
    const c = connection()
    expect(await readScanNativeRetirementGuard(c, action, "guard-one", authority)).toEqual(stop)
    expect(c.query).toHaveBeenCalledWith("SELECT app.require_scan_native_origin_reader()", [])
    expect(c.query).toHaveBeenCalledWith(
      "SELECT * FROM app.read_scan_native_retirement_guard($1)",
      ["guard-one"]
    )
  })
  it("retained observation returns the exact binding without extending action expiry", async () => {
    expect(await readScanNativeRetainedGuard(connection(), action, "guard-one")).toEqual(action)
  })
  it.each([
    "bindingInputJson",
    "commandInputChecksum",
    "originalInputJson",
    "wrapperInputJson",
    "headInputJson",
    "confirmedSequence",
    "streamId",
    "sourceSequence",
  ])("rejects substituted %s", async (field) => {
    await expect(
      readScanNativeRetirementGuard(
        connection({ ...row, [field]: "substituted" }),
        action,
        "guard-one",
        authority
      )
    ).rejects.toThrow()
  })
  it("rejects missing historical rows and caller binding substitution", async () => {
    await expect(
      readScanNativeRetirementGuard(connection(null), action, "guard-one", authority)
    ).rejects.toThrow()
    await expect(
      readScanNativeRetainedGuard(
        connection(),
        { ...action, workspaceId: "workspace-other" },
        "guard-one"
      )
    ).rejects.toThrow()
  })
  it("rejects a valid JSON journal record whose signed payload was altered", async () => {
    const original = JSON.parse(String(row.originalInputJson))
    original.payload.command.attemptId = "another-attempt"
    await expect(
      readScanNativeRetirementGuard(
        connection({ ...row, originalInputJson: canonicalJson(original) }),
        action,
        "guard-one",
        authority
      )
    ).rejects.toThrow()
  })
  it("rejects independently substituted wrapper signing authority", async () => {
    const secret = "different-wrapper-secret-000000000000000000000000"
    await expect(
      readScanNativeRetirementGuard(connection(), action, "guard-one", {
        ...authority,
        wrapperSigningSecret: secret,
        wrapperKeyHash: sha256Hex(secret),
      })
    ).rejects.toThrow()
  })
})
