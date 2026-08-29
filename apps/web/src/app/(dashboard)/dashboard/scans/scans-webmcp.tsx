"use client"

import { useEffect, useRef } from "react"
import { registerWebMcpTool, type WebMcpInputSchema } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import { getManualScanOptions } from "@/lib/scan-presets"

import type { TargetItem } from "./scans-client"

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
      forbiddenInputKeys: [
        "workspaceId",
        "workspace",
        "userId",
        "user",
        "targetId",
        "evidence",
        "secret",
      ],
      handler: async (input) => {
        const currentTargets = targetsRef.current
        const currentSelectedPreset = selectedPresetRef.current

        const byName = currentTargets.filter(
          (t) => t.name.localeCompare(input.targetName, undefined, { sensitivity: "base" }) === 0
        )

        if (byName.length === 0) {
          throw new Error(
            `No target named "${input.targetName}" is visible. Create or select a target first.`
          )
        }

        if (byName.length > 1) {
          throw new Error(
            `Multiple targets named "${input.targetName}" are visible. Select the target manually in the dashboard.`
          )
        }

        const [target] = byName
        if (!target) {
          throw new Error(`Target "${input.targetName}" was selected but is no longer visible.`)
        }
        const options = getManualScanOptions({
          type: target.type,
          hasApiSpec: Boolean(target.apiSpecUrl),
        })
        const enabledOptions = options.filter((o) => o.available)

        const desiredReviewType = input.reviewType?.trim()
        const currentStillAvailable = enabledOptions.find((o) => o.id === currentSelectedPreset)

        let selectedOption = enabledOptions.find((o) => o.id === desiredReviewType)

        if (desiredReviewType && !selectedOption) {
          throw new Error(
            `Review type "${desiredReviewType}" is not available for ${target.name}. Choose a different type or target.`
          )
        }

        if (!selectedOption) {
          selectedOption = currentStillAvailable ?? enabledOptions[0]
        }

        if (!selectedOption) {
          throw new Error(
            `No review option is available for ${target.name}. Add configuration first.`
          )
        }

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
}
