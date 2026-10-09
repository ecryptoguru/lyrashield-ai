import type { Metadata } from "next"
import { z } from "zod"
import { getSystemPrisma } from "@lyrashield/db"
import { notFound } from "next/navigation"
import { KeyRound } from "lucide-react"
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { PageHeader } from "@/components/page-header"
import { LicensesClient } from "./licenses-client"
import { parseAdminCursor } from "@/lib/platform-admin-lists"

/**
 * Platform administrator licenses dashboard.
 *
 * Shows all issued licenses with search/filter by owner email. This is a
 * global admin view, not workspace-scoped: an elevated platform administrator
 * can see every license issued across the platform.
 */
export const metadata: Metadata = {
  title: "Licenses",
}

export default async function LicensesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; cursor?: string }>
}) {
  try {
    await requirePlatformAdminIdentity()
  } catch {
    notFound()
  }

  const params = z
    .object({
      q: z.string().optional().catch(undefined),
      status: z.enum(["active", "revoked"]).catch("active"),
      cursor: z.string().optional().catch(undefined),
    })
    .parse(await searchParams)
  const query = params.q?.trim().slice(0, 320) ?? ""
  const statusFilter = params.status === "revoked" ? "revoked" : "active"
  const cursor = parseAdminCursor(params.cursor)

  const where = {
    revoked: statusFilter === "revoked",
    ...(query ? { ownerEmail: { contains: query, mode: "insensitive" as const } } : {}),
  }

  const licenses = await getSystemPrisma().license.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 101,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      activations: {
        where: { deactivatedAt: null },
        select: { id: true, machineId: true, activatedAt: true, lastSeenAt: true },
      },
      key: { select: { id: true } },
      revocations: { select: { reason: true, revokedAt: true } },
    },
  })

  const nextCursor = licenses.length > 100 ? licenses[99]!.id : null
  const initialData = licenses.slice(0, 100).map((l) => ({
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
      <LicensesClient
        key={`${statusFilter}:${query}:${cursor ?? ""}`}
        initialData={initialData}
        query={query}
        statusFilter={statusFilter}
        cursor={cursor ?? null}
        nextCursor={nextCursor}
      />
    </div>
  )
}
