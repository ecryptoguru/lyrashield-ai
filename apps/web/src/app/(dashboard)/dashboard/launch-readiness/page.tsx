import type { Metadata } from "next"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { Rocket } from "lucide-react"
import { LaunchReadinessClient } from "./launch-readiness-client"
import {
  describeReleaseCheck,
  parseReleaseReference,
  type ReleaseIdentityInput,
} from "@/lib/launch-readiness"
import { withWorkspaceRLS } from "@lyrashield/db"
import { projectGateReadinessReport } from "@/lib/launch-readiness"
import { getGateReadinessTargets } from "@/lib/launch-readiness-server"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"

export const metadata: Metadata = {
  title: "Launch Readiness",
}

export default async function LaunchReadinessPage({
  searchParams,
}: {
  searchParams: Promise<{
    targetId?: string | string[]
    commit?: string | string[]
    artifactDigest?: string | string[]
  }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader title="Launch Readiness" icon={Rocket} />
        <NoWorkspaceState
          icon={Rocket}
          description="Create a workspace during onboarding to view launch readiness."
        />
      </div>
    )
  }

  // The release check lives in the URL so deep links, refresh, and
  // Back/Forward describe the same check. Repeated or conflicting values are
  // ambiguous and rejected rather than first-wins.
  const params = await searchParams
  const repeated = Object.entries(params).find(
    ([, value]) => Array.isArray(value) && value.length > 1
  )
  const rawTargetId = typeof params.targetId === "string" ? params.targetId.trim() : ""
  const rawCommit = typeof params.commit === "string" ? params.commit.trim() : ""
  const rawDigest = typeof params.artifactDigest === "string" ? params.artifactDigest.trim() : ""
  const commit = rawCommit ? parseReleaseReference(rawCommit) : null
  const digest = rawDigest ? parseReleaseReference(rawDigest) : null
  const requestedIdentity: ReleaseIdentityInput | null =
    commit?.kind === "COMMIT" ? commit : digest?.kind === "ARTIFACT_DIGEST" ? digest : null
  const checkError =
    (repeated ? `${repeated[0]} may only be supplied once` : null) ??
    (rawCommit && rawDigest
      ? "commit and artifactDigest are mutually exclusive"
      : rawCommit && (!commit || commit.kind !== "COMMIT")
        ? "commit must be a full 40-character SHA"
        : rawDigest && (!digest || digest.kind !== "ARTIFACT_DIGEST")
          ? "artifactDigest must be a sha256: digest with 64 hex characters"
          : null)
  const checkRequested = Boolean(rawCommit || rawDigest)

  const allTargets = await getGateReadinessTargets(workspaceId)

  // A release reference without a target auto-selects only when there is
  // exactly one authorized target — otherwise the user must choose rather
  // than have the identity applied across every target.
  const resolvedTargetId =
    rawTargetId || (checkRequested && allTargets.length === 1 ? allTargets[0]!.targetId : "")
  const checkNeedsTarget = checkRequested && !checkError && !resolvedTargetId
  const effectiveTargetId = checkError ? "" : resolvedTargetId
  const identityOptions = checkError
    ? undefined
    : requestedIdentity
      ? requestedIdentity.kind === "COMMIT"
        ? { expectedCommit: requestedIdentity.value }
        : { expectedArtifactDigest: requestedIdentity.value }
      : undefined

  const [groups, targets] = await Promise.all([
    withWorkspaceRLS(workspaceId, (tx) =>
      tx.finding.groupBy({
        by: ["severity", "status", "verified"],
        where: {
          workspaceId,
          deletedAt: null,
          ...(effectiveTargetId ? { targetId: effectiveTargetId } : {}),
        },
        _count: { _all: true },
      })
    ),
    effectiveTargetId || identityOptions
      ? getGateReadinessTargets(workspaceId, effectiveTargetId || undefined, identityOptions)
      : Promise.resolve(allTargets),
  ])

  const releaseCheck =
    !checkError && !checkNeedsTarget && effectiveTargetId
      ? describeReleaseCheck(
          targets.find((target) => target.targetId === effectiveTargetId) ?? null,
          requestedIdentity
        )
      : null

  const initialReport = projectGateReadinessReport(
    groups.map((g) => ({ ...g, count: g._count._all })),
    targets
  )

  return (
    <LaunchReadinessClient
      // The URL owns the check state; remount on navigation so a changed or
      // cleared reference can never leave a previous result on screen.
      key={`${rawTargetId}|${rawCommit}|${rawDigest}`}
      workspaceId={workspaceId}
      initialReport={initialReport}
      targets={allTargets.map((target) => ({
        targetId: target.targetId,
        targetName: target.targetName,
      }))}
      initialTargetId={effectiveTargetId}
      initialReleaseCheck={releaseCheck}
      initialCheckError={checkError}
      checkNeedsTarget={checkNeedsTarget}
    />
  )
}
