import { useEffect, useRef, useState } from "react"
import type { Finding, ScanSummary, SyncConnection, SyncResult } from "../lib/types"
import {
  connectWorkspace,
  listScans,
  getScanDetail,
  disconnectSync,
  getSyncState,
  hasSyncApiKey,
  saveSyncApiKey,
  syncFindings,
} from "../lib/tauri"

interface Props {
  onBack: () => void
}

export function SyncScreen({ onBack }: Props) {
  const mounted = useRef(true)
  const [scans, setScans] = useState<ScanSummary[]>([])
  const [scanId, setScanId] = useState("")
  const [findings, setFindings] = useState<Finding[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const selectedFindings = findings.filter((finding) => selected.has(finding.id))
  const [workspaceId, setWorkspaceId] = useState("")
  const [connection, setConnection] = useState<SyncConnection | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [hasApiKey, setHasApiKey] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [results, setResults] = useState<SyncResult[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let disposed = false
    void Promise.all([getSyncState(), hasSyncApiKey(), listScans()])
      .then(([saved, hasKey, history]) => {
        if (disposed) return
        setConnection(saved)
        setHasApiKey(hasKey)
        setScans(history)
        if (history.length === 0) setDetailLoading(false)
        setScanId((current) => current || history[0]?.scanId || "")
      })
      .catch((e: unknown) => {
        if (!disposed) setLoadError(String(e))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [retry])

  useEffect(() => {
    if (!scanId) return
    let disposed = false
    void getScanDetail(scanId)
      .then((detail) => {
        if (!disposed) setFindings(detail.findings)
      })
      .catch((e: unknown) => {
        if (!disposed) setLoadError(String(e))
      })
      .finally(() => {
        if (!disposed) setDetailLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [scanId, retry])

  const back = (
    <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground">
      ← Back
    </button>
  )
  const loadStatus = loadError ? (
    <div role="alert">
      <p>{loadError}</p>
      <button
        className="underline"
        onClick={() => {
          setLoading(true)
          setDetailLoading(!!scanId)
          setLoadError(null)
          setRetry((v) => v + 1)
        }}
      >
        Retry loading
      </button>
    </div>
  ) : loading || detailLoading ? (
    <p role="status">Loading local findings…</p>
  ) : null

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    try {
      if (!hasApiKey) {
        await saveSyncApiKey(apiKey)
        if (!mounted.current) return
        setApiKey("")
        setHasApiKey(true)
      }
      const conn = await connectWorkspace(undefined, workspaceId)
      if (mounted.current) setConnection(conn)
    } catch (e) {
      if (mounted.current) setError(String(e))
    } finally {
      if (mounted.current) setConnecting(false)
    }
  }

  async function handleSync() {
    if (!connection || selectedFindings.length === 0 || loading || detailLoading || loadError)
      return
    setSyncing(true)
    setError(null)
    setResults([])
    try {
      const syncResults = await syncFindings(undefined, connection.workspaceId, selectedFindings)
      if (!mounted.current) return
      setResults(syncResults)
      // Refresh trusted state after sync
      const refreshed = await getSyncState()
      if (mounted.current && refreshed) setConnection(refreshed)
    } catch (e) {
      if (mounted.current) setError(String(e))
    } finally {
      if (mounted.current) setSyncing(false)
    }
  }

  async function handleDisconnect() {
    try {
      await disconnectSync()
      if (!mounted.current) return
      setConnection(null)
      setResults([])
      setHasApiKey(false)
    } catch (e) {
      if (mounted.current) setError(String(e))
    }
  }

  if (!connection) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-6 shadow-sm sm:p-8">
          {back}
          {loadStatus}
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-foreground">Cloud Sync</h1>
            <p className="text-sm text-muted-foreground">
              Connect your LyraShield workspace to sync findings. Sync is off by default — only
              explicitly selected findings leave your machine. License and workspace API keys stay
              in OS keychain, never browser storage.
            </p>
          </div>
          <div className="space-y-4">
            <label htmlFor="sync-workspace">Workspace ID</label>
            <input
              id="sync-workspace"
              type="text"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="Workspace ID"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
            />
            {!hasApiKey && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground" htmlFor="sync-api-key">
                  Write-capable workspace API key
                </label>
                <input
                  id="sync-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  placeholder="lsk_…"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  Create this in Cloud Dashboard → API Keys. It is scoped to this workspace and
                  saved only in your OS keychain.
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <button
              onClick={handleConnect}
              disabled={
                loading || !!loadError || connecting || !workspaceId || (!hasApiKey && !apiKey)
              }
              className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {connecting ? "Connecting…" : "Connect Workspace"}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Requires a sync addon or Cloud subscription. The server enforces entitlement.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-6 shadow-sm sm:p-8">
        {back}
        {loadStatus}
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">Cloud Sync</h1>
          <p className="text-sm text-muted-foreground">
            Connected to workspace <code className="text-foreground">{connection.workspaceId}</code>
          </p>
        </div>
        <div className="space-y-4">
          <label className="block text-sm" htmlFor="sync-scan">
            Local scan
          </label>
          <select
            id="sync-scan"
            value={scanId}
            disabled={syncing || loading}
            className="w-full rounded-md border border-input bg-background p-2"
            onChange={(event) => {
              setScanId(event.target.value)
              setDetailLoading(true)
              setFindings([])
              setSelected(new Set())
              setResults([])
              setLoadError(null)
            }}
          >
            {scans.map((scan) => (
              <option key={scan.scanId} value={scan.scanId}>
                {scan.target} ({scan.status})
              </option>
            ))}
          </select>
          <p className="text-sm text-muted-foreground">
            Select the findings to send to your workspace. Nothing is selected by default.
          </p>
          {!loading && !detailLoading && findings.length === 0 && (
            <p>No local findings available.</p>
          )}
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {findings.map((finding) => (
              <label
                key={finding.id}
                className="flex items-start gap-2 rounded-md border border-border p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.has(finding.id)}
                  disabled={syncing || detailLoading}
                  onChange={(event) =>
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (event.target.checked) next.add(finding.id)
                      else next.delete(finding.id)
                      return next
                    })
                  }
                />
                <span className="min-w-0 break-words">{finding.title}</span>
              </label>
            ))}
          </div>

          {results.length > 0 && (
            <div className="space-y-1">
              {results.map((r, i) => (
                <p
                  key={i}
                  className={`text-sm ${r.status === "success" ? "text-success" : r.status === "error" ? "text-destructive" : "text-warning"}`}
                >
                  {r.status === "success"
                    ? `Synced ${r.syncedCount} findings`
                    : r.status === "entitlement_missing"
                      ? `Entitlement missing: ${r.message}`
                      : r.status === "cursor_rewind"
                        ? "Sync state changed. Retry to continue from the saved position."
                        : `Error: ${r.message}`}
                </p>
              ))}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            onClick={handleSync}
            disabled={
              syncing || loading || detailLoading || !!loadError || selectedFindings.length === 0
            }
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {syncing ? "Syncing…" : `Sync ${selectedFindings.length} Findings`}
          </button>
          <button
            onClick={handleDisconnect}
            disabled={syncing}
            className="w-full text-sm text-muted-foreground hover:text-foreground"
          >
            Disconnect and remove stored cloud key
          </button>
        </div>
      </div>
    </div>
  )
}
