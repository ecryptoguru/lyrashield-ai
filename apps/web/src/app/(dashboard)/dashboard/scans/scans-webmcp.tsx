"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import { registerWebMcpTool } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"

import type { TargetItem } from "./scan-types"
import {
  createCheckSecurityScanTool,
  createPrepareSecurityScanTool,
  createRequestSecurityScanTool,
} from "./scans-webmcp.utils"

export function useScansWebMcp({
  workspaceId,
  principalId,
  visibleDraft,
  targets,
  selectedPreset,
  setEngineBudgetCeiling,
  setSelectedTarget,
  setSelectedPreset,
  setShowCreate,
  setModeResetNotice,
}: {
  workspaceId: string
  principalId: string
  visibleDraft: { targetId: string; reviewType?: string; budget: string } | null
  targets: TargetItem[]
  selectedPreset: string
  setEngineBudgetCeiling: (value: string) => void
  setSelectedTarget: (targetId: string) => void
  setSelectedPreset: (presetId: string) => void
  setShowCreate: (show: boolean) => void
  setModeResetNotice: (notice: string | null) => void
}) {
  const receiptStore = useWebMcpReceiptStore()
  const targetsRef = useRef(targets)
  const selectedPresetRef = useRef(selectedPreset)

  const draftRef = useRef({ workspaceId, principalId, visibleDraft })
  useLayoutEffect(() => {
    targetsRef.current = targets
    selectedPresetRef.current = selectedPreset
    draftRef.current = { workspaceId, principalId, visibleDraft }
  }, [targets, selectedPreset, workspaceId, principalId, visibleDraft])

  // Advisory read-only preflight: reports whether the server would currently
  // admit the chosen review, using the page's own workspace and session —
  // agent input can never supply a workspace or principal. Returns the same
  // verdict semantics the SDK/CLI/MCP preflight exposes.
  useEffect(() => {
    const cleanup = registerWebMcpTool({
      ...createCheckSecurityScanTool({
        workspaceId,
        getTargets: () => targetsRef.current,
        getSelectedPreset: () => selectedPresetRef.current,
      }),
      receiptStore,
    })

    return cleanup
  }, [workspaceId, receiptStore])

  // Prepare the existing form for human confirmation. No apiPost.
  useEffect(() => {
    const cleanup = registerWebMcpTool({
      ...createPrepareSecurityScanTool({
        getTargets: () => targetsRef.current,
        getSelectedPreset: () => selectedPresetRef.current,
        setEngineBudgetCeiling,
        setSelectedTarget,
        setSelectedPreset,
        setShowCreate,
        setModeResetNotice,
      }),
      receiptStore,
    })

    return cleanup
  }, [
    workspaceId,
    setEngineBudgetCeiling,
    setSelectedTarget,
    setSelectedPreset,
    setShowCreate,
    setModeResetNotice,
    receiptStore,
  ])

  // W3-07: the durable execution tool. Server-bound workspace/principal
  // identity (the browser session), W3-01 idempotency semantics, and the
  // authoritative scan admission checks live on the server; agent input can
  // never supply another workspace or principal.
  useEffect(() => {
    const cleanup = registerWebMcpTool({
      ...createRequestSecurityScanTool({
        workspaceId,
        getMatchingDraftBudget: (targetId, reviewType) => {
          const scope = draftRef.current
          if (scope.workspaceId !== workspaceId || scope.principalId !== principalId)
            throw new Error("The active workspace or user changed. Start a new review.")
          const draft = scope.visibleDraft
          return draft?.targetId === targetId && draft.reviewType === reviewType
            ? draft.budget
            : undefined
        },
        getTargets: () => targetsRef.current,
        getSelectedPreset: () => selectedPresetRef.current,
      }),
      receiptStore,
    })

    return cleanup
  }, [workspaceId, principalId, receiptStore])
}
