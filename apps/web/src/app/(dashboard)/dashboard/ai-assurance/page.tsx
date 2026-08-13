import { notFound, redirect } from "next/navigation"
import { prisma, getAiSystemProfile, getThreatModel, listControlEvidence } from "@lyrashield/db"
import { getCachedSession, getCachedWorkspaceContext } from "@/lib/cache"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import { PageHeader } from "@/components/page-header"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { AiAssuranceClient } from "./ai-assurance-client"
import { ShieldCheck } from "lucide-react"
import { buildControlEvidenceList } from "@/lib/ai-assurance"

export default async function AiAssurancePage({
  searchParams,
}: {
  searchParams: Promise<{ targetId?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const { workspaceId, workspaces } = await getCachedWorkspaceContext(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title="Operational Evidence Vault"
          description="AI assurance evidence by target"
        />
        <NoWorkspaceState
          icon={ShieldCheck}
          description="Create a workspace to manage AI assurance evidence."
        />
      </div>
    )
  }

  const role = workspaces.find((w) => w.id === workspaceId)?.role
  if (!role || !hasPermission(role, PERMISSIONS.aiAssurance.view)) {
    return notFound()
  }

  const { targetId } = await searchParams

  const targets = await prisma.target.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })

  const selectedTargetId = targetId ?? (targets.length === 1 ? targets[0]?.id : undefined)

  if (!selectedTargetId && targets.length > 0) {
    redirect(`/dashboard/ai-assurance?targetId=${targets[0]?.id}`)
  }

  const controlEvidence = selectedTargetId
    ? await listControlEvidence({ workspaceId, targetId: selectedTargetId })
    : []
  const [profile, threatModel] = selectedTargetId
    ? await Promise.all([
        getAiSystemProfile(workspaceId, selectedTargetId),
        getThreatModel(workspaceId, selectedTargetId),
      ])
    : [null, null]
  const items = buildControlEvidenceList(controlEvidence)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operational Evidence Vault"
        description="Versioned, workspace-private evidence for the seven evidence-required Vibe Security 50 controls."
      />
      <AiAssuranceClient
        workspaceId={workspaceId}
        targetId={selectedTargetId ?? null}
        targets={targets}
        initialItems={items}
        canManage={hasPermission(role, PERMISSIONS.aiAssurance.manage)}
        canReview={hasPermission(role, PERMISSIONS.aiAssurance.review)}
        initialProfile={(profile?.currentVersion?.profile ?? null) as never}
        initialThreatModel={(threatModel?.currentVersion?.content ?? null) as never}
      />
    </div>
  )
}
