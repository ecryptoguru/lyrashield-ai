import type { ScanData } from "./scan-detail-types"

export function ScanCapacityBanner({ scan }: { scan: ScanData }) {
  if (!scan.capacity) return null
  return (
    <div className="mb-4 rounded-lg border p-4 text-sm" role="status">
      {scan.capacity.state === "WAITING" ? (
        <p>
          Waiting for account review capacity. This review holds your active review slot and has not
          reserved any minutes.
        </p>
      ) : scan.capacity.state === "REVIEW_REQUIRED" ? (
        <p>Accounting needs review before another scan can start. Your evidence is preserved.</p>
      ) : scan.status === "CANCELLED" && scan.capacity.admissionHeld ? (
        <p>
          Cancellation requested. Waiting for analysis to stop and accounting to finish before
          another review can start.
        </p>
      ) : scan.capacity.state === "SETTLED" && scan.capacity.admissionHeld ? (
        <p>Finalizing this review before your active review slot is released.</p>
      ) : scan.capacity.state === "SETTLED" ? (
        <p>
          {scan.capacity.chargedMinutes} agent-minutes charged. Positive elapsed analysis time
          rounds up to whole minutes
          {scan.capacity.multiplier === 3 ? ", then uses the Deep/Custom 3× multiplier" : ""}.
          {scan.capacity.absorbedMinutes > 0
            ? " Time beyond reserved capacity was not charged."
            : ""}
        </p>
      ) : scan.capacity.state === "RELEASED" ? (
        <p>No agent-minutes charged. Reserved capacity has been released.</p>
      ) : (
        <p>
          Up to {scan.capacity.fundedMinutes} agent-minutes reserved for this review. Analysis stops
          within the available capacity; unused minutes are released after settlement.
        </p>
      )}
    </div>
  )
}
