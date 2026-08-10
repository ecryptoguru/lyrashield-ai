import { getScanWithEvents, prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { Radar } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { RUN_SINGULAR } from "@/lib/terminology"
import { ScanDetailClient } from "./scan-detail-client"

export default async function ScanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const { id } = await params
  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div>
        <PageHeader title={RUN_SINGULAR} />
        <NoWorkspaceState
          icon={Radar}
          description={`Create a workspace before viewing ${RUN_SINGULAR.toLowerCase()}.`}
        />
      </div>
    )
  }

  const scan = await getScanWithEvents(id, workspaceId)
  if (!scan) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h2 className="mb-2 text-lg font-semibold">Scan not found</h2>
        <p className="text-muted-foreground text-sm">
          This scan may have been deleted or you don&apos;t have access to it.
        </p>
      </div>
    )
  }

  const findings = await prisma.finding.findMany({
    where: { scanId: id, workspaceId, deletedAt: null },
    select: {
      id: true,
      title: true,
      severity: true,
      status: true,
      cwe: true,
      cvssScore: true,
      summary: true,
      verified: true,
      verificationStatus: true,
      verificationMethod: true,
      verificationReason: true,
      createdAt: true,
    },
    orderBy: { severity: "desc" },
  })

  const target = scan.target

  const scanData = {
    id: scan.id,
    workspaceId: scan.workspaceId,
    status: scan.status,
    goal: scan.goal,
    mode: scan.mode,
    triggerType: scan.triggerType,
    startedAt: scan.startedAt ? scan.startedAt.toISOString() : null,
    endedAt: scan.endedAt ? scan.endedAt.toISOString() : null,
    summary: scan.summary,
    errorCategory: scan.errorCategory,
    errorMessage: scan.errorMessage,
    createdAt: scan.createdAt.toISOString(),
    target: target
      ? {
          id: target.id,
          name: target.name,
          type: target.type,
          url: target.url,
          repoFullName: target.repoFullName,
        }
      : null,
    events: scan.events.map((e) => ({
      id: e.id,
      stage: e.stage,
      level: e.level,
      message: e.message,
      metadata:
        e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata)
          ? (e.metadata as Record<string, unknown>)
          : null,
      createdAt: e.createdAt.toISOString(),
    })),
    integrity: {
      manifestChecksum: (scan.resultManifest as { checksum?: string | null } | undefined | null)?.checksum ?? null,
      urlExecution: (
        (scan.resultManifest as { manifest?: unknown } | undefined | null)?.manifest as
          | { urlExecution?: unknown }
          | undefined
          | null
      )?.urlExecution as Record<string, unknown> | undefined,
      coverage: scan.coverageReceipts.map((receipt) => ({
        scanner: receipt.scanner,
        controlId: receipt.controlId,
        status: receipt.status,
        reason: receipt.reason,
        subject: receipt.subject,
        metadata:
          receipt.metadata &&
          typeof receipt.metadata === "object" &&
          !Array.isArray(receipt.metadata)
            ? (receipt.metadata as Record<string, unknown>)
            : null,
      })),
    },
  }

  const findingsData = findings.map((f) => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    status: f.status,
    cwe: f.cwe,
    cvssScore: f.cvssScore,
    summary: f.summary,
    verified: f.verified,
    verificationStatus: f.verificationStatus,
    verificationMethod: f.verificationMethod,
    verificationReason: f.verificationReason,
    createdAt: f.createdAt.toISOString(),
  }))

  return <ScanDetailClient scan={scanData} findings={findingsData} />
}
