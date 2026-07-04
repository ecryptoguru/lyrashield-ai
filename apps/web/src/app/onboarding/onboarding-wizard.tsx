"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  ShieldCheck,
  Check,
  ChevronRight,
  ChevronLeft,
  SkipForward,
  Globe,
  Zap,
  FileCheck,
  Rocket,
  Bug,
  GitBranch,
  Clock,
} from "lucide-react"
import { Button, Input, Spinner, GithubIcon } from "@lyrashield/ui"
import { apiPost, apiPatch } from "@/lib/api-client"

const STEPS = [
  { label: "Workspace", icon: ShieldCheck },
  { label: "Target", icon: GithubIcon },
  { label: "Goal", icon: Zap },
  { label: "Preflight", icon: FileCheck },
  { label: "Scan", icon: Rocket },
  { label: "Results", icon: Bug },
  { label: "Fix", icon: GitBranch },
]

const GOALS = [
  { value: "CHECK_PR", label: "Check a PR", description: "Review a pull request for security issues before merging", icon: GitBranch },
  { value: "TEST_APP", label: "Test my app", description: "Run a security scan against your running application", icon: Bug },
  { value: "LAUNCH_REVIEW", label: "Launch review", description: "Pre-launch security review before going to production", icon: Rocket },
  { value: "WEEKLY_MONITOR", label: "Monitor weekly", description: "Set up recurring weekly security scans", icon: ShieldCheck },
] as const

interface OnboardingData {
  currentStep: number
  completed: boolean
  skipped: boolean
  workspaceId: string | null
  targetId: string | null
  selectedGoal: string | null
}

export function OnboardingWizard({ initialState }: { initialState: OnboardingData }) {
  const router = useRouter()
  const [step, setStep] = useState(initialState.currentStep)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<OnboardingData>(initialState)

  // Workspace form state
  const [wsName, setWsName] = useState("")
  const [wsMode, setWsMode] = useState<"VIBE" | "TEAM">("VIBE")

  // Target form state
  const [targetType, setTargetType] = useState<"REPO" | "URL">("REPO")
  const [targetName, setTargetName] = useState("")
  const [repoOwner, setRepoOwner] = useState("")
  const [repoName, setRepoName] = useState("")
  const [targetUrl, setTargetUrl] = useState("")

  // Goal state
  const [selectedGoal, setSelectedGoal] = useState<string | null>(initialState.selectedGoal)

  const updateState = useCallback(async (updates: Partial<OnboardingData>) => {
    setError(null)
    try {
      const updated = await apiPatch<OnboardingData>("/api/onboarding", updates)
      setData(updated)
      return updated
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong")
      return null
    }
  }, [])

  async function handleCreateWorkspace() {
    if (!wsName.trim()) {
      setError("Workspace name is required")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const ws = await apiPost<{ id: string }>('/api/workspaces', { name: wsName, mode: wsMode })
      await updateState({ workspaceId: ws.id, currentStep: 1 })
      setStep(1)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create workspace")
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateTarget() {
    if (!targetName.trim()) {
      setError("Target name is required")
      return
    }
    if (targetType === "REPO" && (!repoOwner.trim() || !repoName.trim())) {
      setError("Repository owner and name are required")
      return
    }
    if (targetType === "URL" && !targetUrl.trim()) {
      setError("URL is required")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const body =
        targetType === "REPO"
          ? { type: "REPO", name: targetName, workspaceId: data.workspaceId, repoProvider: "github", repoOwner, repoName, environment: "STAGING" }
          : { type: "WEB_APP", name: targetName, workspaceId: data.workspaceId, url: targetUrl, environment: "STAGING" }

      const target = await apiPost<{ id: string }>("/api/targets", body)
      await updateState({ targetId: target.id, currentStep: 2 })
      setStep(2)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create target")
    } finally {
      setLoading(false)
    }
  }

  async function handleSelectGoal(goal: string) {
    setSelectedGoal(goal)
    setLoading(true)
    const updated = await updateState({ selectedGoal: goal, currentStep: 3 })
    setLoading(false)
    if (updated) setStep(3)
  }

  async function handleNext() {
    const nextStep = step + 1
    setLoading(true)
    const updated = await updateState({ currentStep: nextStep })
    setLoading(false)
    if (updated) setStep(nextStep)
  }

  async function handleBack() {
    const prevStep = Math.max(0, step - 1)
    setLoading(true)
    const updated = await updateState({ currentStep: prevStep })
    setLoading(false)
    if (updated) setStep(prevStep)
  }

  async function handleSkip() {
    setLoading(true)
    await updateState({ skipped: true, completed: true })
    setLoading(false)
    router.push("/dashboard")
    router.refresh()
  }

  async function handleComplete() {
    setLoading(true)
    await updateState({ completed: true })
    setLoading(false)
    router.push("/dashboard")
    router.refresh()
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* Progress Indicator */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          {STEPS.map((s, i) => (
            <div key={s.label} className="flex flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                {i > 0 && (
                  <div className={`h-0.5 flex-1 transition-colors duration-300 ${i <= step ? "bg-primary" : "bg-border"}`} />
                )}
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 transition-[border-color,box-shadow] duration-300 ${
                    i < step
                      ? "gradient-primary border-transparent text-primary-foreground shadow-sm"
                      : i === step
                      ? "border-primary text-primary shadow-primary-glow"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {i < step ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <s.icon className="h-4 w-4" aria-hidden="true" />
                  )}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`h-0.5 flex-1 transition-colors duration-300 ${i < step ? "bg-primary" : "bg-border"}`} />
                )}
              </div>
              <span
                className={`mt-2 text-xs font-medium ${
                  i === step ? "block text-foreground" : "hidden sm:block text-muted-foreground"
                }`}
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Skip Button */}
      <div className="mb-4 flex justify-end">
        <Button
          onClick={handleSkip}
          disabled={loading}
          variant="ghost"
          size="sm"
        >
          <SkipForward className="h-4 w-4" aria-hidden="true" />
          Skip onboarding
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      {/* Step Content */}
      <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        {/* Step 0: Workspace */}
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Create your workspace</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                A workspace is where your projects, targets, and scans live.
              </p>
            </div>
            {data.workspaceId && (
              <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                <Check className="h-4 w-4 text-primary" aria-hidden="true" />
                Workspace already created. Click Next to continue.
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor="ws-name">
                Workspace name
              </label>
              <Input
                id="ws-name"
                type="text"
                value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                placeholder="My Security Team"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Mode</label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setWsMode("VIBE")}
                  className={`flex-1 rounded-lg border p-3 text-left text-sm transition-[border-color,box-shadow] ${
                    wsMode === "VIBE" ? "border-primary bg-primary/5 shadow-sm" : "hover:bg-accent"
                  }`}
                >
                  <div className="font-medium">Vibe</div>
                  <div className="text-muted-foreground">Solo developer</div>
                </button>
                <button
                  onClick={() => setWsMode("TEAM")}
                  className={`flex-1 rounded-lg border p-3 text-left text-sm transition-[border-color,box-shadow] ${
                    wsMode === "TEAM" ? "border-primary bg-primary/5 shadow-sm" : "hover:bg-accent"
                  }`}
                >
                  <div className="font-medium">Team</div>
                  <div className="text-muted-foreground">Multiple members</div>
                </button>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={data.workspaceId ? () => { setStep(1) } : handleCreateWorkspace}
                disabled={loading}
              >
                {loading && <Spinner className="mr-1" />}
                {data.workspaceId ? "Next" : "Create workspace"}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 1: Target */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Choose your target</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                What do you want to scan? Connect a GitHub repo or enter an app URL.
              </p>
            </div>
            {data.targetId && (
              <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                <Check className="h-4 w-4 text-primary" aria-hidden="true" />
                Target already set. Click Next to continue.
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                onClick={() => setTargetType("REPO")}
                className={`flex flex-1 items-center gap-3 rounded-lg border p-4 text-left transition-[border-color,box-shadow] ${
                  targetType === "REPO" ? "border-primary bg-primary/5 shadow-sm" : "hover:bg-accent"
                }`}
              >
                <GithubIcon className="h-5 w-5" aria-hidden="true" />
                <div>
                  <div className="font-medium">GitHub Repo</div>
                  <div className="text-sm text-muted-foreground">Scan a repository</div>
                </div>
              </button>
              <button
                onClick={() => setTargetType("URL")}
                className={`flex flex-1 items-center gap-3 rounded-lg border p-4 text-left transition-[border-color,box-shadow] ${
                  targetType === "URL" ? "border-primary bg-primary/5 shadow-sm" : "hover:bg-accent"
                }`}
              >
                <Globe className="h-5 w-5" aria-hidden="true" />
                <div>
                  <div className="font-medium">App URL</div>
                  <div className="text-sm text-muted-foreground">Scan a running app</div>
                </div>
              </button>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor="target-name">
                Target name
              </label>
              <Input
                id="target-name"
                type="text"
                value={targetName}
                onChange={(e) => setTargetName(e.target.value)}
                placeholder="My Web App"
              />
            </div>
            {targetType === "REPO" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium" htmlFor="repo-owner">
                    Repo owner
                  </label>
                  <Input
                    id="repo-owner"
                    type="text"
                    value={repoOwner}
                    onChange={(e) => setRepoOwner(e.target.value)}
                    placeholder="octocat"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium" htmlFor="repo-name">
                    Repo name
                  </label>
                  <Input
                    id="repo-name"
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    placeholder="Hello-World"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="mb-1.5 block text-sm font-medium" htmlFor="target-url">
                  App URL
                </label>
                <Input
                  id="target-url"
                  type="url"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://myapp.example.com"
                />
              </div>
            )}
            <div className="flex justify-between">
              <Button
                onClick={handleBack}
                disabled={loading}
                variant="ghost"
                size="sm"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
              <Button
                onClick={data.targetId ? () => { setStep(2) } : handleCreateTarget}
                disabled={loading}
              >
                {loading && <Spinner className="mr-1" />}
                {data.targetId ? "Next" : "Add target"}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Goal */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Choose your goal</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                What are you trying to accomplish with this scan?
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {GOALS.map((goal) => (
                <button
                  key={goal.value}
                  onClick={() => handleSelectGoal(goal.value)}
                  disabled={loading}
                  className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-[border-color,box-shadow] ${
                    selectedGoal === goal.value
                      ? "border-primary bg-primary/5 shadow-sm"
                      : "hover:bg-accent"
                  }`}
                >
                  <goal.icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                  <div>
                    <div className="font-medium">{goal.label}</div>
                    <div className="text-sm text-muted-foreground">{goal.description}</div>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex justify-between">
              <Button
                onClick={handleBack}
                disabled={loading}
                variant="ghost"
                size="sm"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Preflight */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Preflight check</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Verifying your setup is ready for scanning.
              </p>
            </div>
            <div className="space-y-3">
              <PreflightItem label="Workspace connected" passed={!!data.workspaceId} />
              <PreflightItem label="Target configured" passed={!!data.targetId} />
              <PreflightItem label="Goal selected" passed={!!data.selectedGoal} />
              <PreflightItem label="Scan policy ready" passed={!!data.workspaceId} />
            </div>
            <div className="flex justify-between">
              <Button
                onClick={handleBack}
                disabled={loading}
                variant="ghost"
                size="sm"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
              <Button
                onClick={handleNext}
                disabled={loading}
              >
                {loading && <Spinner className="mr-1" />}
                Continue
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Scan (placeholder) */}
        {step === 4 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Start your first scan</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The scan engine integration is coming in Sprint 5.
              </p>
            </div>
            <div className="rounded-xl border border-dashed bg-card/50 p-8 text-center">
              <Rocket className="mx-auto mb-3 h-10 w-10 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                The LyraShield scan engine is being integrated. Once ready, you&apos;ll be able to
                start a scan directly from this wizard.
              </p>
            </div>
            <div className="flex justify-between">
              <Button
                onClick={handleBack}
                disabled={loading}
                variant="ghost"
                size="sm"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
              <Button
                onClick={handleNext}
                disabled={loading}
              >
                Continue
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 5: Results (placeholder) */}
        {step === 5 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">View your results</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Scan results will appear here once the engine is integrated.
              </p>
            </div>
            <div className="rounded-xl border border-dashed bg-card/50 p-8 text-center">
              <Bug className="mx-auto mb-3 h-10 w-10 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                Findings, severity ratings, and evidence will be displayed here after your first scan.
              </p>
            </div>
            <div className="flex justify-between">
              <Button
                onClick={handleBack}
                disabled={loading}
                variant="ghost"
                size="sm"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
              <Button
                onClick={handleNext}
                disabled={loading}
              >
                Continue
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 6: Fix (placeholder) */}
        {step === 6 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold">Create a fix PR</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Fix proposals and PR creation will be available after scan engine integration.
              </p>
            </div>
            <div className="rounded-xl border border-dashed bg-card/50 p-8 text-center">
              <GitBranch className="mx-auto mb-3 h-10 w-10 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                Once scans produce findings, you&apos;ll be able to generate fix proposals and create
                pull requests directly from LyraShield.
              </p>
            </div>
            <div className="flex justify-between">
              <Button
                onClick={handleBack}
                disabled={loading}
                variant="ghost"
                size="sm"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
              <Button
                onClick={handleComplete}
                disabled={loading}
              >
                {loading && <Spinner className="mr-1" />}
                <Check className="h-4 w-4" aria-hidden="true" />
                Finish onboarding
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PreflightItem({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div
        className={`flex h-6 w-6 items-center justify-center rounded-full ${
          passed ? "gradient-primary text-primary-foreground" : "bg-muted text-muted-foreground"
        }`}
      >
        {passed ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Clock className="h-3.5 w-3.5" aria-hidden="true" />}
      </div>
      <span className={`text-sm ${passed ? "text-foreground" : "text-muted-foreground"}`}>
        {label}
      </span>
    </div>
  )
}
