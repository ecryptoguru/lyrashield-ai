"use client"

import { useEffect, useRef } from "react"
import { registerWebMcpTool, type WebMcpInputSchema } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"

import type { TargetItem } from "./scan-types"
import {
  createCheckSecurityScanHandler,
  resolveReviewOption,
  resolveVisibleTargetByName,
} from "./scans-webmcp.utils"

const WEBMCP_FORBIDDEN_INPUT_KEYS = [
  "workspaceId",
  "workspace",
  "userId",
  "user",
  "targetId",
  "evidence",
  "secret",
]

const prepareScanInputSchema: WebMcpInputSchema = {
  required: ["targetName"],
  properties: {
    targetName: {
      type: "string",
      description: "The unique visible target name.",
    },
    reviewType: {
      type: "string",
      description: "Optional review type id. Defaults to the first available option.",
    },
  },
}

const checkScanInputSchema: WebMcpInputSchema = {
  required: ["targetName"],
  properties: {
    targetName: {
      type: "string",
      description: "The unique visible target name.",
    },
    reviewType: {
      type: "string",
      description: "Optional review type id. Defaults to the first available option.",
    },
  },
}

const requestScanInputSchema: WebMcpInputSchema = {
  required: ["targetName", "requestId"],
  properties: {
    requestId: {
      type: "string",
      description:
        "Unique ID for this requested scan. Reuse only for an identical retry; use a new ID for a new scan.",
    },
    targetName: {
      type: "string",
      description: "The unique visible target name.",
    },
    reviewType: {
      type: "string",
      description: "Optional review type id. Defaults to the first available option.",
    },
  },
}

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
    const checkHandler = createCheckSecurityScanHandler({
      workspaceId,
      getTargets: () => targetsRef.current,
      getSelectedPreset: () => selectedPresetRef.current,
    })
    const cleanup = registerWebMcpTool<{
      targetName: string
      reviewType?: string
    }>({
      name: "check_security_scan",
      title: "Check security scan",
      description:
        "Advisory read-only check whether starting a scan for a target and review type would currently be admitted. Returns the server's verdict; does not start the scan.",
      inputSchema: checkScanInputSchema,
      receiptStore,
      classification: "read",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      durableMutation: false,
      humanConfirmationRequired: false,
      forbiddenInputKeys: WEBMCP_FORBIDDEN_INPUT_KEYS,
      handler: (input, options) => checkHandler(input, options),
    })

    return cleanup
  }, [workspaceId, receiptStore])

  useEffect(() => {
    const cleanup = registerWebMcpTool<{
      targetName: string
      reviewType?: string
    }>({
      name: "prepare_security_scan",
      title: "Prepare security scan",
      description:
        "Prepare the scan creation form for a target and review type. Does not start the scan.",
      inputSchema: prepareScanInputSchema,
      receiptStore,
      classification: "mutation-prepared",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: true,
      humanConfirmationRequired: true,
      forbiddenInputKeys: WEBMCP_FORBIDDEN_INPUT_KEYS,
      handler: async (input) => {
        const target = resolveVisibleTargetByName(targetsRef.current, input.targetName)
        const selectedOption = resolveReviewOption(
          target,
          input.reviewType,
          selectedPresetRef.current
        )

        // Prepare the existing form for human confirmation. No apiPost.
        setSelectedTarget(target.id)
        setSelectedPreset(selectedOption.id)
        setShowCreate(true)
        setModeResetNotice(null)

        return {
          prepared: true,
          target: { name: target.name, type: target.type },
          reviewType: {
            id: selectedOption.id,
            label: selectedOption.label,
            goal: selectedOption.goal,
            mode: selectedOption.mode,
          },
          nextStep: "Click the Start button to create the scan.",
          note: "This tool only prepared the form. A durable scan requires your confirmation.",
        }
      },
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
    const cleanup = registerWebMcpTool<{
      requestId: string
      targetName: string
      reviewType?: string
    }>({
      name: "request_security_scan",
      title: "Request security scan",
      description:
        "Start a scan for a target and review type. Durable: the scan persists and consumes workspace usage subject to authorization and budget.",
      inputSchema: requestScanInputSchema,
      receiptStore,
      classification: "mutation-durable",
      dataClass: "workspace-summary",
      untrustedContent: false,
      uiChanged: false,
      durableMutation: true,
      humanConfirmationRequired: false,
      forbiddenInputKeys: WEBMCP_FORBIDDEN_INPUT_KEYS,
      handler: async (input, { signal }) => {
        const target = resolveVisibleTargetByName(targetsRef.current, input.targetName)
        const selectedOption = resolveReviewOption(
          target,
          input.reviewType,
          selectedPresetRef.current
        )

        // Cancellation after server acceptance reports the existing or
        // uncertain operation rather than falsely claiming no side effect.
        if (signal.aborted) {
          throw new Error(
            "The request was cancelled before the server confirmed it. Poll operation status before retrying."
          )
        }

        const response = await fetch("/api/scans", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.requestId,
          },
          body: JSON.stringify({
            workspaceId,
            targetId: target.id,
            goal: selectedOption.goal,
            mode: selectedOption.mode,
          }),
          signal,
        })
        const body = (await response.json().catch(() => null)) as {
          data?: { id?: string; operationId?: string }
          error?: { code?: string; message?: string }
        } | null
        if (!response.ok) {
          throw new Error(body?.error?.message ?? "The scan could not be started.")
        }
        return {
          started: true,
          scanId: body?.data?.id,
          operationId: body?.data?.operationId,
          target: { name: target.name, type: target.type },
          reviewType: { id: selectedOption.id, label: selectedOption.label },
          note: "The scan is durable. Poll its status or open it in Scans.",
        }
      },
    })

    return cleanup
  }, [workspaceId, receiptStore])
}
