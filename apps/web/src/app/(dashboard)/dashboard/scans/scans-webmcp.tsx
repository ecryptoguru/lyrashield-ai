"use client"

import { useEffect, useRef } from "react"
import { registerWebMcpTool, type WebMcpInputSchema } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import { getManualScanOptions } from "@/lib/scan-presets"
import { apiGet } from "@/lib/api-client"
import { scanEligibilitySchema } from "@/lib/api-schemas"

import type { TargetItem } from "./scan-types"

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

const checkScanInputSchema: WebMcpInputSchema = {
  required: ["targetName"],
  properties: prepareScanInputSchema.properties,
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
    const cleanup = registerWebMcpTool<{ targetName: string; reviewType?: string }>({
      name: "check_security_scan",
      title: "Check scan eligibility",
      description:
        "Check advisory eligibility for a visible target and review type. Does not start a scan.",
      inputSchema: checkScanInputSchema,
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
        "targetId",
        "evidence",
        "secret",
      ],
      handler: async (input, { signal }) =>
        checkVisibleScanEligibility(
          input,
          workspaceId,
          targetsRef.current,
          selectedPresetRef.current,
          signal
        ),
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
      forbiddenInputKeys: [
        "workspaceId",
        "workspace",
        "userId",
        "user",
        "targetId",
        "evidence",
        "secret",
      ],
      handler: async (input, { signal }) =>
        prepareVisibleScan(
          input,
          workspaceId,
          targetsRef.current,
          selectedPresetRef.current,
          { setSelectedTarget, setSelectedPreset, setShowCreate, setModeResetNotice },
          signal
        ),
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
      forbiddenInputKeys: [
        "workspaceId",
        "workspace",
        "userId",
        "user",
        "targetId",
        "evidence",
        "secret",
      ],
      handler: async (input, { signal }) => {
        const currentTargets = targetsRef.current
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
        }).filter((o) => o.available)
        const desired = input.reviewType?.trim()
        if (desired && !options.some((o) => o.id === desired)) {
          throw new Error(
            `Review type "${desired}" is not available for ${target.name}. Choose a different type or target.`
          )
        }
        const selectedOption = desired
          ? options.find((o) => o.id === desired)
          : (options.find((o) => o.id === selectedPresetRef.current) ?? options[0])
        if (!selectedOption) {
          throw new Error(
            `No review option is available for ${target.name}. Add configuration first.`
          )
        }

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

export async function prepareVisibleScan(
  input: { targetName: string; reviewType?: string },
  workspaceId: string,
  targets: TargetItem[],
  selectedPreset: string,
  setters: {
    setSelectedTarget: (id: string) => void
    setSelectedPreset: (id: string) => void
    setShowCreate: (show: boolean) => void
    setModeResetNotice: (notice: string | null) => void
  },
  signal: AbortSignal
) {
  const eligibility = await checkVisibleScanEligibility(
    input,
    workspaceId,
    targets,
    selectedPreset,
    signal
  )
  signal.throwIfAborted()
  const target = targets.find((item) => item.name === eligibility.target.name)
  if (!target) throw new Error("The selected target is no longer visible.")
  // The check above revalidates the browser session and target ownership on
  // the server before any UI state changes. It never creates a scan.
  setters.setSelectedTarget(target.id)
  setters.setSelectedPreset(eligibility.reviewType.id)
  setters.setShowCreate(true)
  setters.setModeResetNotice(null)
  return {
    prepared: true,
    target: eligibility.target,
    reviewType: eligibility.reviewType,
    eligibility: {
      allowed: eligibility.allowed,
      code: eligibility.code,
      message: eligibility.message,
      remainingMinutes: eligibility.remainingMinutes,
      advisory: true,
    },
    nextStep: eligibility.allowed
      ? "Review the form and click Start to create the scan."
      : "Review the eligibility blocker in the form before starting a scan.",
    note: "No scan was created. Submission repeats the authoritative checks and may consume the sponsoring account's allowance.",
  }
}

export async function checkVisibleScanEligibility(
  input: { targetName: string; reviewType?: string },
  workspaceId: string,
  targets: TargetItem[],
  selectedPreset: string,
  signal: AbortSignal
) {
  const matches = targets.filter(
    (target) =>
      target.name.localeCompare(input.targetName, undefined, { sensitivity: "base" }) === 0
  )
  if (matches.length !== 1)
    throw new Error("Select one uniquely named visible target in the dashboard.")
  const target = matches[0]!
  const options = getManualScanOptions({
    type: target.type,
    hasApiSpec: Boolean(target.apiSpecUrl),
  }).filter((option) => option.available)
  const desired = input.reviewType?.trim()
  if (desired && !options.some((option) => option.id === desired)) {
    throw new Error("The review type is unavailable for this target.")
  }
  const option = desired
    ? options.find((item) => item.id === desired)
    : (options.find((item) => item.id === selectedPreset) ?? options[0])
  if (!option) throw new Error("No review option is available for this target.")
  const eligibility = await apiGet(
    `/api/scans/eligibility?${new URLSearchParams({
      workspaceId,
      targetId: target.id,
      goal: option.goal,
      mode: option.mode,
    })}`,
    { signal, schema: scanEligibilitySchema }
  )
  signal.throwIfAborted()
  return {
    target: { name: target.name, type: target.type },
    reviewType: { id: option.id, label: option.label, goal: option.goal, mode: option.mode },
    allowed: eligibility.allowed,
    code: eligibility.code,
    message: eligibility.message,
    remainingMinutes: eligibility.remainingMinutes,
    advisory: true,
    note: "Eligibility may change. Starting a scan repeats the authoritative checks and may consume the sponsoring account's allowance.",
  }
}
