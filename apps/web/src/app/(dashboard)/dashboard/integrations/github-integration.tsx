"use client"

import { useState } from "react"
import Link from "next/link"
import { Check, RefreshCw, Plus, ChevronRight } from "lucide-react"
import { Button, Badge, Spinner, GithubIcon } from "@lyrashield/ui"
import { apiGet, apiPost } from "@/lib/api-client"

interface Repo {
  id: number
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
}

export function GithubIntegration({
  workspaceId,
  connected,
  accountLogin,
}: {
  workspaceId: string
  connected: boolean
  accountLogin: { accountLogin?: string } | null
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repos, setRepos] = useState<Repo[]>([])
  const [reposLoaded, setReposLoaded] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [targetCreated, setTargetCreated] = useState(false)

  async function handleConnect() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiPost<{ installUrl: string }>("/api/integrations/github/install", {
        workspaceId,
      })
      window.location.href = data.installUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect")
      setLoading(false)
    }
  }

  async function loadRepos() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet<Repo[]>(`/api/integrations/github/repos?workspaceId=${workspaceId}`)
      setRepos(data)
      setReposLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load repos")
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateTarget() {
    if (!selectedRepo) return
    setLoading(true)
    setError(null)
    try {
      await apiPost("/api/targets", {
        workspaceId,
        type: "REPO",
        name: selectedRepo.fullName,
        repoProvider: "github",
        repoOwner: selectedRepo.owner,
        repoName: selectedRepo.name,
        branch: selectedRepo.defaultBranch,
        environment: "STAGING",
      })
      setTargetCreated(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create target")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-card rounded-xl border p-4 shadow-sm sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="bg-foreground text-background flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <GithubIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">GitHub</h2>
            <p className="text-muted-foreground text-sm">
              Connect your GitHub repositories for scanning.
            </p>
          </div>
        </div>
        {connected ? (
          <Badge variant="success">
            <Check className="h-3 w-3" aria-hidden="true" />
            Connected{accountLogin?.accountLogin ? ` as ${accountLogin.accountLogin}` : ""}
          </Badge>
        ) : (
          <Button onClick={handleConnect} disabled={loading}>
            {loading ? <Spinner /> : <GithubIcon className="h-4 w-4" aria-hidden="true" />}
            Connect GitHub
          </Button>
        )}
      </div>

      {error && (
        <div
          className="border-destructive/50 bg-destructive/10 text-destructive mt-4 rounded-md border p-3 text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      {connected && !reposLoaded && (
        <div className="mt-4">
          <Button onClick={loadRepos} disabled={loading} variant="secondary">
            {loading ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            Load repositories
          </Button>
        </div>
      )}

      {reposLoaded && (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-medium">Select a repository to add as a scan target:</h3>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {repos.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No repositories found. Make sure the GitHub App has access to repos.
              </p>
            ) : (
              repos.map((repo) => (
                <button
                  type="button"
                  key={repo.id}
                  onClick={() => setSelectedRepo(repo)}
                  className={`focus-visible:ring-ring flex w-full cursor-pointer items-center justify-between rounded-lg border p-3 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${
                    selectedRepo?.id === repo.id ? "border-primary bg-primary/5" : "hover:bg-accent"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <GithubIcon className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                    <span className="font-medium">{repo.fullName}</span>
                    {repo.private && (
                      <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
                        private
                      </span>
                    )}
                  </div>
                  {selectedRepo?.id === repo.id && (
                    <Check className="text-primary h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              ))
            )}
          </div>
          {selectedRepo && !targetCreated && (
            <Button onClick={handleCreateTarget} disabled={loading}>
              {loading ? <Spinner /> : <Plus className="h-4 w-4" aria-hidden="true" />}
              Add &ldquo;{selectedRepo.fullName}&rdquo; as target
            </Button>
          )}
          {targetCreated && (
            <div
              className="border-primary/30 bg-primary/5 flex items-center gap-2 rounded-md border p-3 text-sm"
              role="status"
            >
              <Check className="text-primary h-4 w-4" aria-hidden="true" />
              Target created successfully. You can now scan this repository.
              <Link
                href="/dashboard/targets"
                className="text-primary ml-auto flex items-center gap-1 hover:underline"
              >
                View targets <ChevronRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
