import {
  getReportByShareToken,
  getShareableReport,
  getSharedLaunchReport,
  type LaunchReportShareablePayload,
} from "@lyrashield/db"
import { notFound } from "next/navigation"
import { SharedReportView } from "./shared-report-view"
import { SharedLaunchReportView } from "./launch-report-view"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Security Assurance Report — LyraShield AI",
  robots: { index: false, follow: false, noarchive: true, noimageindex: true },
  referrer: "no-referrer",
}

export default async function SharedReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ token?: string }>
}) {
  const { id } = await params
  const { token } = await searchParams

  if (!token) return notFound()

  const report = await getReportByShareToken(token)
  if (!report || report.id !== id) return notFound()

  // WP4: launch-readiness reports render the allowlisted gate-verdict payload,
  // token-gated and fail-closed (unknown/revoked/expired → 404).
  const launchPayload = await getSharedLaunchReport(report.id, token)
  if (launchPayload) {
    return <SharedLaunchReportView payload={launchPayload as LaunchReportShareablePayload} />
  }

  const shareable = await getShareableReport(report.id, report.workspaceId)
  if (!shareable) return notFound()

  return <SharedReportView report={shareable} />
}
