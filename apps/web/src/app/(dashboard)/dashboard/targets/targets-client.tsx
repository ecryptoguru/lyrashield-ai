"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Plus, Crosshair, Bug, Globe, GitBranch, ArrowLeft } from "lucide-react"
import { Button, Badge, EmptyState, FormField, Input, Select, LoadMore } from "@lyrashield/ui"
import { apiGetPaginated, apiPost } from "@/lib/api-client"

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
  initialData,
  initialNextCursor,
}: {
  workspaceId: string
  projects: Project[]
  initialProjectId?: string
  initialData?: Target[]
  initialNextCursor?: string | null
}) {
  const router = useRouter()
  const [targets, setTargets] = useState<Target[]>(initialData ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor ?? null)
  const [loading, setLoading] = useState(!initialData)
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
      const params: Record<string, string | undefined> = { workspaceId }
      if (filterProjectId) params.projectId = filterProjectId
      const result = await apiGetPaginated<Target>(`/api/targets`, params)
      setTargets(result.items)
      setNextCursor(result.nextCursor)
      setFetchError(null)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to load targets")
    } finally {
      setLoading(false)
    }
  }, [filterProjectId, workspaceId])

  useEffect(() => {
    if (initialData) return
    queueMicrotask(() => {
      void fetchTargets()
    })
  }, [fetchTargets, initialData])

  async function handleCreateRepo(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      await apiPost("/api/targets", {
        workspaceId,
        type: "REPO",
        name: repoForm.name,
        repoOwner: repoForm.repoOwner,
        repoName: repoForm.repoName,
        branch: repoForm.branch,
        projectId: repoForm.projectId || undefined,
        environment: repoForm.environment,
      })
      setShowForm(false)
      setRepoForm({ name: "", repoOwner: "", repoName: "", branch: "main", projectId: "", environment: "STAGING" })
      await fetchTargets()
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create target")
    } finally {
      setCreating(false)
    }
  }

  async function handleCreateUrl(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      await apiPost("/api/targets", {
        workspaceId,
        type: urlForm.type,
        name: urlForm.name,
        url: urlForm.url,
        projectId: urlForm.projectId || undefined,
        environment: urlForm.environment,
      })
      setShowForm(false)
      setUrlForm({ name: "", url: "", type: "WEB_APP", projectId: "", environment: "STAGING" })
      await fetchTargets()
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create target")
    } finally {
      setCreating(false)
    }
  }

  const loadMore = useCallback(async (cursor: string) => {
    const params: Record<string, string | undefined> = { workspaceId, cursor }
    if (filterProjectId) params.projectId = filterProjectId
    return apiGetPaginated<Target>(`/api/targets`, params)
  }, [workspaceId, filterProjectId])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading targets...</p>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <p className="mb-4 text-sm text-destructive" role="alert">{fetchError}</p>
        <Button variant="secondary" onClick={() => fetchTargets()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {filterProjectId && (
            <button
              onClick={() => {
                setFilterProjectId(null)
                router.push("/dashboard/targets")
              }}
              className="mb-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" aria-hidden="true" />
              All targets
            </button>
          )}
          <h1 className="text-2xl font-bold tracking-tight">Targets</h1>
          <p className="mt-1 text-sm text-muted-foreground">Repositories and URLs to scan</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)} className="shrink-0">
          <Plus className="h-4 w-4" aria-hidden="true" />
          New Target
        </Button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
          <div className="mb-4 flex flex-wrap gap-2">
            <Button
              variant={formType === "REPO" ? "default" : "secondary"}
              onClick={() => setFormType("REPO")}
              size="sm"
            >
              <GitBranch className="h-4 w-4" aria-hidden="true" />
              Repository
            </Button>
            <Button
              variant={formType === "URL" ? "default" : "secondary"}
              onClick={() => setFormType("URL")}
              size="sm"
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
              URL / API
            </Button>
          </div>

          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {error}
            </div>
          )}

          {formType === "REPO" ? (
            <form onSubmit={handleCreateRepo} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="Target Name" htmlFor="repo-name-input">
                  <Input
                    id="repo-name-input"
                    type="text"
                    value={repoForm.name}
                    onChange={(e) => setRepoForm({ ...repoForm, name: e.target.value })}
                    required
                    maxLength={100}
                    autoFocus
                    placeholder="My App Backend"
                  />
                </FormField>
                <FormField label="Project (optional)" htmlFor="repo-project">
                  <Select
                    id="repo-project"
                    value={repoForm.projectId}
                    onChange={(e) => setRepoForm({ ...repoForm, projectId: e.target.value })}
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </FormField>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="Repo Owner" htmlFor="repo-owner">
                  <Input
                    id="repo-owner"
                    type="text"
                    value={repoForm.repoOwner}
                    onChange={(e) => setRepoForm({ ...repoForm, repoOwner: e.target.value })}
                    required
                    placeholder="lyrashield"
                  />
                </FormField>
                <FormField label="Repo Name" htmlFor="repo-name-field">
                  <Input
                    id="repo-name-field"
                    type="text"
                    value={repoForm.repoName}
                    onChange={(e) => setRepoForm({ ...repoForm, repoName: e.target.value })}
                    required
                    placeholder="lyrashield"
                  />
                </FormField>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="Branch" htmlFor="repo-branch">
                  <Input
                    id="repo-branch"
                    type="text"
                    value={repoForm.branch}
                    onChange={(e) => setRepoForm({ ...repoForm, branch: e.target.value })}
                    placeholder="main"
                  />
                </FormField>
                <FormField label="Environment" htmlFor="repo-env">
                  <Select
                    id="repo-env"
                    value={repoForm.environment}
                    onChange={(e) => setRepoForm({ ...repoForm, environment: e.target.value })}
                  >
                    <option value="LOCAL">Local</option>
                    <option value="PREVIEW">Preview</option>
                    <option value="STAGING">Staging</option>
                    <option value="PRODUCTION">Production</option>
                  </Select>
                </FormField>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={creating}>
                  {creating ? "Creating..." : "Create Target"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => { setShowForm(false); setError(null) }}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleCreateUrl} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="Target Name" htmlFor="url-name">
                  <Input
                    id="url-name"
                    type="text"
                    value={urlForm.name}
                    onChange={(e) => setUrlForm({ ...urlForm, name: e.target.value })}
                    required
                    maxLength={100}
                    autoFocus
                    placeholder="Staging API"
                  />
                </FormField>
                <FormField label="Type" htmlFor="url-type">
                  <Select
                    id="url-type"
                    value={urlForm.type}
                    onChange={(e) => setUrlForm({ ...urlForm, type: e.target.value as "WEB_APP" | "API" })}
                  >
                    <option value="WEB_APP">Web App</option>
                    <option value="API">API</option>
                  </Select>
                </FormField>
              </div>
              <FormField label="URL" htmlFor="url-input">
                <Input
                  id="url-input"
                  type="url"
                  value={urlForm.url}
                  onChange={(e) => setUrlForm({ ...urlForm, url: e.target.value })}
                  required
                  placeholder="https://staging.example.com"
                />
              </FormField>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="Project (optional)" htmlFor="url-project">
                  <Select
                    id="url-project"
                    value={urlForm.projectId}
                    onChange={(e) => setUrlForm({ ...urlForm, projectId: e.target.value })}
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Environment" htmlFor="url-env">
                  <Select
                    id="url-env"
                    value={urlForm.environment}
                    onChange={(e) => setUrlForm({ ...urlForm, environment: e.target.value })}
                  >
                    <option value="LOCAL">Local</option>
                    <option value="PREVIEW">Preview</option>
                    <option value="STAGING">Staging</option>
                    <option value="PRODUCTION">Production</option>
                  </Select>
                </FormField>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={creating}>
                  {creating ? "Creating..." : "Create Target"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => { setShowForm(false); setError(null) }}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {targets.length === 0 ? (
        <EmptyState
          icon={Crosshair}
          title="No targets yet"
          description="Add a repository or URL target to start scanning."
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add target
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Name</th>
                <th className="px-4 py-3 text-left font-semibold">Type</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Project</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Environment</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Scans</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Findings</th>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
                  onClick={() => router.push(`/dashboard/targets/${t.id}`)}
                  tabIndex={0}
                  role="link"
                  aria-label={`View target ${t.name}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      router.push(`/dashboard/targets/${t.id}`)
                    }
                  }}
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
                    <Badge>
                      {t.type === "REPO" ? <GitBranch className="h-3 w-3" aria-hidden="true" /> : <Globe className="h-3 w-3" aria-hidden="true" />}
                      {t.type}
                    </Badge>
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                    {t.project?.name ?? "—"}
                  </td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    <span className="text-xs">{t.environment}</span>
                  </td>
                  <td className="hidden px-4 py-3 sm:table-cell">{t.scanCount}</td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    {t.findingCount > 0 ? (
                      <span className="flex items-center gap-1 text-destructive">
                        <Bug className="h-3 w-3" aria-hidden="true" />
                        {t.findingCount}
                      </span>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={t.status === "active" ? "success" : "muted"}>
                      {t.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LoadMore
        cursor={nextCursor}
        onLoadMore={loadMore}
        onItems={(items) => setTargets((prev) => [...prev, ...items as Target[]])}
        onNextCursor={setNextCursor}
      />
    </div>
  )
}
