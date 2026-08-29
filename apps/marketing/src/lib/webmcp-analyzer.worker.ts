/// <reference lib="webworker" />

import { discoverWebMcpTools } from "@lyrashield/security/webmcp/discover"
import { planWebMcpRewrite } from "@lyrashield/security/webmcp/rewrite"
import {
  evaluateWebMcpSurface,
  summarizeWebMcpCoverage,
  type WebMcpControlId,
  type WebMcpCoverageSummary,
  type WebMcpRewritePlan,
  type WebMcpScanFile,
  type WebMcpSignal,
  type WebMcpToolInventory,
} from "@lyrashield/security/webmcp"
import { WEBMCP_FREE_LIMITS } from "./webmcp-config"

interface WebMcpAnalyzeResult {
  inventory: WebMcpToolInventory
  signals: WebMcpSignal[]
  coverage: WebMcpCoverageSummary
}

interface AnalyzeRequest {
  id: string
  type: "analyze"
  files: WebMcpScanFile[]
}

interface PrepareRewriteRequest {
  id: string
  type: "prepareRewrite"
  files: WebMcpScanFile[]
  signals: WebMcpSignal[]
  selectedControlIds: WebMcpControlId[]
}

type WorkerRequest = AnalyzeRequest | PrepareRewriteRequest

interface AnalyzeResponse {
  id: string
  type: "analyze"
  result: WebMcpAnalyzeResult
}

interface RewriteResponse {
  id: string
  type: "prepareRewrite"
  plan: WebMcpRewritePlan
}

interface ErrorResponse {
  id: string
  type: "error"
  message: string
}

async function analyzeFiles(files: WebMcpScanFile[]): Promise<WebMcpAnalyzeResult> {
  const { inventory, context } = await discoverWebMcpTools(files, {
    limits: WEBMCP_FREE_LIMITS,
  })
  const signals = evaluateWebMcpSurface(files, inventory, context)
  const coverage = summarizeWebMcpCoverage(signals, inventory.limitsReached)

  return { inventory, signals, coverage }
}

async function prepareRewrite(
  files: WebMcpScanFile[],
  signals: WebMcpSignal[],
  selectedControlIds: WebMcpControlId[]
): Promise<WebMcpRewritePlan> {
  const selectedSignals = signals.filter(
    (s) =>
      selectedControlIds.includes(s.controlId) &&
      (s.state === "DETECTED" || s.state === "INCONCLUSIVE")
  )

  const { inventory } = await discoverWebMcpTools(files, { limits: WEBMCP_FREE_LIMITS })

  return planWebMcpRewrite(files, selectedSignals, inventory, { maxEditSizeBytes: 2048 })
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    if (request.type === "analyze") {
      const result = await analyzeFiles(request.files)
      const response: AnalyzeResponse = { id: request.id, type: "analyze", result }
      self.postMessage(response)
    } else if (request.type === "prepareRewrite") {
      const plan = await prepareRewrite(request.files, request.signals, request.selectedControlIds)
      const response: RewriteResponse = { id: request.id, type: "prepareRewrite", plan }
      self.postMessage(response)
    } else {
      const response: ErrorResponse = {
        id: (request as { id: string }).id,
        type: "error",
        message: "Unknown request type",
      }
      self.postMessage(response)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const response: ErrorResponse = { id: request.id, type: "error", message }
    self.postMessage(response)
  }
}
