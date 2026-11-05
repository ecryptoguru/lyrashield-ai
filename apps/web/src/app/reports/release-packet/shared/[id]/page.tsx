import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { getReleasePacket, getReportByShareToken } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { ReleasePacketPayloadSchema } from "@lyrashield/types"
import { Card, buttonVariants } from "@lyrashield/ui"
import { ReleasePacketView } from "./release-packet-view"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Private Release Packet — LyraShield AI",
  robots: { index: false, follow: false, noarchive: true, noimageindex: true },
  referrer: "no-referrer",
}

export default async function PrivateReleasePacketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ token?: string; workspaceId?: string }>
}) {
  const { id } = await params
  const { token } = await searchParams
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) notFound()
  const report = await getReportByShareToken(token)
  if (
    !report ||
    report.id !== id ||
    !report.shareExpiresAt ||
    // eslint-disable-next-line react-hooks/purity -- server component, Date.now() is safe here
    report.shareExpiresAt.getTime() <= Date.now()
  ) {
    notFound()
  }

  const session = await getSession()
  if (!session) {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-xl items-center px-4 py-10">
        <Card className="w-full p-6 text-center">
          <h1 className="text-xl font-semibold">Private release packet</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Sign in to the workspace that owns this packet, then reopen this private link.
          </p>
          <Link href="/sign-in" className={buttonVariants({ className: "mt-5 min-h-11" })}>
            Sign in
          </Link>
        </Card>
      </main>
    )
  }

  try {
    await requirePermission(report.workspaceId, PERMISSIONS.report.download)
  } catch {
    notFound()
  }
  const payload = await getReleasePacket(id, report.workspaceId)
  if (!payload) notFound()
  const parsed = ReleasePacketPayloadSchema.safeParse(payload)
  if (!parsed.success) notFound()
  return <ReleasePacketView payload={parsed.data} workspaceId={report.workspaceId} reportId={id} />
}
