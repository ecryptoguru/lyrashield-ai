"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Plus, ArrowLeft } from "lucide-react"
import { Button, Spinner, LoadMore } from "@lyrashield/ui"
import { githubReposSchema } from "@/lib/api-schemas"
import { apiGet, apiGetPaginated, apiPost, apiDelete } from "@/lib/api-client"
import { TARGET_PLURAL, TARGET_SINGULAR } from "@/lib/terminology"
import { DashboardErrorCard } from "@/components/dashboard-error-card"
import {
  EMPTY_REPO_FORM,
  EMPTY_URL_FORM,
  targetsPaginatedSchema,
  type GithubRepo,
  type RepoFormState,
  type Target,
  type UrlFormState,
} from "./targets-model"
import { RepoTargetForm, TargetCreatePanel, UrlTargetForm } from "./targets-form"
import { TargetsEmptyState, TargetsTable } from "./targets-table"

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
  const searchParams = useSearchParams()
  const deletedNotice = searchParams.get("deleted")
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [targets, setTargets] = useState<Target[]>(initialData ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor ?? null)
  const [loading, setLoading] = useState(!initialData)
  const [showForm, setShowForm] = useState(false)
  const [formType, setFormType] = useState<"REPO" | "URL">("REPO")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [filterProjectId, setFilterProjectId] = useState<string | null>(initialProjectId ?? null)

  const [repoForm, setRepoForm] = useState<RepoFormState>(EMPTY_REPO_FORM)
  const [urlForm, setUrlForm] = useState<UrlFormState>(EMPTY_URL_FORM)

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
        const repos = await apiGet(`/api/integrations/github/repos?workspaceId=${workspaceId}`, {
          schema: githubReposSchema,
        })
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
        installationId: repo.installationId,
      })
    }
  }

  const fetchTargets = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | undefined> = { workspaceId }
      if (filterProjectId) params.projectId = filterProjectId
      const result = await apiGetPaginated(`/api/targets`, params, {
        schema: targetsPaginatedSchema,
      })
      setTargets(result.items)
      setNextCursor(result.nextCursor)
      setFetchError(null)
    } catch (e) {
      setFetchError(
        e instanceof Error ? e.message : `Failed to load ${TARGET_PLURAL.toLowerCase()}`
      )
    } finally {
      setLoading(false)
    }
  }, [filterProjectId, workspaceId])

  useEffect(() => {
    if (initialData) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch, setState runs in promise callback
    void fetchTargets()
  }, [fetchTargets, initialData])

  useEffect(() => {
    // One-shot notice after a detail-page delete navigates back here.
    if (!deletedNotice) return
    const params = new URLSearchParams(searchParams.toString())
    params.delete("deleted")
    router.replace(
      params.size > 0 ? `/dashboard/targets?${params.toString()}` : "/dashboard/targets",
      { scroll: false }
    )
  }, [deletedNotice, router, searchParams])

  async function handleDeleteTarget(target: Target) {
    setDeleteError(null)
    try {
      await apiDelete(
        `/api/targets/${encodeURIComponent(target.id)}?workspaceId=${encodeURIComponent(workspaceId)}`
      )
      setTargets((prev) => prev.filter((t) => t.id !== target.id))
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : `Failed to delete ${TARGET_SINGULAR.toLowerCase()}`
      )
    }
  }

  async function handleCreateRepo() {
    setCreating(true)
    setError(null)
    try {
      await apiPost("/api/targets", {
        workspaceId,
        type: "REPO",
        name: repoForm.name,
        repoOwner: repoForm.repoOwner,
        repoName: repoForm.repoName,
        ...(repoForm.installationId ? { installationId: repoForm.installationId } : {}),
        ...(repoForm.branch.trim() ? { branch: repoForm.branch.trim() } : {}),
      })
      setShowForm(false)
      setRepoForm(EMPTY_REPO_FORM)
      await fetchTargets()
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to create ${TARGET_SINGULAR.toLowerCase()}`)
    } finally {
      setCreating(false)
    }
  }

  async function handleCreateUrl() {
    setCreating(true)
    setError(null)
    try {
      await apiPost("/api/targets", {
        workspaceId,
        type: urlForm.urlType,
        name: urlForm.name,
        url: urlForm.url,
        apiSpecUrl: urlForm.urlType === "API" ? urlForm.apiSpecUrl || undefined : undefined,
        ownershipAttested: urlForm.ownershipAttested,
      })
      setShowForm(false)
      setUrlForm(EMPTY_URL_FORM)
      await fetchTargets()
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to create ${TARGET_SINGULAR.toLowerCase()}`)
    } finally {
      setCreating(false)
    }
  }

  const loadMore = useCallback(
    async (cursor: string) => {
      const params: Record<string, string | undefined> = { workspaceId, cursor }
      if (filterProjectId) params.projectId = filterProjectId
      return apiGetPaginated(`/api/targets`, params, { schema: targetsPaginatedSchema })
    },
    [workspaceId, filterProjectId]
  )

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12" aria-busy="true">
        <Spinner className="h-6 w-6" />
        <p className="text-muted-foreground text-sm">Loading {TARGET_PLURAL.toLowerCase()}…</p>
      </div>
    )
  }

  if (fetchError) {
    return <DashboardErrorCard message={fetchError} onRetry={() => fetchTargets()} className="" />
  }

  return (
    <div className="min-w-0 max-w-full">
      {deletedNotice && (
        <p className="bg-primary/10 text-primary mb-4 rounded-lg px-4 py-3 text-sm" role="status">
          {deletedNotice} was deleted. Its scans, findings, verdicts and reports are retained.
        </p>
      )}
      {deleteError && (
        <p className="text-destructive mb-4 text-sm" role="alert">
          {deleteError}
        </p>
      )}
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
              All {TARGET_PLURAL.toLowerCase()}
            </button>
          )}
          <h1 className="text-2xl font-bold tracking-tight">{TARGET_PLURAL}</h1>
          <p className="text-muted-foreground mt-1 text-sm">Repositories and URLs to scan</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)} className="shrink-0">
          <Plus className="h-4 w-4" aria-hidden="true" />
          New {TARGET_SINGULAR}
        </Button>
      </div>

      {showForm && (
        <TargetCreatePanel formType={formType} onFormTypeChange={setFormType} error={error}>
          {formType === "REPO" ? (
            <RepoTargetForm
              picker={{
                connected: githubConnected,
                accountLogin: githubAccountLogin,
                repos: githubRepos,
                loading: reposLoading,
                mode: repoMode,
                onModeChange: setRepoMode,
                selectedRepoId,
                onSelectRepo: handleSelectRepo,
              }}
              repoForm={repoForm}
              onRepoFormChange={(patch) => setRepoForm({ ...repoForm, ...patch })}
              creating={creating}
              onSubmit={handleCreateRepo}
              onCancel={() => {
                setShowForm(false)
                setError(null)
              }}
            />
          ) : (
            <UrlTargetForm
              urlForm={urlForm}
              onUrlFormChange={(patch) => setUrlForm({ ...urlForm, ...patch })}
              creating={creating}
              onSubmit={handleCreateUrl}
              onCancel={() => {
                setShowForm(false)
                setError(null)
              }}
            />
          )}
        </TargetCreatePanel>
      )}

      {targets.length === 0 ? (
        <TargetsEmptyState onAdd={() => setShowForm(true)} />
      ) : (
        <TargetsTable targets={targets} onDelete={(t) => void handleDeleteTarget(t)} />
      )}

      <LoadMore
        cursor={nextCursor}
        onLoadMore={loadMore}
        onItems={(items) => setTargets((prev) => [...prev, ...items])}
        onNextCursor={setNextCursor}
      />
    </div>
  )
}
