import type { ReleasePacketPayload } from "@lyrashield/types"
import { evaluateVerdictApplicability } from "./gate-service"
import type { ScopedTransaction } from "./rls"

export interface ReleasePacketApplicability {
  state: "CURRENT" | "NOT_CURRENT" | "UNAVAILABLE"
  reasons: Array<{ code: string; message: string }>
}

/** Reassess current applicability without changing the signed historical packet. */
export async function readPacketApplicability(
  tx: ScopedTransaction,
  workspaceId: string,
  packet: ReleasePacketPayload,
  now: Date
): Promise<ReleasePacketApplicability> {
  try {
    const identity = packet.assessment.assessedIdentity
    if (!identity) return { state: "UNAVAILABLE", reasons: [] }
    const verdict = await tx.gateVerdict.findFirst({
      where: { id: packet.assessment.verdictId, workspaceId, targetId: packet.target.id },
    })
    if (
      !verdict ||
      verdict.evaluatedAt.toISOString() !== packet.assessment.evaluatedAt ||
      verdict.state !== packet.assessment.historicalState
    ) {
      return { state: "UNAVAILABLE", reasons: [] }
    }
    const current = await evaluateVerdictApplicability(tx, workspaceId, verdict, {
      expectedCommit: identity.kind === "COMMIT" ? identity.value : undefined,
      expectedArtifactDigest: identity.kind === "ARTIFACT_DIGEST" ? identity.value : undefined,
      now,
    })
    return { state: current.applicable ? "CURRENT" : "NOT_CURRENT", reasons: current.reasons }
  } catch {
    return { state: "UNAVAILABLE", reasons: [] }
  }
}
