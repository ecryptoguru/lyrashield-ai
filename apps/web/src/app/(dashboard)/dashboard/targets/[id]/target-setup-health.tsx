"use client"

import { useEffect, useRef } from "react"
import Link from "next/link"
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw } from "lucide-react"
import { Badge, Button, Card, Spinner } from "@lyrashield/ui"
import { type SetupHealthSnapshot, type SetupRecoveryAction } from "@lyrashield/types"
import { track } from "@/lib/analytics"
import { useTargetSetupHealth } from "./use-target-setup-health"

interface SetupPresentation {
  label: string
  explanation: string
  code: string
  recoveryAction: SetupRecoveryAction | null
}

export function presentTargetSetupHealth(snapshot: SetupHealthSnapshot): SetupPresentation {
  const primary =
    snapshot.checks.find((check) => check.code === snapshot.primaryCheck) ?? snapshot.checks[0]
  return {
    label:
      snapshot.status === "ready"
        ? "Setup ready"
        : snapshot.status === "unknown"
          ? "Setup status unknown"
          : "Setup blocked",
    explanation:
      primary?.explanation ??
      (snapshot.status === "ready"
        ? "The required setup checks passed."
        : "Setup could not be established."),
    code: primary?.code ?? snapshot.primaryCheck,
    recoveryAction: primary?.recoveryAction ?? null,
  }
}

const RECOVERY_HREF: Partial<Record<SetupRecoveryAction, string>> = {
  SELECT_WORKSPACE: "/dashboard/targets",
  RECONNECT_AGENT: "/dashboard/connections",
  CONNECT_GITHUB: "/dashboard/integrations",
  VERIFY_DOMAIN: "#domain-verification",
  // ADD_API_SPEC has no anchored control on this page; render the action text
  // without linking to a dead fragment.
  REFRESH_ATTACHMENTS: "/dashboard/scans",
  START_TRIAL: "/dashboard/billing",
  REVIEW_BILLING: "/dashboard/billing",
  EDIT_POLICY: "/dashboard/settings/workspace",
  CONTACT_ADMIN: "/dashboard/settings/workspace",
}

export function TargetSetupHealth({
  workspaceId,
  targetId,
  actorId,
  goal,
  mode,
  workflow = "REVIEW_TARGET",
}: {
  workspaceId: string
  targetId: string
  actorId: string
  goal: string
  mode: string
  workflow?: "REVIEW_TARGET" | "REVIEW_CHANGES" | "AUTHENTICATED_ASSESSMENT"
}) {
  const { snapshot, loading, error, retry } = useTargetSetupHealth({
    workspaceId,
    targetId,
    actorId,
    goal,
    mode,
    workflow,
  })
  const trackedBlockers = useRef(new Set<string>())
  const presentation = snapshot ? presentTargetSetupHealth(snapshot) : null
  const href = presentation?.recoveryAction ? RECOVERY_HREF[presentation.recoveryAction] : undefined

  useEffect(() => {
    trackedBlockers.current.clear()
  }, [actorId, workspaceId, targetId])

  useEffect(() => {
    if (!snapshot || snapshot.status === "ready" || !presentation) return
    if (!/^[A-Z][A-Z0-9_]{1,95}$/.test(presentation.code)) return
    const key = `${snapshot.scopeFingerprint}:${presentation.code}`
    if (trackedBlockers.current.has(key)) return
    trackedBlockers.current.add(key)
    track("setup_blocker_viewed", { blocker_code: presentation.code, surface: "target" })
  }, [presentation, snapshot])

  return (
    <Card className="p-5" aria-labelledby="target-setup-heading">
      <div className="flex flex-wrap items-center gap-2">
        {snapshot?.status === "ready" ? (
          <CheckCircle2 className="text-success size-4" aria-hidden="true" />
        ) : snapshot?.status === "blocked" ? (
          <AlertTriangle className="text-warning size-4" aria-hidden="true" />
        ) : (
          <CircleHelp className="text-muted-foreground size-4" aria-hidden="true" />
        )}
        <h2 id="target-setup-heading" className="font-semibold">
          Setup health
        </h2>
        {snapshot && (
          <Badge
            variant={
              snapshot.status === "ready"
                ? "success"
                : snapshot.status === "blocked"
                  ? "warning"
                  : "muted"
            }
          >
            {snapshot.status}
          </Badge>
        )}
      </div>
      <div aria-live="polite" aria-atomic="true">
        {loading ? (
          <p className="text-muted-foreground mt-3 flex items-center gap-2 text-sm">
            <Spinner className="size-4" /> Checking current setup…
          </p>
        ) : error ? (
          <div role="alert" className="mt-3 space-y-3 text-sm">
            <p>{error}</p>
            <p className="text-muted-foreground">
              Starting a review will repeat the authoritative check.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <RefreshCw className="mr-2 size-4" aria-hidden="true" /> Retry
            </Button>
          </div>
        ) : presentation ? (
          <div className="mt-3 space-y-2 text-sm">
            <p className="font-medium">{presentation.label}</p>
            <p className="text-muted-foreground">{presentation.explanation}</p>
            <p className="text-muted-foreground font-mono text-xs break-all">{presentation.code}</p>
            {href && (
              <Link
                href={href}
                className="text-primary min-h-11 inline-flex items-center font-medium hover:underline"
              >
                {presentation.recoveryAction?.replaceAll("_", " ").toLowerCase()}
              </Link>
            )}
            {snapshot?.limitations.length ? (
              <details className="pt-1">
                <summary className="cursor-pointer font-medium">Review limitations</summary>
                <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-5">
                  {snapshot.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}
