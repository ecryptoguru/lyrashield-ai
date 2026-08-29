"use client"

import { useEffect, useRef } from "react"
import { registerWebMcpTool, type WebMcpInputSchema } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import { apiGet } from "@/lib/api-client"
import { z } from "zod"
import type { LaunchReadinessReport } from "./launch-readiness-client"

const launchReadinessInputSchema: WebMcpInputSchema = {
  properties: {
    focusBlockers: {
      type: "boolean",
      description: "Only return the blocking conditions.",
    },
  },
}

const launchReadinessReportSchema = z
  .object({
    verdict: z.enum(["NOT_EVALUATED", "INCONCLUSIVE", "GO", "GO_WITH_CONDITIONS", "NO_GO"]),
    score: z.number().nullable(),
    summary: z.string(),
    blockingFindings: z.number(),
    totalFindings: z.number(),
    verifiedFindings: z.number(),
    bySeverity: z.record(z.string(), z.number()),
    conditions: z.array(z.string()),
    recommendations: z.array(z.string()),
  })
  .passthrough()

export function useLaunchReadinessWebMcp({
  workspaceId,
  onReport,
}: {
  workspaceId: string
  onReport?: (report: LaunchReadinessReport) => void
}) {
  const receiptStore = useWebMcpReceiptStore()
  const onReportRef = useRef(onReport)

  useEffect(() => {
    onReportRef.current = onReport
  }, [onReport])

  useEffect(() => {
    const cleanup = registerWebMcpTool<{ focusBlockers?: boolean }>({
      name: "review_launch_readiness",
      title: "Review launch readiness",
      description:
        "Return a bounded launch readiness summary for this workspace, optionally focusing on blockers.",
      inputSchema: launchReadinessInputSchema,
      receiptStore,
      classification: "read",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      humanConfirmationRequired: false,
      forbiddenInputKeys: ["workspaceId", "workspace", "userId", "user", "targetId", "evidence"],
      handler: async (input, { signal }) => {
        const report = await apiGet<LaunchReadinessReport>(
          `/api/launch-readiness?workspaceId=${encodeURIComponent(workspaceId)}`,
          { signal, schema: launchReadinessReportSchema }
        )
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")

        const onReport = onReportRef.current
        if (onReport) {
          onReport(report)
        }

        const focus = input.focusBlockers === true
        const conditions = focus
          ? report.conditions.filter(
              (c) => c.toLowerCase().includes("block") || c.toLowerCase().includes("fix")
            )
          : report.conditions

        const recommendations = focus
          ? report.recommendations.filter(
              (r) =>
                r.toLowerCase().includes("block") ||
                r.toLowerCase().includes("critical") ||
                r.toLowerCase().includes("high")
            )
          : report.recommendations

        return {
          verdict: report.verdict,
          score: report.score,
          summary: report.summary,
          blockingFindings: report.blockingFindings,
          totalFindings: report.totalFindings,
          verifiedFindings: report.verifiedFindings,
          bySeverity: report.bySeverity,
          conditions,
          recommendations,
          focused: focus,
          note: focus
            ? "Showing blocker-focused conditions and recommendations. The full report is available in the dashboard."
            : undefined,
        }
      },
    })

    return cleanup
  }, [workspaceId, receiptStore])
}
