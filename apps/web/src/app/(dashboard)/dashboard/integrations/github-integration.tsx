"use client"

import { useState } from "react"
import { Loader2, Check, RefreshCw, Plus, ChevronRight } from "lucide-react"
import { GithubIcon } from "@lyrashield/ui"

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
      const res = await fetch("/api/integrations/github/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error?.message ?? "Failed to get install URL")
      window.location.href = json.data.installUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect")
      setLoading(false)
    }
  }

  async function loadRepos() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/integrations/github/repos?workspaceId=${workspaceId}`)
      const json = await res.json()
      if (!json.success) throw new Error(json.error?.message ?? "Failed to load repos")
      setRepos(json.data)
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
      const res = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          type: "REPO",
          name: selectedRepo.fullName,
          repoProvider: "github",
          repoOwner: selectedRepo.owner,
          repoName: selectedRepo.name,
          branch: selectedRepo.defaultBranch,
          environment: "STAGING",
        }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error?.message ?? "Failed to create target")
      setTargetCreated(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create target")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-foreground text-background">
            <GithubIcon className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">GitHub</h2>
            <p className="text-sm text-muted-foreground">
              Connect your GitHub repositories for scanning.
            </p>
          </div>
        </div>
        {connected ? (
          <span className="flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Check className="h-3 w-3" />
            Connected{accountLogin?.accountLogin ? ` as ${accountLogin.accountLogin}` : ""}
          </span>
        ) : (
          <button
            onClick={handleConnect}
            disabled={loading}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GithubIcon className="h-4 w-4" />}
            Connect GitHub
          </button>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {connected && !reposLoaded && (
        <div className="mt-4">
          <button
            onClick={loadRepos}
            disabled={loading}
            className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Load repositories
          </button>
        </div>
      )}

      {reposLoaded && (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-medium">Select a repository to add as a scan target:</h3>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {repos.length === 0 ? (
              <p className="text-sm text-muted-foreground">No repositories found. Make sure the GitHub App has access to repos.</p>
            ) : (
              repos.map((repo) => (
                <button
                  key={repo.id}
                  onClick={() => setSelectedRepo(repo)}
                  className={`flex w-full items-center justify-between rounded-md border p-3 text-left text-sm transition-colors ${
                    selectedRepo?.id === repo.id ? "border-primary bg-primary/5" : "hover:bg-accent"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <GithubIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{repo.fullName}</span>
                    {repo.private && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">private</span>
                    )}
                  </div>
                  {selectedRepo?.id === repo.id && <Check className="h-4 w-4 text-primary" />}
                </button>
              ))
            )}
          </div>
          {selectedRepo && !targetCreated && (
            <button
              onClick={handleCreateTarget}
              disabled={loading}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add &ldquo;{selectedRepo.fullName}&rdquo; as target
            </button>
          )}
          {targetCreated && (
            <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
              <Check className="h-4 w-4 text-primary" />
              Target created successfully. You can now scan this repository.
              <a href="/dashboard/targets" className="ml-auto flex items-center gap-1 text-primary hover:underline">
                View targets <ChevronRight className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
