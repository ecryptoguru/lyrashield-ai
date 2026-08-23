import { useEffect, useState } from "react"
import { checkUpdateEligibility, installUpdate, onUpdateProgress } from "../lib/tauri"
import type { LicenseStatus, UpdateCheckResult } from "../lib/types"

interface Props {
  status: LicenseStatus | null
  onLogout: () => void
}

export function LicenseStatusScreen({ status, onLogout }: Props) {
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)

  const canCheck = status?.state === "active" || status?.state === "expired_eligibility"

  useEffect(() => {
    if (!canCheck) return
    let cancelled = false
    void checkUpdateEligibility()
      .then((result) => {
        if (!cancelled) setUpdate(result)
      })
      .catch(() => {
        if (!cancelled) {
          setUpdate({ state: "error", message: "Unable to check for updates. Try again later." })
        }
      })
    return () => {
      cancelled = true
    }
  }, [canCheck])

  async function checkForUpdates() {
    setChecking(true)
    setUpdate(null)
    try {
      setUpdate(await checkUpdateEligibility())
    } catch {
      setUpdate({ state: "error", message: "Unable to check for updates. Try again later." })
    } finally {
      setChecking(false)
    }
  }

  async function confirmAndInstall(version: string) {
    if (!window.confirm(`Install LyraShield ${version} and restart the app?`)) return
    setInstalling(true)
    setProgress(0)
    let unlisten: (() => void) | undefined
    try {
      unlisten = await onUpdateProgress((event) => {
        if (event.totalBytes && event.totalBytes > 0) {
          setProgress(Math.min(100, Math.round((event.downloadedBytes / event.totalBytes) * 100)))
        }
      })
      await installUpdate(version)
    } catch (error) {
      setUpdate({
        state: "error",
        message:
          typeof error === "string"
            ? error
            : error instanceof Error
              ? error.message
              : "Update installation failed.",
      })
      setProgress(null)
    } finally {
      unlisten?.()
      setInstalling(false)
    }
  }

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

  if (status.state === "offline_grace_expired") {
    return (
      <div className="flex min-h-full items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg space-y-4 rounded-lg border border-warning/40 bg-card p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-foreground">
            Reconnect to verify your license
          </h1>
          <p className="text-sm text-muted-foreground">
            LyraShield Local works offline for seven days after verification. Connect to the
            internet, then restart the app. Your license and local scan data remain stored.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
          >
            Try again
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
  const offlineRemaining = status.offlineGraceRemainingSeconds

  return (
    <div className="flex min-h-full items-center justify-center bg-background">
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
        {offlineRemaining !== null && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3" role="status">
            <p className="text-sm font-medium text-foreground">Offline mode</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Reconnect within {formatRemaining(offlineRemaining)} to keep scanning and checking for
              updates.
            </p>
          </div>
        )}
        <div className="space-y-3 rounded-md border border-border p-4" aria-live="polite">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Updates</h2>
              <p className="text-xs text-muted-foreground">
                Updates install only after confirmation.
              </p>
            </div>
            <button
              onClick={checkForUpdates}
              disabled={checking || installing}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checking ? "Checking…" : "Check for updates"}
            </button>
          </div>
          {update?.state === "available" && (
            <div className="space-y-3">
              <p className="text-sm text-foreground">LyraShield {update.version} is available.</p>
              {update.notes && (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{update.notes}</p>
              )}
              {installing && progress !== null && (
                <div>
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>Downloading update</span>
                    <span>{progress}%</span>
                  </div>
                  <progress
                    aria-label="Update download progress"
                    className="h-2 w-full"
                    value={progress}
                    max={100}
                  />
                </div>
              )}
              <button
                onClick={() => confirmAndInstall(update.version)}
                disabled={installing}
                className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {installing ? "Installing…" : "Install and restart"}
              </button>
            </div>
          )}
          {update?.state === "not_available" && (
            <p className="text-sm text-muted-foreground">You are using the latest version.</p>
          )}
          {update?.state === "license_expired" && (
            <p className="text-sm text-muted-foreground">
              Update eligibility has expired. This installed version remains usable
              {update.perpetualFallbackBuild
                ? ` under fallback build ${update.perpetualFallbackBuild}.`
                : "."}
            </p>
          )}
          {update?.state === "error" && (
            <p className="text-sm text-destructive" role="alert">
              {update.message}
            </p>
          )}
        </div>
        <button onClick={onLogout} className="text-sm text-muted-foreground hover:text-foreground">
          Deactivate this machine
        </button>
      </div>
    </div>
  )
}

function formatRemaining(seconds: number): string {
  const hours = Math.max(1, Math.ceil(seconds / 3600))
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.ceil(hours / 24)
  return `${days} day${days === 1 ? "" : "s"}`
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
