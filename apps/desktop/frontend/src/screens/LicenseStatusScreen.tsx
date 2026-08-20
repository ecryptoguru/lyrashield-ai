import type { LicenseStatus } from "../lib/types"

interface Props {
  status: LicenseStatus | null
  onLogout: () => void
}

export function LicenseStatusScreen({ status, onLogout }: Props) {
  if (!status || status.state === "none") {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">No active license.</p>
      </div>
    )
  }

  if (status.state === "revoked") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-xl font-semibold text-destructive">License Revoked</h1>
          <p className="text-sm text-muted-foreground">
            This license has been revoked. Contact support@lyrashieldai.com.
          </p>
          <button
            onClick={onLogout}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
          >
            Go to Activation
          </button>
        </div>
      </div>
    )
  }

  const isExpired = status.state === "expired_eligibility"
  const sku = isExpired ? null : status.sku
  const seatCount = isExpired ? null : status.seatCount
  const machineCount = isExpired ? null : status.machineCount
  const updateEligibleUntil = status.updateEligibleUntil
  const fallback = status.perpetualFallbackBuild

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-full max-w-lg space-y-6 rounded-lg border border-border bg-card p-8 shadow-sm">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">LyraShield Local</h1>
          <p className="text-sm text-muted-foreground">License status</p>
        </div>
        <div className="space-y-3">
          {sku && <Row label="Plan" value={formatSku(sku)} />}
          {seatCount !== null && <Row label="Seats" value={String(seatCount)} />}
          {machineCount !== null && <Row label="Activated machines" value={String(machineCount)} />}
          <Row
            label="Update eligibility"
            value={new Date(updateEligibleUntil).toLocaleDateString()}
          />
          <Row
            label="Status"
            value={isExpired ? "Expired (perpetual fallback active)" : "Active"}
            highlight={isExpired ? "warning" : "success"}
          />
          {fallback && <Row label="Perpetual fallback build" value={fallback} />}
        </div>
        <button onClick={onLogout} className="text-sm text-muted-foreground hover:text-foreground">
          Deactivate this machine
        </button>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: "success" | "warning"
}) {
  const color =
    highlight === "success"
      ? "text-success"
      : highlight === "warning"
        ? "text-warning"
        : "text-foreground"
  return (
    <div className="flex justify-between border-b border-border pb-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium ${color}`}>{value}</span>
    </div>
  )
}

function formatSku(sku: string): string {
  return sku
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}
