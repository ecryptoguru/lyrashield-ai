import { withWorkspaceRLS } from "@lyrashield/db"
import { normalizeDomainForProof } from "@lyrashield/security"

/** Read-only summaries expose no DNS challenge tokens or mutation capability. */
export async function getTargetDomainStatuses(
  workspaceId: string,
  targets: { id: string; type: string; url: string | null }[]
) {
  const domains = new Map(
    targets.map((target) => [
      target.id,
      target.type === "WEB_APP" || target.type === "API"
        ? normalizeDomainForProof(target.url ?? "")
        : null,
    ])
  )
  const eligible = targets.filter((target) => domains.get(target.id))
  if (!eligible.length) return new Map<string, string>()
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const [proofs, attestations] = await Promise.all([
      tx.targetDomainVerification.findMany({
        where: {
          workspaceId,
          domain: { in: [...new Set(domains.values())].filter((d): d is string => !!d) },
        },
        select: { domain: true, status: true, expiresAt: true },
        orderBy: { updatedAt: "desc" },
      }),
      tx.auditLog.findMany({
        where: {
          workspaceId,
          action: "target.ownership_attested",
          resourceType: "target",
          resourceId: { in: eligible.map((target) => target.id) },
        },
        select: { resourceId: true },
      }),
    ])
    const attested = new Set(attestations.map((row) => row.resourceId))
    return new Map(
      eligible.map((target) => {
        const proof = proofs.find((row) => row.domain === domains.get(target.id))
        const status =
          proof?.status === "VERIFIED" && proof.expiresAt > new Date()
            ? `Verified until ${proof.expiresAt.toISOString()}`
            : proof && proof.expiresAt <= new Date()
              ? "Not verified (expired)"
              : attested.has(target.id)
                ? "Self-attested"
                : "Not verified"
        return [target.id, status]
      })
    )
  })
}
