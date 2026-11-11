import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { verifySupervisorReceiptHmac } from "../../db/src/scan-supervisor-receipt-verifier"
import { canonicalJson, sha256Hex, toBrokerReceiptType } from "./index"
import { SignedJournal } from "./journal"

const roots: string[] = []
const secret = "s".repeat(48)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("toBrokerReceiptType", () => {
  it("maps journal events to the broker vocabulary", () => {
    expect(toBrokerReceiptType({ type: "attempt_prepared" })).toBe("PREPARE_COMPLETED")
    expect(toBrokerReceiptType({ type: "command_intent" })).toBe("COMMAND_ACCEPTED")
    expect(toBrokerReceiptType({ type: "resource_create_planned" })).toBe("EXECUTOR_CREATE_INTENT")
    expect(toBrokerReceiptType({ type: "resource_bound" })).toBe("UNKNOWN")
    expect(toBrokerReceiptType({ type: "resource_started" })).toBe("EXECUTOR_STARTED")
    expect(toBrokerReceiptType({ type: "provider_grants_bound" })).toBe("UNKNOWN")
    expect(toBrokerReceiptType({ type: "provider_grants_revoked" })).toBe("UNKNOWN")
    expect(toBrokerReceiptType({ type: "attempt_status" })).toBe("UNKNOWN")
    expect(toBrokerReceiptType({ type: "command_terminal", status: "STOPPED" })).toBe("STOPPED")
    expect(toBrokerReceiptType({ type: "command_terminal", status: "NEVER_DISPATCHED" })).toBe(
      "NEVER_DISPATCHED"
    )
    expect(toBrokerReceiptType({ type: "command_terminal", status: "UNKNOWN" })).toBe("UNKNOWN")
    expect(toBrokerReceiptType({ type: "command_terminal", status: "STARTED" })).toBe("UNKNOWN")
  })
})

describe("journal HMAC round-trip (broker verifier semantics)", () => {
  it("verifies actual journal bytes containing a prototype-named field", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-broker-receipt-test-"))
    roots.push(root)
    const journal = new SignedJournal<Record<string, unknown>>(
      join(root, "journal.jsonl"),
      secret,
      (value) => value as Record<string, unknown>
    )
    const payload = JSON.parse(
      '{"supervisorInstanceId":"supervisor-test-1","nested":{"__proto__":{"value":1}}}'
    ) as Record<string, unknown>
    const record = await journal.append(payload)
    expect(
      verifySupervisorReceiptHmac({
        record,
        expectedInstanceId: "supervisor-test-1",
        secret,
      })
    ).toEqual({ ok: true, sequence: 1, supervisorInstanceId: "supervisor-test-1" })
    expect(await journal.load()).toEqual([record])
  })

  it("signs with the canonical recipe and verifies with the broker algorithm", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-broker-receipt-test-"))
    roots.push(root)
    const payloadSchema = z
      .object({
        supervisorInstanceId: z.string().min(1),
        observedAt: z.string(),
        kind: z.string(),
        value: z.number(),
      })
      .strict()
    const journal = new SignedJournal(join(root, "journal.jsonl"), secret, (value) =>
      payloadSchema.parse(value)
    )
    const payload = {
      supervisorInstanceId: "supervisor-test-1",
      observedAt: "2026-11-06T00:00:00.000Z",
      kind: "attempt_prepared",
      value: 1,
    }
    const record = await journal.append(payload)
    // Broker-side recomputation (mirrors verifySupervisorReceiptHmac):
    // hash = sha256Hex(canonicalJson({version,sequence,previousHash,payload}))
    const unsigned = {
      version: record.version,
      sequence: record.sequence,
      previousHash: record.previousHash,
      payload: record.payload,
    }
    const expectedHash = sha256Hex(canonicalJson(unsigned))
    expect(expectedHash).toBe(record.hash)
    const expectedSignature = createHmac("sha256", secret)
      .update(canonicalJson({ ...unsigned, hash: expectedHash }), "utf8")
      .digest("hex")
    expect(expectedSignature).toBe(record.signature)
    expect(record.payload.supervisorInstanceId).toBe("supervisor-test-1")
  })
})
