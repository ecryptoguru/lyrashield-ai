import { useEffect, useState } from "react"
import type { Finding, ScanEvent } from "../lib/types"
import { exportSarif, onScanEvent } from "../lib/tauri"

interface Props {
  scanId: string
  onBack: () => void
}

export function ScanProgressScreen({ scanId, onBack }: Props) {
  const [progressLines, setProgressLines] = useState<string[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [status, setStatus] = useState<"running" | "completed" | "failed">("running")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unlisten = onScanEvent((event: ScanEvent) => {
      if (event.scanId !== scanId) return
      switch (event.type) {
        case "progress":
          setProgressLines((prev) => [...prev.slice(-200), event.line])
          break
        case "finding":
          setFindings((prev) => [...prev, event.finding])
          break
        case "completed":
          setStatus("completed")
          break
        case "failed":
          setStatus("failed")
          setError(event.error)
          break
        case "cancelled":
          setStatus("completed")
          break
      }
    })
    return () => {
      unlisten.then((u) => u())
    }
  }, [scanId])

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
                  : "bg-destructive/20 text-destructive"
            }`}
          >
            {status}
          </span>
        </div>
        {findings.length > 0 && status !== "running" && (
          <button
            onClick={handleExportSarif}
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent"
          >
            Export SARIF
          </button>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Findings panel */}
        <div className="w-1/2 overflow-y-auto border-r border-border p-4">
          <h2 className="mb-3 text-sm font-medium text-foreground">Findings ({findings.length})</h2>
          {findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {status === "running" ? "Waiting for findings…" : "No findings."}
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

        {/* Progress panel */}
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
