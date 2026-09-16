"use client"

import Link from "next/link"
import { Check, ChevronLeft, ChevronRight, Globe, ShieldCheck } from "lucide-react"
import { Button, FormField, Input, Spinner, Badge, GithubIcon } from "@lyrashield/ui"
import type { OperationFailurePresentation } from "@/lib/operation-failure"
import type { ManualScanOption } from "@/lib/scan-presets"
import {
  RUN_SINGULAR,
  TARGET_DETAILS_LABEL,
  TARGET_NAME_LABEL,
  TARGET_SINGULAR,
} from "@/lib/terminology"
import {
  pathLabel,
  pathNeedsRepo,
  stepModelForPath,
  type OnboardingPath,
} from "./onboarding-flow.utils"

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
  return (
    <>
      {failure && (
        <div
          role="alert"
          className="border-destructive bg-destructive/10 mb-4 space-y-2 border-l-2 p-4 text-sm"
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
                Try again
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
          role="alert"
          className="border-destructive bg-destructive/10 mb-4 border-l-2 p-3 text-sm"
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
          Choose what LyraShield reviews first. You can connect GitHub, point at a live app or API,
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
              : "Review a repository. Connect an authorized repository. Scans inspect code; fixes and pull requests are separate actions."}
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
          <Globe className="text-primary mb-2 size-6" aria-hidden="true" />
          <span className="block text-sm font-medium">Add an API</span>
          <span className="text-muted-foreground mt-1 block text-xs">
            Scan an API&apos;s public surface — no repo access needed.
          </span>
        </button>
      </div>
    </div>
  )
}

export function UrlTargetView({
  eyebrow,
  path,
  productName,
  onProductNameChange,
  url,
  ownershipAttested,
  onUrlChange,
  onOwnershipChange,
  loading,
  onBack,
  onSubmit,
}: {
  eyebrow: string
  path: "url" | "api"
  productName: string
  onProductNameChange: (name: string) => void
  url: string
  ownershipAttested: boolean
  onUrlChange: (url: string) => void
  onOwnershipChange: (attested: boolean) => void
  loading: boolean
  onBack: () => void
  onSubmit: () => void
}) {
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <div>
        {/* Same step model as the progress list — the eyebrow and the
            highlighted item always describe the same step (v16 3.1). */}
        <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">
          {path === "api" ? "Add your API" : "Add your app URL"}
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          {path === "api"
            ? "Point LyraShield at the API's base URL. Scans run over HTTP against the public surface."
            : "Point LyraShield at the app's URL. Scans run over HTTP against the public surface."}{" "}
          You can connect GitHub later from Connections.
        </p>
      </div>

      {/* The name asked here is the name saved: the details step shows it
          read-only instead of asking again (v16 3.1). */}
      <FormField label={TARGET_NAME_LABEL} htmlFor="url-name">
        <Input
          id="url-name"
          type="text"
          value={productName}
          onChange={(e) => onProductNameChange(e.target.value)}
          maxLength={100}
          autoFocus
          placeholder={path === "api" ? "Production API" : "Staging Site"}
        />
      </FormField>

      <FormField label="URL" htmlFor="url-input">
        <Input
          id="url-input"
          type="url"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={path === "api" ? "https://api.example.com" : "https://staging.example.com"}
        />
      </FormField>

      <div className="flex items-start gap-2">
        <input
          id="ownership-check"
          type="checkbox"
          name="ownershipAttested"
          checked={ownershipAttested}
          onChange={(e) => onOwnershipChange(e.target.checked)}
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
        <Button type="button" variant="ghost" onClick={onBack} disabled={loading}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        <Button type="submit" disabled={loading || !ownershipAttested}>
          {loading ? (
            <Spinner className="mr-2" />
          ) : (
            <ChevronRight className="size-4" aria-hidden="true" />
          )}
          Continue
        </Button>
      </div>
    </form>
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
  reviewOptions,
  selectedReview,
  onSelectGoal,
  loading,
  onBack,
  onStart,
}: {
  eyebrow: string
  path: OnboardingPath
  productName: string
  onProductNameChange: (name: string) => void
  retryingExistingTarget: boolean
  reviewOptions: ManualScanOption[]
  selectedReview: ManualScanOption | undefined
  onSelectGoal: (goal: string) => void
  loading: boolean
  onBack: () => void
  onStart: () => void
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">{TARGET_DETAILS_LABEL}</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          {retryingExistingTarget
            ? `Retry the review for ${productName || `this ${TARGET_SINGULAR.toLowerCase()}`}. The target stays locked so the retry cannot create or scan a different target.`
            : pathNeedsRepo(path)
              ? `Name your ${TARGET_SINGULAR.toLowerCase()}. You can classify its environment later in target settings.`
              : `Reviewing your ${pathLabel(path)}. Confirm the details and choose what you need from this ${RUN_SINGULAR.toLowerCase()}.`}
        </p>
      </div>

      {retryingExistingTarget ? (
        <div className="bg-muted/40 rounded-lg border p-4">
          <p className="text-sm font-medium">{productName || `Existing ${TARGET_SINGULAR}`}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Existing {pathLabel(path)} · target details are locked for this retry
          </p>
        </div>
      ) : pathNeedsRepo(path) ? (
        // GitHub flow: the name is chosen here (v16 3.1 — asked once).
        <FormField label={TARGET_NAME_LABEL} htmlFor="product-name">
          <Input
            id="product-name"
            value={productName}
            onChange={(e) => onProductNameChange(e.target.value)}
            placeholder="My web app"
          />
        </FormField>
      ) : (
        // URL/API flow: the name was asked on the previous screen and is
        // the name saved — shown here for confirmation only.
        <div className="bg-muted/40 rounded-lg border p-4">
          <p className="text-muted-foreground text-xs font-medium">{TARGET_NAME_LABEL}</p>
          <p className="mt-1 text-sm font-medium">{productName || "Unnamed target"}</p>
        </div>
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
              Depth: {selectedReview.mode.toLowerCase()} · runs within your workspace plan, budgets,
              and target authorization. A clean result is not a security guarantee.
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
                onClick={() => onSelectGoal(option.goal)}
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
                  ~{option.estimate.low}-{option.estimate.high} min · {option.mode.toLowerCase()}
                </span>
              </button>
            ))}
          </div>
        </details>
        {path === "api" && (
          <p className="text-muted-foreground mt-2 text-xs">
            Add an OpenAPI document after setup to unlock Contract and Contract Behavior reviews.
          </p>
        )}
      </fieldset>

      <p className="border-warning bg-warning/10 border-l-2 p-3 text-sm">
        A {RUN_SINGULAR.toLowerCase()} reports evidence and limitations. A clean result is not a
        universal security guarantee.
      </p>

      <div className="flex justify-between gap-3">
        {/* GitHub path backs into repo-select (step 2); URL/API back into
            the URL form (step 1, path kept). */}
        {retryingExistingTarget ? (
          <span />
        ) : (
          <Button type="button" variant="ghost" onClick={onBack} disabled={loading}>
            <ChevronLeft className="size-4" /> Back
          </Button>
        )}
        <Button type="button" onClick={onStart} disabled={loading}>
          <ShieldCheck className="size-4" />
          {loading ? "Starting…" : `Start ${selectedReview?.label.toLowerCase() ?? "review"}`}
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
