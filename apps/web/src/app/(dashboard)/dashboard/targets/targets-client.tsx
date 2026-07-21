"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Plus, Crosshair, Bug, Globe, GitBranch, ArrowLeft } from "lucide-react"
import {
  Button,
  Badge,
  EmptyState,
  FormField,
  Input,
  Spinner,
  LoadMore,
  Select,
} from "@lyrashield/ui"
import { apiGet, apiGetPaginated, apiPost } from "@/lib/api-client"

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

interface GithubRepo {
  id: number
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
}

export function TargetsClient({
  workspaceId,
  initialProjectId,
  initialData,
  initialNextCursor,
  githubConnected = false,
  githubAccountLogin = null,
}: {
  workspaceId: string
  initialProjectId?: string
  initialData?: Target[]
  initialNextCursor?: string | null
  githubConnected?: boolean
  githubAccountLogin?: string | null
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
    branch: "",
  })
  const [urlForm, setUrlForm] = useState({
    name: "",
    url: "",
    urlType: "WEB_APP" as "WEB_APP" | "API",
  })

  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [repoMode, setRepoMode] = useState<"picker" | "manual">("picker")
  const [selectedRepoId, setSelectedRepoId] = useState<string>("")

  useEffect(() => {
    if (
      !githubConnected ||
      formType !== "REPO" ||
      !showForm ||
      githubRepos.length > 0 ||
      reposLoading
    )
      return
    let cancelled = false
    void (async () => {
      try {
        setReposLoading(true)
        const repos = await apiGet<GithubRepo[]>(
          `/api/integrations/github/repos?workspaceId=${workspaceId}`
        )
        if (cancelled) return
        setGithubRepos(repos)
      } catch {
        if (cancelled) return
        setRepoMode("manual")
      } finally {
        if (cancelled) return
        setReposLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [githubConnected, formType, showForm, githubRepos.length, reposLoading, workspaceId])

  function handleSelectRepo(repoId: string) {
    setSelectedRepoId(repoId)
    const repo = githubRepos.find((r) => String(r.id) === repoId)
    if (repo) {
      setRepoForm({
        name: repo.fullName,
        repoOwner: repo.owner,
        repoName: repo.name,
        branch: repo.defaultBranch,
      })
    }
  }

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
        ...(repoForm.branch ? { branch: repoForm.branch } : {}),
      })
      setShowForm(false)
      setRepoForm({
        name: "",
        repoOwner: "",
        repoName: "",
        branch: "",
      })
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
        type: urlForm.urlType,
        name: urlForm.name,
        url: urlForm.url,
      })
      setShowForm(false)
      setUrlForm({ name: "", url: "", urlType: "WEB_APP" })
      await fetchTargets()
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create target")
    } finally {
      setCreating(false)
    }
  }

  const loadMore = useCallback(
    async (cursor: string) => {
      const params: Record<string, string | undefined> = { workspaceId, cursor }
      if (filterProjectId) params.projectId = filterProjectId
      return apiGetPaginated<Target>(`/api/targets`, params)
    },
    [workspaceId, filterProjectId]
  )

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12" aria-busy="true">
        <Spinner className="h-6 w-6" />
        <p className="text-muted-foreground text-sm">Loading targets...</p>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <p className="text-destructive mb-4 text-sm" role="alert">
          {fetchError}
        </p>
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
              type="button"
              onClick={() => {
                setFilterProjectId(null)
                router.push("/dashboard/targets")
              }}
              className="text-muted-foreground hover:text-foreground mb-2 flex cursor-pointer items-center gap-1 text-sm transition-colors"
            >
              <ArrowLeft className="h-3 w-3" aria-hidden="true" />
              All targets
            </button>
          )}
          <h1 className="text-2xl font-bold tracking-tight">Targets</h1>
          <p className="text-muted-foreground mt-1 text-sm">Repositories and URLs to scan</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)} className="shrink-0">
          <Plus className="h-4 w-4" aria-hidden="true" />
          New Target
        </Button>
      </div>

      {showForm && (
        <div className="bg-card mb-6 rounded-xl border p-4 shadow-sm sm:p-6">
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
              URL
            </Button>
          </div>

          {error && (
            <div
              className="bg-destructive/10 text-destructive mb-4 rounded-md p-3 text-sm"
              role="alert"
            >
              {error}
            </div>
          )}

          {formType === "REPO" ? (
            <form onSubmit={handleCreateRepo} className="space-y-4">
              {githubConnected && repoMode === "picker" && (
                <>
                  <FormField label="Select repository" htmlFor="repo-select">
                    {reposLoading ? (
                      <div className="text-muted-foreground flex items-center gap-2 text-sm">
                        <Spinner className="h-4 w-4" />
                        Loading repositories...
                      </div>
                    ) : githubRepos.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        No repositories found.{" "}
                        <button
                          type="button"
                          onClick={() => setRepoMode("manual")}
                          className="text-primary hover:underline"
                        >
                          Enter manually
                        </button>
                      </p>
                    ) : (
                      <Select
                        id="repo-select"
                        value={selectedRepoId}
                        onChange={(e) => handleSelectRepo(e.target.value)}
                      >
                        <option value="">Choose a repository...</option>
                        {githubRepos.map((repo) => (
                          <option key={repo.id} value={String(repo.id)}>
                            {repo.fullName}
                            {repo.private ? " (private)" : ""}
                          </option>
                        ))}
                      </Select>
                    )}
                  </FormField>
                  <button
                    type="button"
                    onClick={() => setRepoMode("manual")}
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                  >
                    Enter repository manually
                  </button>
                </>
              )}
              {(!githubConnected || repoMode === "manual") && (
                <>
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
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <FormField label="Repo Owner" htmlFor="repo-owner">
                      <Input
                        id="repo-owner"
                        type="text"
                        value={repoForm.repoOwner}
                        onChange={(e) => setRepoForm({ ...repoForm, repoOwner: e.target.value })}
                        required
                        placeholder={githubAccountLogin ?? "lyrashield"}
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
                  {githubConnected && repoMode === "manual" && (
                    <button
                      type="button"
                      onClick={() => setRepoMode("picker")}
                      className="text-muted-foreground hover:text-foreground text-xs underline"
                    >
                      Use repository picker
                    </button>
                  )}
                </>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={creating || (!repoForm.name && !selectedRepoId)}>
                  {creating ? "Creating..." : "Create Target"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setShowForm(false)
                    setError(null)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleCreateUrl} className="space-y-4">
              <FormField label="Type" htmlFor="url-type">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={urlForm.urlType === "WEB_APP" ? "default" : "secondary"}
                    size="sm"
                    onClick={() => setUrlForm({ ...urlForm, urlType: "WEB_APP" })}
                  >
                    <Globe className="h-4 w-4" aria-hidden="true" />
                    Web App
                  </Button>
                  <Button
                    type="button"
                    variant={urlForm.urlType === "API" ? "default" : "secondary"}
                    size="sm"
                    onClick={() => setUrlForm({ ...urlForm, urlType: "API" })}
                  >
                    API
                  </Button>
                </div>
              </FormField>
              <FormField label="Target Name" htmlFor="url-name">
                <Input
                  id="url-name"
                  type="text"
                  value={urlForm.name}
                  onChange={(e) => setUrlForm({ ...urlForm, name: e.target.value })}
                  required
                  maxLength={100}
                  autoFocus
                  placeholder={urlForm.urlType === "API" ? "Production API" : "Staging Site"}
                />
              </FormField>
              <FormField label="URL" htmlFor="url-input">
                <Input
                  id="url-input"
                  type="url"
                  value={urlForm.url}
                  onChange={(e) => setUrlForm({ ...urlForm, url: e.target.value })}
                  required
                  placeholder={
                    urlForm.urlType === "API"
                      ? "https://api.example.com"
                      : "https://staging.example.com"
                  }
                />
              </FormField>
              <div className="flex gap-2">
                <Button type="submit" disabled={creating}>
                  {creating ? "Creating..." : "Create Target"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setShowForm(false)
                    setError(null)
                  }}
                >
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
            <thead className="bg-muted/30 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Name</th>
                <th className="px-4 py-3 text-left font-semibold">Type</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Scans</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Findings</th>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr
                  key={t.id}
                  className="hover:bg-muted/30 cursor-pointer border-b last:border-0"
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
                      <div className="text-muted-foreground text-xs">{t.repoFullName}</div>
                    )}
                    {t.url && <div className="text-muted-foreground text-xs">{t.url}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge>
                      {t.type === "REPO" ? (
                        <GitBranch className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Globe className="h-3 w-3" aria-hidden="true" />
                      )}
                      {t.type}
                    </Badge>
                  </td>
                  <td className="hidden px-4 py-3 sm:table-cell">{t.scanCount}</td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    {t.findingCount > 0 ? (
                      <span className="text-destructive flex items-center gap-1">
                        <Bug className="h-3 w-3" aria-hidden="true" />
                        {t.findingCount}
                      </span>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={t.status === "active" ? "success" : "muted"}>{t.status}</Badge>
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
        onItems={(items) => setTargets((prev) => [...prev, ...(items as Target[])])}
        onNextCursor={setNextCursor}
      />
    </div>
  )
}
