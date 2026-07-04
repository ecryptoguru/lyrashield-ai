"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Plus, Crosshair, Bug, Globe, GitBranch, ArrowLeft } from "lucide-react"

interface Target {
  id: string
  name: string
  type: string
  url: string | null
  repoFullName: string | null
  branch: string | null
  environment: string
  status: string
  lastScanAt: string | null
  project: { id: string; name: string } | null
  scanCount: number
  findingCount: number
  createdAt: string
}

interface Project {
  id: string
  name: string
}

export function TargetsClient({
  workspaceId,
  projects,
  initialProjectId,
}: {
  workspaceId: string
  projects: Project[]
  initialProjectId?: string
}) {
  const router = useRouter()
  const [targets, setTargets] = useState<Target[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formType, setFormType] = useState<"REPO" | "URL">("REPO")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [filterProjectId, setFilterProjectId] = useState<string | null>(initialProjectId ?? null)

  const [repoForm, setRepoForm] = useState({
    name: "",
    repoOwner: "",
    repoName: "",
    branch: "main",
    projectId: "",
    environment: "STAGING",
  })
  const [urlForm, setUrlForm] = useState({
    name: "",
    url: "",
    type: "WEB_APP" as "WEB_APP" | "API",
    projectId: "",
    environment: "STAGING",
  })

  const fetchTargets = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ workspaceId })
      if (filterProjectId) params.set("projectId", filterProjectId)
      const res = await fetch(`/api/targets?${params}`)
      const data = await res.json()
      if (data.success) {
        setTargets(data.data)
        setFetchError(null)
      } else {
        setFetchError(data.error?.message ?? "Failed to load targets")
      }
    } catch {
      setFetchError("Failed to load targets")
    } finally {
      setLoading(false)
    }
  }, [filterProjectId, workspaceId])

  useEffect(() => {
    queueMicrotask(() => {
      void fetchTargets()
    })
  }, [fetchTargets])

  async function handleCreateRepo(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const res = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          type: "REPO",
          name: repoForm.name,
          repoOwner: repoForm.repoOwner,
          repoName: repoForm.repoName,
          branch: repoForm.branch,
          projectId: repoForm.projectId || undefined,
          environment: repoForm.environment,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowForm(false)
        setRepoForm({ name: "", repoOwner: "", repoName: "", branch: "main", projectId: "", environment: "STAGING" })
        await fetchTargets()
        router.refresh()
      } else {
        setError(data.error?.message ?? "Failed to create target")
      }
    } catch {
      setError("Failed to create target")
    } finally {
      setCreating(false)
    }
  }

  async function handleCreateUrl(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const res = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          type: urlForm.type,
          name: urlForm.name,
          url: urlForm.url,
          projectId: urlForm.projectId || undefined,
          environment: urlForm.environment,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowForm(false)
        setUrlForm({ name: "", url: "", type: "WEB_APP", projectId: "", environment: "STAGING" })
        await fetchTargets()
        router.refresh()
      } else {
        setError(data.error?.message ?? "Failed to create target")
      }
    } catch {
      setError("Failed to create target")
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-sm text-muted-foreground">Loading targets...</p>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <p className="mb-4 text-sm text-destructive">{fetchError}</p>
        <button
          onClick={() => fetchTargets()}
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          {filterProjectId && (
            <button
              onClick={() => {
                setFilterProjectId(null)
                router.push("/dashboard/targets")
              }}
              className="mb-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" />
              All targets
            </button>
          )}
          <h1 className="text-2xl font-bold">Targets</h1>
          <p className="text-sm text-muted-foreground">Repositories and URLs to scan</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Target
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border p-6">
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setFormType("REPO")}
              className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium ${
                formType === "REPO" ? "bg-primary text-primary-foreground" : "border hover:bg-accent"
              }`}
            >
              <GitBranch className="h-4 w-4" />
              Repository
            </button>
            <button
              onClick={() => setFormType("URL")}
              className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium ${
                formType === "URL" ? "bg-primary text-primary-foreground" : "border hover:bg-accent"
              }`}
            >
              <Globe className="h-4 w-4" />
              URL / API
            </button>
          </div>

          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {formType === "REPO" ? (
            <form onSubmit={handleCreateRepo} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="repo-name-input" className="mb-1 block text-sm font-medium">Target Name</label>
                  <input
                    id="repo-name-input"
                    type="text"
                    value={repoForm.name}
                    onChange={(e) => setRepoForm({ ...repoForm, name: e.target.value })}
                    required
                    maxLength={100}
                    autoFocus
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="My App Backend"
                  />
                </div>
                <div>
                  <label htmlFor="repo-project" className="mb-1 block text-sm font-medium">Project (optional)</label>
                  <select
                    id="repo-project"
                    value={repoForm.projectId}
                    onChange={(e) => setRepoForm({ ...repoForm, projectId: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="repo-owner" className="mb-1 block text-sm font-medium">Repo Owner</label>
                  <input
                    id="repo-owner"
                    type="text"
                    value={repoForm.repoOwner}
                    onChange={(e) => setRepoForm({ ...repoForm, repoOwner: e.target.value })}
                    required
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="lyrashield"
                  />
                </div>
                <div>
                  <label htmlFor="repo-name-field" className="mb-1 block text-sm font-medium">Repo Name</label>
                  <input
                    id="repo-name-field"
                    type="text"
                    value={repoForm.repoName}
                    onChange={(e) => setRepoForm({ ...repoForm, repoName: e.target.value })}
                    required
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="lyrashield"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="repo-branch" className="mb-1 block text-sm font-medium">Branch</label>
                  <input
                    id="repo-branch"
                    type="text"
                    value={repoForm.branch}
                    onChange={(e) => setRepoForm({ ...repoForm, branch: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="main"
                  />
                </div>
                <div>
                  <label htmlFor="repo-env" className="mb-1 block text-sm font-medium">Environment</label>
                  <select
                    id="repo-env"
                    value={repoForm.environment}
                    onChange={(e) => setRepoForm({ ...repoForm, environment: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="LOCAL">Local</option>
                    <option value="PREVIEW">Preview</option>
                    <option value="STAGING">Staging</option>
                    <option value="PRODUCTION">Production</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={creating} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {creating ? "Creating..." : "Create Target"}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setError(null) }} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleCreateUrl} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="url-name" className="mb-1 block text-sm font-medium">Target Name</label>
                  <input
                    id="url-name"
                    type="text"
                    value={urlForm.name}
                    onChange={(e) => setUrlForm({ ...urlForm, name: e.target.value })}
                    required
                    maxLength={100}
                    autoFocus
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="Staging API"
                  />
                </div>
                <div>
                  <label htmlFor="url-type" className="mb-1 block text-sm font-medium">Type</label>
                  <select
                    id="url-type"
                    value={urlForm.type}
                    onChange={(e) => setUrlForm({ ...urlForm, type: e.target.value as "WEB_APP" | "API" })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="WEB_APP">Web App</option>
                    <option value="API">API</option>
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor="url-input" className="mb-1 block text-sm font-medium">URL</label>
                <input
                  id="url-input"
                  type="url"
                  value={urlForm.url}
                  onChange={(e) => setUrlForm({ ...urlForm, url: e.target.value })}
                  required
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="https://staging.example.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="url-project" className="mb-1 block text-sm font-medium">Project (optional)</label>
                  <select
                    id="url-project"
                    value={urlForm.projectId}
                    onChange={(e) => setUrlForm({ ...urlForm, projectId: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="url-env" className="mb-1 block text-sm font-medium">Environment</label>
                  <select
                    id="url-env"
                    value={urlForm.environment}
                    onChange={(e) => setUrlForm({ ...urlForm, environment: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="LOCAL">Local</option>
                    <option value="PREVIEW">Preview</option>
                    <option value="STAGING">Staging</option>
                    <option value="PRODUCTION">Production</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={creating} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {creating ? "Creating..." : "Create Target"}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setError(null) }} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {targets.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <Crosshair className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          <h2 className="mb-2 text-lg font-semibold">No targets yet</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Add a repository or URL target to start scanning.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Add target
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Project</th>
                <th className="px-4 py-3 text-left font-medium">Environment</th>
                <th className="px-4 py-3 text-left font-medium">Scans</th>
                <th className="px-4 py-3 text-left font-medium">Findings</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
                  onClick={() => router.push(`/dashboard/targets/${t.id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.name}</div>
                    {t.repoFullName && (
                      <div className="text-xs text-muted-foreground">{t.repoFullName}</div>
                    )}
                    {t.url && (
                      <div className="text-xs text-muted-foreground">{t.url}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground">
                      {t.type === "REPO" ? <GitBranch className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
                      {t.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {t.project?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs">{t.environment}</span>
                  </td>
                  <td className="px-4 py-3">{t.scanCount}</td>
                  <td className="px-4 py-3">
                    {t.findingCount > 0 ? (
                      <span className="flex items-center gap-1 text-destructive">
                        <Bug className="h-3 w-3" />
                        {t.findingCount}
                      </span>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                      t.status === "active" ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"
                    }`}>
                      {t.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
