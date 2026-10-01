import { useCallback, useEffect, useRef, useState } from "react"
import { apiGet, apiPost } from "@/lib/api-client"
import { track } from "@/lib/analytics"
import { githubReposSchema, installUrlSchema } from "@/lib/api-schemas"
import { bucketCount, bucketDuration, type OnboardingFailureState } from "./onboarding-wizard-model"
import type { OnboardingPath } from "./onboarding-flow.utils"
import type { Repo } from "./onboarding-step-views"
import type { OnboardingPersist } from "./use-onboarding-persistence"

/**
 * Owns the GitHub path of the wizard: repository listing (explicit load and
 * the one-shot auto-fetch on entering step 2), the chosen repo, the
 * "GitHub unavailable" degradation, and the connect flow that redirects to
 * the GitHub App install URL. Step transitions themselves stay with the
 * wizard — the hook receives the setters it needs.
 */
export function useOnboardingRepos({
  workspaceId,
  step,
  setPath,
  setLoading,
  setError,
  setFailure,
  ensureWorkspace,
  persist,
  oauthReturnState,
}: {
  workspaceId: string | null
  step: number
  setPath: (path: OnboardingPath) => void
  setLoading: (loading: boolean) => void
  setError: (message: string | null) => void
  setFailure: (failure: OnboardingFailureState) => void
  ensureWorkspace: () => Promise<string>
  persist: OnboardingPersist
  oauthReturnState?: string
}) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [reposLoaded, setReposLoaded] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [githubUnavailable, setGithubUnavailable] = useState(false)
  const autoFetchAttempted = useRef(false)
  const repoRequest = useRef("")

  const fetchRepos = useCallback(() => {
    if (!workspaceId) return Promise.resolve<Repo[]>([])
    return apiGet<Repo[]>(`/api/integrations/github/repos?workspaceId=${workspaceId}`, {
      schema: githubReposSchema,
    })
  }, [workspaceId])

  const loadRepos = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    setFailure(null)
    const startedAt = performance.now()
    const requestId = crypto.randomUUID()
    repoRequest.current = requestId
    try {
      const res = await fetchRepos()
      if (requestId !== repoRequest.current) return
      setRepos(res)
      setReposLoaded(true)
      setSelectedRepo((current) => res.find((repo) => repo.id === current?.id) ?? null)
      track("repos_loaded", {
        repo_count_bucket: bucketCount(res.length),
        load_ms_bucket: bucketDuration(performance.now() - startedAt),
      })
    } catch (cause) {
      if (requestId === repoRequest.current) {
        setError(cause instanceof Error ? cause.message : "Could not load repositories.")
      }
    } finally {
      if (requestId === repoRequest.current) setLoading(false)
    }
  }, [workspaceId, fetchRepos, setLoading, setError, setFailure])

  useEffect(() => {
    if (step !== 2 || autoFetchAttempted.current || !workspaceId) return
    autoFetchAttempted.current = true
    const requestId = crypto.randomUUID()
    repoRequest.current = requestId
    const startedAt = performance.now()
    fetchRepos()
      .then((res) => {
        if (requestId !== repoRequest.current) return
        setRepos(res)
        setReposLoaded(true)
        track("repos_loaded", {
          repo_count_bucket: bucketCount(res.length),
          load_ms_bucket: bucketDuration(performance.now() - startedAt),
        })
      })
      .catch((cause) => {
        if (requestId !== repoRequest.current) return
        setError(cause instanceof Error ? cause.message : "Could not load repositories.")
      })
    return () => {
      repoRequest.current = ""
      autoFetchAttempted.current = false
    }
  }, [step, workspaceId, fetchRepos, setError])

  async function connectGitHub() {
    setLoading(true)
    setError(null)
    setFailure(null)
    try {
      const resolvedWorkspaceId = await ensureWorkspace()
      const res = await apiPost(
        "/api/integrations/github/install",
        {
          workspaceId: resolvedWorkspaceId,
          returnTo: "onboarding",
          ...(oauthReturnState ? { oauthReturnState } : {}),
        },
        { schema: installUrlSchema }
      )
      await persist({ currentStep: 2, skipped: false })
      track("github_connect_started")
      window.location.assign(res.installUrl)
    } catch {
      // The GitHub App is not configured (or the endpoint otherwise failed). Do
      // not strand the user: mark the path unavailable and keep them on the
      // four-way choice with the other three ways forward intact. Only reset the
      // path when the user is still on the chooser — a failed *reconnect* from
      // the repo-select step should not yank them back. Do not interpolate the
      // raw server error into the UI.
      setGithubUnavailable(true)
      if (step === 1) setPath(null)
      setError(
        "GitHub connect is unavailable right now. You can add an app URL or API instead or skip for now."
      )
    } finally {
      setLoading(false)
    }
  }

  return {
    repos,
    reposLoaded,
    selectedRepo,
    setSelectedRepo,
    githubUnavailable,
    loadRepos,
    connectGitHub,
  }
}
