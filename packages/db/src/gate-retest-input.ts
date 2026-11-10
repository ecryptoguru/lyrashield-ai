import type { ScopedTransaction } from "./rls"
import { loadReceiptBackedRetestFindingIds } from "./retest-evidence-trust"

export async function loadGateFindings(
  tx: ScopedTransaction,
  workspaceId: string,
  targetId: string
) {
  const findings = await tx.finding.findMany({
    where: { workspaceId, targetId, deletedAt: null },
    select: {
      id: true,
      severity: true,
      status: true,
      verificationStatus: true,
      lastSeenAt: true,
      scanId: true,
      dedupeKey: true,
      disposition: true,
      dispositionActorUserId: true,
      dispositionReason: true,
      dispositionAssessmentId: true,
      dispositionAt: true,
      canonicalFindingId: true,
      verificationReceipts: {
        where: { OR: [{ status: { in: ["VALIDATED", "VERIFIED"] } }, { method: "RETEST" }] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true, method: true, scanId: true, verifierVersion: true, evidence: true },
      },
    },
  })
  const trustedRetests = await loadReceiptBackedRetestFindingIds(tx, {
    workspaceId,
    targetId,
    findings: findings
      .filter((finding) => finding.status === "FIXED")
      .map((finding) => ({
        ...finding,
        verificationReceipts: finding.verificationReceipts.filter(
          (receipt) => receipt.method === "RETEST"
        ),
      })),
  })
  return { findings, trustedRetests }
}
