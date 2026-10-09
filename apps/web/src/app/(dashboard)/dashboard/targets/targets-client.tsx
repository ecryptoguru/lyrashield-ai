"use client"

import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { z } from "zod"
import { Plus, ArrowLeft } from "lucide-react"
import { Button, Spinner, LoadMore } from "@lyrashield/ui"
import { githubReposSchema, installUrlSchema } from "@/lib/api-schemas"
import { ApiError, apiGet, apiGetPaginated, apiPost, apiDelete } from "@/lib/api-client"
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

function TargetAddRouteSync({
  router,
  searchParams,
}: {
  router: ReturnType<typeof useRouter>
  searchParams: ReturnType<typeof useSearchParams>
}) {
  useEffect(() => {
    if (searchParams.get("add") !== "1") return
    const params = new URLSearchParams(searchParams.toString())
    params.delete("add")
    router.replace(
      params.size > 0 ? `/dashboard/targets?${params.toString()}` : "/dashboard/targets",
      { scroll: false }
    )
  }, [router, searchParams])
  return null
}

function TargetsPageHeader({
  filterProjectId,
  showForm,
  hasTargets,
  onClearProjectFilter,
  onToggleForm,
}: {
  filterProjectId: string | null
  showForm: boolean
  hasTargets: boolean
  onClearProjectFilter: () => void
  onToggleForm: () => void
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        {filterProjectId && (
          <button
            type="button"
            onClick={onClearProjectFilter}
            className="text-muted-foreground hover:text-foreground mb-2 flex cursor-pointer items-center gap-1 text-sm transition-colors"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            All {TARGET_PLURAL.toLowerCase()}
          </button>
        )}
        <h1 className="text-2xl font-bold tracking-tight">{TARGET_PLURAL}</h1>
        <p className="text-muted-foreground mt-1 text-sm">Repositories and URLs to scan</p>
      </div>
      {hasTargets && (
        <Button onClick={onToggleForm} className="shrink-0" aria-expanded={showForm}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {showForm ? "Close form" : `Add ${TARGET_SINGULAR.toLowerCase()}`}
        </Button>
      )}
    </div>
  )
}

function createTargetScanHandlers(args: {
  scanSetup: boolean
  workspaceId: string
  router: ReturnType<typeof useRouter>
  repoForm: RepoFormState
  urlForm: UrlFormState
  fetchTargets: () => Promise<void>
  setCreating: Dispatch<SetStateAction<boolean>>
  setConnecting: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
  setShowForm: Dispatch<SetStateAction<boolean>>
  setRepoForm: Dispatch<SetStateAction<RepoFormState>>
  setUrlForm: Dispatch<SetStateAction<UrlFormState>>
  setCreatedTarget: Dispatch<SetStateAction<{ id: string; name: string } | null>>
  selectedRepoId: string
}) {
  const { scanSetup, workspaceId, router, repoForm, urlForm } = args
  async function save(body: Record<string, unknown>) {
    try {
      return await apiPost("/api/targets", body, {
        schema: z.object({ id: z.string().min(1), name: z.string() }).passthrough(),
      })
    } catch (cause) {
      if (!scanSetup || !(cause instanceof ApiError) || cause.code !== "TARGET_EXISTS") throw cause
      const existing = z.object({ existingTargetId: z.string().min(1) }).safeParse(cause.details)
      if (!existing.success) throw cause
      return {
        id: existing.data.existingTargetId,
        name: typeof body.name === "string" ? body.name : "Selected target",
      }
    }
  }
  async function connectForScan() {
    args.setConnecting(true)
    args.setError(null)
    try {
      const data = await apiPost(
        "/api/integrations/github/install",
        { workspaceId, returnTo: "scan" },
        { schema: installUrlSchema }
      )
      window.location.href = data.installUrl
    } catch (cause) {
      args.setError(cause instanceof Error ? cause.message : "Could not connect GitHub. Try again.")
      args.setConnecting(false)
    }
  }
  async function create(kind: "REPO" | "URL") {
    args.setCreating(true)
    args.setError(null)
    try {
      const body =
        kind === "REPO"
          ? {
              workspaceId,
              type: kind,
              name: repoForm.name,
              repoOwner: repoForm.repoOwner,
              repoName: repoForm.repoName,
              ...(repoForm.installationId ? { installationId: repoForm.installationId } : {}),
              ...(repoForm.branch.trim() ? { branch: repoForm.branch.trim() } : {}),
            }
          : {
              workspaceId,
              type: urlForm.urlType,
              name: urlForm.name,
              url: urlForm.url,
              apiSpecUrl: urlForm.urlType === "API" ? urlForm.apiSpecUrl || undefined : undefined,
              ownershipAttested: urlForm.ownershipAttested,
            }
      const saved = await save(body)
      args.setCreatedTarget(saved)
      if (scanSetup)
        return router.replace(`/dashboard/scans?new=1&target=${encodeURIComponent(saved.id)}`)
      args.setShowForm(false)
      if (kind === "REPO") args.setRepoForm(EMPTY_REPO_FORM)
      else args.setUrlForm(EMPTY_URL_FORM)
      await args.fetchTargets()
      router.refresh()
    } catch (error) {
      args.setError(
        error instanceof Error ? error.message : `Failed to create ${TARGET_SINGULAR.toLowerCase()}`
      )
    } finally {
      args.setCreating(false)
    }
  }
  return {
    connectForScan,
    handleCreateRepo: () => create("REPO"),
    handleCreateUrl: () => create("URL"),
    selectedRepoId: args.selectedRepoId,
  }
}

function ScanSetupHeading() {
  return (
    <div className="mb-6 space-y-2">
      <h1 className="text-2xl font-bold tracking-tight">Configure a scan</h1>
      <p className="text-muted-foreground text-sm">
        Add the app, API, or repository you want to review. Next, confirm the scan scope and profile
        before starting.
      </p>
    </div>
  )
}

function CreatedTargetNotice({ target }: { target: { id: string; name: string } }) {
  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm">
        <span className="font-medium">{target.name}</span> is ready for scan setup.
      </p>
      <Link
        href={`/dashboard/scans?new=1&target=${encodeURIComponent(target.id)}`}
        className="bg-primary text-primary-foreground inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium hover:bg-primary/90"
      >
        Configure scan
      </Link>
    </div>
  )
}

function GithubScanConnection({
  connecting,
  onConnect,
  showWarning,
}: {
  connecting: boolean
  onConnect: () => void
  showWarning: boolean
}) {
  return (
    <div className="mb-4 space-y-2">
      <p className="text-muted-foreground text-sm">
        Connect GitHub to choose an accessible repository. You can also enter a public repository
        below.
      </p>
      {showWarning && (
        <p role="status" className="text-sm">
          GitHub access could not be confirmed. Retry the connection or use a public repository.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={connecting}
        aria-busy={connecting}
        onClick={onConnect}
      >
        {connecting ? "Connecting…" : "Connect GitHub"}
      </Button>
    </div>
  )
}

export function TargetsClient({
  workspaceId,
  initialProjectId,
  initialData,
  initialNextCursor,
  githubConnected = false,
  githubAccountLogin = null,
  scanSetup = false,
}: {
  workspaceId: string
  initialProjectId?: string
  initialData?: Target[]
  initialNextCursor?: string | null
  githubConnected?: boolean
  githubAccountLogin?: string | null
  scanSetup?: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const deletedNotice = searchParams.get("deleted")
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [targets, setTargets] = useState<Target[]>(initialData ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor ?? null)
  const [loading, setLoading] = useState(!initialData)
  const [showForm, setShowForm] = useState(scanSetup || searchParams.get("add") === "1")
  const [formType, setFormType] = useState<"REPO" | "URL">(
    scanSetup &&
      (searchParams.get("source") === "url" ||
        (!githubConnected && searchParams.get("source") !== "repo"))
      ? "URL"
      : "REPO"
  )
  const [connecting, setConnecting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdTarget, setCreatedTarget] = useState<{ id: string; name: string } | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [filterProjectId, setFilterProjectId] = useState<string | null>(initialProjectId ?? null)

  const [repoForm, setRepoForm] = useState<RepoFormState>(EMPTY_REPO_FORM)
  const [urlForm, setUrlForm] = useState<UrlFormState>(EMPTY_URL_FORM)

  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [repoMode, setRepoMode] = useState<"picker" | "manual">("picker")
  const [selectedRepoId, setSelectedRepoId] = useState<string>("")

  useEffect(() => {
    if (!githubConnected || formType !== "REPO" || !showForm) return
    // Loading and results are outputs of this request, not effect dependencies.
    // Otherwise setting loading cancels the very request that should clear it.
    let cancelled = false
    const abort = new AbortController()
    void (async () => {
      try {
        setReposLoading(true)
        const repos = await apiGet(`/api/integrations/github/repos?workspaceId=${workspaceId}`, {
          schema: githubReposSchema,
          signal: abort.signal,
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
      abort.abort()
    }
  }, [githubConnected, formType, showForm, workspaceId])

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
      setCreatedTarget((current) => (current?.id === target.id ? null : current))
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : `Failed to delete ${TARGET_SINGULAR.toLowerCase()}`
      )
    }
  }

  const { connectForScan, handleCreateRepo, handleCreateUrl } = createTargetScanHandlers({
    scanSetup,
    workspaceId,
    router,
    repoForm,
    urlForm,
    fetchTargets,
    setCreating,
    setConnecting,
    setError,
    setShowForm,
    setRepoForm,
    setUrlForm,
    setCreatedTarget,
    selectedRepoId,
  })

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
      {scanSetup ? (
        <ScanSetupHeading />
      ) : (
        <>
          {" "}
          <TargetAddRouteSync router={router} searchParams={searchParams} />
          <TargetsPageHeader
            filterProjectId={filterProjectId}
            showForm={showForm}
            hasTargets={targets.length > 0}
            onClearProjectFilter={() => {
              setFilterProjectId(null)
              router.push("/dashboard/targets")
            }}
            onToggleForm={() => setShowForm(!showForm)}
          />
        </>
      )}
      {createdTarget && !scanSetup && <CreatedTargetNotice target={createdTarget} />}

      {showForm && (
        <TargetCreatePanel formType={formType} onFormTypeChange={setFormType} error={error}>
          {scanSetup && formType === "REPO" && !githubConnected && (
            <GithubScanConnection
              connecting={connecting}
              onConnect={() => void connectForScan()}
              showWarning={Boolean(searchParams.get("github"))}
            />
          )}
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
              submitLabel={scanSetup ? "Continue to scan setup" : undefined}
              repoForm={repoForm}
              onRepoFormChange={(patch) => setRepoForm({ ...repoForm, ...patch })}
              creating={creating}
              onSubmit={handleCreateRepo}
              onCancel={() => {
                if (scanSetup) router.push("/dashboard/scans")
                else setShowForm(false)
                setError(null)
              }}
            />
          ) : (
            <UrlTargetForm
              submitLabel={scanSetup ? "Continue to scan setup" : undefined}
              urlForm={urlForm}
              onUrlFormChange={(patch) => setUrlForm({ ...urlForm, ...patch })}
              creating={creating}
              onSubmit={handleCreateUrl}
              onCancel={() => {
                if (scanSetup) router.push("/dashboard/scans")
                else setShowForm(false)
                setError(null)
              }}
            />
          )}
        </TargetCreatePanel>
      )}

      {!scanSetup && targets.length === 0 && !showForm ? (
        <TargetsEmptyState onAdd={() => setShowForm(true)} />
      ) : !scanSetup && targets.length > 0 ? (
        <TargetsTable targets={targets} onDelete={(t) => void handleDeleteTarget(t)} />
      ) : null}

      <LoadMore
        cursor={nextCursor}
        onLoadMore={loadMore}
        onItems={(items) => setTargets((prev) => [...prev, ...items])}
        onNextCursor={setNextCursor}
      />
    </div>
  )
}
