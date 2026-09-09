"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronLeft, ChevronRight, Globe, ShieldCheck } from "lucide-react"
import { Button, FormField, Input, Spinner, Badge, GithubIcon } from "@lyrashield/ui"
import {
  githubReposSchema,
  idSchema,
  installUrlSchema,
  onboardingDataSchema,
} from "@/lib/api-schemas"
import { z } from "zod"
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client"
import { track } from "@/lib/analytics"
import { planIntentPath, rememberPlanIntent } from "@/lib/plan-intent"
import { PRODUCT_SINGULAR, RUN_SINGULAR } from "@/lib/terminology"
import {
  buildUrlTargetPayload,
  ensureOnboardingTargetId,
  getOnboardingReviewOptions,
  nextStepForPath,
  onboardingPathForTargetType,
  pathLabel,
  pathNeedsRepo,
  targetNameFromUrl,
  type OnboardingPath,
} from "./onboarding-flow.utils"

interface OnboardingData {
  updatedAt?: string
  currentStep: number
  completed: boolean
  skipped: boolean
  workspaceId: string | null
  targetId: string | null
  selectedGoal: string | null
  targetType?: string | null
  targetName?: string | null
}

interface Repo {
  id: number
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
  installationId: string
}

export function OnboardingWizard({
  initialState,
  selectedPlan,
  suggestedWorkspaceName,
  oauthReturnQuery,
  oauthReturnState,
}: {
  initialState: OnboardingData
  selectedPlan?: string | null
  /** Used to name a default workspace when the user has none (W2-01). */
  suggestedWorkspaceName?: string
  /**
   * W2-05: server-verified OAuth return state. When present, onboarding
   * completion returns the user to /oauth/consent with the preserved
   * authorization request instead of the dashboard. The destination is a
   * fixed route — the query is the only thing carried — and the signature,
   * expiry, and user binding were verified by the server page.
   */
  oauthReturnState?: string
  oauthReturnQuery?: string | null
}) {
  const router = useRouter()
  useEffect(() => {
    rememberPlanIntent(selectedPlan)
  }, [selectedPlan])
  // W2-05: where completion lands. An OAuth-arriving user returns to the
  // consent screen (their memberships are re-checked there); everyone else
  // keeps the existing destinations. The plan intent is dropped on the OAuth
  // return path — the consent flow, not billing, is the pending task.
  const completionPath = oauthReturnQuery
    ? `/oauth/consent?${oauthReturnQuery}`
    : selectedPlan
      ? planIntentPath("/dashboard/billing", selectedPlan)
      : "/dashboard"
  // W2-01: workspace naming left the critical path. The wizard starts at the
  // target chooser; a workspace is created lazily (with a sensible default
  // name) only when the user picks a path that needs one. A stale persisted
  // step 0 cannot reappear.
  const [step, setStep] = useState(Math.max(initialState.currentStep ?? 1, 1))
  const [data, setData] = useState(initialState)
  const persistedState = useRef(initialState)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [repos, setRepos] = useState<Repo[]>([])
  const [reposLoaded, setReposLoaded] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [productName, setProductName] = useState(initialState.targetName ?? "")
  // W2-03: environment classification left the critical path. The safe default
  // is metadata on the target and stays editable in target settings; it never
  // changes scanner eligibility, authorization, or execution here.
  const environment = "STAGING"
  const [selectedGoal, setSelectedGoal] = useState<string>(
    initialState.selectedGoal ?? "LAUNCH_REVIEW"
  )
  // Four-way step 2: which way the user chose to add their first target.
  // If the user already created a target (targetId is set) but we don't know
  // which path they took, leave path null — the step is already past step 2.
  const [path, setPath] = useState<OnboardingPath>(
    onboardingPathForTargetType(initialState.targetType ?? null)
  )
  const [githubUnavailable, setGithubUnavailable] = useState(false)
  const [urlForm, setUrlForm] = useState({ url: "", ownershipAttested: false })
  const autoFetchAttempted = useRef(false)
  const repoRequest = useRef("")
  const reviewOptions = getOnboardingReviewOptions(path)
  const selectedReview =
    reviewOptions.find((option) => option.goal === selectedGoal) ?? reviewOptions[0]
  const retryingExistingTarget = Boolean(data.targetId)

  function bucketCount(n: number): string {
    if (n <= 0) return "0"
    if (n <= 3) return "1-3"
    if (n <= 10) return "4-10"
    if (n <= 50) return "11-50"
    return "50+"
  }

  function bucketDuration(ms: number): string {
    if (ms < 250) return "under_250ms"
    if (ms < 1000) return "250ms_1s"
    if (ms < 3000) return "1s_3s"
    if (ms < 10000) return "3s_10s"
    return "10s_plus"
  }

  function friendlyTargetError(cause: unknown): string {
    if (cause instanceof ApiError) {
      if (cause.code === "SSRF_BLOCKED") {
        return "That URL isn't allowed because it points to an internal, private, or unresolvable address. Use a public target you own or are authorized to scan."
      }
      if (cause.code === "VALIDATION_ERROR") {
        return "We couldn't save your target. Please check the name and URL and try again."
      }
      // W2-02: a same-source retry continues with the target that already
      // exists instead of creating a second one.
      if (cause.code === "TARGET_EXISTS") {
        return "A target for this source already exists in your workspace. Open Targets to continue with it — no duplicate was created."
      }
    }
    return cause instanceof Error ? cause.message : "Could not start the review."
  }

  const fetchRepos = useCallback(() => {
    if (!data.workspaceId) return Promise.resolve<Repo[]>([])
    return apiGet<Repo[]>(`/api/integrations/github/repos?workspaceId=${data.workspaceId}`, {
      schema: githubReposSchema,
    })
  }, [data.workspaceId])

  const loadRepos = useCallback(async () => {
    if (!data.workspaceId) return
    setLoading(true)
    setError(null)
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
  }, [data.workspaceId, fetchRepos])

  useEffect(() => {
    if (step !== 2 || autoFetchAttempted.current || !data.workspaceId) return
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
  }, [step, data.workspaceId, fetchRepos])

  async function persist(updates: Partial<OnboardingData>) {
    let next
    try {
      next = await apiPatch(
        "/api/onboarding",
        { ...updates, expectedUpdatedAt: persistedState.current.updatedAt },
        { schema: onboardingDataSchema }
      )
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "ONBOARDING_CHANGED") router.refresh()
      throw cause
    }
    persistedState.current = next
    setData(next)
    return next
  }

  /**
   * W2-01: workspace creation is lazy and unnamed. The workspace is created
   * with a sensible default only when the user picks a path that needs one —
   * never merely by visiting onboarding, and never with a required naming
   * step. A concurrent tab that won the slug race is adopted instead of
   * duplicated.
   */
  async function ensureWorkspace(): Promise<string> {
    if (data.workspaceId) return data.workspaceId
    try {
      const workspace = await apiPost(
        "/api/workspaces",
        { name: suggestedWorkspaceName?.trim() || "My workspace", mode: "VIBE" },
        { schema: idSchema }
      )
      await persist({ workspaceId: workspace.id, currentStep: Math.max(step, 1), skipped: false })
      return workspace.id
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "SLUG_TAKEN") {
        // A concurrent tab created the default workspace first: adopt it.
        const existing = await apiGet("/api/workspaces", {
          schema: z.object({ data: z.array(z.object({ id: z.string().min(1) })).min(1) }),
        })
        const adopted = existing.data[0]
        if (!adopted) throw cause
        await persist({
          workspaceId: adopted.id,
          currentStep: Math.max(step, 1),
          skipped: false,
        })
        return adopted.id
      }
      throw cause
    }
  }

  async function connectGitHub() {
    setLoading(true)
    setError(null)
    try {
      const workspaceId = await ensureWorkspace()
      const res = await apiPost(
        "/api/integrations/github/install",
        {
          workspaceId,
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
        "GitHub connect is unavailable right now. You can add an app URL or API instead, or skip for now."
      )
    } finally {
      setLoading(false)
    }
  }

  async function choosePath(next: Exclude<OnboardingPath, null>) {
    setError(null)
    track("onboarding_path_chosen", { path: next })
    if (next === "skip") {
      void skipOnboarding()
      return
    }
    if (next === "github") {
      void connectGitHub()
      return
    }
    // URL / API: the workspace is created lazily here (W2-01) — no naming
    // step; the default name is editable later in settings.
    if (!data.workspaceId) {
      setLoading(true)
      try {
        await ensureWorkspace()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not prepare your workspace.")
        return
      } finally {
        setLoading(false)
      }
    }
    // URL / API: prefill a sensible product name, then collect the URL. The
    // onward step comes from the shared helper so the wizard and the flow logic
    // cannot diverge.
    setPath(next)
    if (!productName) {
      setProductName(next === "api" ? "Production API" : "Staging Site")
    }
  }

  async function skipOnboarding() {
    setLoading(true)
    setError(null)
    try {
      await persist({ skipped: true, currentStep: 0 })
      router.push(completionPath)
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not skip setup.")
      setLoading(false)
    }
  }

  // Validate the URL/API inputs and advance to product details. The target is
  // NOT created here — creation is deferred to createProductAndStart (the same
  // step the GitHub path uses) so the name/environment the user confirms on the
  // final step are what actually get saved, and so going Back -> Continue never
  // orphans a duplicate target.
  function continueWithUrlTarget() {
    const payload = buildUrlTargetPayload({
      workspaceId: data.workspaceId,
      path,
      name: productName,
      url: urlForm.url,
      environment,
      ownershipAttested: urlForm.ownershipAttested,
    })
    if (!payload) {
      setError(
        urlForm.ownershipAttested
          ? "Enter a name and a valid URL to continue."
          : "Confirm you own or are authorized to scan this target."
      )
      return
    }
    setError(null)
    const next = nextStepForPath(payload.type === "API" ? "api" : "url")
    if (next !== null) setStep(next)
  }

  async function confirmRepoAndContinue() {
    if (!selectedRepo) {
      setError("Select a repository to continue.")
      return
    }
    track("repos_selected", { selected_count: 1 })
    setProductName(selectedRepo.name)
    setStep(3)
  }

  async function createProductAndStart() {
    if (!data.workspaceId) {
      setError("Workspace is required.")
      return
    }
    // A retry after scan admission fails reuses the target persisted by the
    // first attempt. New flows create it here so Back -> Continue cannot orphan
    // a duplicate before the final action.
    const hasExistingTarget = Boolean(data.targetId)
    const needsRepo = pathNeedsRepo(path)
    if (!hasExistingTarget && needsRepo && !selectedRepo) {
      setError("Workspace and repository are required.")
      return
    }
    if (
      !hasExistingTarget &&
      !needsRepo &&
      !buildUrlTargetPayload({
        workspaceId: data.workspaceId,
        path,
        name: productName,
        url: urlForm.url,
        environment,
        ownershipAttested: urlForm.ownershipAttested,
      })
    ) {
      setError("Add a valid target and confirm ownership to continue.")
      return
    }
    if (!hasExistingTarget && !productName.trim()) {
      setError(`Name your ${PRODUCT_SINGULAR.toLowerCase()} to continue.`)
      return
    }
    if (!selectedReview) {
      setError("Choose a goal for this review.")
      return
    }

    setLoading(true)
    setError(null)
    try {
      const targetId = await ensureOnboardingTargetId(data.targetId, async () => {
        if (needsRepo && selectedRepo) {
          const target = await apiPost(
            "/api/targets",
            {
              workspaceId: data.workspaceId,
              name: productName.trim(),
              type: "REPO",
              repoProvider: "github",
              repoOwner: selectedRepo.owner,
              repoName: selectedRepo.name,
              installationId: selectedRepo.installationId,
              branch: selectedRepo.defaultBranch,
              environment,
            },
            { schema: idSchema }
          )
          return target.id
        }

        const payload = buildUrlTargetPayload({
          workspaceId: data.workspaceId,
          path,
          name: productName,
          url: urlForm.url,
          environment,
          ownershipAttested: urlForm.ownershipAttested,
        })
        if (!payload) throw new Error("Target details are required.")
        const target = await apiPost("/api/targets", payload, { schema: idSchema })
        return target.id
      })
      await persist({ targetId, selectedGoal: selectedReview.goal, currentStep: 3, skipped: false })
      const scan = await apiPost(
        "/api/scans",
        {
          workspaceId: data.workspaceId,
          targetId,
          goal: selectedReview.goal,
          mode: selectedReview.mode,
        },
        { schema: idSchema }
      )
      await persist({
        currentStep: 4,
        completed: true,
        skipped: false,
        selectedGoal: selectedReview.goal,
      })
      track("first_run_started", {
        preset: selectedReview.goal,
        asset_count: 1,
        estimate_low_min: selectedReview.estimate.low,
        estimate_high_min: selectedReview.estimate.high,
      })
      // W2-05: agent-first completion returns to the originating client's
      // consent flow; the started scan keeps running server-side.
      router.push(oauthReturnQuery ? completionPath : `/dashboard/scans/${scan.id}`)
      router.refresh()
    } catch (cause) {
      setError(friendlyTargetError(cause))
    } finally {
      setLoading(false)
    }
  }

  // The progress bar adapts to the chosen path: GitHub users see a
  // "Select repository" step; URL/API users skip it, so we collapse it
  // and show "Target details" as the third step instead. Workspace naming is
  // no longer a step (W2-01): the server provisions the workspace.
  const isGithubFlow = path === "github" || (path === null && step <= 2)
  const steps = isGithubFlow
    ? ["Add target", "Select repository", `${PRODUCT_SINGULAR} details`]
    : ["Add target", `${PRODUCT_SINGULAR} details`]
  const displayStep = Math.max(step - 1, 0)

  return (
    <div className="w-full max-w-2xl">
      <ol
        className={`mb-2 grid border-y ${steps.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}
        aria-label="Getting started progress"
      >
        {steps.map((label, index) => {
          const current = index === displayStep
          const done = index < displayStep
          return (
            <li
              key={label}
              className={`min-h-16 border-l-2 px-2 py-3 text-xs font-semibold ${
                current
                  ? "border-primary bg-primary/8 text-primary"
                  : "text-muted-foreground border-transparent"
              }`}
              aria-current={current ? "step" : undefined}
            >
              <span className="mb-1 flex size-5 items-center justify-center border text-[10px]">
                {done ? <Check className="size-3" aria-hidden="true" /> : index + 1}
              </span>
              {/* Always name the current step on every breakpoint; the rest stay
                  desktop-only to avoid crowding phones. A bare "1-2-3-4" gave
                  mobile users no idea where they were. */}
              <span className={current ? "inline" : "hidden sm:inline"}>{label}</span>
            </li>
          )
        })}
      </ol>
      <p className="text-muted-foreground mb-4 text-xs sm:hidden" aria-live="polite">
        Step {displayStep + 1} of {steps.length}
      </p>

      {error && (
        <p
          role="alert"
          className="border-destructive bg-destructive/10 mb-4 border-l-2 p-3 text-sm"
        >
          {error}
        </p>
      )}

      <section className="rounded-xl border p-5 sm:p-7" aria-live="polite">
        {step === 1 && path !== "url" && path !== "api" && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 1
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">Add your first target</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Choose what LyraShield reviews first. You can connect GitHub, point at a live app or
                API, or set this up later.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => choosePath("github")}
                disabled={loading || githubUnavailable}
                className="hover:bg-accent rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                <GithubIcon className="mb-2 size-6" aria-hidden="true" />
                <span className="block text-sm font-medium">Connect GitHub</span>
                <span className="text-muted-foreground mt-1 block text-xs">
                  {githubUnavailable
                    ? "Unavailable right now — pick another option."
                    : "Review a repository. Connect an authorized repository. Scans inspect code; fixes and pull requests are separate actions."}
                </span>
              </button>

              <button
                type="button"
                onClick={() => choosePath("url")}
                disabled={loading}
                className="hover:bg-accent rounded-lg border p-4 text-left transition-colors disabled:opacity-60"
              >
                <Globe className="text-primary mb-2 size-6" aria-hidden="true" />
                <span className="block text-sm font-medium">Add an app URL</span>
                <span className="text-muted-foreground mt-1 block text-xs">
                  Scan a live web app over HTTP — no repo access needed.
                </span>
              </button>

              <button
                type="button"
                onClick={() => choosePath("api")}
                disabled={loading}
                className="hover:bg-accent rounded-lg border p-4 text-left transition-colors disabled:opacity-60"
              >
                <Globe className="text-primary mb-2 size-6" aria-hidden="true" />
                <span className="block text-sm font-medium">Add an API</span>
                <span className="text-muted-foreground mt-1 block text-xs">
                  Scan an API&apos;s public surface — no repo access needed.
                </span>
              </button>
            </div>
          </div>
        )}

        {step === 1 && (path === "url" || path === "api") && (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault()
              continueWithUrlTarget()
            }}
          >
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 2
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">
                {path === "api" ? "Add your API" : "Add your app URL"}
              </h2>
              <p className="text-muted-foreground mt-2 text-sm">
                {path === "api"
                  ? "Point LyraShield at the API's base URL. Scans run over HTTP against the public surface."
                  : "Point LyraShield at the app's URL. Scans run over HTTP against the public surface."}{" "}
                You can connect GitHub later from Integrations.
              </p>
            </div>

            <FormField label={`${PRODUCT_SINGULAR} name`} htmlFor="url-name">
              <Input
                id="url-name"
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                maxLength={100}
                autoFocus
                placeholder={path === "api" ? "Production API" : "Staging Site"}
              />
            </FormField>

            <FormField label="URL" htmlFor="url-input">
              <Input
                id="url-input"
                type="url"
                value={urlForm.url}
                onChange={(e) => {
                  const url = e.target.value
                  setUrlForm({ ...urlForm, url })
                  // W2-02: selection and naming are one step — the name prefills
                  // from the parsed host and stays editable.
                  if (
                    !productName ||
                    productName === "Staging Site" ||
                    productName === "Production API"
                  ) {
                    const fromHost = targetNameFromUrl(e.target.value)
                    if (fromHost) setProductName(fromHost)
                  }
                }}
                placeholder={
                  path === "api" ? "https://api.example.com" : "https://staging.example.com"
                }
              />
            </FormField>

            <div className="flex items-start gap-2">
              <input
                id="ownership-check"
                type="checkbox"
                name="ownershipAttested"
                checked={urlForm.ownershipAttested}
                onChange={(e) => setUrlForm({ ...urlForm, ownershipAttested: e.target.checked })}
                required
                aria-required="true"
                aria-describedby="ownership-help"
                className="border-border text-primary focus:ring-ring mt-1 h-4 w-4 rounded focus:ring-2"
              />
              <div className="flex-1">
                <label htmlFor="ownership-check" className="text-sm">
                  I own or am authorized to scan this target.
                </label>
                <p id="ownership-help" className="text-muted-foreground text-xs">
                  This confirms you have permission to test this target.
                </p>
              </div>
            </div>

            <div className="flex justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPath(null)}
                disabled={loading}
              >
                <ChevronLeft className="size-4" /> Back
              </Button>
              <Button type="submit" disabled={loading || !urlForm.ownershipAttested}>
                {loading ? (
                  <Spinner className="mr-2" />
                ) : (
                  <ChevronRight className="size-4" aria-hidden="true" />
                )}
                Continue
              </Button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 2
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">Select a repository</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Choose the repository you want to review first.
              </p>
            </div>

            {repos.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm">
                  {error
                    ? "We couldn't load repositories. You may need to reconnect GitHub or check the installation."
                    : reposLoaded
                      ? "No repositories are available. Check which repositories your GitHub installation can access, then load them again."
                      : "After you finish the GitHub install, click below to load repositories."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" onClick={loadRepos} disabled={loading}>
                    {loading ? <Spinner /> : <RefreshCwIcon />}
                    Load repositories
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={connectGitHub}
                    disabled={loading}
                  >
                    <GithubIcon className="size-4" aria-hidden="true" />
                    Reconnect GitHub
                  </Button>
                </div>
              </div>
            )}

            {repos.length > 0 && (
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-1">
                {repos.map((repo) => (
                  <button
                    type="button"
                    key={repo.id}
                    onClick={() => setSelectedRepo(repo)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      selectedRepo?.id === repo.id ? "bg-primary/8 text-primary" : "hover:bg-accent"
                    }`}
                  >
                    <span className="truncate font-medium">{repo.fullName}</span>
                    {repo.private && <Badge variant="muted">Private</Badge>}
                    {selectedRepo?.id === repo.id && (
                      <Check className="size-4" aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="flex justify-between gap-3">
              <Button type="button" variant="ghost" onClick={() => setStep(1)} disabled={loading}>
                <ChevronLeft className="size-4" /> Back
              </Button>
              <Button
                type="button"
                onClick={confirmRepoAndContinue}
                disabled={loading || !selectedRepo}
              >
                <ChevronRight className="size-4" /> Continue
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step {pathNeedsRepo(path) ? 3 : 2}
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">{PRODUCT_SINGULAR} details</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                {retryingExistingTarget
                  ? `Retry the review for ${productName || `this ${PRODUCT_SINGULAR.toLowerCase()}`}. The target stays locked so the retry cannot create or scan a different target.`
                  : pathNeedsRepo(path)
                    ? `Name your ${PRODUCT_SINGULAR.toLowerCase()}. You can classify its environment later in target settings.`
                    : `Reviewing your ${pathLabel(path)}. Name it and choose what you need from this ${RUN_SINGULAR.toLowerCase()}.`}
              </p>
            </div>

            {retryingExistingTarget ? (
              <div className="bg-muted/40 rounded-lg border p-4">
                <p className="text-sm font-medium">
                  {productName || `Existing ${PRODUCT_SINGULAR}`}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Existing {pathLabel(path)} · target details are locked for this retry
                </p>
              </div>
            ) : (
              <FormField label={`${PRODUCT_SINGULAR} name`} htmlFor="product-name">
                <Input
                  id="product-name"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="My web app"
                />
              </FormField>
            )}

            {/* W2-04: one recommended eligible review, with alternatives behind
                an explicit "Change review" toggle. Essential scope, limitation,
                and usage information stays outside the collapsed details. */}
            <fieldset>
              <legend className="mb-2 text-sm font-medium">
                Recommended review for this {pathLabel(path)}
              </legend>
              {selectedReview && (
                <div className="border-primary bg-primary/8 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{selectedReview.label}</span>
                    <Badge variant="info">
                      ~{selectedReview.estimate.low}–{selectedReview.estimate.high} min
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-1 text-sm">{selectedReview.description}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Depth: {selectedReview.mode.toLowerCase()} · runs within your workspace plan,
                    budgets, and target authorization. A clean result is not a security guarantee.
                  </p>
                </div>
              )}
              <details className="mt-2">
                <summary className="text-muted-foreground cursor-pointer text-sm font-medium">
                  Change review
                </summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {reviewOptions.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      onClick={() => setSelectedGoal(option.goal)}
                      aria-pressed={selectedReview?.id === option.id}
                      className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                        selectedReview?.id === option.id
                          ? "border-primary bg-primary/8"
                          : "hover:bg-accent"
                      }`}
                    >
                      <span className="block font-medium">{option.label}</span>
                      <span className="text-muted-foreground text-xs">{option.description}</span>
                      <span className="text-muted-foreground mt-1 block text-xs">
                        ~{option.estimate.low}-{option.estimate.high} min ·{" "}
                        {option.mode.toLowerCase()}
                      </span>
                    </button>
                  ))}
                </div>
              </details>
              {path === "api" && (
                <p className="text-muted-foreground mt-2 text-xs">
                  Add an OpenAPI document after setup to unlock Contract and Contract Behavior
                  reviews.
                </p>
              )}
            </fieldset>

            <p className="border-warning bg-warning/10 border-l-2 p-3 text-sm">
              A {RUN_SINGULAR.toLowerCase()} reports evidence and limitations. A clean result is not
              a universal security guarantee.
            </p>

            <div className="flex justify-between gap-3">
              {/* GitHub path backs into repo-select (step 2); URL/API back into
                  the URL form (step 1, path kept). */}
              {retryingExistingTarget ? (
                <span />
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep(pathNeedsRepo(path) ? 2 : 1)}
                  disabled={loading}
                >
                  <ChevronLeft className="size-4" /> Back
                </Button>
              )}
              <Button type="button" onClick={createProductAndStart} disabled={loading}>
                <ShieldCheck className="size-4" />
                {loading ? "Starting…" : `Start ${selectedReview?.label.toLowerCase() ?? "review"}`}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-center border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void skipOnboarding()}
            disabled={loading}
          >
            Skip / finish later
          </Button>
        </div>
      </section>
    </div>
  )
}

function RefreshCwIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}
