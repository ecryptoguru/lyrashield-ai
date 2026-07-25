"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, Copy, KeyRound, Plus, ShieldAlert } from "lucide-react"
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from "@lyrashield/ui"
import { writeClipboard } from "@/components/scorecard-share-composer"
import { apiDelete, apiGet, apiPost, ApiError } from "@/lib/api-client"

interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

interface CreatedKey extends ApiKeyRow {
  rawKey: string
}

/**
 * Workspace API keys — used by the LyraShield MCP server, CLI, and CI.
 * The raw key is displayed exactly once after creation.
 */
export function ApiKeysSection({
  workspaceId,
  canManage,
}: {
  workspaceId: string
  canManage: boolean
}) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState("")
  const [scope, setScope] = useState<"read" | "write">("read")
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await apiGet<ApiKeyRow[]>(`/api/api-keys?workspaceId=${workspaceId}`)
      setKeys(data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load API keys")
      setKeys([])
    }
  }, [workspaceId])

  useEffect(() => {
    if (!canManage) return
    let active = true
    apiGet<ApiKeyRow[]>(`/api/api-keys?workspaceId=${workspaceId}`)
      .then((data) => {
        if (!active) return
        setKeys(data)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!active) return
        setError(err instanceof ApiError ? err.message : "Failed to load API keys")
        setKeys([])
      })
    return () => {
      active = false
    }
  }, [canManage, workspaceId])

  if (!canManage) return null

  /**
   * Reset the create form to its defaults. Scope MUST be reset along with the
   * name: leaving the previous selection sticky silently grants write access to
   * a key the user believes is read-only (least-privilege default is "read").
   */
  function closeCreateForm() {
    setShowCreate(false)
    setName("")
    setScope("read")
  }

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    setError(null)
    try {
      const created = await apiPost<CreatedKey>("/api/api-keys", {
        workspaceId,
        name: name.trim(),
        scopes: scope === "write" ? ["read", "write"] : ["read"],
      })
      setCreatedKey(created)
      closeCreateForm()
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create API key")
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(id: string) {
    setError(null)
    try {
      await apiDelete(`/api/api-keys/${id}?workspaceId=${workspaceId}`)
      setConfirmRevoke(null)
      if (createdKey?.id === id) setCreatedKey(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke API key")
    }
  }

  async function copyKey() {
    if (!createdKey) return
    try {
      await writeClipboard(createdKey.rawKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError("Failed to copy API key. Copy it manually or check your browser permissions.")
      setCopied(false)
    }
  }

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? []
  const revokedKeys = keys?.filter((k) => k.revokedAt) ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden="true" />
          API keys
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => (showCreate ? closeCreateForm() : setShowCreate(true))}
          aria-expanded={showCreate}
          aria-controls="api-key-create-form"
        >
          <Plus className="mr-1 size-4" aria-hidden="true" />
          New key
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Connect the LyraShield MCP server, CLI, or CI to this workspace. Keys are shown once at
          creation and can be revoked at any time.
        </p>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {createdKey ? (
          <div className="border-primary/40 bg-primary/5 space-y-2 rounded-md border p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="size-4" aria-hidden="true" />
              Copy this key now — it will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1.5 font-mono text-xs">
                {createdKey.rawKey}
              </code>
              <Button size="sm" variant="outline" onClick={() => void copyKey()}>
                {copied ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
                <span className="sr-only">Copy API key</span>
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setCreatedKey(null)}>
              I&apos;ve stored it safely
            </Button>
          </div>
        ) : null}

        {showCreate ? (
          <div id="api-key-create-form" className="space-y-3 rounded-md border p-4">
            <div className="space-y-1">
              <label htmlFor="api-key-name" className="text-sm font-medium">
                Key name
              </label>
              <input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="e.g. Cursor on my laptop, CI pipeline"
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Access</legend>
              <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="api-key-scope"
                    checked={scope === "read"}
                    onChange={() => setScope("read")}
                  />
                  Read-only <span className="text-muted-foreground">(recommended)</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="api-key-scope"
                    checked={scope === "write"}
                    onChange={() => setScope("write")}
                  />
                  Read &amp; write (can start scans, create reports)
                </label>
              </div>
              {scope === "write" ? (
                <p className="text-muted-foreground text-xs">
                  This key will be able to start scans and create reports in this workspace. Prefer
                  read-only unless a tool needs to make changes.
                </p>
              ) : null}
            </fieldset>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void handleCreate()}
                disabled={creating || !name.trim()}
              >
                {creating ? <Spinner className="mr-1 size-4" /> : null}
                Create key
              </Button>
              <Button size="sm" variant="ghost" onClick={closeCreateForm}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {keys === null ? (
          <div className="flex items-center gap-2 py-2">
            <Spinner className="size-4" />
            <span className="text-muted-foreground text-sm">Loading keys…</span>
          </div>
        ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
          <p className="text-muted-foreground text-sm">No API keys yet.</p>
        ) : (
          <ul className="divide-y">
            {activeKeys.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{key.name}</p>
                  <p className="text-muted-foreground font-mono text-xs">
                    {key.prefix}…
                    <span className="ml-2 font-sans">
                      {key.lastUsedAt
                        ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                        : "never used"}
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="muted">
                    {key.scopes.includes("write") ? "read & write" : "read-only"}
                  </Badge>
                  {confirmRevoke === key.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => void handleRevoke(key.id)}
                      >
                        Confirm revoke
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(key.id)}>
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
            {revokedKeys.map((key) => (
              <li
                key={key.id}
                className="text-muted-foreground flex items-center justify-between gap-2 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm line-through">{key.name}</p>
                  <p className="font-mono text-xs">{key.prefix}…</p>
                </div>
                <Badge variant="muted">revoked</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
