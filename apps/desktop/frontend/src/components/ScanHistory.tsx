import { useEffect, useState } from "react"
import { listScans } from "../lib/tauri"
import type { ScanSummary, ScanWorkflow } from "../lib/types"

function workflowLabel(workflow: ScanWorkflow): string {
  return workflow === "REVIEW_CHANGES" ? "review changes" : "review target"
}

export function ScanHistory({ onOpen }: { onOpen: (scanId: string) => void }) {
  const [scans, setScans] = useState<ScanSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let disposed = false
    void listScans()
      .then((saved) => {
        if (!disposed) setScans(saved)
      })
      .catch((e: unknown) => {
        if (!disposed) setError(String(e))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [retry])
  return (
    <section aria-labelledby="scan-history" className="mt-8 space-y-3">
      <h2 id="scan-history" className="text-lg font-semibold">
        Scan history
      </h2>
      {loading ? (
        <p role="status">Loading scans…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            className="underline"
            onClick={() => {
              setLoading(true)
              setError(null)
              setRetry((v) => v + 1)
            }}
          >
            Retry history
          </button>
        </div>
      ) : scans.length === 0 ? (
        <p className="text-sm text-muted-foreground">No local scans yet.</p>
      ) : (
        scans.map((scan) => (
          <button
            key={scan.scanId}
            onClick={() => onOpen(scan.scanId)}
            aria-label={`Open scan ${scan.scanId}`}
            className="block w-full rounded-md border border-border p-3 text-left hover:bg-accent"
          >
            <span className="block break-all font-medium">{scan.target}</span>
            <span className="text-sm text-muted-foreground">
              {scan.status} · {scan.backend === "cloud" ? "cloud" : "local"} ·{" "}
              {scan.workflow === "unknown" ? "workflow unknown" : workflowLabel(scan.workflow)} ·{" "}
              {scan.mode} · {scan.findingCount} findings · {scan.startedAt}
            </span>
          </button>
        ))
      )}
    </section>
  )
}
