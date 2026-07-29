"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronLeft, ChevronRight, ShieldCheck } from "lucide-react"
import { Button, FormField, Input, Spinner, Badge, GithubIcon } from "@lyrashield/ui"
import { apiGet, apiPost, apiPatch } from "@/lib/api-client"
import { track } from "@/lib/analytics"
import { PRODUCT_SINGULAR, ENVIRONMENT_SINGULAR, RUN_SINGULAR } from "@/lib/terminology"
import { GOAL_OPTIONS } from "@/lib/labels"

interface V2OnboardingData {
  currentStep: number
  completed: boolean
  skipped: boolean
  workspaceId: string | null
  targetId: string | null
  selectedGoal: string | null
}

interface Repo {
  id: number
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
}

export function V2OnboardingWizard({ initialState }: { initialState: V2OnboardingData }) {
  const router = useRouter()
  const [step, setStep] = useState(initialState.workspaceId ? 1 : 0)
  const [data, setData] = useState(initialState)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [workspaceName, setWorkspaceName] = useState("")
  const [repos, setRepos] = useState<Repo[]>([])
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [productName, setProductName] = useState("")
  const [environment, setEnvironment] = useState("STAGING")
  const [selectedGoal, setSelectedGoal] = useState<string>("LAUNCH_REVIEW")
  const autoFetchAttempted = useRef(false)

  function bucketCount(n: number): string {
    if (n <= 0) return "0"
    if (n <= 3) return "1-3"
    if (n <= 10) return "4-10"
    if (n <= 50) return "11-50"
    return "50+"
  }

  const fetchRepos = useCallback(() => {
    if (!data.workspaceId) return Promise.resolve<Repo[]>([])
    return apiGet<Repo[]>(`/api/integrations/github/repos?workspaceId=${data.workspaceId}`)
  }, [data.workspaceId])

  const loadRepos = useCallback(async () => {
    if (!data.workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetchRepos()
      setRepos(res)
      track("repos_loaded", {
        repo_count_bucket: bucketCount(res.length),
        load_ms_bucket: "unknown",
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load repositories.")
    } finally {
      setLoading(false)
    }
  }, [data.workspaceId, fetchRepos])

  useEffect(() => {
    if (step !== 2 || autoFetchAttempted.current || !data.workspaceId) return
    autoFetchAttempted.current = true
    fetchRepos()
      .then((res) => {
        setRepos(res)
        track("repos_loaded", {
          repo_count_bucket: bucketCount(res.length),
          load_ms_bucket: "unknown",
        })
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not load repositories.")
      })
  }, [step, data.workspaceId, fetchRepos])

  async function persist(updates: Partial<V2OnboardingData>) {
    const next = await apiPatch<V2OnboardingData>("/api/onboarding", updates)
    setData(next)
    return next
  }

  async function createWorkspace() {
    if (!workspaceName.trim()) {
      setError("Name your workspace to continue.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const workspace = await apiPost<{ id: string }>("/api/workspaces", {
        name: workspaceName.trim(),
        mode: "VIBE",
      })
      await persist({ workspaceId: workspace.id, currentStep: 1, skipped: false })
      setStep(1)
      track("signup_started", { method: "web" })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create your workspace.")
    } finally {
      setLoading(false)
    }
  }

  async function connectGitHub() {
    if (!data.workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiPost<{ installUrl: string }>("/api/integrations/github/install", {
        workspaceId: data.workspaceId,
      })
      track("github_connect_started")
      window.open(res.installUrl, "_blank", "noopener,noreferrer")
      setStep(2)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start GitHub connect.")
    } finally {
      setLoading(false)
    }
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
    if (!data.workspaceId || !selectedRepo) {
      setError("Workspace and repository are required.")
      return
    }
    if (!productName.trim()) {
      setError(`Name your ${PRODUCT_SINGULAR.toLowerCase()} to continue.`)
      return
    }
    if (!selectedGoal) {
      setError("Choose a goal for this review.")
      return
    }

    setLoading(true)
    setError(null)
    try {
      const target = await apiPost<{ id: string }>("/api/targets", {
        workspaceId: data.workspaceId,
        name: productName.trim(),
        type: "REPO",
        repoProvider: "github",
        repoOwner: selectedRepo.owner,
        repoName: selectedRepo.name,
        branch: selectedRepo.defaultBranch,
        environment,
      })
      await persist({ targetId: target.id, selectedGoal, currentStep: 3, skipped: false })
      const scan = await apiPost<{ id: string }>("/api/scans", {
        workspaceId: data.workspaceId,
        targetId: target.id,
        goal: selectedGoal,
        mode: "SAFE",
      })
      await persist({ currentStep: 4, completed: true, skipped: false, selectedGoal })
      track("first_run_started", {
        preset: selectedGoal,
        asset_count: 1,
        estimate_low_min: 1,
        estimate_high_min: 5,
      })
      router.push(`/dashboard/scans/${scan.id}`)
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the review.")
    } finally {
      setLoading(false)
    }
  }

  const steps = ["Workspace", "Connect GitHub", "Select repository", `${PRODUCT_SINGULAR} details`]

  return (
    <div className="w-full max-w-2xl">
      <ol className="mb-6 grid grid-cols-4 border-y" aria-label="Getting started progress">
        {steps.map((label, index) => {
          const current = index === step
          const done = index < step
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
              <span className="hidden sm:inline">{label}</span>
            </li>
          )
        })}
      </ol>

      {error && (
        <p
          role="alert"
          className="border-destructive bg-destructive/10 mb-4 border-l-2 p-3 text-sm"
        >
          {error}
        </p>
      )}

      <section className="rounded-xl border p-5 sm:p-7" aria-live="polite">
        {step === 0 && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 1
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">Give your work a home</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                A workspace keeps your products and reviews together.
              </p>
            </div>
            <FormField label="Workspace name" htmlFor="workspace-name">
              <Input
                id="workspace-name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="My app security"
                autoComplete="organization"
              />
            </FormField>
            <div className="flex justify-end">
              <Button type="button" onClick={createWorkspace} disabled={loading}>
                {loading ? <Spinner className="mr-2" /> : <ChevronRight className="size-4" />}
                Continue
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 2
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">Connect GitHub</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Authorise the LyraShield GitHub App to read your repositories.
              </p>
            </div>
            <div className="bg-muted/50 rounded-lg border p-6 text-center">
              <GithubIcon className="mx-auto mb-3 size-10" aria-hidden="true" />
              <p className="text-sm">
                We only read repository metadata and source code you grant access to. We never write
                code without an approval.
              </p>
            </div>
            <div className="flex justify-between gap-3">
              <Button type="button" variant="ghost" onClick={() => setStep(0)} disabled={loading}>
                <ChevronLeft className="size-4" /> Back
              </Button>
              <Button type="button" onClick={connectGitHub} disabled={loading}>
                {loading ? (
                  <Spinner className="mr-2" />
                ) : (
                  <GithubIcon className="size-4" aria-hidden="true" />
                )}
                Connect GitHub
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 3
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
                    : "After you finish the GitHub install in the new tab, click below to load repositories."}
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
                Step 4
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">{PRODUCT_SINGULAR} details</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Name your {PRODUCT_SINGULAR.toLowerCase()} and choose the environment to review.
              </p>
            </div>

            <FormField label={`${PRODUCT_SINGULAR} name`} htmlFor="product-name">
              <Input
                id="product-name"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="My web app"
              />
            </FormField>

            <fieldset>
              <legend className="mb-2 text-sm font-medium">{ENVIRONMENT_SINGULAR}</legend>
              <div className="grid grid-cols-3 gap-2">
                {["STAGING", "PRODUCTION", "DEVELOPMENT"].map((env) => (
                  <button
                    type="button"
                    key={env}
                    onClick={() => setEnvironment(env)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      environment === env
                        ? "border-primary bg-primary/8 text-primary"
                        : "hover:bg-accent"
                    }`}
                  >
                    {env.toLowerCase()}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-sm font-medium">
                What do you need from this {RUN_SINGULAR.toLowerCase()}?
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {GOAL_OPTIONS.map((goal) => (
                  <button
                    type="button"
                    key={goal.value}
                    onClick={() => setSelectedGoal(goal.value)}
                    className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                      selectedGoal === goal.value
                        ? "border-primary bg-primary/8"
                        : "hover:bg-accent"
                    }`}
                  >
                    <span className="block font-medium">{goal.label}</span>
                    <span className="text-muted-foreground text-xs">{goal.description}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <p className="border-warning bg-warning/10 border-l-2 p-3 text-sm">
              A {RUN_SINGULAR.toLowerCase()} reports evidence and limitations. A clean result is not
              a universal security guarantee.
            </p>

            <div className="flex justify-between gap-3">
              <Button type="button" variant="ghost" onClick={() => setStep(2)} disabled={loading}>
                <ChevronLeft className="size-4" /> Back
              </Button>
              <Button type="button" onClick={createProductAndStart} disabled={loading}>
                <ShieldCheck className="size-4" />
                {loading
                  ? "Starting…"
                  : `Start ${GOAL_OPTIONS.find((g) => g.value === selectedGoal)?.label.toLowerCase() ?? "review"}`}
              </Button>
            </div>
          </div>
        )}
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
