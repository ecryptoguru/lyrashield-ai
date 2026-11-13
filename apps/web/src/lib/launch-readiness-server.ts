import {
  getCurrentGateVerdicts,
  MAX_GATE_READ_BATCH_TARGETS,
  parseAssessmentSnapshot,
  withWorkspaceRLS,
} from "@lyrashield/db"
import type { GateReadinessTarget } from "./launch-readiness"

interface ReadinessIdentityOptions {
  expectedCommit?: string
  expectedArtifactDigest?: string
}

/**
 * Uncached gate readiness for a bounded page of active targets. Reads are set-based: one
 * RLS transaction with a statement count constant in the page size
 * (Deep Review v16 2.1) — never a per-target verdict fan-out. The result must
 * stay uncached: release decisions are computed on every request.
 */
export async function getGateReadinessTargets(
  workspaceId: string,
  targetId?: string,
  identity: ReadinessIdentityOptions = {},
  cursor?: string
): Promise<GateReadinessTarget[] & { nextCursor: string | null; partial: boolean }> {
  const targets = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.target.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(targetId ? { id: targetId } : cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
      take: targetId ? 1 : MAX_GATE_READ_BATCH_TARGETS + 1,
    })
  )
  const page = targets.slice(0, MAX_GATE_READ_BATCH_TARGETS)
  const nextCursor =
    !targetId && targets.length > MAX_GATE_READ_BATCH_TARGETS ? page.at(-1)!.id : null
  const partial = !targetId && Boolean(cursor || nextCursor)
  if (page.length === 0) return Object.assign([], { nextCursor, partial })

  const verdictsByTarget = await getCurrentGateVerdicts(
    workspaceId,
    page.map((target) => target.id),
    {
      expectedCommit: identity.expectedCommit,
      expectedArtifactDigest: identity.expectedArtifactDigest,
    }
  )

  const projected: GateReadinessTarget[] = page.map((target) => {
    const result = verdictsByTarget.get(target.id)
    if (!result) {
      return {
        targetId: target.id,
        targetName: target.name,
        state: "INSUFFICIENT_EVIDENCE" as const,
        historicalState: null,
        applicable: false,
        blockingFindings: 0,
        identity: null,
        assessedIdentity: null,
        reasons: [
          {
            code: "NO_GATE_VERDICT",
            message: "No Gate v2 assessment exists for this target.",
          },
        ],
      }
    }

    const historical = result.historical as unknown as {
      blockingReasons?: unknown[]
      state?: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
      assessmentSnapshot?: unknown
    }
    // The assessed identity is read from the verdict's own snapshot — never
    // from evaluatedIdentity, which echoes the caller's requested identity on
    // mismatch and cannot answer "which release was assessed".
    const assessedIdentity =
      parseAssessmentSnapshot(historical.assessmentSnapshot)?.identity ?? null
    return {
      targetId: target.id,
      targetName: target.name,
      state: result.state,
      historicalState: historical.state ?? null,
      applicable: result.applicability.applicable,
      blockingFindings: historical.blockingReasons?.length ?? 0,
      identity: result.applicability.evaluatedIdentity ?? null,
      assessedIdentity,
      reasons: result.applicability.reasons,
    }
  })
  return Object.assign(projected, { nextCursor, partial })
}
