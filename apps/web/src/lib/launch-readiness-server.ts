import { getCurrentGateVerdicts, withWorkspaceRLS } from "@lyrashield/db"
import type { GateReadinessTarget } from "./launch-readiness"

export interface ReadinessIdentityOptions {
  expectedCommit?: string
  expectedArtifactDigest?: string
}

/**
 * Uncached gate readiness for every active target. Reads are set-based: one
 * RLS transaction with a statement count constant in the number of targets
 * (Deep Review v16 2.1) — never a per-target verdict fan-out. The result must
 * stay uncached: release decisions are computed on every request.
 */
export async function getGateReadinessTargets(
  workspaceId: string,
  targetId?: string,
  identity: ReadinessIdentityOptions = {}
): Promise<GateReadinessTarget[]> {
  const targets = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.target.findMany({
      where: { workspaceId, deletedAt: null, ...(targetId ? { id: targetId } : {}) },
      select: { id: true, name: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  )
  if (targets.length === 0) return []

  const verdictsByTarget = await getCurrentGateVerdicts(
    workspaceId,
    targets.map((target) => target.id),
    {
      expectedCommit: identity.expectedCommit,
      expectedArtifactDigest: identity.expectedArtifactDigest,
    }
  )

  return targets.map((target) => {
    const result = verdictsByTarget.get(target.id)
    if (!result) {
      return {
        targetId: target.id,
        targetName: target.name,
        state: "INSUFFICIENT_EVIDENCE" as const,
        applicable: false,
        blockingFindings: 0,
        identity: null,
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
    }
    return {
      targetId: target.id,
      targetName: target.name,
      state: result.state,
      applicable: result.applicability.applicable,
      blockingFindings: historical.blockingReasons?.length ?? 0,
      identity: result.applicability.evaluatedIdentity ?? null,
      reasons: result.applicability.reasons,
    }
  })
}
