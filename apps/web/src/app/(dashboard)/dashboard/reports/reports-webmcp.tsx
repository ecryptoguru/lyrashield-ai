"use client"

import { useEffect, useRef } from "react"
import { registerWebMcpTool } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import type { ReportItem } from "./reports-model"
import { createReviewScanReportTool } from "./reports-webmcp.utils"

/**
 * Registers `review_scan_report` for the reports page. The workspace is bound
 * at registration and identifiers resolve against the page's own visible
 * report list — never an agent-supplied foreign id space. On unmount or a
 * workspace change the effect cleanup unregisters the tool.
 */
export function useReportsWebMcp({
  workspaceId,
  reports,
}: {
  workspaceId: string
  reports: ReportItem[]
}) {
  const receiptStore = useWebMcpReceiptStore()
  const reportsRef = useRef(reports)

  useEffect(() => {
    reportsRef.current = reports
  }, [reports])

  useEffect(() => {
    const cleanup = registerWebMcpTool({
      ...createReviewScanReportTool({
        workspaceId,
        getReports: () => reportsRef.current,
      }),
      receiptStore,
    })
    return cleanup
  }, [workspaceId, receiptStore])
}
