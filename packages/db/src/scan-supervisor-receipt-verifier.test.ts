import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  canonicalizeSupervisorReceipt,
  sha256Hex,
  verifySupervisorReceiptHmac,
  type SupervisorReceiptRecord,
} from "./scan-supervisor-receipt-verifier"

const SECRET = "s".repeat(48)
const WRONG_SECRET = "w".repeat(48)
const INSTANCE = "supervisor-test-1"

function signRecord(
  payload: unknown,
  options: {
    sequence?: number
    previousHash?: string
    secret?: string
    supervisorInstanceId?: string
  } = {}
): SupervisorReceiptRecord {
  const sequence = options.sequence ?? 1
  const previousHash = options.previousHash ?? "0".repeat(64)
  const unsigned = { version: 1, sequence, previousHash, payload }
  const hash = sha256Hex(canonicalizeSupervisorReceipt(unsigned))
  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(canonicalizeSupervisorReceipt(unsigned, hash), "utf8")
    .digest("hex")
  return {
    version: 1,
    sequence,
    previousHash,
    hash,
    signature,
    payload,
    supervisorInstanceId: options.supervisorInstanceId ?? INSTANCE,
  }
}

describe("verifySupervisorReceiptHmac", () => {
  it("accepts a well-formed receipt", () => {
    const record = signRecord({ supervisorInstanceId: INSTANCE, kind: "attempt_prepared" })
    const result = verifySupervisorReceiptHmac({
      record,
      expectedInstanceId: INSTANCE,
      secret: SECRET,
    })
    expect(result).toEqual({ ok: true, sequence: 1, supervisorInstanceId: INSTANCE })
  })

  it("resolves supervisorInstanceId from the payload when the envelope omits it", () => {
    const record = signRecord({ supervisorInstanceId: INSTANCE, kind: "attempt_prepared" })
    const { supervisorInstanceId: _omitted, ...withoutEnvelope } = record
    void _omitted
    expect(
      verifySupervisorReceiptHmac({
        record: withoutEnvelope,
        expectedInstanceId: INSTANCE,
        secret: SECRET,
      })
    ).toEqual({ ok: true, sequence: 1, supervisorInstanceId: INSTANCE })
  })

  it("rejects a tampered payload", () => {
    const record = signRecord({ supervisorInstanceId: INSTANCE, kind: "attempt_prepared" })
    const tampered = { ...record, payload: { supervisorInstanceId: INSTANCE, kind: "forged" } }
    const result = verifySupervisorReceiptHmac({
      record: tampered,
      expectedInstanceId: INSTANCE,
      secret: SECRET,
    })
    expect(result).toMatchObject({ ok: false, code: "HASH_MISMATCH" })
  })

  it("rejects a receipt signed with the wrong key", () => {
    const record = signRecord(
      { supervisorInstanceId: INSTANCE, kind: "attempt_prepared" },
      { secret: WRONG_SECRET }
    )
    const result = verifySupervisorReceiptHmac({
      record,
      expectedInstanceId: INSTANCE,
      secret: SECRET,
    })
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" })
  })

  it("rejects a bad chain (wrong predecessor)", () => {
    const first = signRecord({ supervisorInstanceId: INSTANCE, n: 1 }, { sequence: 1 })
    const second = signRecord(
      { supervisorInstanceId: INSTANCE, n: 2 },
      { sequence: 2, previousHash: first.hash }
    )
    expect(
      verifySupervisorReceiptHmac({
        record: second,
        expectedInstanceId: INSTANCE,
        secret: SECRET,
        expectedSequence: 2,
        expectedPreviousHash: first.hash,
      })
    ).toEqual({ ok: true, sequence: 2, supervisorInstanceId: INSTANCE })
    const broken = verifySupervisorReceiptHmac({
      record: second,
      expectedInstanceId: INSTANCE,
      secret: SECRET,
      expectedSequence: 2,
      expectedPreviousHash: "f".repeat(64),
    })
    expect(broken).toMatchObject({ ok: false, code: "CHAIN_MISMATCH" })
  })

  it("rejects an unknown instance", () => {
    const record = signRecord(
      { supervisorInstanceId: "supervisor-other", kind: "attempt_prepared" },
      { supervisorInstanceId: "supervisor-other" }
    )
    const result = verifySupervisorReceiptHmac({
      record,
      expectedInstanceId: INSTANCE,
      secret: SECRET,
    })
    expect(result).toMatchObject({ ok: false, code: "INSTANCE_MISMATCH" })
  })

  it("rejects a receipt missing the instance id", () => {
    const record = signRecord({ kind: "attempt_prepared" })
    const { supervisorInstanceId: _omitted, ...withoutInstance } = record
    void _omitted
    const result = verifySupervisorReceiptHmac({
      record: withoutInstance,
      expectedInstanceId: INSTANCE,
      secret: SECRET,
    })
    expect(result).toMatchObject({ ok: false, code: "MISSING_INSTANCE" })
  })

  it("rejects when the supplied secret does not match the expected key hash", () => {
    const record = signRecord({ supervisorInstanceId: INSTANCE, kind: "attempt_prepared" })
    const result = verifySupervisorReceiptHmac({
      record,
      expectedInstanceId: INSTANCE,
      secret: WRONG_SECRET,
      expectedKeyHash: sha256Hex(SECRET),
    })
    expect(result).toMatchObject({ ok: false, code: "KEY_MISMATCH" })
  })

  it("accepts a matching expected key hash", () => {
    const record = signRecord({ supervisorInstanceId: INSTANCE, kind: "attempt_prepared" })
    expect(
      verifySupervisorReceiptHmac({
        record,
        expectedInstanceId: INSTANCE,
        secret: SECRET,
        expectedKeyHash: sha256Hex(SECRET),
      })
    ).toEqual({ ok: true, sequence: 1, supervisorInstanceId: INSTANCE })
  })

  it.each(["", "s", "s".repeat(31)])(
    "rejects an empty or short HMAC secret (%j bytes)",
    (secret) => {
      const record = signRecord(
        { supervisorInstanceId: INSTANCE, kind: "attempt_prepared" },
        { secret }
      )
      expect(
        verifySupervisorReceiptHmac({ record, expectedInstanceId: INSTANCE, secret })
      ).toMatchObject({ ok: false, code: "INVALID_SECRET" })
    }
  )

  it("rejects an envelope instance id that differs from the signed payload", () => {
    const record = signRecord(
      { supervisorInstanceId: INSTANCE, kind: "attempt_prepared" },
      { supervisorInstanceId: "supervisor-other" }
    )
    expect(
      verifySupervisorReceiptHmac({
        record,
        expectedInstanceId: "supervisor-other",
        secret: SECRET,
      })
    ).toMatchObject({ ok: false, code: "INSTANCE_MISMATCH" })
  })

  it("rejects a receipt version other than the supervisor journal version", () => {
    const record = {
      ...signRecord({ supervisorInstanceId: INSTANCE, kind: "attempt_prepared" }),
      version: 2,
    }
    expect(
      verifySupervisorReceiptHmac({ record, expectedInstanceId: INSTANCE, secret: SECRET })
    ).toMatchObject({ ok: false, code: "INVALID_VERSION" })
  })

  it("rejects a malformed signature", () => {
    const record = signRecord({ supervisorInstanceId: INSTANCE, kind: "attempt_prepared" })
    expect(
      verifySupervisorReceiptHmac({
        record: { ...record, signature: "z".repeat(64) },
        expectedInstanceId: INSTANCE,
        secret: SECRET,
      })
    ).toMatchObject({ ok: false, code: "INVALID_SIGNATURE" })
  })

  it("matches the independent canonical receipt vector", () => {
    // Produced outside this verifier (Node crypto + stable key sort) so a shared
    // canonicalization mistake in the test helper cannot certify itself.
    const goldenSecret = "0123456789abcdef0123456789abcdef"
    const unsigned = {
      version: 1,
      sequence: 1,
      previousHash: "0".repeat(64),
      payload: {
        supervisorInstanceId: INSTANCE,
        kind: "attempt_prepared",
        attemptId: "attempt-1",
      },
    }
    expect(canonicalizeSupervisorReceipt(unsigned)).toBe(
      '{"payload":{"attemptId":"attempt-1","kind":"attempt_prepared","supervisorInstanceId":"supervisor-test-1"},"previousHash":"0000000000000000000000000000000000000000000000000000000000000000","sequence":1,"version":1}'
    )
    expect(
      verifySupervisorReceiptHmac({
        record: {
          ...unsigned,
          hash: "6a7173a4f1c548dd831b7136ef4837b6ce9305db2da73517fab8a162bf04fc9e",
          signature: "68720924b5ad15a828ca53e9ca484212d21aa150ba8772bbbd6c72d26f59f179",
          supervisorInstanceId: INSTANCE,
        },
        expectedInstanceId: INSTANCE,
        secret: goldenSecret,
        expectedKeyHash: sha256Hex(goldenSecret),
      })
    ).toEqual({ ok: true, sequence: 1, supervisorInstanceId: INSTANCE })
  })
})
