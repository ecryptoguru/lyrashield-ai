import type { GateEvidenceInput } from "@lyrashield/gate"
import type { ScopedTransaction } from "./rls"
import type { Prisma } from "./generated/prisma"
import { loadReceiptBackedRetestFindingIds } from "./retest-evidence-trust"

export const gateFindingSelect = {
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
} satisfies Prisma.FindingSelect

export async function loadGateFindings(
  tx: ScopedTransaction,
  workspaceId: string,
  targetId: string
) {
  const findings = await tx.finding.findMany({
    where: { workspaceId, targetId, deletedAt: null },
    select: gateFindingSelect,
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

export function prepareGateFindingInputs(
  findings: Awaited<ReturnType<typeof loadGateFindings>>["findings"],
  trustedRetests: Set<string>,
  scanId: string | null
): GateEvidenceInput["findings"] {
  const prepared = findings.map((finding) => {
    const trustedRetest = trustedRetests.has(finding.id)
    const positiveReceipt = finding.verificationReceipts.some(
      (receipt) =>
        receipt.scanId === scanId &&
        (receipt.status === "VALIDATED" || receipt.status === "VERIFIED") &&
        Boolean(receipt.method) &&
        receipt.method !== "RETEST"
    )
    const applicableDisposition =
      Boolean(finding.dispositionActorUserId) &&
      Boolean(finding.dispositionReason) &&
      Boolean(finding.dispositionAt) &&
      scanId !== null &&
      finding.dispositionAssessmentId === scanId &&
      (finding.disposition === "ACCEPTED_RISK" || finding.disposition === "FALSE_POSITIVE")
    return { finding, trustedRetest, positiveReceipt, applicableDisposition }
  })
  const byId = new Map(prepared.map((entry) => [entry.finding.id, entry]))
  const resolvedById = new Map<string, boolean>()
  const duplicateResolved = (entry: (typeof prepared)[number]): boolean => {
    const path: string[] = []
    const seen = new Set<string>()
    let current: (typeof prepared)[number] | undefined = entry
    let resolved = false
    while (current) {
      const id = current.finding.id
      if (resolvedById.has(id)) {
        resolved = resolvedById.get(id)!
        break
      }
      if (seen.has(id)) break
      seen.add(id)
      path.push(id)
      if (current.trustedRetest || current.applicableDisposition) {
        resolved = true
        break
      }
      if (current.finding.status !== "DUPLICATE" || !current.finding.canonicalFindingId) break
      current = byId.get(current.finding.canonicalFindingId)
    }
    for (const id of path) resolvedById.set(id, resolved)
    return resolved
  }
  return prepared.map((entry) => ({
    id: entry.finding.id,
    severity: entry.finding.severity,
    status: entry.finding.status,
    verificationStatus: entry.finding.verificationStatus,
    retestConfirmedResolved: entry.finding.status === "FIXED" && entry.trustedRetest,
    hasPositiveEvidence: entry.positiveReceipt || entry.trustedRetest,
    hasApplicableDisposition: entry.applicableDisposition,
    applicableDisposition: entry.applicableDisposition
      ? (entry.finding.disposition as "ACCEPTED_RISK" | "FALSE_POSITIVE")
      : null,
    duplicateCanonicalResolved: duplicateResolved(entry),
    lastSeenAtMs: entry.finding.lastSeenAt.getTime(),
  }))
}
