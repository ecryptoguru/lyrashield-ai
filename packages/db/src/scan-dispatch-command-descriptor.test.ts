import { describe, expect, it } from "vitest"
import { canonicalizeJson, sha256Sync } from "@lyrashield/security/webmcp"
import {
  assertPreparationProviderPolicy,
  readStoredDispatchCommand,
} from "./scan-dispatch-command-descriptor"

const command = {
  type: "STOP",
  commandId: "command-one",
  attemptId: "attempt-one",
  expectedReceiptHash: "a".repeat(64),
}
const input = canonicalizeJson(command)

describe("retained exact supervisor command inputs", () => {
  it("keeps legacy unavailable and validates exact canonical bytes", () => {
    expect(readStoredDispatchCommand(null, null)).toBeNull()
    expect(readStoredDispatchCommand(input, sha256Sync(input))).toEqual(command)
  })
  it.each([
    [input, null],
    [null, sha256Sync(input)],
    [input, "b".repeat(64)],
    [input + " ", sha256Sync(input + " ")],
    ["{}", sha256Sync("{}")],
    ["private-malformed-input", sha256Sync("private-malformed-input")],
  ])("rejects malformed, partial, changed or noncanonical input", (bytes, checksum) => {
    expect(() => readStoredDispatchCommand(bytes, checksum)).toThrowError(
      expect.objectContaining({ code: "DISPATCH_REPLAY_CONFLICT" })
    )
  })
  it("does not disclose malformed command bytes in its error", () => {
    expect(() =>
      readStoredDispatchCommand("private-malformed-input", sha256Sync("private-malformed-input"))
    ).toThrow("Command descriptor is malformed or noncanonical")
  })
})

const prepare = {
  type: "PREPARE" as const,
  commandId: "command-one",
  attempt: {
    attemptId: "attempt-one",
    scanId: "scan-one",
    workspaceId: "workspace-one",
    operationId: "operation-one",
    authorityEpochId: "epoch-one",
    authorityRevision: 1,
    workerIdentity: "worker-one",
    billingMode: "PAID" as const,
    expiresAt: "2026-11-13T12:00:00.000Z",
  },
  executors: [],
  provider: {
    providerId: "fixture",
    maxRequests: 1,
    costReservationMicros: 3_000_000,
    maxReservedCostMicros: 3_200_000,
  },
}
describe("descriptor provider budget authority", () => {
  it("uses exact decimal-to-micros comparison at the approved boundary", () => {
    expect(() => assertPreparationProviderPolicy(prepare, "3.2000")).not.toThrow()
    expect(() =>
      assertPreparationProviderPolicy(
        { ...prepare, provider: { ...prepare.provider, maxReservedCostMicros: 3_200_001 } },
        "3.2000"
      )
    ).toThrow()
    expect(() =>
      assertPreparationProviderPolicy(
        { ...prepare, provider: { ...prepare.provider, costReservationMicros: 3_200_001 } },
        "3.2000"
      )
    ).toThrow()
  })
  it("requires provider policy only for paid execution", () => {
    expect(() =>
      assertPreparationProviderPolicy({ ...prepare, provider: undefined }, "3.2000")
    ).toThrow()
    expect(() =>
      assertPreparationProviderPolicy(
        { ...prepare, attempt: { ...prepare.attempt, billingMode: "UNMETERED" } },
        "0"
      )
    ).toThrow()
    expect(() =>
      assertPreparationProviderPolicy(
        {
          ...prepare,
          provider: undefined,
          attempt: { ...prepare.attempt, billingMode: "UNMETERED" },
        },
        "0"
      )
    ).not.toThrow()
  })
  it.each(["NaN", "Infinity", "-1", "0.0000001"])(
    "rejects invalid persisted budget %s",
    (budget) => {
      expect(() => assertPreparationProviderPolicy(prepare, budget)).toThrow()
    }
  )
})
