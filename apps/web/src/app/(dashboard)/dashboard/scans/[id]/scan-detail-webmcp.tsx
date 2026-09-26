"use client"

import { useEffect } from "react"
import { registerWebMcpTool } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import { createReviewScanProgressTool } from "./scan-detail-webmcp.utils"

/**
 * Registers `review_scan_progress` for the scan this detail page displays.
 * The workspace and scan id are bound here — agent input can never supply a
 * different workspace, principal or foreign scan. On unmount or a route to
 * another scan the registration is cleaned up by the effect contract.
 */
export function useScanDetailWebMcp({
  workspaceId,
  scanId,
}: {
  workspaceId: string
  scanId: string
}) {
  const receiptStore = useWebMcpReceiptStore()

  useEffect(() => {
    const cleanup = registerWebMcpTool({
      ...createReviewScanProgressTool({
        workspaceId,
        getScanId: () => scanId,
      }),
      receiptStore,
    })
    return cleanup
  }, [workspaceId, scanId, receiptStore])
}
