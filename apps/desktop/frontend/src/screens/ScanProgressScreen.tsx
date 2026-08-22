import { useCallback, useEffect, useRef, useState } from "react"
import type { Finding, ScanEvent } from "../lib/types"
import { cancelScan, exportSarif, getScanEvents, onScanEvent } from "../lib/tauri"

interface Props {
  scanId: string
  onBack: () => void
}

export function ScanProgressScreen({ scanId, onBack }: Props) {
  const [progressLines, setProgressLines] = useState<string[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [status, setStatus] = useState<"running" | "completed" | "failed" | "cancelled">("running")
  const [error, setError] = useState<string | null>(null)
  const seenFindings = useRef(new Set<string>())

  const applyEvent = useCallback(
    (event: ScanEvent) => {
      if (event.scanId !== scanId) return
      switch (event.type) {
        case "progress":
          setProgressLines((prev) => [...prev.slice(-200), event.line])
          break
        case "finding":
          if (!seenFindings.current.has(event.finding.id)) {
            seenFindings.current.add(event.finding.id)
            setFindings((prev) => [...prev, event.finding])
          }
          break
        case "completed":
          setStatus("completed")
          break
        case "failed":
          setStatus("failed")
          setError(event.error)
          break
        case "cancelled":
          setStatus("cancelled")
          break
      }
    },
    [scanId]
  )

  // Subscribe before replay so a fast local scan cannot finish in the replay/listener gap.
  useEffect(() => {
    const unlisten = onScanEvent(applyEvent)
    void getScanEvents(scanId, 0)
      .then((events) => events.forEach((event) => applyEvent(event.event)))
      .catch(() => {})
    return () => {
      unlisten.then((u) => u())
    }
  }, [scanId, applyEvent])

  async function handleExportSarif() {
    try {
      const sarif = await exportSarif(findings, scanId)
      const blob = new Blob([sarif], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `lyrashield-${scanId}.sarif`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleCancel() {
    try {
      await cancelScan(scanId)
      setStatus("cancelled")
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground">
            ← Back
          </button>
          <h1 className="text-lg font-semibold text-foreground">Scan {scanId}</h1>
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
            {status}
          </span>
        </div>
        <div className="flex gap-2">
          {status === "running" && (
            <button
              onClick={handleCancel}
              className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive hover:bg-destructive/10"
            >
              Cancel
            </button>
          )}
          {findings.length > 0 && status !== "running" && (
            <button
              onClick={handleExportSarif}
              className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent"
            >
              Export SARIF
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/2 overflow-y-auto border-r border-border p-4">
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
          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
        </div>
        <div className="w-1/2 overflow-y-auto bg-muted/30 p-4">
          <h2 className="mb-3 text-sm font-medium text-foreground">Engine output</h2>
          <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
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
