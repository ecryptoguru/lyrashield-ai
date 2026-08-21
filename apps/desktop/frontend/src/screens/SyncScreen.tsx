import { useEffect, useState } from "react"
import type { SyncConnection, SyncResult } from "../lib/types"
import { connectWorkspace, disconnectSync, getSyncState, syncFindings } from "../lib/tauri"

interface Props {
  findings: {
    id: string
    severity: string
    title: string
    description: string | null
    filePath: string | null
    lineNumber: number | null
    status: string
    verified: boolean
    detectedAt: string
  }[]
}

export function SyncScreen({ findings }: Props) {
  const [workspaceId, setWorkspaceId] = useState("")
  const [connection, setConnection] = useState<SyncConnection | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [results, setResults] = useState<SyncResult[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Load trusted cursor from native store (single source of truth)
    getSyncState()
      .then((saved) => {
        if (saved) setConnection(saved)
      })
      .catch(() => {})
  }, [])

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    try {
      const conn = await connectWorkspace(undefined, workspaceId)
      setConnection(conn)
    } catch (e) {
      setError(String(e))
    } finally {
      setConnecting(false)
    }
  }

  async function handleSync() {
    if (!connection) return
    setSyncing(true)
    setError(null)
    setResults([])
    try {
      const syncResults = await syncFindings(undefined, connection.workspaceId, findings)
      setResults(syncResults)
      // Refresh trusted state after sync
      const refreshed = await getSyncState()
      if (refreshed) setConnection(refreshed)
    } catch (e) {
      setError(String(e))
    } finally {
      setSyncing(false)
    }
  }

  async function handleDisconnect() {
    await disconnectSync()
    setConnection(null)
    setResults([])
  }

  if (!connection) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-8 shadow-sm">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-foreground">Cloud Sync</h1>
            <p className="text-sm text-muted-foreground">
              Connect your LyraShield workspace to sync findings. Sync is off by default — only
              explicitly selected findings leave your machine. Raw license key stays in OS keychain, never in browser storage.
            </p>
          </div>
          <div className="space-y-4">
            <input
              type="text"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="Workspace ID"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              onClick={handleConnect}
              disabled={connecting || !workspaceId}
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
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-8 shadow-sm">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">Cloud Sync</h1>
          <p className="text-sm text-muted-foreground">
            Connected to workspace <code className="text-foreground">{connection.workspaceId}</code> seq={connection.seq}
          </p>
        </div>
        <div className="space-y-4">
          <div className="rounded-md bg-muted/30 p-3 text-sm">
            <p className="text-muted-foreground">
              Findings to sync:{" "}
              <span className="font-medium text-foreground">{findings.length}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Max 500 per batch. Seq monotonic CAS.</p>
          </div>

          {results.length > 0 && (
            <div className="space-y-1">
              {results.map((r, i) => (
                <p
                  key={i}
                  className={`text-sm ${r.status === "success" ? "text-success" : r.status === "error" ? "text-destructive" : "text-warning"}`}
                >
                  {r.status === "success"
                    ? `Synced ${r.syncedCount} findings seq→${r.newSeq}`
                    : r.status === "entitlement_missing"
                      ? `Entitlement missing: ${r.message}`
                      : r.status === "cursor_rewind"
                        ? `Cursor rewind: server seq ${r.serverSeq}`
                        : `Error: ${r.message}`}
                </p>
              ))}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={handleSync}
            disabled={syncing || findings.length === 0}
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {syncing ? "Syncing…" : `Sync ${findings.length} Findings`}
          </button>
          <button
            onClick={handleDisconnect}
            className="w-full text-sm text-muted-foreground hover:text-foreground"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  )
}
