"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronLeft, ChevronRight, Globe, Rocket, SkipForward } from "lucide-react"
import { Button, FormField, GithubIcon, Input, Spinner } from "@lyrashield/ui"
import { apiPatch, apiPost } from "@/lib/api-client"

const GOALS = [
  { value: "CHECK_PR", label: "Check a PR", description: "Review a pull request before merging." },
  {
    value: "TEST_APP",
    label: "Test my app",
    description: "Review an app or repository for issues.",
  },
  {
    value: "LAUNCH_REVIEW",
    label: "Launch review",
    description: "Check what needs attention before release.",
  },
  { value: "WEEKLY_MONITOR", label: "Monitor weekly", description: "Set a recurring review goal." },
] as const

interface OnboardingData {
  currentStep: number
  completed: boolean
  skipped: boolean
  workspaceId: string | null
  targetId: string | null
  selectedGoal: string | null
}

function getInitialPhase(state: OnboardingData) {
  if (!state.workspaceId) return 0
  if (!state.targetId || !state.selectedGoal) return 1
  return 2
}

export function OnboardingWizard({ initialState }: { initialState: OnboardingData }) {
  const router = useRouter()
  const [phase, setPhase] = useState(() => getInitialPhase(initialState))
  const [data, setData] = useState(initialState)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspaceName, setWorkspaceName] = useState("")
  const [workspaceMode, setWorkspaceMode] = useState<"VIBE" | "TEAM">("VIBE")
  const [targetType, setTargetType] = useState<"REPO" | "URL">("REPO")
  const [targetName, setTargetName] = useState("")
  const [repoOwner, setRepoOwner] = useState("")
  const [repoName, setRepoName] = useState("")
  const [targetUrl, setTargetUrl] = useState("")
  const [selectedGoal, setSelectedGoal] = useState(initialState.selectedGoal ?? "TEST_APP")
  const [replaceTarget, setReplaceTarget] = useState(!initialState.targetId)

  async function persist(updates: Partial<OnboardingData>) {
    const next = await apiPatch<OnboardingData>("/api/onboarding", updates)
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
        mode: workspaceMode,
      })
      await persist({ workspaceId: workspace.id, currentStep: 1, skipped: false })
      setPhase(1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create your workspace.")
    } finally {
      setLoading(false)
    }
  }

  async function saveTargetAndGoal() {
    if (!data.workspaceId) {
      setError("Create a workspace before adding a target.")
      return
    }
    if (!selectedGoal) {
      setError("Choose what you want this scan to help with.")
      return
    }
    if (replaceTarget && !targetName.trim()) {
      setError("Name the app or repository you want to review.")
      return
    }
    if (replaceTarget && targetType === "REPO" && (!repoOwner.trim() || !repoName.trim())) {
      setError("Enter both the repository owner and name.")
      return
    }
    if (replaceTarget && targetType === "URL" && !targetUrl.trim()) {
      setError("Enter the app URL.")
      return
    }

    setLoading(true)
    setError(null)
    try {
      let targetId = data.targetId
      if (replaceTarget) {
        const target = await apiPost<{ id: string }>("/api/targets", {
          workspaceId: data.workspaceId,
          name: targetName.trim(),
          type: targetType === "REPO" ? "REPO" : "WEB_APP",
          environment: "STAGING",
          ...(targetType === "REPO"
            ? {
                repoProvider: "github",
                repoOwner: repoOwner.trim(),
                repoName: repoName.trim(),
              }
            : { url: targetUrl.trim() }),
        })
        targetId = target.id
      }

      await persist({ targetId, selectedGoal, currentStep: 2, skipped: false })
      setPhase(2)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this target.")
    } finally {
      setLoading(false)
    }
  }

  async function startScan() {
    if (!data.workspaceId || !data.targetId) {
      setError("Add a workspace and target before starting a scan.")
      return
    }

    setLoading(true)
    setError(null)
    try {
      const scan = await apiPost<{ id: string }>("/api/scans", {
        workspaceId: data.workspaceId,
        targetId: data.targetId,
        goal: selectedGoal,
        mode: "SAFE",
      })
      await persist({ currentStep: 4, completed: true, skipped: false, selectedGoal })
      router.push(`/dashboard/scans/${scan.id}`)
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the scan. Try again.")
    } finally {
      setLoading(false)
    }
  }

  async function finishLater() {
    setLoading(true)
    setError(null)
    try {
      await persist({ skipped: true })
      router.push("/dashboard")
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your progress.")
    } finally {
      setLoading(false)
    }
  }

  const phases = ["Workspace", "What to protect", "Review and start"]

  return (
    <div className="w-full max-w-2xl">
      <ol className="mb-6 grid grid-cols-3 border-y" aria-label="Getting started progress">
        {phases.map((label, index) => {
          const current = index === phase
          const done = index < phase
          return (
            <li
              key={label}
              className={`min-h-16 border-l-2 px-3 py-3 text-xs font-semibold sm:px-4 ${
                current
                  ? "border-primary bg-primary/8 text-primary"
                  : "text-muted-foreground border-transparent"
              }`}
              aria-current={current ? "step" : undefined}
            >
              <span className="mb-1 flex size-5 items-center justify-center border text-[10px]">
                {done ? <Check className="size-3" aria-hidden="true" /> : index + 1}
              </span>
              {label}
            </li>
          )
        })}
      </ol>

      <div className="mb-4 flex justify-end">
        <Button type="button" onClick={finishLater} disabled={loading} variant="ghost" size="sm">
          <SkipForward className="size-4" aria-hidden="true" />
          Finish later
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="border-destructive bg-destructive/10 mb-4 border-l-2 p-3 text-sm"
        >
          {error}
        </p>
      )}

      <section className="border p-5 sm:p-7" aria-live="polite">
        {phase === 0 && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 1
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">Give your work a home</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                A workspace keeps your apps, scans, and reports together.
              </p>
            </div>
            <FormField label="Workspace name" htmlFor="workspace-name">
              <Input
                id="workspace-name"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="My app security"
                autoComplete="organization"
              />
            </FormField>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Who is this for?</legend>
              <div className="grid gap-px border sm:grid-cols-2">
                {[
                  ["VIBE", "Just me", "A solo project or small product"],
                  ["TEAM", "My team", "Shared work across multiple people"],
                ].map(([value, title, description]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setWorkspaceMode(value as "VIBE" | "TEAM")}
                    className={`focus-visible:ring-ring min-h-24 p-4 text-left transition-[background-color,border-color] duration-150 focus-visible:ring-2 focus-visible:outline-none ${
                      workspaceMode === value ? "bg-primary/8" : "hover:bg-accent"
                    }`}
                    aria-pressed={workspaceMode === value}
                  >
                    <span className="block font-medium">{title}</span>
                    <span className="text-muted-foreground mt-1 block text-sm">{description}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end">
              <Button type="button" onClick={createWorkspace} disabled={loading}>
                {loading ? <Spinner className="mr-2" /> : <ChevronRight className="size-4" />}
                Continue
              </Button>
            </div>
          </div>
        )}

        {phase === 1 && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 2
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">
                What do you want to protect?
              </h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Add one app or repository and choose the outcome you need.
              </p>
            </div>

            {data.targetId && !replaceTarget ? (
              <div className="border-primary bg-primary/8 flex items-center justify-between gap-3 border-l-2 p-4 text-sm">
                <span>A target is already connected to this workspace.</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setReplaceTarget(true)}
                >
                  Add another
                </Button>
              </div>
            ) : (
              <>
                <div
                  className="grid gap-px border sm:grid-cols-2"
                  role="group"
                  aria-label="Target type"
                >
                  <button
                    type="button"
                    onClick={() => setTargetType("REPO")}
                    className={`focus-visible:ring-ring flex min-h-24 items-center gap-3 p-4 text-left focus-visible:ring-2 focus-visible:outline-none ${targetType === "REPO" ? "bg-primary/8" : "hover:bg-accent"}`}
                    aria-pressed={targetType === "REPO"}
                  >
                    <GithubIcon className="size-5" aria-hidden="true" />
                    <span>
                      <span className="block font-medium">Repository</span>
                      <span className="text-muted-foreground text-sm">Review source code</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetType("URL")}
                    className={`focus-visible:ring-ring flex min-h-24 items-center gap-3 p-4 text-left focus-visible:ring-2 focus-visible:outline-none ${targetType === "URL" ? "bg-primary/8" : "hover:bg-accent"}`}
                    aria-pressed={targetType === "URL"}
                  >
                    <Globe className="size-5" aria-hidden="true" />
                    <span>
                      <span className="block font-medium">Live app</span>
                      <span className="text-muted-foreground text-sm">Review a public URL</span>
                    </span>
                  </button>
                </div>
                <FormField label="Name" htmlFor="target-name">
                  <Input
                    id="target-name"
                    value={targetName}
                    onChange={(event) => setTargetName(event.target.value)}
                    placeholder="My web app"
                  />
                </FormField>
                {targetType === "REPO" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField label="Repository owner" htmlFor="repo-owner">
                      <Input
                        id="repo-owner"
                        value={repoOwner}
                        onChange={(event) => setRepoOwner(event.target.value)}
                        placeholder="octocat"
                      />
                    </FormField>
                    <FormField label="Repository name" htmlFor="repo-name">
                      <Input
                        id="repo-name"
                        value={repoName}
                        onChange={(event) => setRepoName(event.target.value)}
                        placeholder="hello-world"
                      />
                    </FormField>
                  </div>
                ) : (
                  <FormField label="Public app URL" htmlFor="target-url">
                    <Input
                      id="target-url"
                      type="url"
                      value={targetUrl}
                      onChange={(event) => setTargetUrl(event.target.value)}
                      placeholder="https://app.example.com"
                    />
                  </FormField>
                )}
              </>
            )}

            <fieldset>
              <legend className="mb-2 text-sm font-medium">What do you need from the scan?</legend>
              <div className="grid gap-px border sm:grid-cols-2">
                {GOALS.map((goal) => (
                  <button
                    key={goal.value}
                    type="button"
                    onClick={() => setSelectedGoal(goal.value)}
                    className={`focus-visible:ring-ring min-h-24 p-4 text-left focus-visible:ring-2 focus-visible:outline-none ${selectedGoal === goal.value ? "bg-primary/8" : "hover:bg-accent"}`}
                    aria-pressed={selectedGoal === goal.value}
                  >
                    <span className="block font-medium">{goal.label}</span>
                    <span className="text-muted-foreground mt-1 block text-sm">
                      {goal.description}
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-between gap-3">
              <Button type="button" variant="ghost" onClick={() => setPhase(0)} disabled={loading}>
                <ChevronLeft className="size-4" />
                Back
              </Button>
              <Button type="button" onClick={saveTargetAndGoal} disabled={loading}>
                {loading ? <Spinner className="mr-2" /> : <ChevronRight className="size-4" />}
                Continue
              </Button>
            </div>
          </div>
        )}

        {phase === 2 && (
          <div className="space-y-5">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Step 3
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">Review and start</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Your first scan uses Safe mode. You can choose other modes later.
              </p>
            </div>
            <dl className="divide-y border text-sm">
              <div className="flex justify-between gap-4 p-4">
                <dt className="text-muted-foreground">Workspace</dt>
                <dd className="font-medium">Ready</dd>
              </div>
              <div className="flex justify-between gap-4 p-4">
                <dt className="text-muted-foreground">Target</dt>
                <dd className="font-medium">Configured</dd>
              </div>
              <div className="flex justify-between gap-4 p-4">
                <dt className="text-muted-foreground">Goal</dt>
                <dd className="font-medium">
                  {GOALS.find((goal) => goal.value === selectedGoal)?.label ?? "Selected"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 p-4">
                <dt className="text-muted-foreground">Scan mode</dt>
                <dd className="font-medium">Safe</dd>
              </div>
            </dl>
            <p className="border-warning bg-warning/10 border-l-2 p-3 text-sm">
              A scan can report evidence and limitations. A clean result is not a universal security
              guarantee.
            </p>
            <div className="flex justify-between gap-3">
              <Button type="button" variant="ghost" onClick={() => setPhase(1)} disabled={loading}>
                <ChevronLeft className="size-4" />
                Back
              </Button>
              <Button type="button" onClick={startScan} disabled={loading}>
                <Rocket className="size-4" />
                {loading ? "Starting…" : "Start safe scan"}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
