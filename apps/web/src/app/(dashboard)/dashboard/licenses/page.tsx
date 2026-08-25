import type { Metadata } from "next"
import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { KeyRound } from "lucide-react"
import { getCachedSession } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { LicensesClient } from "./licenses-client"

/**
 * Admin licenses dashboard — founder-only (OWNER role).
 *
 * Shows all issued licenses with search/filter by owner email. This is a
 * global admin view, not workspace-scoped: the founder can see every license
 * issued across the platform.
 */
export const metadata: Metadata = {
  title: "Licenses",
}

export default async function LicensesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: "active" | "revoked" }>
}) {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  // Founder-only gate: the user must be an OWNER on at least one workspace.
  const ownerMembership = await prisma.workspaceMember.findFirst({
    where: { userId: session.userId, role: "OWNER", status: "active" },
  })
  if (!ownerMembership) {
    redirect("/dashboard")
  }

  const params = await searchParams
  const query = params.q?.trim() ?? ""
  const statusFilter = params.status ?? "active"

  const where = {
    revoked: statusFilter === "revoked",
    ...(query ? { ownerEmail: { contains: query, mode: "insensitive" as const } } : {}),
  }

  const licenses = await prisma.license.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      activations: {
        where: { deactivatedAt: null },
        select: { id: true, machineId: true, activatedAt: true, lastSeenAt: true },
      },
      key: { select: { id: true } },
      revocations: { select: { reason: true, revokedAt: true } },
    },
  })

  const initialData = licenses.map((l) => ({
    id: l.id,
    ownerEmail: l.ownerEmail,
    sku: l.sku,
    seatCount: l.seatCount,
    machinesActivated: l.activations.length,
    machineIds: l.machineIds,
    updateEligibleUntil: l.updateEligibleUntil.toISOString(),
    perpetualFallbackBuild: l.perpetualFallbackBuild,
    revoked: l.revoked,
    revokedAt: l.revokedAt?.toISOString() ?? null,
    revocationReason: l.revocations[0]?.reason ?? null,
    issuedAt: l.issuedAt.toISOString(),
    createdAt: l.createdAt.toISOString(),
    hasLicenseKey: Boolean(l.key),
  }))

  return (
    <div>
      <PageHeader
        title="Licenses"
        description="Admin view of all issued Local / Desktop licenses."
        icon={KeyRound}
      />
      {initialData.length === 0 && !query ? (
        <NoWorkspaceState icon={KeyRound} description="No licenses have been issued yet." />
      ) : (
        <LicensesClient initialData={initialData} query={query} statusFilter={statusFilter} />
      )}
    </div>
  )
}
