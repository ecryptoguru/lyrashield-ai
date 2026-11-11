import { notFound, redirect } from "next/navigation"
import { ShieldCheck } from "lucide-react"
import { z } from "zod"
import { PERMISSIONS } from "@lyrashield/auth"
import { requirePermission } from "@lyrashield/auth/server"
import {
  getReleasePacket,
  getReleasePacketForDelegatedRead,
  ReleasePacketError,
} from "@lyrashield/db"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { releasePacketVerificationContext } from "@/lib/release-packet-verification"
import { ReleasePacketView } from "@/app/reports/release-packet/shared/[id]/release-packet-view"

export const dynamic = "force-dynamic"
export const metadata = { title: "Release packet" }

export default async function WorkspaceReleasePacketPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!z.string().min(1).max(128).safeParse(id).success) notFound()
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")
  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader title="Release packet" />
        <NoWorkspaceState
          icon={ShieldCheck}
          description="Select a workspace to view its release packets."
        />
      </div>
    )
  }

  let authorizedSession: Awaited<ReturnType<typeof requirePermission>>["session"]
  try {
    ;({ session: authorizedSession } = await requirePermission(
      workspaceId,
      PERMISSIONS.report.download
    ))
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") notFound()
    throw error
  }
  const oauth = authorizedSession.oauth
  if (
    oauth &&
    (!oauth.connectionId || !oauth.authorizationVersion || oauth.workspaceId !== workspaceId)
  ) {
    notFound()
  }
  let result: Awaited<ReturnType<typeof getReleasePacket>>
  try {
    const verification = await releasePacketVerificationContext()
    result = oauth?.connectionId
      ? await getReleasePacketForDelegatedRead({
          reportId: id,
          workspaceId,
          userId: authorizedSession.userId,
          connectionId: oauth.connectionId,
          authorizationVersion: oauth.authorizationVersion!,
          ...verification,
        })
      : await getReleasePacket(id, workspaceId, verification)
  } catch (error) {
    if (error instanceof ReleasePacketError) notFound()
    throw error
  }
  if (!result) notFound()
  return <ReleasePacketView result={result} workspaceId={workspaceId} reportId={id} workspaceView />
}
