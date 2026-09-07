import { getCurrentGateVerdict, withWorkspaceRLS } from "@lyrashield/db"
import type { GateReadinessTarget } from "./launch-readiness"

export interface ReadinessIdentityOptions {
  expectedCommit?: string
  expectedArtifactDigest?: string
}

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

  return Promise.all(
    targets.map(async (target) => {
      const result = await getCurrentGateVerdict(workspaceId, target.id, {
        expectedCommit: identity.expectedCommit,
        expectedArtifactDigest: identity.expectedArtifactDigest,
      })
      if (!result) {
        return {
          targetId: target.id,
          targetName: target.name,
          state: "INSUFFICIENT_EVIDENCE" as const,
          applicable: false,
          blockingFindings: 0,
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
        reasons: result.applicability.reasons,
      }
    })
  )
}
