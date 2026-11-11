import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { ShieldCheck } from "lucide-react"
import { Card, buttonVariants } from "@lyrashield/ui"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { ReleasePacketForm } from "./release-packet-form"
import { parseReleasePacketSearchParams } from "./release-packet-create"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Create Release Packet",
  robots: { index: false, follow: false, noarchive: true, noimageindex: true },
}

export default async function CreateReleasePacketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")
  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader title="Create Release Packet" />
        <NoWorkspaceState
          icon={ShieldCheck}
          description="Create or select a workspace before issuing a release packet."
        />
      </div>
    )
  }
  const parsed = parseReleasePacketSearchParams(await searchParams)
  if (parsed.status === "invalid") {
    return (
      <div>
        <PageHeader title="Create Release Packet" />
        <Card className="p-5">
          <h2 className="font-semibold">Exact release required</h2>
          <p role="alert" className="text-destructive mt-2 text-sm">
            {parsed.reason}
          </p>
          <Link
            href="/dashboard/targets"
            className={buttonVariants({ variant: "outline", className: "mt-4" })}
          >
            Return to targets
          </Link>
        </Card>
      </div>
    )
  }
  return (
    <div className="space-y-5">
      <PageHeader
        title="Create Release Packet"
        description="Issue one private, immutable snapshot tied to the exact assessed release."
      />
      <ReleasePacketForm
        workspaceId={workspaceId}
        targetId={parsed.targetId}
        identity={parsed.identity}
      />
    </div>
  )
}
