import assert from "node:assert/strict"
import test from "node:test"
import { assertV26ImageIdentity, assertV26WorkerEntrypoints } from "../v26-image-capability.mjs"

const expected = {
  digest: `sha256:${"a".repeat(64)}`,
  sourceRevision: "b".repeat(40),
  engineRevision: "c".repeat(40),
}
const actual = { ...expected, accountingProtocol: "reservations/2" }
test("only accepts an exact digest, source, engine and accounting marker", () => {
  assert.doesNotThrow(() => assertV26ImageIdentity({ actual, expected, kind: "worker" }))
  assert.doesNotThrow(() => assertV26ImageIdentity({ actual, expected, kind: "web" }))
  for (const [field, value] of [
    ["digest", `sha256:${"d".repeat(64)}`],
    ["sourceRevision", "e".repeat(40)],
    ["engineRevision", "f".repeat(40)],
    ["accountingProtocol", "reservations/1"],
  ])
    assert.throws(() =>
      assertV26ImageIdentity({ actual: { ...actual, [field]: value }, expected, kind: "worker" })
    )
  assert.throws(() =>
    assertV26ImageIdentity({
      actual: { ...actual, accountingProtocol: undefined },
      expected,
      kind: "worker",
    })
  )
})

test("requires actual reservation and slot runtime entrypoints", () => {
  const db = {
    SCAN_ACCOUNTING_PROTOCOL: "reservations/2",
    createScan() {},
    lockUserScanAdmission() {},
    releaseStoppedScanSlot() {},
  }
  const billing = { reserveScanCapacity() {}, confirmScanCapacityStopped() {} }
  assert.doesNotThrow(() => assertV26WorkerEntrypoints(db, billing))
  assert.throws(() => assertV26WorkerEntrypoints({ ...db, lockUserScanAdmission: null }, billing))
  assert.throws(() =>
    assertV26WorkerEntrypoints(db, { ...billing, reserveScanCapacity: undefined })
  )
})
