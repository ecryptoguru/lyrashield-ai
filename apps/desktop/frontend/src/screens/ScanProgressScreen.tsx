import { useEffect, useRef, useState } from "react"
import type { Finding, ScanEvent, ScanStatus } from "../lib/types"
import { cancelScan, exportSarif, getScanEvents, getScanDetail, onScanEvent } from "../lib/tauri"

interface Props {
  scanId: string
  onBack: () => void
}

export function ScanProgressScreen(props: Props) {
  return <ScanProgress key={props.scanId} {...props} />
}

function ScanProgress({ scanId, onBack }: Props) {
  const [progressLines, setProgressLines] = useState<string[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [status, setStatus] = useState<ScanStatus>("pending")
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const current = useRef<symbol | null>(null)

  useEffect(() => {
    const identity = Symbol(scanId)
    current.current = identity
    let disposed = false
    let unlisten: (() => void) | undefined
    const seenFindings = new Set<string>()
    const buffered: ScanEvent[] = []
    let ready = false
    function applyEvent(event: ScanEvent) {
      if (disposed || event.scanId !== scanId) return
      switch (event.type) {
        case "progress":
          setProgressLines((prev) => [...prev.slice(-199), event.line])
          break
        case "finding":
          if (!seenFindings.has(event.finding.id)) {
            seenFindings.add(event.finding.id)
            setFindings((prev) => [...prev, event.finding])
          }
          break
        case "started":
          setStatus((prev) => (prev === "pending" ? "running" : prev))
          break
        case "completed":
        case "cancelled":
        case "failed":
          setStatus(event.type)
          setCancelling(false)
          if (event.type === "failed") setError(event.error)
          break
        case "error":
          setError(event.error)
          setCancelling(false)
          break
      }
    }
    async function subscribe() {
      try {
        unlisten = await onScanEvent((event) => {
          if (disposed || event.scanId !== scanId) return
          if (ready) applyEvent(event)
          else buffered.push(event)
        })
        if (disposed) {
          unlisten()
          return
        }
        const events = await getScanEvents(scanId, 0)
        if (disposed) return
        events.forEach(({ event }) => applyEvent(event))
        const detail = await getScanDetail(scanId)
        if (disposed) return
        detail.findings.forEach((finding) => applyEvent({ type: "finding", scanId, finding }))
        setStatus(detail.status)
        buffered.forEach(applyEvent)
        ready = true
      } catch (e) {
        unlisten?.()
        if (!disposed) setError(String(e))
      }
    }
    void subscribe()
    return () => {
      disposed = true
      current.current = null
      unlisten?.()
    }
  }, [scanId, retry])

  async function handleExportSarif() {
    const identity = current.current
    try {
      const sarif = await exportSarif(findings, scanId)
      if (current.current !== identity) return
      const blob = new Blob([sarif], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `lyrashield-${scanId}.sarif`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      if (current.current === identity) setError(String(e))
    }
  }

  async function handleCancel() {
    const identity = current.current
    setCancelling(true)
    setError(null)
    try {
      await cancelScan(scanId)
      const detail = await getScanDetail(scanId)
      if (current.current !== identity) return
      setStatus(detail.status)
      setCancelling(false)
      if (detail.status === "pending" || detail.status === "running") {
        setError("Cancellation has not been durably confirmed. Retry to refresh the scan.")
      }
    } catch (e) {
      if (current.current !== identity) return
      setError(String(e))
      setCancelling(false)
    }
  }
  const active = status === "running" || status === "pending"

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground">
            ← Back
          </button>
          <h1 className="break-all text-lg font-semibold text-foreground">Scan {scanId}</h1>
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              status === "running"
                ? "bg-warning/20 text-warning"
                : status === "completed"
                  ? "bg-success/20 text-success"
                  : status === "cancelled"
                    ? "bg-muted text-muted-foreground"
                    : "bg-destructive/20 text-destructive"
            }`}
          >
            {cancelling ? "Cancelling…" : status}
          </span>
        </div>
        <div className="flex gap-2">
          {active && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive hover:bg-destructive/10"
            >
              Cancel
            </button>
          )}
          {findings.length > 0 && !active && (
            <button
              onClick={handleExportSarif}
              className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent"
            >
              Export SARIF
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row">
        <div className="min-w-0 sm:w-1/2 overflow-y-auto border-r border-border p-4">
          <h2 className="mb-3 text-sm font-medium text-foreground">Findings ({findings.length})</h2>
          {findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {status === "running"
                ? "Waiting for findings…"
                : status === "cancelled"
                  ? "Scan cancelled."
                  : "No findings."}
            </p>
          ) : (
            <div className="space-y-2">
              {findings.map((f) => (
                <div key={f.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between">
                    <span className="text-sm font-medium text-foreground">{f.title}</span>
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-xs ${severityColor(f.severity)}`}
                    >
                      {f.severity}
                    </span>
                  </div>
                  {f.filePath && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {f.filePath}
                      {f.lineNumber ? `:${f.lineNumber}` : ""}
                    </p>
                  )}
                  {f.description && (
                    <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {error && (
            <div role="alert" className="mt-4 text-sm text-destructive">
              <p>{error}</p>
              <button
                className="mt-2 underline"
                onClick={() => {
                  setProgressLines([])
                  setFindings([])
                  setStatus("pending")
                  setCancelling(false)
                  setError(null)
                  setRetry((value) => value + 1)
                }}
              >
                Retry scan updates
              </button>
            </div>
          )}
        </div>
        <div className="min-w-0 sm:w-1/2 overflow-y-auto bg-muted/30 p-4">
          <h2 className="mb-3 text-sm font-medium text-foreground">Engine output</h2>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {progressLines.join("\n")}
          </pre>
        </div>
      </div>
    </div>
  )
}

function severityColor(severity: string): string {
  switch (severity.toUpperCase()) {
    case "CRITICAL":
      return "bg-destructive/20 text-destructive"
    case "HIGH":
      return "bg-critical/20 text-critical"
    case "MEDIUM":
      return "bg-warning/20 text-warning"
    case "LOW":
      return "bg-primary/20 text-primary"
    default:
      return "bg-muted text-muted-foreground"
  }
}
