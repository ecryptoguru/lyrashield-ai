"use client"

import { useEffect } from "react"
import { apiGet } from "@/lib/api-client"
import { scanPollDataSchema } from "@/lib/api-schemas"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import { registerWebMcpTool } from "@/lib/webmcp/register"

/** The route supplies identity; an agent cannot select another scan or workspace. */
export function useScanProgressWebMcp(scanId: string, workspaceId: string) {
  const receiptStore = useWebMcpReceiptStore()

  useEffect(
    () =>
      registerWebMcpTool({
        name: "review_scan_progress",
        title: "Review scan progress",
        description: "Read the current status and recorded stage of the scan open on this page.",
        inputSchema: { properties: {} },
        receiptStore,
        classification: "read",
        dataClass: "workspace-summary",
        untrustedContent: false,
        uiChanged: false,
        humanConfirmationRequired: false,
        forbiddenInputKeys: [
          "workspaceId",
          "workspace",
          "userId",
          "user",
          "scanId",
          "id",
          "evidence",
        ],
        handler: async (_input, { signal }) => readScanProgress(scanId, workspaceId, signal),
      }),
    [scanId, workspaceId, receiptStore]
  )
}

export async function readScanProgress(scanId: string, workspaceId: string, signal: AbortSignal) {
  const scan = await apiGet(
    `/api/scans/${encodeURIComponent(scanId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    { signal, schema: scanPollDataSchema }
  )
  signal.throwIfAborted()
  if (scan.id !== scanId || scan.workspaceId !== workspaceId) {
    throw new Error("The scan response did not match this page.")
  }
  const lastEvent = scan.events?.at(-1)
  return {
    scanId,
    status: scan.status,
    stage: lastEvent?.stage ?? null,
    startedAt: scan.startedAt,
    endedAt: scan.endedAt,
    recordedCoverageCount: scan.coverageReceipts?.length ?? 0,
    manifestAvailable: Boolean(scan.resultManifest?.checksum),
    progressPercent: null,
    note: "Status and stage are recorded facts. No completion percentage is available.",
    recoveryPath: `/dashboard/scans/${encodeURIComponent(scanId)}`,
  }
}
