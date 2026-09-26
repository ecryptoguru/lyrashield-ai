"use client"

import { useEffect, useRef } from "react"
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
  targets,
  selectedPreset,
  setSelectedTarget,
  setSelectedPreset,
  setShowCreate,
  setModeResetNotice,
}: {
  workspaceId: string
  targets: TargetItem[]
  selectedPreset: string
  setSelectedTarget: (targetId: string) => void
  setSelectedPreset: (presetId: string) => void
  setShowCreate: (show: boolean) => void
  setModeResetNotice: (notice: string | null) => void
}) {
  const receiptStore = useWebMcpReceiptStore()
  const targetsRef = useRef(targets)
  const selectedPresetRef = useRef(selectedPreset)

  useEffect(() => {
    targetsRef.current = targets
    selectedPresetRef.current = selectedPreset
  }, [targets, selectedPreset])

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
        getTargets: () => targetsRef.current,
        getSelectedPreset: () => selectedPresetRef.current,
      }),
      receiptStore,
    })

    return cleanup
  }, [workspaceId, receiptStore])
}
