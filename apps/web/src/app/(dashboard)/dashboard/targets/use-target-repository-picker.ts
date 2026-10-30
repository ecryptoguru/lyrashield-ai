"use client"
import { useEffect, useState, type Dispatch, type SetStateAction } from "react"
import { apiGet } from "@/lib/api-client"
import { githubReposPageSchema } from "@/lib/api-schemas"
import { EMPTY_REPO_FORM, type GithubRepo, type RepoFormState } from "./targets-model"

export function useTargetRepositoryPicker({
  workspaceId,
  githubConnected,
  formType,
  showForm,
  setRepoForm,
}: {
  workspaceId: string
  githubConnected: boolean
  formType: string
  showForm: boolean
  setRepoForm: Dispatch<SetStateAction<RepoFormState>>
}) {
  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([])
  const [reposNextPage, setReposNextPage] = useState<number | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [reposSearch, setReposSearch] = useState("")
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
        const page = await apiGet(
          `/api/integrations/github/repos?workspaceId=${encodeURIComponent(workspaceId)}&page=1`,
          {
            schema: githubReposPageSchema,
            signal: abort.signal,
          }
        )
        if (cancelled) return
        setGithubRepos(page.items)
        setReposNextPage(page.nextPage)
        setReposError(null)
      } catch {
        if (cancelled) return
        setReposError(
          "Repositories could not be loaded. Enter a repository manually or retry by reopening this form."
        )
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

  async function loadMoreRepos() {
    if (reposLoading || reposNextPage === null) return
    setReposLoading(true)
    setReposError(null)
    try {
      const page = await apiGet(
        `/api/integrations/github/repos?workspaceId=${encodeURIComponent(workspaceId)}&page=${reposNextPage}`,
        { schema: githubReposPageSchema }
      )
      setGithubRepos((current) => [
        ...current,
        ...page.items.filter((repo) => !current.some((existing) => existing.id === repo.id)),
      ])
      setReposNextPage(page.nextPage)
    } catch {
      setReposError(
        "More repositories could not be loaded. Try again; loaded results are retained."
      )
    } finally {
      setReposLoading(false)
    }
  }

  function handleSelectRepo(repoId: string) {
    setSelectedRepoId(repoId)
    const repo = githubRepos.find((r) => String(r.id) === repoId)
    if (!repo) {
      setRepoForm(EMPTY_REPO_FORM)
      return
    }
    setRepoForm({
      name: repo.fullName,
      repoOwner: repo.owner,
      repoName: repo.name,
      branch: repo.defaultBranch,
      installationId: repo.installationId,
    })
  }

  return {
    githubRepos,
    reposNextPage,
    reposError,
    reposSearch,
    setReposSearch,
    reposLoading,
    repoMode,
    setRepoMode,
    selectedRepoId,
    setSelectedRepoId,
    handleSelectRepo,
    loadMoreRepos,
  }
}
