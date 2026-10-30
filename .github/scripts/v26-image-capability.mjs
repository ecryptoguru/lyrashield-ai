const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

/** An OCI label is only meaningful when tied to the qualified exact image. */
export function assertV26ImageIdentity({ actual, expected, kind }) {
  if (
    !["web", "worker"].includes(kind) ||
    !SHA.test(expected?.sourceRevision ?? "") ||
    !DIGEST.test(expected?.digest ?? "") ||
    actual?.digest !== expected.digest ||
    actual?.sourceRevision !== expected.sourceRevision ||
    actual?.accountingProtocol !== "reservations/2" ||
    (kind === "worker" &&
      (!SHA.test(expected.engineRevision ?? "") ||
        actual.engineRevision !== expected.engineRevision))
  )
    throw new Error("v26 image identity or accounting capability is unavailable")
}

/** Execute inside the pinned worker image, not against host dependencies. */
export function assertV26WorkerEntrypoints(db, billing) {
  if (
    db?.SCAN_ACCOUNTING_PROTOCOL !== "reservations/2" ||
    typeof db.createScan !== "function" ||
    typeof db.lockUserScanAdmission !== "function" ||
    typeof db.releaseStoppedScanSlot !== "function" ||
    typeof billing?.reserveScanCapacity !== "function" ||
    typeof billing.confirmScanCapacityStopped !== "function"
  )
    throw new Error("v26 worker entrypoints are unavailable")
}
