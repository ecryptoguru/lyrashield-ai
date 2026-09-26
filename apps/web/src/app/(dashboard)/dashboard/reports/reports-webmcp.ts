"use client"

import { useEffect, useRef } from "react"
import { z } from "zod"
import { apiGet } from "@/lib/api-client"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import { registerWebMcpTool } from "@/lib/webmcp/register"
import type { ReportItem } from "./reports-model"

const reportDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  format: z.string(),
  createdAt: z.string(),
  scanSummary: z.object({ scanId: z.string() }).passthrough().nullable().optional(),
})

export function useReportsWebMcp(workspaceId: string, reports: ReportItem[]) {
  const receiptStore = useWebMcpReceiptStore()
  const reportsRef = useRef(reports)
  useEffect(() => {
    reportsRef.current = reports
  }, [reports])

  useEffect(
    () =>
      registerWebMcpTool<{ reportId: string }>({
        name: "review_scan_report",
        title: "Review scan report",
        description:
          "Read the status and metadata of a report visible on this page. Does not create or share it.",
        inputSchema: {
          required: ["reportId"],
          properties: {
            reportId: { type: "string", description: "Visible report ID." },
          },
        },
        receiptStore,
        classification: "read",
        dataClass: "workspace-summary",
        untrustedContent: false,
        uiChanged: false,
        humanConfirmationRequired: false,
        forbiddenInputKeys: ["workspaceId", "workspace", "userId", "user", "scanId", "evidence"],
        handler: async ({ reportId }, { signal }) =>
          readVisibleReport(reportId, workspaceId, reportsRef.current, signal),
      }),
    [workspaceId, receiptStore]
  )
}

export async function readVisibleReport(
  reportId: string,
  workspaceId: string,
  visibleReports: ReportItem[],
  signal: AbortSignal
) {
  if (!visibleReports.some((report) => report.id === reportId)) {
    throw new Error("That report is not visible on this page.")
  }
  const report = await apiGet(
    `/api/reports/${encodeURIComponent(reportId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    { signal, schema: reportDetailSchema }
  )
  signal.throwIfAborted()
  if (report.id !== reportId) throw new Error("The report response did not match the request.")
  return {
    reportId: report.id,
    scanId: report.scanSummary?.scanId ?? null,
    title: report.title,
    type: report.type,
    status: report.status,
    format: report.format,
    createdAt: report.createdAt,
    available: report.status === "COMPLETED",
    recoveryPath: `/dashboard/reports`,
    note: "This is a private report read. No public share link was created.",
  }
}
