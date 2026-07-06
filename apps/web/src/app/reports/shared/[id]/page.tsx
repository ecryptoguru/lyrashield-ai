import { getReportByShareToken, getShareableReport } from "@lyrashield/db"
import { notFound } from "next/navigation"
import { SharedReportView } from "./shared-report-view"

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

  const shareable = await getShareableReport(report.id, report.workspaceId)
  if (!shareable) return notFound()

  return <SharedReportView report={shareable} />
}
