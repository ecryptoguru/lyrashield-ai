"use client"

import Link from "next/link"
import type { Dispatch, SetStateAction } from "react"
import { AlertCircle, Check, ChevronDown, ChevronRight, Clock, Play } from "lucide-react"
import { Badge, Button, cn, FormField, Input, Select, Spinner } from "@lyrashield/ui"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { formatEstimate } from "@/lib/estimator"
import { getScanModeLabel, getTargetTypeLabel } from "@/lib/enum-labels"
import type { ManualScanOption } from "@/lib/scan-presets"
import { RUN_SINGULAR, TARGET_SINGULAR } from "@/lib/terminology"
import { getReviewSetupGuidance, isBillingRecoveryCode } from "./scans-client.utils"
import type { ScanEligibilityState, TargetItem } from "./scan-types"
import type { ScanAttachmentItem } from "@/lib/api-schemas"

function modeBadgeVariant(mode: string): "default" | "success" | "info" | "warning" | "muted" {
  switch (mode) {
    case "SAFE":
      return "success"
    case "STANDARD":
      return "info"
    case "DEEP":
      return "warning"
    default:
      return "default"
  }
}

export function CreateScanSheet({
  open,
  onOpenChange,
  isDesktop,
  errorCode,
  targets,
  selectedTarget,
  handleSelectTarget,
  availableOptions,
  enabledOptions,
  selectedOption,
  choosePreset,
  modeResetNotice,
  selectedFocus,
  setSelectedFocus,
  reviewSetupGuidance,
  eligibility,
  setEligibilityAttempt,
  canManageBilling,
  startingTrial,
  handleStartTrial,
  startDisabled,
  creating,
  handleCreateScan,
  showAdvanced,
  setShowAdvanced,
  baseRef,
  setBaseRef,
  headRef,
  setHeadRef,
  attachments,
  selectedAttachments,
  toggleAttachment,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  isDesktop: boolean
  errorCode: string | null
  targets: TargetItem[]
  selectedTarget: string
  handleSelectTarget: (targetId: string) => void
  availableOptions: ManualScanOption[]
  enabledOptions: ManualScanOption[]
  selectedOption: ManualScanOption | undefined
  choosePreset: (id: string) => void
  modeResetNotice: string | null
  selectedFocus: string | null
  setSelectedFocus: Dispatch<SetStateAction<string | null>>
  reviewSetupGuidance: ReturnType<typeof getReviewSetupGuidance>
  eligibility: ScanEligibilityState
  setEligibilityAttempt: Dispatch<SetStateAction<number>>
  canManageBilling: boolean
  startingTrial: boolean
  handleStartTrial: () => Promise<void>
  startDisabled: boolean
  creating: boolean
  handleCreateScan: () => Promise<void>
  showAdvanced: boolean
  setShowAdvanced: Dispatch<SetStateAction<boolean>>
  baseRef: string
  setBaseRef: Dispatch<SetStateAction<string>>
  headRef: string
  setHeadRef: Dispatch<SetStateAction<string>>
  attachments: ScanAttachmentItem[]
  selectedAttachments: string[]
  toggleAttachment: (id: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isDesktop ? "right" : "bottom"}
        className={cn(
          "flex flex-col gap-0 p-0",
          isDesktop
            ? "w-full max-w-xl sm:max-w-xl"
            : "h-[92vh] max-h-[92vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
        )}
      >
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle>Start a {RUN_SINGULAR.toLowerCase()}</SheetTitle>
          <SheetDescription>
            Choose a {TARGET_SINGULAR.toLowerCase()} and how thorough the review should be. Starting
            a {RUN_SINGULAR.toLowerCase()} begins durable server-side work that may use the
            sponsoring account&apos;s agent-minute allowance.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-5">
            {errorCode === "DOMAIN_VERIFICATION_REQUIRED" && selectedTarget && (
              <div role="alert" className="border-destructive/40 rounded-lg border p-3 text-sm">
                <p>Domain verification is required before this review can start.</p>
                <Link
                  href={`/dashboard/targets/${encodeURIComponent(selectedTarget)}#domain-verification`}
                  className="text-primary inline-flex min-h-11 items-center font-medium hover:underline"
                >
                  Verify control of this domain
                </Link>
              </div>
            )}
            <FormField label={TARGET_SINGULAR} htmlFor="scan-target">
              <Select
                id="scan-target"
                value={selectedTarget}
                onChange={(e) => handleSelectTarget(e.target.value)}
              >
                <option value="">Select a {TARGET_SINGULAR.toLowerCase()}…</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({getTargetTypeLabel(t.type)})
                  </option>
                ))}
              </Select>
            </FormField>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="block text-sm font-medium">Review type</p>
                <span className="text-muted-foreground text-xs">Simple options: pick one</span>
              </div>

              <div role="radiogroup" aria-label="Scan type" className="grid grid-cols-1 gap-3">
                {availableOptions.map((option) => {
                  const isSelected = selectedOption?.id === option.id
                  const isDisabled = !option.available
                  return (
                    <button
                      key={option.id}
                      id={`preset-${option.id}`}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      aria-disabled={isDisabled}
                      aria-label={`${option.label}: ${option.description}${isDisabled ? ` (${option.disabledReason})` : ""}`}
                      tabIndex={isSelected ? 0 : -1}
                      disabled={isDisabled}
                      onClick={() => !isDisabled && choosePreset(option.id)}
                      onKeyDown={(e) => {
                        if (isDisabled) return
                        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                          e.preventDefault()
                          const idx = enabledOptions.findIndex((o) => o.id === option.id)
                          const next = enabledOptions[(idx + 1) % enabledOptions.length]
                          if (next) {
                            choosePreset(next.id)
                            document.getElementById(`preset-${next.id}`)?.focus()
                          }
                        }
                        if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                          e.preventDefault()
                          const idx = enabledOptions.findIndex((o) => o.id === option.id)
                          const prev =
                            enabledOptions[
                              (idx - 1 + enabledOptions.length) % enabledOptions.length
                            ]
                          if (prev) {
                            choosePreset(prev.id)
                            document.getElementById(`preset-${prev.id}`)?.focus()
                          }
                        }
                      }}
                      className={cn(
                        "group focus-visible:ring-ring relative flex min-h-23 w-full flex-col items-start rounded-lg border p-4 text-left shadow-xs transition-[border-color,box-shadow,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                        isDisabled
                          ? "opacity-60 cursor-not-allowed bg-muted/40 border-dashed"
                          : isSelected
                            ? "border-primary bg-primary/6 dark:bg-primary/12 ring-primary/20 shadow-sm ring-1"
                            : "border-border bg-card hover:border-border/80 hover:bg-accent/50"
                      )}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-sm font-semibold tracking-tight">{option.label}</span>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={modeBadgeVariant(option.mode)}
                            className="px-2 py-0 text-xs font-semibold tracking-wide uppercase"
                          >
                            {getScanModeLabel(option.mode)}
                          </Badge>
                          {isSelected ? (
                            <span className="bg-primary text-primary-foreground inline-flex size-5 items-center justify-center rounded-full">
                              <Check className="size-3" aria-hidden="true" />
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className="text-muted-foreground mt-1.5 line-clamp-3 text-xs leading-relaxed">
                        {option.description}
                      </span>
                      {isDisabled && option.disabledReason ? (
                        <span className="mt-2 text-xs text-amber-600">{option.disabledReason}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>

              <p className="text-muted-foreground mt-2 text-xs">
                {selectedOption?.hint}{" "}
                {selectedOption && !selectedOption.usesAi
                  ? "Deterministic surface checks only — no engine review."
                  : "Engine review plus deterministic checks."}
              </p>
              {modeResetNotice && (
                <p className="text-amber-600 mt-2 text-xs" role="status" aria-live="polite">
                  {modeResetNotice}
                </p>
              )}
              {selectedOption?.usesAi && (
                <div className="mt-3" role="group" aria-label="Optional emphasis">
                  <p className="text-muted-foreground mb-1.5 text-xs">
                    Optional emphasis — steers engine attention, never reduces coverage.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ["auth", "Auth & sessions"],
                        ["payments", "Payments"],
                        ["llm_surface", "LLM surface"],
                        ["file_handling", "File handling"],
                        ["data_exposure", "Data exposure"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={selectedFocus === value}
                        onClick={() => setSelectedFocus((prev) => (prev === value ? null : value))}
                        className={cn(
                          "focus-visible:ring-ring min-h-9 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none",
                          selectedFocus === value
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-accent/50"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {selectedOption?.requiresRevisionInputs && (
                <div
                  className="mt-3 space-y-3 rounded-lg border p-3"
                  role="group"
                  aria-label="Revisions to compare"
                >
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Compare an exact change set. The base ref is required; the head defaults to the
                    target&apos;s branch. Both resolve to immutable commits before the review
                    starts.
                  </p>
                  <FormField label="Base revision (required)" htmlFor="scan-base-ref">
                    <Input
                      id="scan-base-ref"
                      value={baseRef}
                      onChange={(e) => setBaseRef(e.target.value)}
                      placeholder="main or a commit SHA"
                      autoComplete="off"
                      required
                    />
                  </FormField>
                  <FormField label="Head revision (optional)" htmlFor="scan-head-ref">
                    <Input
                      id="scan-head-ref"
                      value={headRef}
                      onChange={(e) => setHeadRef(e.target.value)}
                      placeholder="Defaults to the target branch"
                      autoComplete="off"
                    />
                  </FormField>
                </div>
              )}
              {attachments.length > 0 && (
                <fieldset className="mt-3 rounded-lg border p-3">
                  <legend className="px-1 text-xs font-medium">Supporting files (optional)</legend>
                  <p className="text-muted-foreground mb-2 text-xs leading-relaxed">
                    Selected files are recorded on the {RUN_SINGULAR.toLowerCase()}&apos;s immutable
                    plan, verified against their stored checksums and staged read-only. They are
                    review inputs only — they can never change scope, checks, limits or
                    authorization.
                  </p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto">
                    {attachments.slice(0, 20).map((attachment) => (
                      <li key={attachment.id}>
                        <label className="hover:bg-accent/50 flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm">
                          <input
                            type="checkbox"
                            className="border-border size-4 shrink-0 rounded"
                            checked={selectedAttachments.includes(attachment.id)}
                            onChange={() => toggleAttachment(attachment.id)}
                          />
                          <span className="truncate">{attachment.filename}</span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {Math.max(1, Math.ceil(attachment.byteLength / 1024))} KB
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {selectedAttachments.length > 0 && (
                    <p className="text-muted-foreground mt-2 text-xs" role="status">
                      {selectedAttachments.length} selected — recorded as immutable inputs.
                    </p>
                  )}
                </fieldset>
              )}
              {reviewSetupGuidance && (
                <div
                  className="border-primary/20 bg-primary/5 mt-3 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                  role="status"
                  aria-live="polite"
                >
                  <p className="text-sm leading-relaxed">{reviewSetupGuidance.message}</p>
                  <Link
                    href={reviewSetupGuidance.href}
                    className="text-primary hover:text-primary/80 focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-1 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
                  >
                    {reviewSetupGuidance.actionLabel}
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Link>
                </div>
              )}
            </div>

            {/* Time and eligibility — always bounded, never silently permissive. */}
            <div aria-live="polite">
              <p className="mb-2 block text-sm font-medium">Time and eligibility</p>
              {!selectedTarget || !selectedOption ? (
                <p className="text-muted-foreground rounded-lg border p-3 text-sm">
                  Select a target and review type to see the estimate and your remaining agent
                  minutes.
                </p>
              ) : eligibility.status === "checking" ? (
                <div className="space-y-2 rounded-lg border p-3" aria-busy="true">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-56" />
                </div>
              ) : eligibility.status === "error" ? (
                <div className="border-amber-500/50 bg-amber-500/10 rounded-lg border p-3 text-sm">
                  <p className="flex items-center gap-2">
                    <AlertCircle className="text-amber-600 size-4 shrink-0" aria-hidden="true" />
                    Eligibility could not be checked. Start stays disabled until it loads.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => setEligibilityAttempt((attempt) => attempt + 1)}
                  >
                    Retry check
                  </Button>
                </div>
              ) : eligibility.status === "ready" && eligibility.eligibility.allowed ? (
                <div className="rounded-lg border p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Clock className="text-muted-foreground size-4" aria-hidden="true" />
                      Est. time: {formatEstimate(selectedOption.estimate)}
                    </span>
                    <span className="text-muted-foreground">
                      Remaining agent minutes:{" "}
                      <span className="text-foreground font-medium">
                        {eligibility.eligibility.remainingMinutes}
                      </span>
                      {eligibility.eligibility.isTrial ? " (trial)" : ""}
                    </span>
                  </p>
                </div>
              ) : eligibility.status === "ready" ? (
                <div
                  className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm"
                  role="alert"
                >
                  <p className="font-medium">This review cannot start yet</p>
                  <p className="text-muted-foreground mt-1">
                    {eligibility.eligibility.message ?? "Not allowed for this workspace."}
                  </p>
                  {eligibility.eligibility.code === "TRIAL_AVAILABLE" &&
                    (canManageBilling ? (
                      <Button
                        type="button"
                        size="sm"
                        className="mt-2"
                        disabled={startingTrial}
                        onClick={handleStartTrial}
                      >
                        {startingTrial ? "Starting trial…" : "Start free trial"}
                      </Button>
                    ) : (
                      <p className="text-muted-foreground mt-2">
                        Ask a workspace owner to start the trial.
                      </p>
                    ))}
                  {isBillingRecoveryCode(eligibility.eligibility.code) && (
                    <p className="mt-2">
                      {canManageBilling ? (
                        <Link
                          href="/dashboard/billing"
                          className="text-primary inline-flex min-h-11 items-center gap-1 font-medium hover:underline"
                        >
                          Review billing options
                          <ChevronRight className="size-4" aria-hidden="true" />
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">
                          Ask a workspace owner to review billing options.
                        </span>
                      )}
                    </p>
                  )}
                  {eligibility.eligibility.code === "DOMAIN_VERIFICATION_REQUIRED" &&
                    selectedTarget && (
                      <Link
                        href={`/dashboard/targets/${encodeURIComponent(selectedTarget)}#domain-verification`}
                        className="text-primary mt-2 inline-flex min-h-11 items-center font-medium hover:underline"
                      >
                        Verify control of this domain
                      </Link>
                    )}
                </div>
              ) : null}
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                aria-expanded={showAdvanced}
                aria-controls="scan-advanced-panel"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
              >
                <ChevronDown
                  className={cn(
                    "size-4 transition-transform duration-(--duration-fast) ease-out",
                    showAdvanced ? "rotate-180" : ""
                  )}
                  aria-hidden="true"
                />
                What this covers
              </button>

              {showAdvanced && selectedOption && (
                <div
                  id="scan-advanced-panel"
                  className="bg-muted/40 border-border mt-2 rounded-lg border p-4"
                >
                  <dl className="space-y-3 text-xs leading-relaxed">
                    <div>
                      <dt className="text-sm font-medium">What this review covers</dt>
                      <dd className="text-muted-foreground mt-1">{selectedOption.hint}</dd>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground font-medium">Workflow</dt>
                        <dd>
                          {selectedOption.workflow === "REVIEW_CHANGES"
                            ? "Scan changes"
                            : "Scan target"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground font-medium">Depth</dt>
                        <dd>{getScanModeLabel(selectedOption.mode)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground font-medium">Effective scope</dt>
                        <dd>{selectedOption.scopeSummary}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground font-medium">Limits</dt>
                        <dd>{selectedOption.limitsSummary}</dd>
                      </div>
                    </div>
                    <div>
                      <dt className="text-muted-foreground font-medium">Applicable checks</dt>
                      <dd>
                        <ul className="text-muted-foreground mt-1 list-inside list-disc">
                          {selectedOption.applicableChecks.map((check) => (
                            <li key={check}>{check}</li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                    {selectedOption.authorizationHint ? (
                      <div>
                        <dt className="text-muted-foreground font-medium">
                          Authorization required
                        </dt>
                        <dd className="text-muted-foreground">
                          {selectedOption.authorizationHint}
                        </dd>
                      </div>
                    ) : null}
                    <dd className="text-muted-foreground">
                      The completed scan records the applicable evidence and any limitations so you
                      can decide what to fix or retest next.
                    </dd>
                  </dl>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 border-t px-6 py-4">
          <Button onClick={handleCreateScan} disabled={startDisabled} className="min-h-11 flex-1">
            {creating ? (
              <>
                <Spinner className="mr-2 h-4 w-4" />
                Starting…
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                Start {RUN_SINGULAR}
              </>
            )}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="min-h-11">
            Cancel
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
