import type { ScanCapacityData } from "./scan-detail-types"

/** Stored account-capacity receipt only; elapsed display never predicts a charge. */
export function ScanCapacityNotice({
  capacity,
  status,
}: {
  capacity: ScanCapacityData
  status: string
}) {
  const elapsedSeconds = Math.max(0, Math.floor(capacity.observedMs / 1000))
  let message: string
  if (status === "CANCELLED" && capacity.admissionHeld && !capacity.executionStopped) {
    message =
      "Cancellation requested. Waiting for analysis to stop and accounting to finish before another review can start."
  } else if (capacity.state === "WAITING") {
    message =
      "Waiting for account review capacity. This review holds your active review slot and has not reserved any minutes."
  } else if (capacity.state === "REVIEW_REQUIRED") {
    message =
      "Accounting needs review before another scan can start. Your evidence is preserved. Contact your account owner or support; do not start a duplicate review."
  } else if (capacity.admissionHeld && capacity.executionStopped) {
    message = "Finalizing this review before your active review slot is released."
  } else if (capacity.state === "SETTLED") {
    message = `${capacity.chargedMinutes} agent-minutes charged. Positive elapsed analysis time rounds up to whole minutes${capacity.multiplier === 3 ? ", then uses the Deep/Custom 3× multiplier" : ""}.${capacity.absorbedMinutes > 0 ? " Time beyond reserved capacity was not charged." : ""}`
  } else if (capacity.state === "RELEASED") {
    message = capacity.admissionHeld
      ? "Finalizing this review before your active review slot is released. No agent-minutes charged."
      : "No agent-minutes charged. Reserved capacity has been released."
  } else {
    message = `Up to ${capacity.fundedMinutes} agent-minutes reserved for this review. Analysis stops within the available capacity; unused minutes are released after settlement.`
  }
  return (
    <div className="mb-4 space-y-2 rounded-lg border p-4 text-sm" role="status">
      <p>{message}</p>
      {capacity.observedMs > 0 && (
        <p>
          Elapsed analysis: {Math.floor(elapsedSeconds / 60)}m {elapsedSeconds % 60}s. Charged
          agent-minutes are separate from elapsed time.
        </p>
      )}
    </div>
  )
}
