"use client"

import { useEffect, useRef } from "react"
import Link from "next/link"
import { Braces, Check, ChevronLeft, ChevronRight, Globe, ShieldCheck } from "lucide-react"
import { Button, Spinner, Badge, GithubIcon } from "@lyrashield/ui"
import type { OperationFailurePresentation } from "@/lib/operation-failure"
import type { ManualScanOption } from "@/lib/scan-presets"
import { getEnvironmentKindLabel } from "@/lib/enum-labels"
import { SCAN_SINGULAR, TARGET_DETAILS_LABEL, TARGET_SINGULAR } from "@/lib/terminology"
import {
  ONBOARDING_ENVIRONMENT,
  stepModelForPath,
  type OnboardingPath,
} from "./onboarding-flow.utils"
import { detailsCopy } from "./onboarding-step-copy"
import { eligibilitySection, reviewPickerSection } from "./onboarding-details-sections"
import { TargetNameSection } from "./onboarding-target-name-section"
import { UrlTargetView } from "./onboarding-url-target-view"
export { UrlTargetView } from "./onboarding-url-target-view"

export interface Repo {
  id: number
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
  installationId: string
}

/** Bounded "how are you building?" options — context only, never gates flow. */
const BUILD_TOOLS = [
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["claude_code", "Claude Code"],
  ["lovable", "Lovable"],
  ["copilot", "Copilot"],
  ["other", "Other"],
] as const

type StepDef = ReturnType<typeof stepModelForPath>[number]

export type OnboardingEligibilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "error" }
  | {
      status: "ready"
      eligibility: {
        allowed: boolean
        code: string | null
        message: string | null
        plan: string
        isTrial: boolean
        remainingMinutes: number
      }
    }

export function StepProgress({
  steps,
  displayStep,
}: {
  steps: readonly StepDef[]
  displayStep: number
}) {
  return (
    <>
      <ol
        className={`mb-2 grid border-y ${steps.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}
        aria-label="Getting started progress"
      >
        {steps.map((entry, index) => {
          const label = entry.label
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
    </>
  )
}

export function OnboardingAlerts({
  failure,
  error,
  loading,
  onRetryFailure,
}: {
  failure: {
    presentation: OperationFailurePresentation
    retry: (() => void) | null
  } | null
  error: string | null
  loading: boolean
  onRetryFailure: (retry: () => void) => void
}) {
  const alertRef = useRef<HTMLDivElement | null>(null)
  const failureKey = failure
    ? `${failure.presentation.cause}|${failure.presentation.recovery}`
    : null
  // The alert renders above a step that stacks the review card, the checks
  // list, the eligibility panel and the warning. On a phone the button the user
  // pressed is off-screen when the alert appears, so the spinner stops and
  // nothing else happens. Move focus and scroll the alert into view, exactly as
  // the scan sheet does for its footer error (scan-submission-feedback).
  useEffect(() => {
    if (!failureKey && !error) return
    const element = alertRef.current
    if (!element) return
    element.focus({ preventScroll: true })
    element.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [failureKey, error])

  return (
    <>
      {failure && (
        <div
          ref={alertRef}
          tabIndex={-1}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="border-destructive bg-destructive/10 mb-4 space-y-2 border-l-2 p-4 text-sm focus:outline-none"
        >
          <p className="font-medium">{failure.presentation.cause}</p>
          <p className="text-muted-foreground">{failure.presentation.effect}</p>
          <p>{failure.presentation.recovery}</p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {failure.retry && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => onRetryFailure(failure.retry!)}
              >
                {failure.presentation.retryLabel ?? "Try again"}
              </Button>
            )}
            {failure.presentation.recoveryHref && (
              <Link
                href={failure.presentation.recoveryHref}
                className="text-primary text-xs font-medium underline underline-offset-4"
              >
                Open the recovery page
              </Link>
            )}
            <a
              href="mailto:support@lyrashieldai.com"
              className="text-muted-foreground text-xs underline underline-offset-4"
            >
              Contact support
            </a>
          </div>
        </div>
      )}
      {error && !failure && (
        <p
          ref={alertRef}
          tabIndex={-1}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="border-destructive bg-destructive/10 mb-4 border-l-2 p-3 text-sm focus:outline-none"
        >
          {error}
        </p>
      )}
    </>
  )
}

export function PathChooserView({
  eyebrow,
  buildTool,
  onBuildTool,
  loading,
  githubUnavailable,
  onChoosePath,
}: {
  eyebrow: string
  buildTool: string | null
  onBuildTool: (tool: string | null) => void
  loading: boolean
  githubUnavailable: boolean
  onChoosePath: (path: Exclude<OnboardingPath, null>) => void
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">Add your first target</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Choose what LyraShield reviews first. You can connect GitHub or point at a live app or API
          or set this up later.
        </p>
      </div>

      {/* Optional context — which agent built the app. Never blocks a
          path choice; persists best-effort only. */}
      <fieldset className="space-y-2">
        <legend className="text-muted-foreground text-xs">
          How are you building? <span className="italic">(optional)</span>
        </legend>
        <div className="flex flex-wrap gap-2">
          {BUILD_TOOLS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={buildTool === value}
              onClick={() => onBuildTool(buildTool === value ? null : value)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                buildTool === value
                  ? "border-primary bg-primary/10 text-primary"
                  : "hover:bg-accent text-muted-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChoosePath("github")}
          disabled={loading || githubUnavailable}
          className="hover:bg-accent rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          <GithubIcon className="mb-2 size-6" aria-hidden="true" />
          <span className="block text-sm font-medium">Connect GitHub</span>
          <span className="text-muted-foreground mt-1 block text-xs">
            {githubUnavailable
              ? "Unavailable right now — pick another option."
              : "Scan a repository. Connect an authorized repository. Scans inspect code; fixes and pull requests are separate actions."}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onChoosePath("url")}
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
          onClick={() => onChoosePath("api")}
          disabled={loading}
          className="hover:bg-accent rounded-lg border p-4 text-left transition-colors disabled:opacity-60"
        >
          <Braces className="text-primary mb-2 size-6" aria-hidden="true" />
          <span className="block text-sm font-medium">Add an API</span>
          <span className="text-muted-foreground mt-1 block text-xs">
            Scan an API&apos;s public surface — no repo access needed.
          </span>
        </button>
      </div>
    </div>
  )
}

export function RepoSelectView({
  eyebrow,
  repos,
  reposLoaded,
  selectedRepoId,
  onSelectRepo,
  loading,
  loadFailed,
  onLoadRepos,
  onReconnect,
  onBack,
  onContinue,
}: {
  eyebrow: string
  repos: Repo[]
  reposLoaded: boolean
  selectedRepoId: number | null
  onSelectRepo: (repo: Repo) => void
  loading: boolean
  loadFailed: boolean
  onLoadRepos: () => void
  onReconnect: () => void
  onBack: () => void
  onContinue: () => void
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">Select a repository</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Choose the repository you want to review first.
        </p>
      </div>

      {repos.length === 0 && (
        <div className="space-y-3">
          <p className="text-sm">
            {loadFailed
              ? "We couldn't load repositories. You may need to reconnect GitHub or check the installation."
              : reposLoaded
                ? "No repositories are available. Check which repositories your GitHub installation can access, then load them again."
                : "After you finish the GitHub install, click below to load repositories."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={onLoadRepos} disabled={loading}>
              {loading ? <Spinner /> : <RefreshCwIcon />}
              Load repositories
            </Button>
            <Button type="button" variant="outline" onClick={onReconnect} disabled={loading}>
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
              onClick={() => onSelectRepo(repo)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                selectedRepoId === repo.id ? "bg-primary/8 text-primary" : "hover:bg-accent"
              }`}
            >
              <span className="truncate font-medium">{repo.fullName}</span>
              {repo.private && <Badge variant="muted">Private</Badge>}
              {selectedRepoId === repo.id && <Check className="size-4" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}

      <div className="flex justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack} disabled={loading}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        <Button type="button" onClick={onContinue} disabled={loading || selectedRepoId === null}>
          <ChevronRight className="size-4" /> Continue
        </Button>
      </div>
    </div>
  )
}

export function TargetDetailsView({
  eyebrow,
  path,
  productName,
  onProductNameChange,
  retryingExistingTarget,
  hasFailedScanAttempt,
  reviewOptions,
  selectedReview,
  eligibility,
  targetId,
  onSelectGoal,
  loading,
  onBack,
  onStart,
  onStartTrial,
}: {
  eyebrow: string
  path: OnboardingPath
  productName: string
  onProductNameChange: (name: string) => void
  retryingExistingTarget: boolean
  hasFailedScanAttempt: boolean
  reviewOptions: ManualScanOption[]
  selectedReview: ManualScanOption | undefined
  eligibility: OnboardingEligibilityState
  targetId: string | null
  onSelectGoal: (goal: string) => void
  loading: boolean
  onBack: () => void
  onStart: (skipEligibilityCheck?: boolean) => void
  onStartTrial: () => void
}) {
  const description = detailsCopy(path, productName, retryingExistingTarget, hasFailedScanAttempt)

  return (
    <div className="space-y-5">
      <div>
        <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">{TARGET_DETAILS_LABEL}</h2>
        <p className="text-muted-foreground mt-2 text-sm">{description}</p>
      </div>

      <TargetNameSection
        path={path}
        productName={productName}
        retryingExistingTarget={retryingExistingTarget}
        onProductNameChange={onProductNameChange}
      />

      {reviewPickerSection({
        path,
        reviewOptions,
        selectedReview,
        loading,
        onSelectGoal,
      })}

      {eligibilitySection({ targetId, eligibility })}

      <p className="border-warning bg-warning/10 border-l-2 p-3 text-sm">
        This {TARGET_SINGULAR.toLowerCase()} is saved as a{" "}
        <span className="font-medium">{getEnvironmentKindLabel(ONBOARDING_ENVIRONMENT)}</span>{" "}
        target. Change its environment in target settings after setup if it is something else.
      </p>

      <p className="text-muted-foreground text-xs">
        A {SCAN_SINGULAR.toLowerCase()} reports evidence and limitations. A clean result is not a
        universal security guarantee.
      </p>

      <div className="flex justify-between gap-3">
        {/* GitHub path backs into repo-select (step 2); URL/API back into
            the URL form (step 1, path kept). */}
        <Button type="button" variant="ghost" onClick={onBack} disabled={loading}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        <Button
          type="button"
          onClick={() =>
            eligibility.status === "error"
              ? onStart(true)
              : eligibility.status === "ready" &&
                  !eligibility.eligibility.allowed &&
                  eligibility.eligibility.code === "TRIAL_AVAILABLE"
                ? onStartTrial()
                : onStart()
          }
          disabled={loading || eligibility.status === "checking"}
        >
          <ShieldCheck className="size-4" aria-hidden="true" />
          {/* One action, named from the first render: the click checks
              eligibility and starts the scan when the server allows it. The
              previous "Check availability" / "Check eligibility again" labels
              described the internal step and asked for a second click. */}
          {loading
            ? eligibility.status === "checking"
              ? "Checking eligibility…"
              : "Starting…"
            : eligibility.status === "error"
              ? `Continue to start ${selectedReview?.label.toLowerCase() ?? "review"}`
              : eligibility.status === "ready" &&
                  !eligibility.eligibility.allowed &&
                  eligibility.eligibility.code === "TRIAL_AVAILABLE"
                ? "Start your free trial"
                : `Start ${selectedReview?.label.toLowerCase() ?? "review"}`}
        </Button>
      </div>
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

/**
 * The wizard's step surface: swaps the four step views inside the bordered
 * section and keeps the always-present "skip / finish later" escape. All
 * handlers come from the wizard — this component holds no state.
 */
export function OnboardingStepSection({
  step,
  path,
  eyebrow,
  busy,
  loading,
  buildTool,
  onBuildTool,
  githubUnavailable,
  onChoosePath,
  urlForm,
  productName,
  onProductNameChange,
  onUrlChange,
  onOwnershipChange,
  onUrlBack,
  onUrlSubmit,
  repos,
  reposLoaded,
  selectedRepoId,
  onSelectRepo,
  reposLoadFailed,
  onLoadRepos,
  onReconnect,
  onRepoBack,
  onRepoContinue,
  retryingExistingTarget,
  hasFailedScanAttempt,
  reviewOptions,
  selectedReview,
  eligibility,
  targetId,
  onSelectGoal,
  onDetailsBack,
  onStart,
  onStartTrial,
  onSkip,
}: {
  step: number
  path: OnboardingPath
  eyebrow: string
  busy: boolean
  loading: boolean
  buildTool: string | null
  onBuildTool: (tool: string | null) => void
  githubUnavailable: boolean
  onChoosePath: (next: Exclude<OnboardingPath, null>) => void
  urlForm: { url: string; ownershipAttested: boolean }
  productName: string
  onProductNameChange: (name: string) => void
  onUrlChange: (url: string) => void
  onOwnershipChange: (attested: boolean) => void
  onUrlBack: () => void
  onUrlSubmit: () => void
  repos: Repo[]
  reposLoaded: boolean
  selectedRepoId: number | null
  onSelectRepo: (repo: Repo | null) => void
  reposLoadFailed: boolean
  onLoadRepos: () => void
  onReconnect: () => void
  onRepoBack: () => void
  onRepoContinue: () => void
  retryingExistingTarget: boolean
  hasFailedScanAttempt: boolean
  reviewOptions: ManualScanOption[]
  selectedReview: ManualScanOption | undefined
  eligibility: OnboardingEligibilityState
  targetId: string | null
  onSelectGoal: (goal: string) => void
  onDetailsBack: () => void
  onStart: (skipEligibilityCheck?: boolean) => void
  onStartTrial: () => void
  onSkip: () => void
}) {
  return (
    <section className="rounded-xl border p-5 sm:p-7" aria-live="polite">
      {step === 1 && path !== "url" && path !== "api" && (
        <PathChooserView
          eyebrow={eyebrow}
          buildTool={buildTool}
          onBuildTool={onBuildTool}
          loading={busy}
          githubUnavailable={githubUnavailable}
          onChoosePath={onChoosePath}
        />
      )}

      {step === 1 && (path === "url" || path === "api") && (
        <UrlTargetView
          eyebrow={eyebrow}
          path={path}
          productName={productName}
          onProductNameChange={onProductNameChange}
          url={urlForm.url}
          ownershipAttested={urlForm.ownershipAttested}
          onUrlChange={onUrlChange}
          onOwnershipChange={onOwnershipChange}
          loading={loading}
          onBack={onUrlBack}
          onSubmit={onUrlSubmit}
        />
      )}

      {step === 2 && (
        <RepoSelectView
          eyebrow={eyebrow}
          repos={repos}
          reposLoaded={reposLoaded}
          selectedRepoId={selectedRepoId}
          onSelectRepo={onSelectRepo}
          loading={loading}
          loadFailed={reposLoadFailed}
          onLoadRepos={onLoadRepos}
          onReconnect={onReconnect}
          onBack={onRepoBack}
          onContinue={onRepoContinue}
        />
      )}

      {step === 3 && (
        <TargetDetailsView
          eyebrow={eyebrow}
          path={path}
          productName={productName}
          onProductNameChange={onProductNameChange}
          retryingExistingTarget={retryingExistingTarget}
          hasFailedScanAttempt={hasFailedScanAttempt}
          reviewOptions={reviewOptions}
          selectedReview={selectedReview}
          eligibility={eligibility}
          targetId={targetId}
          onSelectGoal={onSelectGoal}
          loading={busy}
          onBack={onDetailsBack}
          onStart={onStart}
          onStartTrial={onStartTrial}
        />
      )}

      <div className="mt-6 flex justify-center border-t pt-4">
        <Button type="button" variant="ghost" size="sm" onClick={onSkip} disabled={loading}>
          Skip / finish later
        </Button>
      </div>
    </section>
  )
}
